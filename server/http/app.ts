// Rotas da API (/api/*). Respostas JSON; rotas desconhecidas -> 404 JSON.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentInfo, ModSummary, OfficeSnapshot, SourceInfo, UpdateStatus } from '../../shared/types';
import type { AccountsService } from '../accounts/service';
import type { DayStatsService } from '../history/daystats';
import type { Office } from '../model/office';
import type { SessionHistory } from '../sources/history';
import { isJsonContentType, isLoopbackHost } from './guard';
import { type AgentInput, InputError } from '../input/tmux';
import { cleanProfile, ProfileError } from '../../shared/profile';
import { type StateStore, StateError } from '../model/state';
import { handleSessionsRoute } from './sessions';
import type { Hub } from './sse';
import { handleStatsRoute } from './stats';
import type { TerminalStreams } from './terminal';

export interface ApiDeps {
  office: Office;
  hub: Hub;
  accounts: AccountsService;
  sources: () => SourceInfo[];
  version: string;
  inDocker: boolean;
  /** Terminal somente leitura ligado (ServerConfig.terminal: só com bind local). */
  terminal?: boolean;
  /** Streams do terminal; sem eles o recurso fica desligado mesmo com `terminal`. */
  terminals?: TerminalStreams;
  /** Histórico de sessões do terminal (GET /api/sessions/*, http/sessions.ts); mesma trava do terminal. */
  sessions?: SessionHistory;
  /** Rotas do timelapse (/api/timeline/*, ver http/timeline.ts); devolve false para o resto. */
  timeline?: (req: IncomingMessage, res: ServerResponse, url: URL) => boolean;
  /**
   * Rotas de /api/permissions (responder pelo escritório, server/permissions/http.ts). Só existem com bind
   * local (ServerConfig.terminal); a trava do Host local é conferida aqui antes de chamá-las.
   */
  permissions?: (req: IncomingMessage, res: ServerResponse, path: string) => void;
  /**
   * Mandar mensagens e abrir agentes pelo escritório (server/input/tmux.ts). Mesma trava do terminal: só com bind
   * local e Host local; sem isto as rotas respondem 403.
   */
  input?: AgentInput;
  /** Vida social salva no servidor (GET/PUT /api/state). */
  state?: StateStore;
  /** Estatísticas do "Meu dia" (GET /api/stats, http/stats.ts). */
  stats?: DayStatsService;
  /** Verificação de versão nova no GitHub (GET /api/updates, POST /api/updates/check; updates/checker.ts). */
  updates?: {
    status(): UpdateStatus;
    check(opts: { manual?: boolean }): Promise<UpdateStatus>;
  };
}

/** GET (disponível?) e POST {text} /api/agents/:id/input. */
const INPUT_ROUTE = /^\/api\/agents\/([^/]+)\/input$/;
/** POST {name?, appearance?} /api/agents/:id/profile: nome e boneco escolhidos no escritório. */
const PROFILE_ROUTE = /^\/api\/agents\/([^/]+)\/profile$/;
/** Conta do Claude aberto pelo escritório (CLAUDE_CONFIG_DIR padrão: ~/.claude). */
const SPAWN_ACCOUNT = '.claude';
/** POST {cwd?, name?, appearance?} /api/agents/new: abre um agente novo no tmux. */
const NEW_AGENT_ROUTE = '/api/agents/new';
/** GET /api/agents/:id/terminal (ids nunca contêm '/'). */
const TERMINAL_ROUTE = /^\/api\/agents\/([^/]+)\/terminal$/;

const MAX_BODY = 256 * 1024;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    // A API só é lida pela própria página: nada de leitura "no-cors" por outras origens.
    'Cross-Origin-Resource-Policy': 'same-origin',
  });
  res.end(data);
}

