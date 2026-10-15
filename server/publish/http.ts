// Rotas /api/publish/* (Hospedagem Habblaude). Trava: a mesma das rotas que agem na máquina — só com bind local
// (ServerConfig.terminal) e Host local; Origin e Content-Type JSON dos POST já passam pelo guard (http/guard.ts).
//   GET    /api/publish/status                       -> PublishStatus (conectado? conta, pareamento)
//   POST   /api/publish/connect                      -> PublishPairing (abre a URL e espera; polling aqui no servidor)
//   POST   /api/publish/disconnect                   -> {ok}
//   GET    /api/publish/projects                     -> {dir, projects}
//   POST   /api/publish/detect      {path}           -> {projeto, deteccao, segredos}
//   POST   /api/publish/env-import  {path}           -> EnvImport
//   POST   /api/publish/account     {handle}         -> Conta              (portal: POST /conta)
//   POST   /api/publish/sites       {nome,tipo,config,handle?} -> 201 {site}
//   GET|PATCH|DELETE /api/publish/sites/:id
//   PUT    /api/publish/sites/:id/env {vars}
//   GET    /api/publish/sites/:id/logs?linhas=
//   POST   /api/publish/sites/:id/dominios {dominio} · POST .../dominios/:nome/verificar · DELETE .../dominios/:nome
//   POST   /api/publish/deploy      {siteId, path, requestId?} -> 202 {deploy, pacote}
//   GET    /api/publish/deploys/:id · GET /api/publish/deploys/:id/logs (SSE repassado do portal)
//   POST   /api/publish/requests    {path, siteId?, origem?} -> 201 {request}   (CLI do agente)
//   GET    /api/publish/requests[?wait=1&since=N]    -> {version, requests}     (long-poll do escritório)
//   GET    /api/publish/requests/:id · POST .../approve {siteId?} · POST .../reject
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { isLoopbackHost } from '../http/guard';
import { errMsg } from '../log';
import { PortalError } from './portal';
import { PublishError, PublishService } from './service';

export interface PublishRoutesDeps {
  service: PublishService;
  /** Recurso ligado (bind local: ServerConfig.terminal). */
  enabled: boolean;
  localHosts?: ReadonlySet<string>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

const SITE = /^\/api\/publish\/sites\/([^/]+)$/;
const SITE_ENV = /^\/api\/publish\/sites\/([^/]+)\/env$/;
const SITE_LOGS = /^\/api\/publish\/sites\/([^/]+)\/logs$/;
const SITE_DOMS = /^\/api\/publish\/sites\/([^/]+)\/dominios$/;
const SITE_DOM = /^\/api\/publish\/sites\/([^/]+)\/dominios\/([^/]+)$/;
const SITE_DOM_CHECK = /^\/api\/publish\/sites\/([^/]+)\/dominios\/([^/]+)\/verificar$/;
const DEPLOY = /^\/api\/publish\/deploys\/([^/]+)$/;
const DEPLOY_LOGS = /^\/api\/publish\/deploys\/([^/]+)\/logs$/;
const REQUEST = /^\/api\/publish\/requests\/([^/]+)$/;
const REQUEST_ACT = /^\/api\/publish\/requests\/([^/]+)\/(approve|reject)$/;

function dec(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new PublishError(400, 'identificador inválido');
  }
}

