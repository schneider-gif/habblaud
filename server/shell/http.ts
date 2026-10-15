// Rotas do terminal embutido.
//   GET  /api/shell                    -> {available, reason?, tabs}
//   POST /api/shell/tabs               {login?, cols?, rows?} -> 201 {tab}   (aba nova: sessão tmux terminal-N)
//   POST /api/shell/tabs/:id/close     -> {ok}                              (fecha a aba: mata a sessão)
//   GET  /api/shell/ws?session=..&cols=..&rows=..   (upgrade WebSocket: o PTY anexado à sessão)
// Protocolo do WebSocket: o servidor manda a saída do PTY em quadros binários e avisos em texto JSON ({t:'exit'},
// {t:'error', message}); o navegador manda texto JSON: {t:'i', d:'teclas'}, {t:'r', c:colunas, r:linhas} e
// {t:'s', n:linhas} (roda do mouse: negativo sobe no histórico, pelo modo cópia do tmux).
//
// Trava (a mesma das mensagens para os agentes, mais estrita): recurso ligado (ServerConfig.shell + tmux/script
// presentes), demonstração desligada, Host aceito pelo guard E local (localhost/127.x ou HABBLAUD_LOCAL_HOSTS). No
// upgrade o guard HTTP não roda e WebSocket não tem CORS, então aqui o Origin é obrigatório e precisa ser exatamente
// a origem da página (http(s)://<Host>): sem isso qualquer site aberto no navegador conseguiria abrir um shell.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import { errMsg, log } from '../log';
import { hostAllowed, isLoopbackHost } from '../http/guard';
import { acceptWebSocket, rejectUpgrade } from '../http/ws';
import { AGENT_SESSION, cleanProgram, SHELL_SESSION, ShellError, type ShellService } from './service';

export const SHELL_WS_PATH = '/api/shell/ws';
const TAB_CLOSE = /^\/api\/shell\/tabs\/([^/]+)\/close$/;
/** Acima disto de saída esperando no socket, o PTY pausa (navegador lento / rede ruim). */
const HIGH_WATER = 1024 * 1024;

