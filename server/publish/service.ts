// Lógica da publicação no escritório: token/pareamento, projetos de ~/projetos, detecção, empacotamento + envio e
// os pedidos de publicação feitos por agentes (CLI habblaud-publicar), que esperam o "Publicar" do usuário.
import { randomBytes } from 'node:crypto';
import { realpath, readdir, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, isAbsolute, join, relative, sep } from 'node:path';
import {
  slugSite,
  type Deteccao,
  type EnvImport,
  type PacoteInfo,
  type ProjetoLocal,
  type PublishPairing,
  type PublishRequest,
  type PublishStatus,
  type SegredoEncontrado,
  type DeployView,
} from '../../shared/publish';
import { errMsg, log } from '../log';
import { detectProject } from './detect';
import { listProjectFiles, packProject, PackError } from './pack';
import { PortalClient, PortalError } from './portal';
import { readEnvFiles, scanSecrets } from './secrets';
import { clearToken, portalUrl, readToken, saveToken } from './token';

export const PROJECTS_DIRNAME = 'projetos';
const REQUEST_TTL_MS = 15 * 60_000;
const TRACK_EVERY_MS = 3_000;
const TRACK_MAX_MS = 25 * 60_000;

export class PublishError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code = 'invalid_input',
  ) {
    super(message);
  }
}

export interface PublishServiceOptions {
  home: string;
  env?: NodeJS.ProcessEnv;
  /** Pasta dos projetos (padrão: <home>/projetos). */
  projectsDir?: string;
  fetch?: typeof fetch;
  /** Intervalo do acompanhamento dos deploys pedidos pelo agente (ms; testes encurtam). */
  trackEveryMs?: number;
}

export class PublishService {
  readonly home: string;
  readonly projectsDir: string;
  private env: NodeJS.ProcessEnv;
  private fetchImpl?: typeof fetch;
  private trackEveryMs: number;
  private pairing?: PublishPairing & { interval: number; timer?: ReturnType<typeof setTimeout> };
  private requests = new Map<string, PublishRequest>();
  private version = 0;
  private waiters = new Set<() => void>();

  constructor(opts: PublishServiceOptions) {
    this.home = opts.home;
    this.env = opts.env ?? process.env;
    this.projectsDir = opts.projectsDir ?? join(opts.home, PROJECTS_DIRNAME);
    this.fetchImpl = opts.fetch;
    this.trackEveryMs = opts.trackEveryMs ?? TRACK_EVERY_MS;
  }

  get portalBase(): string {
    return portalUrl(this.env);
  }

  /** Cliente do portal com o token atual (sem token: só pareamento). */
  portal(): PortalClient {
    return new PortalClient({ base: this.portalBase, token: readToken(this.home, this.env)?.token, fetch: this.fetchImpl });
  }

  // ------------------------------------------------------------ conexão

  async status(): Promise<PublishStatus> {
    const tok = readToken(this.home, this.env);
    const out: PublishStatus = { available: true, portalUrl: this.portalBase, connected: !!tok, tokenSource: tok?.source ?? null };
    if (this.pairing) {
      const { timer: _t, interval: _i, ...p } = this.pairing;
      out.pairing = p;
    }
    if (tok) {
      try {
        out.conta = await this.portal().conta();
      } catch (err) {
        out.erro = err instanceof PortalError ? err.message : errMsg(err);
        out.erroCode = err instanceof PortalError ? err.code : 'network';
      }
    }
    return out;
  }

  /** Começa o pareamento (estilo device-code) e faz o polling aqui no servidor até o token chegar. */
  async connect(): Promise<PublishPairing> {
    this.stopPairing();
    const r = await this.portal().conectar(`Habblaud em ${safeHostname()}`);
    const interval = Math.max(1, Math.min(30, Number(r.interval) || 3));
    this.pairing = { code: r.code, url: r.url, status: 'pending', expiresAt: Date.now() + (Number(r.expiresIn) || 600) * 1000, interval };
    this.schedulePoll();
    const { timer: _t, interval: _i, ...p } = this.pairing;
    return p;
  }

  private schedulePoll(): void {
    const p = this.pairing;
    if (!p || p.status !== 'pending') return;
    p.timer = setTimeout(() => void this.pollOnce(), p.interval * 1000);
    p.timer.unref?.();
  }

  private async pollOnce(): Promise<void> {
    const p = this.pairing;
    if (!p || p.status !== 'pending') return;
    if (Date.now() > p.expiresAt) {
      p.status = 'expired';
      return;
    }
    try {
      const r = await new PortalClient({ base: this.portalBase, fetch: this.fetchImpl }).conectarToken(p.code);
      if (this.pairing !== p) return;
      if (r.status === 'ok') {
        saveToken(this.home, r.token);
        p.status = 'ok';
        log.info('Publicar: escritório conectado à conta Habblaude.');
        return;
      }
      if (r.status === 'expired') {
        p.status = 'expired';
        return;
      }
    } catch (err) {
      // Falha de rede passageira: tenta de novo no próximo intervalo.
      p.erro = errMsg(err);
    }
    this.schedulePoll();
  }

