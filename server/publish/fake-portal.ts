// Portal FALSO, em memória, que implementa o contrato de publicação (para testes, prints e desenvolvimento local).
//   npx tsx server/publish/fake-portal.ts [--port 8787] [--auto] [--inativo sem_complemento] [--sem-handle]
// Depois rode o Habblaud com HB_PORTAL_URL=http://127.0.0.1:8787.
// Pareamento: abra a URL mostrada pelo wizard (página com "Confirmar") ou use --auto (confirma no 2º polling).
// Domínio próprio: a 1ª verificação fica "pendente"; da 2ª em diante, "ok".
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import type { Conta, DeployView, DominioView, MotivoInativo, PlanoView, SiteConfig, SiteView, Tipo } from '../../shared/publish';

export interface FakePortalOptions {
  port?: number;
  host?: string;
  /** Confirma o pareamento sozinho no 2º polling. */
  autoConfirm?: boolean;
  ativo?: boolean;
  motivo?: MotivoInativo;
  handle?: string | null;
  plano?: PlanoView;
  /** Intervalo entre as etapas do build simulado (ms). */
  stepMs?: number;
  /** Deploys falham (para testar o erro). */
  failDeploys?: boolean;
  log?: boolean;
}

interface Pairing {
  code: string;
  confirmed: boolean;
  polls: number;
  expiresAt: number;
  token?: string;
  delivered: boolean;
}

interface FakeDeploy extends DeployView {
  siteId: string;
  linhas: string[];
  body?: Buffer;
}

interface FakeSite extends SiteView {
  env: Record<string, string>;
  checks: Record<string, number>;
}

export const VITRINE: PlanoView = { id: 'vitrine', nome: 'Vitrine', maxSites: 1, memoriaMB: 512, cpus: 0.5, maxDominios: 1, maxUploadMB: 50 };

export interface FakePortal {
  url: string;
  state: {
    pairings: Map<string, Pairing>;
    tokens: Set<string>;
    sites: Map<string, FakeSite>;
    deploys: Map<string, FakeDeploy>;
    conta: { handle: string | null; ativo: boolean; motivo?: MotivoInativo; plano: PlanoView };
  };
  confirm(code: string): void;
  close(): Promise<void>;
}

const now = () => new Date().toISOString();
const id = (p: string) => `${p}_${randomBytes(6).toString('hex')}`;