/** Lê o corpo JSON. Exige `Content-Type: application/json` (barreira contra CSRF; ver http/guard.ts). */
export function readJson(req: IncomingMessage): Promise<unknown> {
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    return Promise.reject(new HttpError(415, 'envie o corpo como JSON (Content-Type: application/json)'));
  }
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      // Grande demais: continua drenando (sem guardar) para conseguir responder 413.
      if (size > MAX_BODY) return void fail(new HttpError(413, 'corpo grande demais'));
      chunks.push(c);
    });
    req.on('end', () => {
      if (size > MAX_BODY) return;
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return ok({});
      try {
        ok(JSON.parse(raw));
      } catch {
        fail(new HttpError(400, 'JSON inválido'));
      }
    });
    req.on('error', fail);
  });
}

/** Resumo da verificação de versão nova para o /api/health. */
function updatesSummary(s: UpdateStatus | undefined): { state: UpdateStatus['state']; latest?: string; available: boolean } {
  return s ? { state: s.state, latest: s.latest, available: s.available } : { state: 'off', available: false };
}

/** Subagentes aninhados mais fundo que isto não existem na prática; o limite só evita laço num parentId torto. */
const MAX_PARENT_HOPS = 16;

/**
 * Resumo para o mod do Claude Code (GET /api/mod/summary, ver ModSummary). `isReal` diz quem é agente de
 * verdade: os do demo vivem só no snapshot (não no Office), então `office.has(id)` os separa sem depender
 * do prefixo "demo:". A própria sessão sai quando vem `session` (e, se vier, `account` também precisa
 * bater): o principal tem o sessionId atual da sessão (troca no /clear) e os subagentes guardam o da
 * sessão que os disparou; por garantia, um subagente também sai quando algum ancestral (parentId) é dela.
 */