  private stopPairing(): void {
    if (this.pairing?.timer) clearTimeout(this.pairing.timer);
    this.pairing = undefined;
  }

  disconnect(): void {
    this.stopPairing();
    clearToken(this.home);
  }

  stop(): void {
    this.stopPairing();
    for (const w of this.waiters) w();
    this.waiters.clear();
  }

  // ------------------------------------------------------------ projetos

  async projects(): Promise<ProjetoLocal[]> {
    let entries;
    try {
      entries = await readdir(this.projectsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({ nome: e.name, path: join(this.projectsDir, e.name) }))
      .sort((a, b) => a.nome.localeCompare(b.nome));
  }

  /** Caminho real de um projeto dentro de ~/projetos (aceita nome da pasta ou caminho absoluto). Senão, 400. */
  async resolveProject(input: unknown): Promise<string> {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0')) throw new PublishError(400, 'Informe a pasta do projeto (path).');
    const raw = input.trim();
    let root: string;
    try {
      root = await realpath(this.projectsDir);
    } catch {
      throw new PublishError(400, `A pasta de projetos (${this.projectsDir}) não existe.`);
    }
    const candidate = isAbsolute(raw) ? raw : join(this.projectsDir, raw);
    let real: string;
    try {
      real = await realpath(candidate);
    } catch {
      throw new PublishError(400, 'Essa pasta não existe.');
    }
    const rel = relative(root, real);
    if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) throw new PublishError(400, 'Só dá para publicar pastas dentro de ~/projetos.');
    const st = await stat(real);
    if (!st.isDirectory()) throw new PublishError(400, 'O caminho precisa ser uma pasta.');
    return real;
  }

  async detect(input: unknown): Promise<{ projeto: ProjetoLocal; deteccao: Deteccao; segredos: SegredoEncontrado[] }> {
    const dir = await this.resolveProject(input);
    const deteccao = await detectProject(dir);
    const list = await listProjectFiles(dir, { tipo: deteccao.tipo, config: deteccao.config });
    const segredos = await scanSecrets(dir, list.files);
    return { projeto: { nome: basename(dir), path: dir }, deteccao, segredos };
  }

  async envImport(input: unknown): Promise<EnvImport> {
    return readEnvFiles(await this.resolveProject(input));
  }

  // ------------------------------------------------------------ publicar

  /** Empacota a pasta e envia ao portal como um deploy novo do site. */
  async deploy(siteId: unknown, input: unknown, requestId?: unknown): Promise<{ deploy: DeployView; pacote: PacoteInfo }> {
    if (typeof siteId !== 'string' || !siteId) throw new PublishError(400, 'Informe o site (siteId).');
    const dir = await this.resolveProject(input);
    const portal = this.portal();
    const { site } = await portal.site(siteId);
    let maxMB: number | undefined;
    try {
      maxMB = (await portal.conta()).plano?.maxUploadMB;
    } catch {
      // sem conta: usa o padrão
    }
    let pack;
    try {
      pack = await packProject(dir, { tipo: site.tipo, config: site.config, maxMB });
    } catch (err) {
      if (err instanceof PackError) throw new PublishError(err.code === 'too_large' ? 413 : 400, err.message, err.code);
      throw err;
    }
    try {
      const deploy = await portal.upload(siteId, pack.file, pack.size);
      const req = typeof requestId === 'string' ? this.requests.get(requestId) : undefined;
      if (req) {
        this.updateRequest(req, { status: 'publishing', siteId, deployId: deploy.id });
        void this.track(req, deploy.id, siteId);
      }
      return { deploy, pacote: { tamanho: pack.size, arquivos: pack.count, avisos: pack.avisos } };
    } finally {
      await pack.cleanup();
    }
  }

  // ------------------------------------------------------------ pedidos do agente

