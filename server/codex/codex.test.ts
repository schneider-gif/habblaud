// Fonte "codex": parser do rollout com fixtures reais (Codex CLI 0.162.1, anonimizadas: caminhos trocados e
// instruções do sistema omitidas; provedor de modelo local de teste), tela do tmux, travas abertas (/proc/locks),
// login, confiança na pasta, terminal da conversa, watcher no escritório e respostas de aprovação pelo tmux.
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { codexShellCommand, cleanEngine, withCodexTrust } from '../input/tmux';
import { decideCodex } from './approvals';
import { codexAccounts, codexAuth, discoverCodexDirs, parseCodexAuth } from './detect';
import { agentPidOf, candidateDayDirs, findRollout, isCodexCmdline, isDaemonCmdline, openThreads, parseProcLocks, uuidV7Time, type ProcReader } from './proc';
import { codexStatus, codexTitle, commandOf, createCodexState, describeCodexCall, isInjectedUserText, likelyApproval, parseCodexLine, patchFiles } from './rollout';
import { approvalKey, classifyCodexScreen } from './screen';
import { cleanToolOutput, createAutoTerminalParser, createCodexTerminalParser, isCodexLine } from './terminal';
import { CodexWatcher } from './watcher';

setQuiet(true);

const FIX = join(__dirname, 'fixtures');
const MULTI = 'rollout-2026-10-15T00-26-07-01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef.jsonl';
const ABORT = 'rollout-2026-10-15T00-28-40-01a13cf6-0e3c-7053-bd16-136a0ae57a99.jsonl';
const EMPTY = 'rollout-2026-10-15T00-29-12-01a13cf6-8a3d-7642-9d5a-b9f299bb76f3.jsonl';
const lines = (f: string) => readFileSync(join(FIX, f), 'utf8').trim().split('\n');

function parseAll(f: string, upTo?: number) {
  const s = createCodexState();
  const acts = [];
  for (const l of lines(f).slice(0, upTo)) acts.push(...parseCodexLine(s, l, { idPrefix: 'cx', now: 0 }).activities.map((a) => a.activity));
  return { s, acts };
}

// ------------------------------------------------------------------ rollout

