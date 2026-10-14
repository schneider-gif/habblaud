// Detectores das missões (puros): recebem fatos já coletados (fins de turno e mensagens vistos no escritório,
// arquivos da pasta do projeto, git) e dizem se a missão terminou e quais passos faltam. A coleta com I/O
// fica em probe.ts; quem junta tudo e chama a cada 30 s é engine.ts.
import type { MissionId, MissionStep } from '../../shared/missions';
import type { AgentStatus, OfficeSnapshot } from '../../shared/types';

/** Um agente principal terminou um turno numa pasta. */
export interface TurnEnd {
  agentId: string;
  dir: string;
  at: number;
}

/** Mensagem mandada pelo escritório (POST /api/agents/:id/input) a um agente que estava numa pasta. */
export interface SentMessage {
  agentId: string;
  dir: string;
  at: number;
}

export interface Facts {
  /** Pasta do projeto da missão. */
  dir: string;
  /** Quando a missão foi começada: nada antes disso conta. */
  startedAt: number;
  turns: readonly TurnEnd[];
  messages: readonly SentMessage[];
  exists: boolean;
  /** index.html (ou build/dist/public). */
  index: boolean;
  /** Página ou script com <canvas> / getContext. */
  canvas: boolean;
  /** Servidor com rotas (dependência ou código). */
  api: boolean;
  /** Banco de dados (dependência, schema ou arquivo .db/.sqlite). */
  db: boolean;
  /** Algum projeto de ~/projetos com remoto do GitHub (e push feito). */
  github?: { remote: boolean; pushed: boolean; project?: string };
  /** Credencial do Claude Code encontrada nesta máquina (auth.ts). */
  auth?: boolean;
  /** Portas TCP escutando por processos com a pasta dentro do projeto (Linux, /proc). Só informação. */
  ports?: readonly number[];
}

export interface Detection {
  done: boolean;
  steps: MissionStep[];
  info?: string;
}

export function emptyFacts(dir: string, startedAt: number): Facts {
  return { dir, startedAt, turns: [], messages: [], exists: false, index: false, canvas: false, api: false, db: false };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

/** `path` é `dir` ou fica dentro dele (comparação por segmentos: "meu-site-2" não está em "meu-site"). */
export function inside(path: string, dir: string): boolean {
  const p = norm(path);
  const d = norm(dir);
  return p === d || p.startsWith(`${d}/`);
}

/** Estados que encerram um turno de quem estava trabalhando. */
const TURN_OVER: ReadonlySet<AgentStatus> = new Set(['idle', 'shell', 'done']);

/**
 * Fins de turno entre dois snapshots: agente principal (fora do demo) que estava `working` e passou a
 * idle/shell/done. Devolve também os status atuais, para a próxima comparação.
 */
export function turnEnds(prev: ReadonlyMap<string, AgentStatus>, snap: OfficeSnapshot, at: number): { ends: TurnEnd[]; next: Map<string, AgentStatus> } {
  const rooms = new Map(snap.rooms.map((r) => [r.id, r.path]));
  const next = new Map<string, AgentStatus>();
  const ends: TurnEnd[] = [];
  for (const a of snap.agents) {
    if (a.kind !== 'main' || a.id.startsWith('demo:')) continue;
    next.set(a.id, a.status);
    if (prev.get(a.id) === 'working' && TURN_OVER.has(a.status)) ends.push({ agentId: a.id, dir: rooms.get(a.roomId) ?? a.roomId, at });
  }
  return { ends, next };
}

function turnIn(f: Facts): boolean {
  return f.turns.some((t) => t.at >= f.startedAt && inside(t.dir, f.dir));
}

const slug = (dir: string) => norm(dir).split('/').pop() ?? dir;

export function detect(id: MissionId, f: Facts): Detection {
  const where = `~/projetos/${slug(f.dir)}`;
  const finish = (steps: MissionStep[], info?: string): Detection => ({ done: steps.every((s) => s.ok), steps, ...(info ? { info } : {}) });
  switch (id) {
    case 'conta-claude': {
      // Credencial nos arquivos/variáveis do Claude Code, ou um agente que já terminou um turno (login no Keychain).
      const worked = f.turns.some((t) => t.at >= f.startedAt);
      return finish(
        [{ label: 'Login feito no Claude Code (conta Pro/Max ou chave de API)', ok: !!f.auth || worked }],
        worked && !f.auth ? 'Um agente já trabalhou aqui: a conta está conectada.' : undefined,
      );
    }
    case 'primeiro-site':
      return finish([
        { label: `Pasta ${where} criada`, ok: f.exists },
        { label: 'Um agente trabalhou nela e entregou', ok: turnIn(f) },
        { label: 'Página pronta (index.html)', ok: f.index },
      ]);
    case 'peca-melhoria': {
      const sent = f.messages.filter((m) => m.at >= f.startedAt && inside(m.dir, f.dir));
      const answered = sent.some((m) => f.turns.some((t) => t.agentId === m.agentId && t.at > m.at));
      return finish([
        { label: `Mensagem pelo escritório a um agente de ${where}`, ok: sent.length > 0 },
        { label: 'O agente terminou a mudança', ok: answered },
      ]);
    }
    case 'jogo-pixel':
      return finish([
        { label: `Pasta ${where} criada`, ok: f.exists },
        { label: 'Um agente trabalhou nela e entregou', ok: turnIn(f) },
        { label: 'Jogo desenhado num <canvas>', ok: f.canvas },
      ]);
    case 'leve-github':
      return finish(
        [
          { label: 'Um projeto ligado a um repositório do GitHub', ok: !!f.github?.remote },
          { label: 'Código enviado (push)', ok: !!f.github?.pushed },
        ],
        f.github?.pushed && f.github.project ? `Enviado: ~/projetos/${f.github.project}.` : undefined,
      );
    case 'api-banco':
      return finish(
        [
          { label: `Pasta ${where} criada`, ok: f.exists },
          { label: 'Um agente trabalhou nela e entregou', ok: turnIn(f) },
          { label: 'Servidor com rotas', ok: f.api },
          { label: 'Dados guardados num banco', ok: f.db },
        ],
        f.ports?.length ? `Servidor no ar na porta ${f.ports.join(', ')}.` : undefined,
      );
  }
}