  async createRequest(body: { path?: unknown; siteId?: unknown; origem?: unknown }): Promise<PublishRequest> {
    const dir = await this.resolveProject(body.path);
    if (!readToken(this.home, this.env)) throw new PublishError(409, 'O escritório ainda não está conectado à Hospedagem Habblaude: abra "Publicar" no escritório e conecte a conta primeiro.', 'unauthenticated');
    let siteId = typeof body.siteId === 'string' && body.siteId ? body.siteId : undefined;
    if (!siteId) {
      // Já existe site com o nome da pasta? Então o pedido é "publicar de novo".
      try {
        const conta = await this.portal().conta();
        siteId = conta.sites.find((s) => s.nome === slugSite(basename(dir)))?.id;
      } catch {
        // sem conta: o usuário escolhe no assistente
      }
    }
    for (const r of this.requests.values()) if (r.status === 'pending' && r.path === dir) this.updateRequest(r, { status: 'expired', erro: 'substituído por um pedido novo' });
    const req: PublishRequest = {
      id: `req_${randomBytes(6).toString('hex')}`,
      path: dir,
      projeto: basename(dir),
      siteId,
      origem: typeof body.origem === 'string' ? body.origem.slice(0, 40) : undefined,
      status: 'pending',
      criadoEm: Date.now(),
    };
    this.requests.set(req.id, req);
    this.bump();
    return req;
  }

  getRequest(id: string): PublishRequest | undefined {
    this.expireOld();
    return this.requests.get(id);
  }

  listRequests(): { version: number; requests: PublishRequest[] } {
    this.expireOld();
    return { version: this.version, requests: [...this.requests.values()].filter((r) => r.status === 'pending' || r.status === 'publishing') };
  }

  /** Espera mudar a lista (long-poll) por até `ms`. */
  waitRequests(since: number, ms: number): Promise<void> {
    if (since !== this.version) return Promise.resolve();
    return new Promise((ok) => {
      const done = () => {
        clearTimeout(t);
        this.waiters.delete(done);
        ok();
      };
      const t = setTimeout(done, ms);
      t.unref?.();
      this.waiters.add(done);
    });
  }

  /** "Publicar" do usuário num pedido que já tem site: empacota, envia e acompanha. */
  async approveRequest(id: string, siteId?: unknown): Promise<PublishRequest> {
    const req = this.getRequest(id);
    if (!req) throw new PublishError(404, 'Pedido não encontrado.', 'not_found');
    if (req.status !== 'pending') throw new PublishError(409, 'Esse pedido já foi respondido.');
    const site = typeof siteId === 'string' && siteId ? siteId : req.siteId;
    if (!site) throw new PublishError(409, 'Esse projeto ainda não tem site: publique pelo assistente.');
    this.updateRequest(req, { status: 'publishing', siteId: site });
    try {
      await this.deploy(site, req.path, req.id);
    } catch (err) {
      this.updateRequest(req, { status: 'failed', erro: err instanceof Error ? err.message : String(err) });
      throw err;
    }
    return req;
  }

  rejectRequest(id: string): PublishRequest {
    const req = this.getRequest(id);
    if (!req) throw new PublishError(404, 'Pedido não encontrado.', 'not_found');
    if (req.status === 'pending') this.updateRequest(req, { status: 'rejected', erro: 'o usuário recusou a publicação' });
    return req;
  }

  private updateRequest(req: PublishRequest, patch: Partial<PublishRequest>): void {
    Object.assign(req, patch);
    this.bump();
  }

  private bump(): void {
    this.version++;
    for (const w of [...this.waiters]) w();
  }

  private expireOld(): void {
    const now = Date.now();
    for (const [id, r] of this.requests) {
      if (r.status === 'pending' && now - r.criadoEm > REQUEST_TTL_MS) this.updateRequest(r, { status: 'expired', erro: 'ninguém confirmou a tempo' });
      // Respondidos há mais de 1 h: esquece.
      if (r.status !== 'pending' && r.status !== 'publishing' && now - r.criadoEm > 60 * 60_000) this.requests.delete(id);
    }
  }

  /** Acompanha o deploy de um pedido até terminar (para o CLI imprimir o resultado). */
  private async track(req: PublishRequest, deployId: string, siteId: string): Promise<void> {
    const started = Date.now();
    while (Date.now() - started < TRACK_MAX_MS) {
      await new Promise((ok) => setTimeout(ok, this.trackEveryMs).unref?.());
      try {
        const { deploy } = await this.portal().deploy(deployId);
        if (deploy.status === 'ok') {
          let url: string | undefined;
          try {
            url = (await this.portal().site(siteId)).site.url;
          } catch {
            // sem url
          }
          return this.updateRequest(req, { status: 'ok', url });
        }
        if (deploy.status === 'failed' || deploy.status === 'canceled') return this.updateRequest(req, { status: 'failed', erro: deploy.erro ?? (deploy.status === 'canceled' ? 'deploy cancelado' : 'o build falhou') });
      } catch (err) {
        if (err instanceof PortalError && err.status === 404) return this.updateRequest(req, { status: 'failed', erro: err.message });
      }
    }
    this.updateRequest(req, { status: 'failed', erro: 'tempo esgotado esperando o deploy' });
  }
}

function safeHostname(): string {
  try {
    return hostname().slice(0, 60);
  } catch {
    return 'escritório';
  }
}
