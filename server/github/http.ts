// Rotas de /api/github (painel "GitHub" da barra superior). Mesma trava do terminal embutido: Host permitido, terminal
// embutido ligado (bind local, Linux, sem root, sem demonstração), Host local; HABBLAUD_GITHUB=0 desliga só isto.
// O guard (http/guard.ts) já exige JSON e Origin local nos POST (contra CSRF).
//
//   GET  /api/github/status          {installed, loggedIn, login?, name?} (?fresh=1 confere de novo)
//   GET  /api/github/repos           [{name, nameWithOwner, updatedAt, isPrivate, url}]  (gh repo list --limit 50)
//   GET  /api/github/prs             [{number, title, url, repo}]                       (gh search prs --author @me)
//   GET  /api/github/folders         [{name, git, remote?}]                             (pastas de ~/projetos)
//   POST /api/github/clone           {repo: "dono/nome"} -> 201 {dir, name}
//   POST /api/github/create          {folder, visibility?: "private"|"public", confirm: true} -> 201 {url, repo, dir}
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostAllowed, isLoopbackHost } from '../http/guard';
import { GithubError, type GithubService } from './service';

export interface GithubRoutesDeps {
  service?: GithubService;
  /** Por que está desligado agora (undefined = ligado). */
  offReason: () => string | undefined;
  allowedHosts: ReadonlySet<string>;
  localHosts?: ReadonlySet<string>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
  /** Avisa que um repositório foi criado/clonado (missão "Leve para o GitHub" confere de novo). */
  onChange?: () => void;
}

/** HABBLAUD_GITHUB com valor "desligado" (0, false, off...) desliga o painel. */
export function githubOffReason(env: NodeJS.ProcessEnv, shellOff: string | undefined): string | undefined {
  const flag = env.HABBLAUD_GITHUB?.trim();
  if (flag && /^(0|false|off|no|nao|não|desligado)$/i.test(flag)) return `HABBLAUD_GITHUB=${flag}`;
  return shellOff ? `o painel do GitHub usa o terminal embutido, que está desligado (${shellOff})` : undefined;
}

export function createGithubRoutes(deps: GithubRoutesDeps) {
  const { sendJson } = deps;
  const gate = (req: IncomingMessage): [number, string] | undefined => {
    const host = req.headers.host;
    if (!hostAllowed(host, deps.allowedHosts)) return [403, 'Host não permitido'];
    const off = deps.offReason();
    if (off || !deps.service) return [403, `GitHub desligado: ${off ?? 'indisponível'}`];
    if (!isLoopbackHost(host, deps.localHosts)) return [403, 'o painel do GitHub só abre pelo próprio computador (http://localhost ou http://127.0.0.1)'];
    return undefined;
  };
  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof GithubError) sendJson(res, err.status, { error: err.message });
    else sendJson(res, (err as { status?: number })?.status ?? 500, { error: err instanceof Error ? err.message : 'erro interno' });
  };

  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const path = url.pathname;
    if (path !== '/api/github' && !path.startsWith('/api/github/')) return false;
    const method = req.method ?? 'GET';
    const denied = gate(req);
    if (path === '/api/github/status' && method === 'GET' && denied) {
      sendJson(res, 200, { available: false, reason: denied[1], installed: false, loggedIn: false });
      return true;
    }
    if (denied) {
      req.resume();
      sendJson(res, denied[0], { error: denied[1] });
      return true;
    }
    const svc = deps.service!;
    const get = (fn: () => Promise<unknown>) => {
      if (method !== 'GET') {
        res.setHeader('Allow', 'GET');
        return sendJson(res, 405, { error: 'método não permitido' });
      }
      fn().then((body) => sendJson(res, 200, body), (err) => fail(res, err));
    };
    const post = (fn: (body: Record<string, unknown>) => Promise<unknown>) => {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { error: 'método não permitido' });
      }
      deps
        .readJson(req)
        .then((b) => fn((b ?? {}) as Record<string, unknown>))
        .then((body) => {
          deps.onChange?.();
          sendJson(res, 201, { ok: true, ...(body as object) });
        })
        .catch((err) => fail(res, err));
    };
    switch (path) {
      case '/api/github/status':
        get(async () => ({ available: true, ...(await svc.status(url.searchParams.get('fresh') === '1')) }));
        return true;
      case '/api/github/repos':
        get(async () => ({ repos: await svc.repos() }));
        return true;
      case '/api/github/prs':
        get(async () => ({ prs: await svc.prs() }));
        return true;
      case '/api/github/folders':
        get(async () => ({ folders: await svc.folders() }));
        return true;
      case '/api/github/clone':
        post((b) => svc.clone(b.repo));
        return true;
      case '/api/github/create':
        post((b) => svc.create(b));
        return true;
      default:
        sendJson(res, 404, { error: 'rota desconhecida' });
        return true;
    }
  };
}