describe('rollout do Codex (fixtures reais)', () => {
  it('sessão com vários turnos: pasta, versão, título, prompts, ferramentas e fins de turno', () => {
    const { s, acts } = parseAll(MULTI);
    expect(s.threadId).toBe('01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef');
    expect(s.cwd).toBe('/home/dev/projetos/loja');
    expect(s.cliVersion).toBe('0.162.1');
    expect(s.approvalPolicy).toBe('on-request');
    expect(codexTitle(s)).toBe('liste os arquivos do projeto');
    expect(s.prompts).toBe(5);
    expect(s.turnOpen).toBe(false);
    expect(codexStatus(s)).toBe('idle');
    expect(s.pending.size).toBe(0);
    expect(s.stats.toolCalls).toBe(5);
    expect(s.stats.tokensIn).toBeGreaterThan(0);
    const kinds = acts.map((a) => a.kind);
    // O contexto do ambiente (<environment_context>) não vira prompt.
    expect(acts.filter((a) => a.kind === 'prompt').map((a) => a.detail)).toEqual([
      'liste os arquivos do projeto',
      'teste de aprovacao por favor',
      'edite um arquivo',
      'me faca uma pergunta',
      'isso vai demorar',
    ]);
    expect(kinds.filter((k) => k === 'done')).toHaveLength(5);
    expect(acts.find((a) => a.tool === 'Write')?.text).toBe('Escrevendo hello.txt');
    expect(acts.find((a) => a.kind === 'ask')?.text).toBe('Fazendo uma pergunta');
    expect(acts.some((a) => a.kind === 'error' && /Comando falhou/.test(a.text))).toBe(true);
    // ids estáveis (ordinal da linha): releitura não duplica
    expect(new Set(acts.map((a) => a.id)).size).toBe(acts.length);
  });

  it('meio do turno: comando pedindo para sair do sandbox fica pendente (provável aprovação)', () => {
    // linhas 0..25 = até o function_call com sandbox_permissions: require_escalated, sem resultado ainda
    const { s } = parseAll(MULTI, 26);
    expect(s.turnOpen).toBe(true);
    expect(codexStatus(s)).toBe('working');
    const pend = [...s.pending.values()];
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ name: 'exec_command', escalated: true, kind: 'command', detail: 'touch /etc/habblaud-teste', justification: 'Preciso gravar fora da pasta do projeto' });
    expect(likelyApproval(s, pend[0].at + 5_000)?.callId).toBe(pend[0].callId);
    expect(likelyApproval(s, pend[0].at + 10)).toBeUndefined();
  });

  it('edição (apply_patch) pendente e depois concluída', () => {
    const mid = parseAll(MULTI, 41).s;
    expect([...mid.pending.values()].map((p) => p.kind)).toEqual(['patch']);
    expect(parseAll(MULTI, 44).s.pending.size).toBe(0);
  });

  it('interrupção (Esc) encerra o turno: "Interrompido por você"', () => {
    const { s, acts } = parseAll(ABORT);
    expect(s.turnOpen).toBe(false);
    expect(acts.at(-1)?.text).toBe('Interrompido por você');
    expect(s.pending.size).toBe(0);
  });

  it('conversa sem mensagem: só o session_meta (sem prompts nem título)', () => {
    const { s, acts } = parseAll(EMPTY);
    expect(s.cwd).toBe('/home/dev/projetos/loja');
    expect(s.prompts).toBe(0);
    expect(codexTitle(s)).toBeUndefined();
    expect(acts).toEqual([]);
  });

  it('linha inválida não quebra; /rename (thread_name_updated) vira o título', () => {
    const s = createCodexState();
    expect(parseCodexLine(s, '{oops', { idPrefix: 'x', now: 5 }).activities).toEqual([]);
    parseCodexLine(s, JSON.stringify({ timestamp: '2026-10-15T00:00:00Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'faça a loja' }] } }), { idPrefix: 'x', now: 0 });
    parseCodexLine(s, JSON.stringify({ timestamp: '2026-10-15T00:00:01Z', type: 'event_msg', payload: { type: 'thread_name_updated', thread_name: 'Loja nova' } }), { idPrefix: 'x', now: 0 });
    expect(codexTitle(s)).toBe('Loja nova');
  });

  it('descrições das ferramentas', () => {
    expect(describeCodexCall('exec_command', { cmd: 'npm test' }).kind).toBe('test');
    expect(describeCodexCall('shell', { command: ['bash', '-lc', 'git status'] }).kind).toBe('git');
    expect(describeCodexCall('apply_patch', {}, '*** Begin Patch\n*** Update File: src/app.ts\n@@\n*** Delete File: old.ts\n*** End Patch').text).toBe('Editando app.ts (+1)');
    expect(describeCodexCall('update_plan', {}).kind).toBe('plan');
    expect(describeCodexCall('web_search', { query: 'vitest' }).kind).toBe('web');
    expect(describeCodexCall('mcp__github__x', {}).kind).toBe('mcp');
    expect(commandOf({ command: ['bash', '-lc', 'ls -la'] })).toBe('ls -la');
    expect(commandOf({ cmd: 'ls' })).toBe('ls');
    expect(patchFiles('*** Add File: a.txt\n+x\n*** Update File: b/c.ts')).toEqual([{ op: 'add', path: 'a.txt' }, { op: 'update', path: 'b/c.ts' }]);
    expect(isInjectedUserText('<environment_context>\n<cwd>/x</cwd>')).toBe(true);
    expect(isInjectedUserText('# AGENTS.md instructions for /x')).toBe(true);
    expect(isInjectedUserText('liste os arquivos')).toBe(false);
  });

  it('update_plan vira a lista de tarefas', () => {
    const s = createCodexState();
    parseCodexLine(s, JSON.stringify({ timestamp: '2026-10-15T00:00:00Z', type: 'response_item', payload: { type: 'function_call', name: 'update_plan', call_id: 'c1', arguments: JSON.stringify({ plan: [{ step: 'Ler o código', status: 'completed' }, { step: 'Escrever testes', status: 'in_progress' }, { step: 'Publicar', status: 'pending' }] }) } }), { idPrefix: 'x', now: 0 });
    expect(s.tasks.map((t) => [t.title, t.status])).toEqual([['Ler o código', 'completed'], ['Escrever testes', 'in_progress'], ['Publicar', 'pending']]);
  });
});

// ------------------------------------------------------------------ tela do tmux

const SCREEN_CMD = `› teste de aprovacao por favor

• Running touch /etc/habblaud-teste

  Would you like to run the following command?

  Environment: local

  Reason: Preciso gravar fora da pasta do projeto

  $ touch /etc/habblaud-teste

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for commands that start with \`touch /etc/habblaud-teste\` (p)
  3. No, and tell Codex what to do differently (esc)

  Press enter to confirm or esc to cancel`;

const SCREEN_EDIT = `• Added hello.txt (+1 -0)
    1 +ola mundo

  Would you like to make the following edits?

  Description: command failed; retry without sandbox?

  Destination: /home/dev/projetos/loja/hello.txt

› 1. Yes, proceed (y)
  2. Yes, and don't ask again for these files (a)
  3. No, and tell Codex what to do differently (esc)`;

const SCREEN_LOGIN = `  Welcome to Codex, OpenAI's command-line coding agent

  Sign in with ChatGPT to use Codex as part of your paid plan
  or connect an API key for usage-based billing

> 1. Sign in with ChatGPT
     Usage included with Plus, Pro, Business, and Enterprise plans

  2. Sign in with Device Code
     Sign in from another device with a one-time code

  3. Provide your own API key
     Pay for what you use`;

const SCREEN_TRUST = `  Folder access
  /home/dev/projetos/loja

  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings.

› 1. Trust and continue
  2. Back to Agent Command Center`;

describe('tela do Codex no tmux', () => {
  it('reconhece aprovação de comando com comando, motivo e "não perguntar de novo" (p)', () => {
    const sc = classifyCodexScreen(SCREEN_CMD);
    expect(sc).toMatchObject({ kind: 'approval', what: 'command', command: 'touch /etc/habblaud-teste', reason: 'Preciso gravar fora da pasta do projeto', alwaysKey: 'p' });
    if (sc.kind !== 'approval') throw new Error('x');
    expect(approvalKey('allow', sc)).toBe('y');
    expect(approvalKey('always', sc)).toBe('p');
    expect(approvalKey('deny', sc)).toBe('Escape');
  });

  it('aprovação de edição usa "a" para não perguntar de novo', () => {
    const sc = classifyCodexScreen(SCREEN_EDIT);
    expect(sc).toMatchObject({ kind: 'approval', what: 'edit', alwaysKey: 'a' });
  });

  it('login, confiança na pasta e tela normal', () => {
    expect(classifyCodexScreen(SCREEN_LOGIN).kind).toBe('login');
    expect(classifyCodexScreen(SCREEN_TRUST).kind).toBe('trust');
    expect(classifyCodexScreen('› Ask Codex to do anything\n  GPT-6.1-Sol default · /x').kind).toBe('normal');
    // a pergunta aparecendo no histórico da conversa (sem as opções) não conta
    expect(classifyCodexScreen('Would you like to run the following command? (respondido)').kind).toBe('normal');
  });
});

// ------------------------------------------------------------------ travas e processos

const LOCKS = `1: POSIX  ADVISORY  READ 1733 00:3c:2007943 128 128
12: FLOCK  ADVISORY  WRITE 1896 00:3c:2015937 0 EOF
13: FLOCK  ADVISORY  WRITE 559 00:3c:2015942 0 EOF
13: -> FLOCK  ADVISORY  WRITE 777 00:3c:2015942 0 EOF
26: FLOCK  ADVISORY  READ 1733 00:3c:2007737 0 EOF`;

describe('travas abertas e processos', () => {
  it('parseProcLocks: só flocks de escrita (inode -> pid); bloqueados ("->") não substituem o dono', () => {
    const m = parseProcLocks(LOCKS);
    expect(m.get(2015937)).toBe(1896);
    expect(m.get(2015942)).toBe(777); // a última linha vence; o importante é haver um dono vivo
    expect(m.has(2007737)).toBe(false);
    expect(m.has(2007943)).toBe(false);
  });

  it('openThreads: .lock com dono vivo conta; sem dono (sobrou de um processo morto) não', () => {
    const tmp = tempDir();
    try {
      const lockDir = join(tmp.dir, 'thread-writer-locks');
      mkdirSync(lockDir, { recursive: true });
      const a = '01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef';
      const b = '01a13cf6-0e3c-7053-bd16-136a0ae57a99';
      writeFileSync(join(lockDir, `${a}.lock`), '');
      writeFileSync(join(lockDir, `${b}.lock`), '');
      writeFileSync(join(lockDir, '.coordination.lock'), '');
      const ino = statSync(join(lockDir, `${a}.lock`)).ino;
      const proc: ProcReader = { locks: () => `5: FLOCK  ADVISORY  WRITE 4242 00:3c:${ino} 0 EOF`, cmdline: () => undefined, ppid: () => undefined, cwd: () => undefined };
      expect(openThreads(tmp.dir, proc)).toEqual([{ threadId: a, holder: 4242 }]);
      // fora do Linux (sem /proc/locks): todo .lock presente conta, sem pid
      const noProc: ProcReader = { ...proc, locks: () => undefined };
      expect(openThreads(tmp.dir, noProc).map((t) => t.threadId).sort()).toEqual([a, b].sort());
    } finally {
      tmp.cleanup();
    }
  });

  it('agentPidOf sobe do binário nativo para o lançador node (pid do pane); daemon é reconhecido', () => {
    const cmd: Record<number, string> = {
      10: 'node /usr/local/bin/codex --no-daemon',
      11: '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex',
      20: '/home/dev/.codex/packages/app-server-daemon/releases/0.162.1/bin/codex app-server --listen unix://',
      30: 'bash',
      31: '/usr/bin/codex',
    };
    const proc: ProcReader = { locks: () => '', cmdline: (p) => cmd[p], ppid: (p) => ({ 11: 10, 31: 30 })[p], cwd: () => undefined };
    expect(agentPidOf(11, proc)).toBe(10);
    expect(agentPidOf(31, proc)).toBe(31);
    expect(isDaemonCmdline(cmd[20])).toBe(true);
    expect(isDaemonCmdline(cmd[11])).toBe(false);
    expect(isCodexCmdline(cmd[10])).toBe(true);
    expect(isCodexCmdline('vim codexmania.txt')).toBe(false);
  });

  it('UUIDv7 -> dia do rollout; findRollout acha o arquivo pelo id', () => {
    const id = '01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef';
    expect(new Date(uuidV7Time(id)!).toISOString()).toBe('2026-10-15T00:26:07.231Z');
    expect(uuidV7Time('12345678-1234-4234-8234-123456789012')).toBeUndefined();
    expect(candidateDayDirs('/s', id, 0)[0].replace(/\\/g, '/')).toBe('/s/2026/10/15');
    const tmp = tempDir();
    try {
      const day = join(tmp.dir, 'sessions', '2026', '10', '14');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, MULTI), readFileSync(join(FIX, MULTI)));
      expect(findRollout(tmp.dir, id, 0)).toBe(join(day, MULTI));
      expect(findRollout(tmp.dir, '01a13cf6-0e3c-7053-bd16-136a0ae57a99', 0, true)).toBeUndefined();
    } finally {
      tmp.cleanup();
    }
  });
});