export function modSummary(
  snap: OfficeSnapshot,
  isReal: (id: string) => boolean,
  version: string,
  own: { account?: string; session?: string } = {},
): ModSummary {
  const byId = new Map(snap.agents.map((a) => [a.id, a]));
  const rooms = new Map(snap.rooms.map((r) => [r.id, r.name]));
  const isOwn = (a: AgentInfo): boolean => {
    if (!own.session || (own.account && a.account !== own.account)) return false;
    let cur: AgentInfo | undefined = a;
    for (let hops = 0; cur && hops <= MAX_PARENT_HOPS; hops++) {
      if (cur.sessionId === own.session) return true;
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return false;
  };
  const present = snap.agents.filter((a) => isReal(a.id) && a.status !== 'offline' && a.status !== 'done' && !isOwn(a));
  const waiting = present
    .filter((a) => a.status === 'waiting')
    .sort((a, b) => a.statusSince - b.statusSince || a.id.localeCompare(b.id))
    .map((a) => ({
      id: a.id,
      name: a.name,
      room: rooms.get(a.roomId) ?? a.roomId,
      account: a.account,
      waitingFor: a.waitingFor ?? 'responder no terminal',
      since: a.statusSince,
      answerable: !!a.permission,
    }));
  return { version, agents: present.length, working: present.filter((a) => a.status === 'working').length, waiting };
}

/** Devolve um handler que trata /api/* e responde false para o resto. */
export function createApiHandler(deps: ApiDeps): (req: IncomingMessage, res: ServerResponse, url: URL) => boolean {
  const { office, hub, accounts } = deps;
  const terminals = deps.terminal ? deps.terminals : undefined;

  const methodNotAllowed = (res: ServerResponse, allow: string) => {
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'método não permitido' });
  };

  const handleDemo = async (req: IncomingMessage, res: ServerResponse) => {
    const body = (await readJson(req)) as { enabled?: unknown };
    if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'esperado {enabled: boolean}');
    if (body.enabled && hub.current().meta.demoLocked) throw new HttpError(403, 'demonstração desligada neste escritório');
    office.setDemo(body.enabled);
    sendJson(res, 200, { ok: true, demo: office.isDemo() });
  };

  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 500, { error: 'erro interno' });
  };

  const failInput = (res: ServerResponse, err: unknown) => {
    if (err instanceof InputError) sendJson(res, err.status, { error: err.message });
    else if (err instanceof ProfileError) sendJson(res, 400, { error: err.message });
    else if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, 502, { error: 'o tmux não respondeu: o agente ainda está aberto?' });
  };

  return (req, res, url) => {
    const path = url.pathname;
    if (path !== '/api' && !path.startsWith('/api/')) return false;
    const method = req.method ?? 'GET';
    const isRead = method === 'GET' || method === 'HEAD';

    if (path === '/api/stream') {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else hub.attach(req, res);
      return true;
    }
    if (path === '/api/snapshot') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, hub.current());
      return true;
    }
    if (path === '/api/health') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        sendJson(res, 200, {
          ok: true,
          version: deps.version,
          demo: office.isDemo(),
          docker: deps.inDocker,
          terminal: !!terminals,
          permissions: !!deps.permissions,
          updates: updatesSummary(deps.updates?.status()),
          sources: deps.sources(),
          accounts: accounts.entries().map((a) => ({ id: a.id, usageStatus: accounts.usageView(a.id).status })),
        });
      }
      return true;
    }
    if (path === '/api/mod/summary') {
      // Lido a cada 5 s por sessão com o mod: só contagens e quem espera (nada que o snapshot já não mostre).
      if (!isRead) methodNotAllowed(res, 'GET');
      else {
        const own = { account: url.searchParams.get('account') || undefined, session: url.searchParams.get('session') || undefined };
        sendJson(res, 200, modSummary(hub.current(), (id) => office.has(id), deps.version, own));
      }
      return true;
    }
    const inputMatch = INPUT_ROUTE.exec(path);
    if (inputMatch || path === NEW_AGENT_ROUTE) {
      const input = deps.terminal ? deps.input : undefined;
      if (!input) {
        sendJson(res, 403, { error: 'enviar mensagens pelo escritório desligado: só funciona com o Habblaud acessível apenas pelo próprio computador' });
      } else if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'mensagens só são enviadas pelo próprio computador (http://localhost ou http://127.0.0.1)' });
      } else if (!inputMatch) {
        if (isRead) input.folders().then((folders) => sendJson(res, 200, { available: true, folders }), (err) => fail(res, err));
        else if (method !== 'POST') methodNotAllowed(res, 'GET, POST');
        else
          readJson(req)
            .then(async (body) => {
              const profile = cleanProfile(body ?? {});
              const r = await input.spawn((body as { cwd?: unknown } | undefined)?.cwd);
              if (r.pid && (profile.name || profile.appearance)) office.setPendingProfile(`${SPAWN_ACCOUNT}:${r.pid}`, profile);
              return r;
            })
            .then((r) => sendJson(res, 201, { ok: true, ...r }))
            .catch((err) => failInput(res, err));
      } else {
        let id: string;
        try {
          id = decodeURIComponent(inputMatch[1]);
        } catch {
          sendJson(res, 400, { error: 'id inválido' });
          return true;
        }
        if (isRead) input.available(id).then((available) => sendJson(res, 200, { available }), (err) => fail(res, err));
        else if (method !== 'POST') methodNotAllowed(res, 'GET, POST');
        else
          readJson(req)
            .then((body) => input.send(id, (body as { text?: unknown } | undefined)?.text))
            .then(() => sendJson(res, 200, { ok: true }))
            .catch((err) => failInput(res, err));
      }
      return true;
    }
    if (path === '/api/state') {
      const state = deps.state;
      if (!state) sendJson(res, 404, { error: 'estado no servidor desligado' });
      else if (isRead) sendJson(res, 200, state.all());
      else if (method !== 'PUT') methodNotAllowed(res, 'GET, PUT');
      else
        readJson(req)
          .then((body) => {
            const b = (body ?? {}) as { key?: unknown; value?: unknown };
            state.set(b.key, b.value);
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => (err instanceof StateError ? sendJson(res, 400, { error: err.message }) : fail(res, err)));
      return true;
    }
    const profileMatch = PROFILE_ROUTE.exec(path);
    if (profileMatch) {
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else if (!deps.terminal || !isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'personalizar agentes só funciona pelo próprio escritório' });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(profileMatch[1]);
        } catch {
          sendJson(res, 400, { error: 'id inválido' });
          return true;
        }
        readJson(req)
          .then((body) => {
            const profile = cleanProfile(body);
            if (!office.setProfile(id, profile)) throw new HttpError(404, 'agente não encontrado (só agentes principais presentes)');
            sendJson(res, 200, { ok: true });
          })
          .catch((err) => failInput(res, err));
      }
      return true;
    }
    const terminalMatch = TERMINAL_ROUTE.exec(path);
    if (terminalMatch) {
      if (method !== 'GET') methodNotAllowed(res, 'GET');
      else if (!terminals) {
        sendJson(res, 403, { error: 'terminal somente leitura desligado: ele só funciona com o Habblaud acessível apenas pelo próprio computador' });
      } else if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'o terminal somente leitura só abre pelo próprio computador (http://localhost ou http://127.0.0.1)' });
      } else {
        let id: string;
        try {
          id = decodeURIComponent(terminalMatch[1]);
        } catch {
          sendJson(res, 400, { error: 'id inválido' });
          return true;
        }
        terminals.attach(req, res, id);
      }
      return true;
    }
    if (path.startsWith('/api/sessions/')) {
      handleSessionsRoute(req, res, path, { history: deps.terminal ? deps.sessions : undefined, terminals });
      return true;
    }
    if (path === '/api/permissions' || path.startsWith('/api/permissions/')) {
      // Responder pelo escritório age sobre as sessões: a mesma trava do terminal (bind local + Host local).
      if (!deps.permissions) {
        sendJson(res, 403, { error: 'responder pelo escritório desligado: só funciona com o Habblaud acessível apenas pelo próprio computador' });
      } else if (!isLoopbackHost(req.headers.host)) {
        sendJson(res, 403, { error: 'pedidos de permissão só são respondidos pelo próprio computador (http://localhost ou http://127.0.0.1)' });
      } else {
        deps.permissions(req, res, path);
      }
      return true;
    }
    if (path.startsWith('/api/agents/')) {
      if (!isRead) {
        methodNotAllowed(res, 'GET');
        return true;
      }
      let id: string;
      try {
        id = decodeURIComponent(path.slice('/api/agents/'.length));
      } catch {
        sendJson(res, 400, { error: 'id inválido' });
        return true;
      }
      const detail = office.detail(id);
      if (detail) sendJson(res, 200, detail);
      else sendJson(res, 404, { error: 'agente não encontrado' });
      return true;
    }
    if (path === '/api/stats' || path.startsWith('/api/stats/')) {
      handleStatsRoute(req, res, url, deps.stats, sendJson);
      return true;
    }
    if (path === '/api/demo') {
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else handleDemo(req, res).catch((err) => fail(res, err));
      return true;
    }
    if (path === '/api/updates') {
      if (!isRead) methodNotAllowed(res, 'GET');
      else sendJson(res, 200, { version: deps.version, ...(deps.updates?.status() ?? { state: 'off', available: false }) });
      return true;
    }
    if (path === '/api/updates/check') {
      // "Verificar agora": consulta o GitHub (no máximo uma vez a cada 30 s) e devolve o status novo.
      if (method !== 'POST') methodNotAllowed(res, 'POST');
      else {
        req.resume();
        const updates = deps.updates;
        if (!updates) sendJson(res, 200, { version: deps.version, state: 'off', available: false });
        else
          updates
            .check({ manual: true })
            .then((status) => sendJson(res, 200, { version: deps.version, ...status }))
            .catch((err) => fail(res, err));
      }
      return true;
    }
    if (deps.timeline?.(req, res, url)) return true;
    sendJson(res, 404, { error: 'rota desconhecida' });
    return true;
  };
}
