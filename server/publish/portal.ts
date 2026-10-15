// Cliente da API de publicação do portal (contrato: docs do portal, 2026-10-14-publicar-contrato.md).
// JSON via fetch; o upload do tar.gz vai em streaming por http(s).request (Content-Length conhecido).
import { createReadStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import type { Conta, DeployView, DominioView, SiteConfig, SiteView, Tipo } from '../../shared/publish';

export class PortalError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly body?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export type TokenPoll = { status: 'ok'; token: string } | { status: 'pending' } | { status: 'expired' };

export interface PortalClientOptions {
  base: string;
  token?: string;
  fetch?: typeof fetch;
  /** Tempo máximo das chamadas JSON (ms). */
  timeoutMs?: number;
}

const enc = encodeURIComponent;

export class PortalClient {
  readonly base: string;
  private token?: string;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(opts: PortalClientOptions) {
    this.base = opts.base.replace(/\/+$/, '');
    this.token = opts.token;
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private headers(json: boolean): Record<string, string> {
    const h: Record<string, string> = { Accept: 'application/json' };
    if (json) h['Content-Type'] = 'application/json';
    if (this.token) h.Authorization = `Bearer ${this.token}`;
    return h;
  }

  /** Chamada JSON; erros do portal viram PortalError (texto pt-BR + code). */
  async request<T>(method: string, path: string, body?: unknown, opts: { auth?: boolean; okStatuses?: number[] } = {}): Promise<{ status: number; data: T }> {
    const auth = opts.auth !== false;
    if (auth && !this.token) throw new PortalError(401, 'Este escritório ainda não está conectado à sua conta Habblaude.', 'unauthenticated');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers: auth ? this.headers(body !== undefined) : { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (err) {
      throw new PortalError(502, `Não foi possível falar com o portal (${this.base}): ${(err as Error).message}`, 'network');
    }
    const text = await res.text();
    let data: unknown = undefined;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = undefined;
    }
    if (res.ok || opts.okStatuses?.includes(res.status)) return { status: res.status, data: data as T };
    const b = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
    const msg = typeof b.error === 'string' ? b.error : `O portal respondeu ${res.status}.`;
    const code = typeof b.code === 'string' ? b.code : res.status === 401 ? 'unauthenticated' : 'internal';
    throw new PortalError(res.status, msg, code, b);
  }

  // ------------------------------------------------------------ pareamento (sem auth)

  async conectar(nome?: string): Promise<{ code: string; url: string; expiresIn: number; interval: number }> {
    const r = await this.request<{ code: string; url: string; expiresIn: number; interval: number }>('POST', '/api/publicar/conectar', nome ? { nome } : {}, { auth: false });
    return r.data;
  }

  async conectarToken(code: string): Promise<TokenPoll> {
    const r = await this.request<{ token?: string; code?: string }>('POST', '/api/publicar/conectar/token', { code }, { auth: false, okStatuses: [428, 410] });
    if (r.status === 200 && typeof r.data?.token === 'string') return { status: 'ok', token: r.data.token };
    if (r.status === 410) return { status: 'expired' };
    return { status: 'pending' };
  }

  // ------------------------------------------------------------ conta e sites

  async conta(): Promise<Conta> {
    return (await this.request<Conta>('GET', '/api/publicar/conta')).data;
  }

  async setHandle(handle: string): Promise<Conta> {
    return (await this.request<Conta>('POST', '/api/publicar/conta', { handle })).data;
  }

  async criarSite(input: { nome: string; tipo: Tipo; config: SiteConfig; handle?: string }): Promise<SiteView> {
    return (await this.request<{ site: SiteView }>('POST', '/api/publicar/sites', input)).data.site;
  }

  async site(id: string): Promise<{ site: SiteView; deploys: DeployView[] }> {
    return (await this.request<{ site: SiteView; deploys: DeployView[] }>('GET', `/api/publicar/sites/${enc(id)}`)).data;
  }

  async patchSite(id: string, patch: { tipo?: Tipo; config?: SiteConfig }): Promise<SiteView> {
    return (await this.request<{ site: SiteView }>('PATCH', `/api/publicar/sites/${enc(id)}`, patch)).data.site;
  }

  async deleteSite(id: string): Promise<void> {
    await this.request('DELETE', `/api/publicar/sites/${enc(id)}`);
  }

  async putEnv(id: string, vars: Record<string, string>): Promise<string[]> {
    return (await this.request<{ envKeys: string[] }>('PUT', `/api/publicar/sites/${enc(id)}/env`, { vars })).data.envKeys;
  }

  async siteLogs(id: string, linhas = 200): Promise<string> {
    return (await this.request<{ logs: string }>('GET', `/api/publicar/sites/${enc(id)}/logs?linhas=${Math.max(1, Math.min(2000, Math.floor(linhas)))}`)).data.logs;
  }

  async addDominio(id: string, dominio: string): Promise<DominioView> {
    return (await this.request<{ dominio: DominioView }>('POST', `/api/publicar/sites/${enc(id)}/dominios`, { dominio })).data.dominio;
  }

  async verificarDominio(id: string, nome: string): Promise<DominioView> {
    return (await this.request<{ dominio: DominioView }>('POST', `/api/publicar/sites/${enc(id)}/dominios/${enc(nome)}/verificar`)).data.dominio;
  }

  async removeDominio(id: string, nome: string): Promise<void> {
    await this.request('DELETE', `/api/publicar/sites/${enc(id)}/dominios/${enc(nome)}`);
  }

  async deploy(id: string): Promise<{ deploy: DeployView; siteId: string }> {
    return (await this.request<{ deploy: DeployView; siteId: string }>('GET', `/api/publicar/deploys/${enc(id)}`)).data;
  }

  // ------------------------------------------------------------ upload e logs

  /** Envia o tar.gz (corpo bruto application/gzip, em streaming) -> 202 {deploy}. */
  upload(siteId: string, file: string, size: number): Promise<DeployView> {
    if (!this.token) return Promise.reject(new PortalError(401, 'Este escritório ainda não está conectado à sua conta Habblaude.', 'unauthenticated'));
    const url = new URL(`${this.base}/api/publicar/sites/${enc(siteId)}/deploys`);
    const mod = url.protocol === 'https:' ? https : http;
    return new Promise((ok, fail) => {
      const req = mod.request(
        url,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/gzip', 'Content-Length': String(size), Accept: 'application/json', Authorization: `Bearer ${this.token}` },
          timeout: 10 * 60_000,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            let b: Record<string, unknown> = {};
            try {
              b = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            } catch {
              // corpo vazio ou não JSON
            }
            const status = res.statusCode ?? 0;
            if (status >= 200 && status < 300 && b.deploy) return ok(b.deploy as DeployView);
            fail(new PortalError(status || 502, typeof b.error === 'string' ? b.error : `O portal respondeu ${status} ao envio.`, typeof b.code === 'string' ? b.code : 'internal', b));
          });
          res.on('error', fail);
        },
      );
      req.on('timeout', () => req.destroy(new Error('tempo esgotado no envio')));
      req.on('error', (err) => fail(err instanceof PortalError ? err : new PortalError(502, `Falha ao enviar o projeto ao portal: ${err.message}`, 'network')));
      const rs = createReadStream(file);
      rs.on('error', (err) => req.destroy(err));
      rs.pipe(req);
    });
  }

  /** Abre o SSE de logs do deploy (devolve a Response para repassar o corpo). */
  async deployLogs(id: string, signal?: AbortSignal): Promise<Response> {
    if (!this.token) throw new PortalError(401, 'Este escritório ainda não está conectado à sua conta Habblaude.', 'unauthenticated');
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/api/publicar/deploys/${enc(id)}/logs`, {
        headers: { Accept: 'text/event-stream', Authorization: `Bearer ${this.token}` },
        signal,
      });
    } catch (err) {
      throw new PortalError(502, `Não foi possível abrir o log no portal: ${(err as Error).message}`, 'network');
    }
    if (!res.ok) {
      let b: Record<string, unknown> = {};
      try {
        b = (await res.json()) as Record<string, unknown>;
      } catch {
        // sem corpo
      }
      throw new PortalError(res.status, typeof b.error === 'string' ? b.error : `O portal respondeu ${res.status}.`, typeof b.code === 'string' ? b.code : 'internal', b);
    }
    return res;
  }
}

/** Interpreta um fluxo SSE (para testes e para o acompanhamento de pedidos do agente). */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<{ event: string; data: string }> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true }).replace(/\r\n/g, '\n');
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let event = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
}