// ------------------------------------------------------------------ conta, login e confiança

describe('conta OpenAI, login e pastas', () => {
  it('auth.json: ChatGPT (tokens) ou chave de API; vazio/sem arquivo = desconectado', async () => {
    expect(parseCodexAuth('{"auth_mode":"apikey","OPENAI_API_KEY":"sk-teste"}')).toEqual({ connected: true, how: 'apiKey' });
    expect(parseCodexAuth('{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"access_token":"a","refresh_token":"r"}}')).toEqual({ connected: true, how: 'chatgpt' });
    expect(parseCodexAuth('{"auth_mode":"apikey","OPENAI_API_KEY":""}')).toEqual({ connected: false });
    expect(parseCodexAuth('lixo')).toEqual({ connected: false });
    const tmp = tempDir();
    try {
      const dir = join(tmp.dir, '.codex');
      mkdirSync(dir);
      expect(await codexAuth([dir])).toEqual({ connected: false });
      writeFileSync(join(dir, 'auth.json'), '{"auth_mode":"apikey","OPENAI_API_KEY":"sk-x"}');
      expect(await codexAuth([dir])).toEqual({ connected: true, how: 'apiKey' });
      const [acc] = codexAccounts([dir], new Map([['.codex', 2]]));
      expect(acc).toMatchObject({ id: '.codex', name: 'Conta OpenAI', engine: 'codex', sessions: 2, plan: 'chave de API', usageStatus: 'disabled' });
      expect(JSON.stringify(acc)).not.toContain('sk-x');
    } finally {
      tmp.cleanup();
    }
  });

  it('discoverCodexDirs: ~/.codex, ~/.codex-*, CODEX_HOME; HABBLAUD_CODEX=0 desliga', () => {
    const tmp = tempDir();
    try {
      mkdirSync(join(tmp.dir, '.codex', 'sessions'), { recursive: true });
      mkdirSync(join(tmp.dir, '.codex-trabalho'), { recursive: true });
      writeFileSync(join(tmp.dir, '.codex-trabalho', 'config.toml'), '');
      mkdirSync(join(tmp.dir, '.codex-vazia'), { recursive: true });
      expect(discoverCodexDirs({}, tmp.dir).map((d) => d.slice(tmp.dir.length + 1))).toEqual(['.codex', '.codex-trabalho']);
      expect(discoverCodexDirs({ HABBLAUD_CODEX: '0' }, tmp.dir)).toEqual([]);
    } finally {
      tmp.cleanup();
    }
  });

  it('confiança na pasta no config.toml (sem duplicar, preservando o resto)', () => {
    const add = withCodexTrust('model = "gpt-6.1-sol"\n', '/home/dev/projetos/loja');
    expect(add).toBe('model = "gpt-6.1-sol"\n\n[projects."/home/dev/projetos/loja"]\ntrust_level = "trusted"\n');
    expect(withCodexTrust(add!, '/home/dev/projetos/loja')).toBeUndefined();
    const fixed = withCodexTrust('[projects."/a"]\ntrust_level = "untrusted"\n\n[tui]\nx = 1\n', '/a');
    expect(fixed).toBe('[projects."/a"]\ntrust_level = "trusted"\n\n[tui]\nx = 1\n');
    expect(withCodexTrust('', '/c/"x"')).toBe('[projects."/c/\\"x\\""]\ntrust_level = "trusted"\n');
    expect(() => withCodexTrust('', '/a\nb')).toThrow();
  });

  it('comando do pane do Codex (novo e retomar) e escolha da ferramenta', () => {
    expect(codexShellCommand()).toBe("bash -lc 'exec codex --no-daemon'");
    expect(codexShellCommand('01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef')).toBe("bash -lc 'exec codex resume --no-daemon 01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef'");
    expect(() => codexShellCommand("x'; rm -rf ~")).toThrow();
    expect(cleanEngine(undefined)).toBe('claude');
    expect(cleanEngine('codex')).toBe('codex');
    expect(() => cleanEngine('gemini')).toThrow();
  });
});