export function createPublishRoutes(deps: PublishRoutesDeps) {
  const { service, sendJson } = deps;

  const fail = (res: ServerResponse, err: unknown) => {
    if (res.headersSent) return void res.destroy();
    if (err instanceof PublishError) return sendJson(res, err.status, { error: err.message, code: err.code });
    if (err instanceof PortalError) {
      const body: Record<string, unknown> = { error: err.message, code: err.code };
      if (err.body?.motivo) body.motivo = err.body.motivo;
      return sendJson(res, err.status >= 400 && err.status < 600 ? err.status : 502, body);
    }
    const status = (err as { status?: number })?.status;
    if (typeof status === 'number') return sendJson(res, status, { error: errMsg(err) });
    sendJson(res, 500, { error: `erro ao publicar: ${errMsg(err)}`, code: 'internal' });
  };

  const json = (req: IncomingMessage) => deps.readJson(req).then((b) => (b && typeof b === 'object' ? b : {}) as Record<string, unknown>);

  /** Responde com o resultado de uma promessa (status fixo). */
  const reply = (res: ServerResponse, p: Promise<unknown>, status = 200) => {
    p.then((body) => sendJson(res, status, body)).catch((err) => fail(res, err));
  };

  const notAllowed = (req: IncomingMessage, res: ServerResponse, allow: string) => {
    req.resume();
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'método não permitido' });
  };

  /** Repassa o SSE de logs do deploy, fechando a conexão com o portal quando o navegador sai. */
  const proxyLogs = (req: IncomingMessage, res: ServerResponse, id: string) => {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    service
      .portal()
      .deployLogs(id, ac.signal)
      .then((upstream) => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', 'X-Content-Type-Options': 'nosniff' });
        res.flushHeaders?.();
        if (!upstream.body) return void res.end();
        const body = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream);
        body.on('error', () => res.end());
        body.pipe(res);
      })
      .catch((err) => {
        if (ac.signal.aborted) return void res.destroy();
        fail(res, err);
      });
  };

  const route = (req: IncomingMessage, res: ServerResponse, url: URL): void => {
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const get = method === 'GET' || method === 'HEAD';
    const portal = () => service.portal();
    let m: RegExpExecArray | null;

    switch (path) {
      case '/api/publish/status':
        return get ? reply(res, service.status()) : notAllowed(req, res, 'GET');
      case '/api/publish/connect':
        if (method !== 'POST') return notAllowed(req, res, 'POST');
        req.resume();
        return reply(res, service.connect());
      case '/api/publish/disconnect':
        if (method !== 'POST') return notAllowed(req, res, 'POST');
        req.resume();
        service.disconnect();
        return sendJson(res, 200, { ok: true });
      case '/api/publish/projects':
        return get ? reply(res, service.projects().then((projects) => ({ dir: service.projectsDir, projects }))) : notAllowed(req, res, 'GET');
      case '/api/publish/detect':
        return method === 'POST' ? reply(res, json(req).then((b) => service.detect(b.path))) : notAllowed(req, res, 'POST');
      case '/api/publish/env-import':
        return method === 'POST' ? reply(res, json(req).then((b) => service.envImport(b.path))) : notAllowed(req, res, 'POST');
      case '/api/publish/account':
        return method === 'POST'
          ? reply(
              res,
              json(req).then((b) => portal().setHandle(String(b.handle ?? ''))),
            )
          : notAllowed(req, res, 'POST');
      case '/api/publish/sites':
        if (method !== 'POST') return notAllowed(req, res, 'POST');
        return reply(
          res,
          json(req).then((b) => portal().criarSite(b as never).then((site) => ({ site }))),
          201,
        );
      case '/api/publish/deploy':
        if (method !== 'POST') return notAllowed(req, res, 'POST');
        return reply(
          res,
          json(req).then((b) => service.deploy(b.siteId, b.path, b.requestId)),
          202,
        );
      case '/api/publish/requests':
        if (method === 'POST')
          return reply(
            res,
            json(req).then((b) => service.createRequest(b).then((request) => ({ request }))),
            201,
          );
        if (!get) return notAllowed(req, res, 'GET, POST');
        {
          const since = Number(url.searchParams.get('since'));
          const wait = url.searchParams.get('wait') === '1' && Number.isFinite(since) ? service.waitRequests(since, 25_000) : Promise.resolve();
          return reply(res, wait.then(() => service.listRequests()));
        }
    }

    if ((m = SITE.exec(path))) {
      const id = dec(m[1]);
      if (get) return reply(res, portal().site(id));
      if (method === 'PATCH') return reply(res, json(req).then((b) => portal().patchSite(id, b as never).then((site) => ({ site }))));
      if (method === 'DELETE') {
        req.resume();
        return reply(res, portal().deleteSite(id).then(() => ({ ok: true })));
      }
      return notAllowed(req, res, 'GET, PATCH, DELETE');
    }
    if ((m = SITE_ENV.exec(path))) {
      const id = dec(m[1]);
      if (method !== 'PUT') return notAllowed(req, res, 'PUT');
      return reply(
        res,
        json(req).then((b) => {
          const vars = b.vars;
          if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw new PublishError(400, 'esperado {vars: {CHAVE: "valor"}}');
          return portal().putEnv(id, vars as Record<string, string>).then((envKeys) => ({ envKeys }));
        }),
      );
    }
    if ((m = SITE_LOGS.exec(path))) {
      if (!get) return notAllowed(req, res, 'GET');
      return reply(res, portal().siteLogs(dec(m[1]), Number(url.searchParams.get('linhas') ?? 200) || 200).then((logs) => ({ logs })));
    }
    if ((m = SITE_DOMS.exec(path))) {
      const id = dec(m[1]);
      if (method !== 'POST') return notAllowed(req, res, 'POST');
      return reply(
        res,
        json(req).then((b) => portal().addDominio(id, String(b.dominio ?? '')).then((dominio) => ({ dominio }))),
        201,
      );
    }
    if ((m = SITE_DOM_CHECK.exec(path))) {
      if (method !== 'POST') return notAllowed(req, res, 'POST');
      req.resume();
      return reply(res, portal().verificarDominio(dec(m[1]), dec(m[2])).then((dominio) => ({ dominio })));
    }
    if ((m = SITE_DOM.exec(path))) {
      if (method !== 'DELETE') return notAllowed(req, res, 'DELETE');
      req.resume();
      return reply(res, portal().removeDominio(dec(m[1]), dec(m[2])).then(() => ({ ok: true })));
    }
    if ((m = DEPLOY_LOGS.exec(path))) {
      if (!get) return notAllowed(req, res, 'GET');
      return proxyLogs(req, res, dec(m[1]));
    }
    if ((m = DEPLOY.exec(path))) {
      if (!get) return notAllowed(req, res, 'GET');
      return reply(res, portal().deploy(dec(m[1])));
    }
    if ((m = REQUEST_ACT.exec(path))) {
      if (method !== 'POST') return notAllowed(req, res, 'POST');
      const id = dec(m[1]);
      if (m[2] === 'reject') {
        req.resume();
        return reply(res, Promise.resolve().then(() => ({ request: service.rejectRequest(id) })));
      }
      return reply(res, json(req).then((b) => service.approveRequest(id, b.siteId).then((request) => ({ request }))));
    }
    if ((m = REQUEST.exec(path))) {
      if (!get) return notAllowed(req, res, 'GET');
      const r = service.getRequest(dec(m[1]));
      return r ? sendJson(res, 200, { request: r }) : sendJson(res, 404, { error: 'Pedido não encontrado.', code: 'not_found' });
    }
    req.resume();
    sendJson(res, 404, { error: 'rota desconhecida' });
  };

  /** Trata /api/publish/* (devolve false para o resto). */
  const api = (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const path = url.pathname;
    if (path !== '/api/publish' && !path.startsWith('/api/publish/')) return false;
    if (!deps.enabled) {
      req.resume();
      sendJson(res, 403, { error: 'Publicar está desligado: só funciona com o Habblaud acessível apenas pelo próprio computador.', code: 'disabled' });
      return true;
    }
    if (!isLoopbackHost(req.headers.host, deps.localHosts)) {
      req.resume();
      sendJson(res, 403, { error: 'Publicar só pelo próprio computador (http://localhost ou http://127.0.0.1).', code: 'forbidden' });
      return true;
    }
    try {
      route(req, res, url);
    } catch (err) {
      fail(res, err);
    }
    return true;
  };

  return { api };
}

/** Atalho para o server/index.ts: serviço + rotas numa linha. */
export function createPublishApi(opts: { home: string; enabled: boolean; sendJson: PublishRoutesDeps['sendJson']; readJson: PublishRoutesDeps['readJson'] }) {
  return createPublishRoutes({ ...opts, service: new PublishService({ home: opts.home }) }).api;
}
