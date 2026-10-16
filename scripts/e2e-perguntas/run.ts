// Teste ponta a ponta das perguntas com opções (AskUserQuestion) contra o TUI real do Claude Code, sem login:
// sobe a API falsa (mock-api.mjs), abre o `claude` num tmux próprio, faz ele perguntar e responde pelo
// QuestionService (o mesmo de produção), conferindo o tool_result que o Claude Code mandou para a "API".
//
//   CLAUDE_BIN=~/cc295/node_modules/.bin/claude npx tsx scripts/e2e-perguntas/run.ts
//
// Só para a máquina de desenvolvimento (usa /tmp e uma pasta de configuração própria do Claude Code).
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentInfo, AskAnswer } from '../../shared/types';
import { QuestionService } from '../../server/questions/service';

const here = dirname(fileURLToPath(import.meta.url));
const CLAUDE = process.env.CLAUDE_BIN ?? 'claude';
const PORT = Number(process.env.MOCK_PORT ?? 18999);
const KEY = 'sk-ant-api03-e2eperguntase2eperguntase2eperguntas00000000';
const root = join(tmpdir(), 'hb-e2e-perguntas');
const SOCK = join(root, 'tmux.sock');
const PANE = 'hbq';

interface Scenario {
  name: string;
  input: unknown;
  answers: AskAnswer[];
  /** Trecho esperado no tool_result. */
  expect: string;
  /** Largura do terminal (padrão 120). */
  width?: number;
}

const q = (question: string, header: string, multiSelect: boolean, labels: string[]) => ({
  question,
  header,
  multiSelect,
  options: labels.map((label) => ({ label, description: `descrição de ${label}` })),
});

const SCENARIOS: Scenario[] = [
  { name: 'uma pergunta, escolha única', input: { questions: [q('Qual banco usar?', 'Banco', false, ['Postgres', 'SQLite', 'Mongo'])] }, answers: [{ selected: [2] }], expect: '"Qual banco usar?"="Mongo"' },
  { name: 'uma pergunta, "Outro"', input: { questions: [q('Qual banco usar?', 'Banco', false, ['Postgres', 'SQLite'])] }, answers: [{ selected: [], other: 'MariaDB com réplica' }], expect: '"Qual banco usar?"="MariaDB com réplica"' },
  { name: 'uma pergunta, várias opções', input: { questions: [q('Quais recursos?', 'Recursos', true, ['Cache', 'Fila', 'Busca'])] }, answers: [{ selected: [0, 2] }], expect: '"Quais recursos?"="Cache, Busca"' },
  {
    name: 'duas perguntas + revisão (única e várias com "Outro")',
    input: { questions: [q('Qual banco usar?', 'Banco', false, ['Postgres', 'SQLite']), q('Quais recursos ligar?', 'Recursos', true, ['Cache', 'Fila', 'Busca'])] },
    answers: [{ selected: [1] }, { selected: [1], other: 'webhooks' }],
    expect: '"Qual banco usar?"="SQLite", "Quais recursos ligar?"="Fila, webhooks"',
  },
  {
    name: 'três perguntas + revisão',
    input: { questions: [q('Linguagem?', 'Ling', false, ['Go', 'Rust', 'TS']), q('Deploy?', 'Deploy', false, ['VPS', 'K8s']), q('Extras?', 'Extras', true, ['Logs', 'Métricas'])] },
    answers: [{ selected: [2] }, { selected: [0] }, { selected: [0, 1] }],
    expect: '"Linguagem?"="TS", "Deploy?"="VPS", "Extras?"="Logs, Métricas"',
  },
  {
    name: 'terminal estreito, "Outro" mais longo que a linha',
    input: { questions: [q('Qual banco usar?', 'Banco', false, ['Postgres', 'SQLite'])] },
    answers: [{ selected: [], other: 'quero um banco relacional com réplica de leitura em outra região e backup diário' }],
    expect: '"Qual banco usar?"="quero um banco relacional com réplica de leitura em outra região e backup diário"',
    width: 60,
  },
];

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
const tmux = (...args: string[]) => execFileSync('tmux', ['-S', SOCK, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const screen = () => tmux('capture-pane', '-p', '-t', PANE);

async function waitFor(test: () => boolean, ms: number, what: string): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (test()) return;
    await sleep(250);
  }
  throw new Error(`tempo esgotado esperando ${what}\n${screen()}`);
}