// ------------------------------------------------------------------ terminal da conversa

describe('terminal da conversa do Codex', () => {
  it('prompts, respostas, comandos com resultado, patch e interrupção', () => {
    const p = createCodexTerminalParser();
    const entries = lines(MULTI).flatMap((l) => p.push(l));
    const users = entries.filter((e) => e.kind === 'user').map((e) => (e as { text: string }).text);
    expect(users[0]).toBe('liste os arquivos do projeto');
    expect(users).not.toContain(expect.stringContaining('environment_context'));
    expect(entries.some((e) => e.kind === 'tool' && e.title === 'Bash(touch /etc/habblaud-teste)')).toBe(true);
    expect(entries.some((e) => e.kind === 'tool' && e.title === 'Edit(hello.txt)' && e.inputKind === 'diff')).toBe(true);
    const failed = entries.find((e) => e.kind === 'result' && e.error);
    expect(failed).toBeDefined();
    expect(entries.filter((e) => e.kind === 'assistant')).toHaveLength(5);
    const ab = createCodexTerminalParser();
    expect(lines(ABORT).flatMap((l) => ab.push(l)).some((e) => e.kind === 'system' && e.text === 'Interrompido por você')).toBe(true);
    expect(cleanToolOutput('Chunk ID: x\nWall time: 0\nProcess exited with code 2\nOutput:\nerro\n')).toEqual({ text: 'erro', exit: 2 });
  });

  it('parser automático: rollout do Codex vs transcript do Claude', () => {
    expect(isCodexLine(lines(MULTI)[0])).toBe(true);
    expect(isCodexLine('{"type":"user","message":{"role":"user","content":"oi"},"uuid":"u1","timestamp":"2026-10-15T00:00:00Z"}')).toBe(false);
    const auto = createAutoTerminalParser();
    expect(lines(MULTI).flatMap((l) => auto.push(l)).length).toBeGreaterThan(10);
  });
});