export interface ShellRoutesDeps {
  service?: ShellService;
  /** Por que está desligado agora (undefined = ligado). */
  offReason: () => string | undefined;
  isDemo: () => boolean;
  allowedHosts: ReadonlySet<string>;
  localHosts?: ReadonlySet<string>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

/** Origin do upgrade: obrigatório e igual a http(s)://<Host> (comparação exata, sem porta "parecida"). */
export function wsOriginOk(origin: string | undefined, host: string | undefined): boolean {
  if (!origin || !host) return false;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.host.toLowerCase() === host.trim().toLowerCase();
}

export function createShellRoutes(deps: ShellRoutesDeps) {
  const { sendJson } = deps;

  /** Motivo da recusa (status, texto) ou undefined. */
  const gate = (req: IncomingMessage): [number, string] | undefined => {
    const host = req.headers.host;
    if (!hostAllowed(host, deps.allowedHosts)) return [403, 'Host não permitido'];
    const off = deps.offReason();
    if (off || !deps.service) return [403, `terminal embutido desligado: ${off ?? 'indisponível'}`];
    if (deps.isDemo()) return [403, 'terminal embutido desligado durante a demonstração'];
    if (!isLoopbackHost(host, deps.localHosts)) return [403, 'o terminal embutido só abre pelo próprio computador (http://localhost ou http://127.0.0.1)'];
    return undefined;
  };

  const fail = (res: ServerResponse, err: unknown) => {
    if (err instanceof ShellError) sendJson(res, err.status, { error: err.message });
    else if ((err as { status?: number })?.status) sendJson(res, (err as { status: number }).status, { error: (err as Error).message });
    else sendJson(res, 502, { error: `o tmux não respondeu: ${errMsg(err)}` });
  };

  const api = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const path = url.pathname;
    if (path !== '/api/shell' && !path.startsWith('/api/shell/')) return false;
    const method = req.method ?? 'GET';
    if (path === '/api/shell' && (method === 'GET' || method === 'HEAD')) {
      const denied = gate(req);
      if (denied) return void sendJson(res, 200, { available: false, reason: denied[1], tabs: [] }), true;
      deps.service!.list().then(
        (tabs) => sendJson(res, 200, { available: true, tabs }),
        (err) => fail(res, err),
      );
      return true;
    }
    const denied = gate(req);
    if (denied) {
      req.resume();
      sendJson(res, denied[0], { error: denied[1] });
      return true;
    }
    const service = deps.service!;
    if (path === '/api/shell/tabs') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      deps
        .readJson(req)
        .then((body) => {
          const b = (body ?? {}) as { login?: unknown; program?: unknown; cols?: unknown; rows?: unknown };
          return service.create({ program: cleanProgram(b.program, b.login), cols: b.cols, rows: b.rows });
        })
        .then((tab) => sendJson(res, 201, { ok: true, tab }))
        .catch((err) => fail(res, err));
      return true;
    }
    const close = TAB_CLOSE.exec(path);
    if (close) {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        sendJson(res, 405, { error: 'método não permitido' });
        return true;
      }
      req.resume();
      let id: string;
      try {
        id = decodeURIComponent(close[1]);
      } catch {
        sendJson(res, 400, { error: 'aba inválida' });
        return true;
      }
      service.close(id).then(
        () => sendJson(res, 200, { ok: true }),
        (err) => fail(res, err),
      );
      return true;
    }
    req.resume();
    sendJson(res, 404, { error: 'rota desconhecida' });
    return true;
  };

  /** Trata o upgrade de SHELL_WS_PATH (devolve false para outros caminhos: o Vite do modo dev cuida dos dele). */
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): boolean => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      return false;
    }
    if (url.pathname !== SHELL_WS_PATH) return false;
    const denied = gate(req);
    if (denied) return rejectUpgrade(socket, denied[0], denied[1]), true;
    if (!wsOriginOk(typeof req.headers.origin === 'string' ? req.headers.origin : undefined, req.headers.host)) {
      rejectUpgrade(socket, 403, 'Origem não permitida');
      return true;
    }
    const session = url.searchParams.get('session') ?? '';
    if (!SHELL_SESSION.test(session) && !AGENT_SESSION.test(session)) {
      rejectUpgrade(socket, 400, 'sessão inválida');
      return true;
    }
    socket.on('error', () => undefined);
    // O PTY nasce antes do 101: sessão inexistente vira 404 em vez de um WebSocket que fecha na hora.
    deps.service!.attach(session, { cols: url.searchParams.get('cols'), rows: url.searchParams.get('rows') }).then(
      (pty) => {
        if (socket.destroyed) return pty.kill();
        const ws = acceptWebSocket(req, socket, head);
        if (!ws) return pty.kill();
        let paused = false;
        const drain = setInterval(() => {
          if (paused && ws.buffered < HIGH_WATER / 4) {
            paused = false;
            pty.resume();
          }
        }, 50);
        pty.onData((chunk) => {
          ws.sendBinary(chunk);
          if (!paused && ws.buffered > HIGH_WATER) {
            paused = true;
            pty.pause();
          }
        });
        pty.onExit((code) => {
          clearInterval(drain);
          if (!ws.closed) {
            ws.sendText(JSON.stringify({ t: 'exit', code }));
            ws.close(1000);
          }
        });
        ws.on('text', (text) => {
          let msg: { t?: unknown; d?: unknown; c?: unknown; r?: unknown; n?: unknown };
          try {
            msg = JSON.parse(text) as typeof msg;
          } catch {
            return;
          }
          if (msg.t === 'i' && typeof msg.d === 'string') pty.write(msg.d);
          else if (msg.t === 's') {
            const n = Number(msg.n);
            if (Number.isFinite(n) && n !== 0) void deps.service!.scroll(session, n).catch(() => undefined);
          } else if (msg.t === 'r') {
            const c = Number(msg.c);
            const r = Number(msg.r);
            if (Number.isFinite(c) && Number.isFinite(r)) pty.resize(Math.max(20, Math.min(500, c)), Math.max(5, Math.min(200, r)));
          }
        });
        ws.on('binary', (data) => pty.write(data));
        ws.on('close', () => {
          clearInterval(drain);
          // Fecha só o cliente tmux: a sessão (e o que roda nela) continua para a próxima visita.
          pty.kill();
        });
      },
      (err) => {
        if (err instanceof ShellError) rejectUpgrade(socket, err.status, err.message);
        else {
          log.warn(`Terminal embutido: falha ao anexar ${session}: ${errMsg(err)}`);
          rejectUpgrade(socket, 502, 'não foi possível abrir o terminal');
        }
      },
    );
    return true;
  };

  return { api, upgrade };
}

export type ShellRoutes = ReturnType<typeof createShellRoutes>;