function transcript(cfg: string): string | undefined {
  const dir = join(cfg, 'projects');
  if (!existsSync(dir)) return undefined;
  const files = readdirSync(dir).flatMap((d) => readdirSync(join(dir, d)).filter((f) => f.endsWith('.jsonl')).map((f) => join(dir, d, f)));
  return files.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
}

async function run(s: Scenario): Promise<void> {
  try {
    tmux('kill-server');
  } catch {
    // não havia servidor
  }
  rmSync(root, { recursive: true, force: true });
  const cfg = join(root, 'cfg');
  const proj = join(root, 'proj');
  mkdirSync(cfg, { recursive: true });
  mkdirSync(proj, { recursive: true });
  const qfile = join(root, 'q.json');
  const log = join(root, 'mock.log');
  writeFileSync(qfile, JSON.stringify(s.input));
  writeFileSync(log, '');
  writeFileSync(
    join(cfg, '.claude.json'),
    JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', numStartups: 5, customApiKeyResponses: { approved: [KEY.slice(-20)], rejected: [] }, projects: { [proj]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, allowedTools: [] } } }),
  );
  const mock = spawn(process.execPath, [join(here, 'mock-api.mjs'), String(PORT), qfile, log], { stdio: 'ignore' });
  try {
    await sleep(400);
    const env = `env CLAUDE_CONFIG_DIR=${cfg} ANTHROPIC_API_KEY=${KEY} ANTHROPIC_BASE_URL=http://127.0.0.1:${PORT} DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`;
    tmux('new-session', '-d', '-s', PANE, '-x', String(s.width ?? 120), '-y', '45', '-c', proj, `${env} ${CLAUDE}`);
    await waitFor(() => /❯|Enter to confirm/.test(screen()), 20_000, 'o Claude Code abrir');
    await sleep(1_500);
    // Diálogos de inicialização (ex.: imports de CLAUDE.md de fora da pasta): fica com a opção padrão.
    for (let i = 0; i < 3 && /Enter to confirm/.test(screen()); i++) {
      tmux('send-keys', '-t', PANE, 'Enter');
      await sleep(1_000);
    }
    tmux('send-keys', '-t', PANE, '-l', '--', 'PERGUNTE agora');
    await sleep(300);
    tmux('send-keys', '-t', PANE, 'Enter');
    await waitFor(() => /Enter to select/.test(screen()), 20_000, 'o diálogo da pergunta');

    const agent = { id: 'a1', kind: 'main', engine: 'claude', status: 'waiting' } as unknown as AgentInfo;
    const svc = new QuestionService({
      office: { list: () => [agent], markDirty: () => {} },
      transcriptPathOf: () => transcript(cfg),
      input: {
        screen: async () => screen(),
        driveKeys: async (_id, keys) => void tmux('send-keys', '-t', PANE, ...keys),
        typeText: async (_id, text) => void tmux('send-keys', '-t', PANE, '-l', '--', text),
      },
    });
    // O transcript pode ser gravado um instante depois de o diálogo aparecer (em produção o poll roda a cada 1,5 s).
    await waitFor(() => (svc.poll(), !!svc.pendingOf('a1')), 5_000, 'a pergunta no transcript');
    const pending = svc.pendingOf('a1')!;
    const r = await svc.answer('a1', { toolUseId: pending.toolUseId, answers: s.answers });
    const results = readFileSync(log, 'utf8');
    if (!results.includes(s.expect.replace(/"/g, '\\"'))) throw new Error(`resposta diferente da esperada.\nesperado: ${s.expect}\nlog: ${results}`);
    if (!r.answered) throw new Error('o tool_result não foi confirmado no transcript');
    svc.poll();
    if (svc.pendingOf('a1')) throw new Error('a pergunta continuou pendente depois da resposta');
  } finally {
    mock.kill();
    try {
      tmux('kill-server');
    } catch {
      // já fechou
    }
  }
}

let failed = 0;
for (const s of SCENARIOS) {
  try {
    await run(s);
    console.log(`ok    ${s.name}`);
  } catch (err) {
    failed++;
    console.log(`FALHA ${s.name}\n${(err as Error).message}`);
  }
}
process.exit(failed ? 1 : 0);