// ------------------------------------------------------------------ watcher no escritório

function newOffice(now: () => number) {
  return new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined, now });
}

/** Pasta do Codex de teste com uma trava aberta (dono = pid 4243, filho do lançador 4242). */
function codexHome(tmpDir: string, threadId: string) {
  const dir = join(tmpDir, '.codex');
  mkdirSync(join(dir, 'thread-writer-locks'), { recursive: true });
  writeFileSync(join(dir, 'thread-writer-locks', `${threadId}.lock`), '');
  const ino = statSync(join(dir, 'thread-writer-locks', `${threadId}.lock`)).ino;
  let open = true;
  const proc: ProcReader = {
    locks: () => (open ? `9: FLOCK  ADVISORY  WRITE 4243 00:3c:${ino} 0 EOF` : ''),
    cmdline: (p) => (p === 4242 ? 'node /usr/local/bin/codex --no-daemon' : p === 4243 ? '/x/@openai/codex-linux-x64/vendor/bin/codex' : undefined),
    ppid: (p) => (p === 4243 ? 4242 : undefined),
    cwd: (p) => (p === 4242 ? '/home/dev/projetos/loja' : undefined),
  };
  return { dir, proc, close: () => (open = false) };
}

describe('CodexWatcher no escritório', () => {
  const ID = '01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef';

  it('agente aparece na hora (antes do rollout), vira conversa com o rollout e sai quando a trava fecha', async () => {
    const tmp = tempDir();
    try {
      let t = Date.parse('2026-10-15T00:26:08Z');
      const office = newOffice(() => t);
      const home = codexHome(tmp.dir, ID);
      let screen = '› Ask Codex to do anything';
      const w = new CodexWatcher({ dirs: () => [home.dir], office, proc: home.proc, now: () => t, screen: async () => screen });
      w.poll(true);
      const a0 = office.get('.codex:4242');
      expect(a0).toMatchObject({ engine: 'codex', account: '.codex', status: 'idle', title: 'Codex pronto: mande a primeira mensagem' });
      expect(office.commit().snapshot.rooms.map((r) => r.path)).toContain('/home/dev/projetos/loja');
      // rollout aparece com a primeira mensagem (meio do turno de aprovação: linhas 0..25)
      const day = join(home.dir, 'sessions', '2026', '10', '15');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, MULTI), lines(MULTI).slice(0, 26).join('\n') + '\n');
      t += 2_000;
      w.poll();
      expect(w.transcriptPathOf('.codex:4242')).toBe(join(day, MULTI));
      expect(office.get('.codex:4242')?.title).toBe('liste os arquivos do projeto');
      expect(office.get('.codex:4242')?.status).toBe('working');
      // a tela mostra o pedido de aprovação: "precisa de você" + pedido respondível
      screen = SCREEN_CMD;
      await w.scanScreens();
      const a1 = office.get('.codex:4242');
      expect(a1?.status).toBe('waiting');
      expect(a1?.waitingFor).toBe('aprovar um comando do Codex');
      const [ap] = w.approvals();
      expect(ap.info).toMatchObject({ tool: 'Bash', title: 'Bash(touch /etc/habblaud-teste)', suggestions: [{ index: 0 }] });
      expect(ap.info.id).toMatch(/^codex-01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef-call_/);
      // aprovado: a tela volta ao normal e o resto do rollout chega
      screen = '› Ask Codex to do anything';
      await w.scanScreens();
      writeFileSync(join(day, MULTI), lines(MULTI).join('\n') + '\n');
      t += 2_000;
      w.poll();
      expect(office.get('.codex:4242')?.status).toBe('idle');
      expect(w.approvals()).toEqual([]);
      // trava fechada (Codex saiu): o agente encerra
      home.close();
      t += 2_000;
      w.poll();
      t += 2_000;
      w.poll();
      expect(office.get('.codex:4242')?.status).toBe('offline');
    } finally {
      tmp.cleanup();
    }
  });

  it('sem tela (fora do tmux): saída do sandbox pendente vira "precisa de você"', () => {
    const tmp = tempDir();
    try {
      let t = Date.parse('2026-10-15T00:26:41Z');
      const office = newOffice(() => t);
      const home = codexHome(tmp.dir, ID);
      const day = join(home.dir, 'sessions', '2026', '10', '15');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, MULTI), lines(MULTI).slice(0, 26).join('\n') + '\n');
      const w = new CodexWatcher({ dirs: () => [home.dir], office, proc: home.proc, now: () => t });
      w.poll(true);
      t += 3_000;
      w.poll();
      expect(office.get('.codex:4242')).toMatchObject({ status: 'waiting', waitingFor: 'aprovar um comando do Codex' });
    } finally {
      tmp.cleanup();
    }
  });

  it('responder pelo escritório: confere a tela de novo e manda a tecla certa', async () => {
    const sent: string[][] = [];
    const typed: string[] = [];
    const sc = classifyCodexScreen(SCREEN_CMD);
    if (sc.kind !== 'approval') throw new Error('x');
    let current: ReturnType<typeof classifyCodexScreen> | undefined = sc;
    const watcher = {
      approvals: () => [{ agentId: '.codex:4242', pid: 4242, screen: sc, info: { id: 'codex-a-1', tool: 'Bash', title: 'Bash(x)', text: 'x', icon: '💻', createdAt: 0, expiresAt: 1 } }],
      screenOf: async () => current,
      refresh: vi.fn(),
    };
    const deps = { watcher, sendKeys: async (_id: string, k: string[]) => void sent.push(k), sendText: async (_id: string, t: string) => void typed.push(t), sleep: async () => {} };
    expect(await decideCodex(deps, 'codex-a-1', { behavior: 'allow' })).toBe('ok');
    expect(await decideCodex(deps, 'codex-a-1', { behavior: 'allow', suggestion: 0 })).toBe('ok');
    expect(await decideCodex(deps, 'codex-a-1', { behavior: 'deny', message: 'use a pasta do projeto' })).toBe('ok');
    expect(sent).toEqual([['y'], ['p'], ['Escape']]);
    expect(typed).toEqual(['use a pasta do projeto']);
    expect(await decideCodex(deps, 'codex-a-1', { behavior: 'allow', suggestion: 3 })).toBe('invalid');
    expect(await decideCodex(deps, 'codex-outro', { behavior: 'allow' })).toBe('not-found');
    // respondido no terminal entre a leitura e o clique: nada é digitado
    current = { kind: 'normal' };
    expect(await decideCodex(deps, 'codex-a-1', { behavior: 'allow' })).toBe('not-found');
    expect(sent).toHaveLength(3);
  });
});