export async function startFakePortal(opts: FakePortalOptions = {}): Promise<FakePortal> {
  const stepMs = opts.stepMs ?? 400;
  const state: FakePortal['state'] = {
    pairings: new Map(),
    tokens: new Set(),
    sites: new Map(),
    deploys: new Map(),
    conta: { handle: opts.handle === undefined ? null : opts.handle, ativo: opts.ativo ?? true, motivo: opts.motivo, plano: opts.plano ?? VITRINE },
  };
  let base = '';
  const listeners = new Map<string, Set<() => void>>();
  const notify = (deployId: string) => listeners.get(deployId)?.forEach((fn) => fn());

  const confirm = (code: string) => {
    const p = state.pairings.get(code);
    if (p && !p.confirmed) {
      p.confirmed = true;
      p.token = `hbp_${randomBytes(32).toString('base64url')}`;
      state.tokens.add(p.token);
    }
  };

  const contaView = (): Conta => ({
    handle: state.conta.handle,
    handleSugerido: 'fulano',
    dominioBase: 'habblaude.app',
    ativo: state.conta.ativo,
    motivo: state.conta.ativo ? undefined : (state.conta.motivo ?? 'sem_complemento'),
    plano: state.conta.ativo ? state.conta.plano : null,
    sites: [...state.sites.values()].filter((s) => s.status !== 'removido').map(view),
    contratarUrl: `${base}/escritorio/publicar`,
    ipServidor: '203.0.113.10',
  });

  const view = (s: FakeSite): SiteView => {
    const { env: _e, checks: _c, ...rest } = s;
    const own = s.dominios.find((d) => d.status === 'ok');
    return { ...rest, url: own ? `https://${own.nome}` : `https://${s.subdominio}`, envKeys: Object.keys(s.env).sort() };
  };
  const deployView = (d: FakeDeploy): DeployView => ({ id: d.id, status: d.status, erro: d.erro, criadoEm: d.criadoEm, terminouEm: d.terminouEm, tamanho: d.tamanho });

  const runDeploy = (d: FakeDeploy) => {
    const site = state.sites.get(d.siteId)!;
    const steps: [string[], FakeDeploy['status']?][] = [
      [['Recebido o pacote do projeto.', `Tamanho: ${Math.round((d.tamanho ?? 0) / 1024)} KB.`], 'building'],
      [[`Gerando o Dockerfile (${site.tipo}).`, 'Step 1/6 : FROM alpine AS hbsrc']],
      [['Instalando dependências…', site.config.install ? `$ ${site.config.install}` : '(padrão do tipo)']],
      [[site.config.build ? `$ ${site.config.build}` : 'Sem etapa de build.', 'Build concluído.']],
      [['Subindo o app…', `Escutando na porta ${site.config.porta}.`]],
    ];
    let i = 0;
    const tick = () => {
      if (d.status === 'canceled') return;
      if (i < steps.length) {
        const [lines, status] = steps[i++];
        d.linhas.push(...lines);
        if (status) d.status = status;
        notify(d.id);
        setTimeout(tick, stepMs).unref();
        return;
      }
      if (opts.failDeploys) {
        d.status = 'failed';
        d.erro = 'O build falhou: o comando de build saiu com código 1.';
        d.linhas.push('npm ERR! code 1');
        site.status = 'falhou';
      } else {
        d.status = 'ok';
        d.linhas.push('Publicado!');
        site.status = 'no_ar';
      }
      d.terminouEm = now();
      site.ultimoDeploy = deployView(d);
      notify(d.id);
    };
    setTimeout(tick, stepMs).unref();
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(data) });
    res.end(data);
  };
  const err = (res: http.ServerResponse, status: number, code: string, error: string, extra: Record<string, unknown> = {}) => send(res, status, { error, code, ...extra });
  const readBody = (req: http.IncomingMessage, limit: number): Promise<Buffer> =>
    new Promise((ok, fail) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= limit) chunks.push(c);
      });
      req.on('end', () => (size > limit ? fail(new Error('too_large')) : ok(Buffer.concat(chunks))));
      req.on('error', fail);
    });
  const readJson = async (req: http.IncomingMessage): Promise<Record<string, unknown>> => {
    const b = await readBody(req, 1024 * 1024);
    try {
      return b.length ? (JSON.parse(b.toString('utf8')) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const path = url.pathname;
    const method = req.method ?? 'GET';
    if (opts.log) console.log(`[portal falso] ${method} ${path}`);
    try {
      // Página de confirmação do pareamento (a "tela do portal" que o cliente abre logado).
      if (path === '/escritorio/publicar/conectar') {
        const code = url.searchParams.get('code') ?? '';
        if (method === 'POST') {
          confirm(code);
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return void res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#211735;color:#fff;padding:40px"><h1>Escritório conectado!</h1><p>Pode voltar ao Habblaud.</p></body>');
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return void res.end(
          `<!doctype html><meta charset="utf-8"><title>Conectar escritório</title><body style="font-family:sans-serif;background:#211735;color:#fff;padding:40px"><h1>Conectar o escritório à sua conta</h1><p>Código: <b>${code.replace(/[^A-Z0-9-]/gi, '')}</b></p><form method="post"><button style="font-size:18px;padding:10px 20px;background:#c8ff32;border:0">Confirmar</button></form></body>`,
        );
      }
      if (path === '/escritorio/publicar') {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        return void res.end('<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;padding:40px"><h1>Hospedagem Habblaude (portal falso)</h1></body>');
      }
      if (path === '/api/publicar/conectar' && method === 'POST') {
        await readJson(req);
        const code = `${randomBytes(2).toString('hex').toUpperCase()}-${randomBytes(2).toString('hex').toUpperCase()}`;
        state.pairings.set(code, { code, confirmed: false, polls: 0, expiresAt: Date.now() + 600_000, delivered: false });
        return send(res, 200, { code, url: `${base}/escritorio/publicar/conectar?code=${code}`, expiresIn: 600, interval: opts.autoConfirm ? 1 : 3 });
      }
      if (path === '/api/publicar/conectar/token' && method === 'POST') {
        const b = await readJson(req);
        const p = state.pairings.get(String(b.code ?? ''));
        if (!p || p.expiresAt < Date.now() || p.delivered) return err(res, 410, 'expired', 'Código expirado.');
        p.polls++;
        if (opts.autoConfirm && p.polls >= 2) confirm(p.code);
        if (!p.confirmed) return err(res, 428, 'pending', 'Aguardando a confirmação no portal.');
        p.delivered = true;
        return send(res, 200, { token: p.token });
      }
      if (!path.startsWith('/api/publicar/')) return err(res, 404, 'not_found', 'Rota desconhecida.');

      // Daqui para baixo: token obrigatório.
      const auth = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization ?? ''));
      if (!auth || !state.tokens.has(auth[1])) {
        req.resume();
        return err(res, 401, 'unauthenticated', 'Token inválido ou revogado. Conecte o escritório de novo.');
      }
      if (path === '/api/publicar/conta') {
        if (method === 'GET') return send(res, 200, contaView());
        if (method === 'POST') {
          const b = await readJson(req);
          const handle = String(b.handle ?? '');
          if (!/^[a-z][a-z0-9]{2,19}$/.test(handle)) return err(res, 400, 'invalid_input', 'Nome de usuário inválido: 3 a 20 letras minúsculas e números, começando por letra.');
          if (state.sites.size) return err(res, 400, 'invalid_input', 'Não dá para trocar o nome depois de criar sites.');
          if (handle === 'ocupado') return err(res, 409, 'address_taken', 'Esse nome já está em uso.');
          state.conta.handle = handle;
          return send(res, 200, contaView());
        }
      }
      if (!state.conta.ativo) {
        req.resume();
        return err(res, 403, 'not_active', 'A Hospedagem Habblaude não está ativa na sua assinatura.', { motivo: state.conta.motivo ?? 'sem_complemento' });
      }
      if (path === '/api/publicar/sites' && method === 'POST') {
        const b = await readJson(req);
        const nome = String(b.nome ?? '');
        if (!/^[a-z0-9-]{1,30}$/.test(nome)) return err(res, 400, 'invalid_input', 'Nome do site inválido (use letras minúsculas, números e hífen).');
        if (typeof b.handle === 'string' && !state.conta.handle) state.conta.handle = b.handle;
        if (!state.conta.handle) return err(res, 400, 'invalid_input', 'Escolha o seu nome de usuário primeiro.');
        const ativos = [...state.sites.values()].filter((s) => s.status !== 'removido');
        if (ativos.length >= state.conta.plano.maxSites) return err(res, 409, 'site_limit', `Seu plano permite ${state.conta.plano.maxSites} site(s).`);
        const sub = `${nome}-${state.conta.handle}.habblaude.app`;
        if (ativos.some((s) => s.subdominio === sub) || nome === 'ocupado') return err(res, 409, 'address_taken', 'Esse endereço já está em uso.');
        const site: FakeSite = { id: id('site'), nome, tipo: (b.tipo as Tipo) ?? 'static', status: 'novo', subdominio: sub, url: `https://${sub}`, dominios: [], config: (b.config as SiteConfig) ?? { porta: 8080 }, envKeys: [], criadoEm: now(), env: {}, checks: {} };
        state.sites.set(site.id, site);
        return send(res, 201, { site: view(site) });
      }
      let m = /^\/api\/publicar\/sites\/([^/]+)(\/.*)?$/.exec(path);
      if (m) {
        const site = state.sites.get(decodeURIComponent(m[1]));
        if (!site || site.status === 'removido') {
          req.resume();
          return err(res, 404, 'not_found', 'Site não encontrado.');
        }
        const sub = m[2] ?? '';
        if (!sub) {
          if (method === 'GET') {
            const deploys = [...state.deploys.values()].filter((d) => d.siteId === site.id).reverse().slice(0, 10).map(deployView);
            return send(res, 200, { site: view(site), deploys });
          }
          if (method === 'PATCH') {
            const b = await readJson(req);
            if (b.tipo) site.tipo = b.tipo as Tipo;
            if (b.config) site.config = b.config as SiteConfig;
            return send(res, 200, { site: view(site) });
          }
          if (method === 'DELETE') {
            site.status = 'removido';
            state.sites.delete(site.id);
            return send(res, 200, { ok: true });
          }
        }
        if (sub === '/env' && method === 'PUT') {
          const b = await readJson(req);
          const vars = (b.vars ?? {}) as Record<string, string>;
          for (const k of Object.keys(vars)) if (!/^[A-Z_][A-Z0-9_]*$/.test(k)) return err(res, 400, 'invalid_input', `Nome de variável inválido: ${k}`);
          site.env = { ...vars };
          return send(res, 200, { envKeys: Object.keys(site.env).sort() });
        }
        if (sub === '/deploys' && method === 'POST') {
          if (!/^application\/(gzip|x-gzip)/.test(String(req.headers['content-type'] ?? ''))) return err(res, 400, 'invalid_input', 'Envie o projeto como application/gzip.');
          let body: Buffer;
          try {
            body = await readBody(req, state.conta.plano.maxUploadMB * 1024 * 1024);
          } catch {
            return err(res, 413, 'too_large', `O pacote passa de ${state.conta.plano.maxUploadMB} MB.`);
          }
          if (body[0] !== 0x1f || body[1] !== 0x8b) return err(res, 400, 'invalid_input', 'O pacote não é um tar.gz.');
          for (const d of state.deploys.values()) if (d.siteId === site.id && d.status === 'queued') d.status = 'canceled';
          const d: FakeDeploy = { id: id('dep'), siteId: site.id, status: 'queued', criadoEm: now(), tamanho: body.length, linhas: [], body };
          state.deploys.set(d.id, d);
          site.status = 'publicando';
          site.ultimoDeploy = deployView(d);
          runDeploy(d);
          return send(res, 202, { deploy: deployView(d) });
        }
        if (sub === '/logs' && method === 'GET') {
          const n = Number(url.searchParams.get('linhas') ?? 200);
          const lines = [`[app] ${site.nome} iniciado na porta ${site.config.porta}`, '[app] GET / 200 3ms', '[app] GET /favicon.ico 404 1ms'];
          return send(res, 200, { logs: lines.slice(-n).join('\n') });
        }
        if (sub === '/dominios' && method === 'POST') {
          const b = await readJson(req);
          const nome = String(b.dominio ?? '').toLowerCase().trim();
          if (!/^(?=.{4,253}$)([a-z0-9-]+\.)+[a-z]{2,}$/.test(nome)) return err(res, 400, 'invalid_input', 'Domínio inválido.');
          if (site.dominios.length >= state.conta.plano.maxDominios) return err(res, 409, 'domain_limit', `Seu plano permite ${state.conta.plano.maxDominios} domínio(s) próprio(s).`);
          const raiz = nome.split('.').length === 2;
          const dom: DominioView = {
            nome,
            status: 'pendente',
            registros: raiz
              ? [
                  { tipo: 'A', nome, valor: '203.0.113.10' },
                  { tipo: 'TXT', nome: `_habblaude.${nome}`, valor: `hb-verify=${randomBytes(8).toString('hex')}` },
                ]
              : [{ tipo: 'CNAME', nome, valor: site.subdominio }],
          };
          site.dominios.push(dom);
          return send(res, 201, { dominio: dom });
        }
        const dm = /^\/dominios\/([^/]+)(\/verificar)?$/.exec(sub);
        if (dm) {
          const nome = decodeURIComponent(dm[1]);
          const dom = site.dominios.find((d) => d.nome === nome);
          if (!dom) return err(res, 404, 'not_found', 'Domínio não encontrado.');
          if (dm[2] && method === 'POST') {
            site.checks[nome] = (site.checks[nome] ?? 0) + 1;
            if (site.checks[nome] >= 2) {
              dom.status = 'ok';
              dom.erro = undefined;
              dom.verificadoEm = now();
            } else dom.erro = 'O registro ainda não apareceu no DNS.';
            return send(res, 200, { dominio: dom });
          }
          if (!dm[2] && method === 'DELETE') {
            site.dominios = site.dominios.filter((d) => d.nome !== nome);
            return send(res, 200, { ok: true });
          }
        }
      }
      m = /^\/api\/publicar\/deploys\/([^/]+)(\/logs)?$/.exec(path);
      if (m && method === 'GET') {
        const d = state.deploys.get(decodeURIComponent(m[1]));
        if (!d) return err(res, 404, 'not_found', 'Deploy não encontrado.');
        if (!m[2]) return send(res, 200, { deploy: deployView(d), siteId: d.siteId });
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        let sent = 0;
        let lastStatus = '';
        const flush = () => {
          if (sent < d.linhas.length) {
            res.write(`event: log\ndata: ${JSON.stringify({ linhas: d.linhas.slice(sent) })}\n\n`);
            sent = d.linhas.length;
          }
          if (d.status !== lastStatus) {
            lastStatus = d.status;
            if (d.status === 'ok' || d.status === 'failed' || d.status === 'canceled') {
              const site = state.sites.get(d.siteId);
              res.write(`event: fim\ndata: ${JSON.stringify({ status: d.status, url: site ? view(site).url : undefined, erro: d.erro })}\n\n`);
              stop();
              res.end();
              return;
            }
            res.write(`event: status\ndata: ${JSON.stringify({ status: d.status })}\n\n`);
          }
        };
        const set = listeners.get(d.id) ?? new Set();
        listeners.set(d.id, set);
        const stop = () => set.delete(flush);
        set.add(flush);
        req.on('close', stop);
        flush();
        return;
      }
      req.resume();
      err(res, 404, 'not_found', 'Rota desconhecida.');
    } catch (e) {
      if (!res.headersSent) err(res, 500, 'internal', `Erro no portal falso: ${(e as Error).message}`);
      else res.destroy();
    }
  });
  await new Promise<void>((ok) => server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', ok));
  const addr = server.address() as AddressInfo;
  base = `http://${opts.host && opts.host !== '0.0.0.0' ? opts.host : '127.0.0.1'}:${addr.port}`;
  return {
    url: base,
    state,
    confirm,
    close: () =>
      new Promise<void>((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

// Execução direta: npx tsx server/publish/fake-portal.ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const val = (name: string) => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const inativo = val('--inativo') as MotivoInativo | undefined;
  const portal = await startFakePortal({
    port: Number(val('--port') ?? 8787),
    autoConfirm: args.includes('--auto'),
    ativo: !inativo,
    motivo: inativo,
    handle: args.includes('--sem-handle') ? null : (val('--handle') ?? null),
    failDeploys: args.includes('--falhar'),
    stepMs: Number(val('--passo') ?? 700),
    log: true,
  });
  console.log(`Portal falso em ${portal.url}  (rode o Habblaud com HB_PORTAL_URL=${portal.url})`);
}