describe('rotas /api/permissions com pedidos do Codex', () => {
  it('ids reais (com "_") são do Codex; o resto segue para o registro do Claude', async () => {
    const { withCodexPermissions } = await import('./approvals');
    const http = await import('node:http');
    const sc = classifyCodexScreen(SCREEN_CMD);
    if (sc.kind !== 'approval') throw new Error('x');
    const id = 'codex-01a13d27-9de4-78e3-8a40-de3203218fcc-call_ksvjcjq4jg';
    const sent: string[][] = [];
    const watcher = {
      approvals: () => [{ agentId: '.codex:9', pid: 9, screen: sc, info: { id, tool: 'Bash', title: 'Bash(x)', text: 'x', icon: '💻', createdAt: 0, expiresAt: 1, input: '$ x' } }],
      screenOf: async () => sc,
      refresh: () => {},
    };
    let claude = 0;
    const handler = withCodexPermissions({ watcher, sendKeys: async (_i, k) => void sent.push(k) }, (_q, res) => {
      claude++;
      res.writeHead(404).end();
    });
    const server = http.createServer((req, res) => handler(req, res, new URL(req.url ?? '/', 'http://x').pathname));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      expect(await (await fetch(`${base}/api/permissions/${id}`)).json()).toMatchObject({ id, input: '$ x' });
      const r = await fetch(`${base}/api/permissions/${id}/decision`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"behavior":"allow"}' });
      expect(r.status).toBe(200);
      expect(sent).toEqual([['y']]);
      await fetch(`${base}/api/permissions/abc123`);
      expect(claude).toBe(1);
    } finally {
      server.close();
    }
  });

  it('opção "não perguntar de novo" em português', async () => {
    const { alwaysRuleText } = await import('./watcher');
    expect(alwaysRuleText('p', "Yes, and don't ask again for commands that start with `touch /etc/x`")).toBe('Não perguntar de novo para comandos que começam com `touch /etc/x`');
    expect(alwaysRuleText('a', 'x')).toBe('Não perguntar de novo para estes arquivos');
  });
});
