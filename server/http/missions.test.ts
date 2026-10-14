// Rotas do quadro de missões: mesma trava das rotas que abrem agentes (bind local + Host local + Origin + JSON).
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MissionsView, MissionStartResult } from '../../shared/missions';
import { AccountsService } from '../accounts/service';
import type { AgentInput } from '../input/tmux';
import { setQuiet } from '../log';
import { MissionsEngine } from '../missions/engine';
import { MissionsStore } from '../missions/store';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { tempDir } from '../test/fixtures';
import { createApiHandler } from './app';
import { createRequestGuard } from './guard';
import { Hub } from './sse';

setQuiet(true);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function start(opts: { terminal?: boolean; spawn?: boolean; auth?: boolean } = {}) {
  const tmp = tempDir();
  const dir = join(tmp.dir, '.claude');
  mkdirSync(join(dir, 'sessions'), { recursive: true });
  const accounts = new AccountsService({ dirs: [dir], home: tmp.dir, env: {}, onChange: () => {} });
  const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: (s) => accounts.list(s), sources: () => [], accountName: () => undefined });
  const hub = new Hub(office, { throttleMs: 10 });
  hub.start();
  const projectsDir = join(tmp.dir, 'projetos');
  const probe = {
    files: async () => ({ exists: true, index: false, canvas: false, api: false, db: false }),
    github: async () => ({ remote: false, pushed: false }),
    ports: async (dirs: readonly string[]) => new Map(dirs.map((d) => [d, [] as number[]])),
    auth: async () => ({ connected: opts.auth ?? true }),
  };
  const engine = new MissionsEngine({ store: new MissionsStore(null), projectsDir, home: tmp.dir, probe });
  // Conta do Claude já conectada: a Missão 0 se conclui sozinha na primeira conferência.
  if ((opts.auth ?? true) === true) await engine.evaluate();
  const spawn = vi.fn(async (cwd: unknown) => ({ session: 's', cwd: String(cwd), pid: 321 }));
  const send = vi.fn(async () => {});
  const input = { available: async () => true, send, folders: async () => [], home: async () => tmp.dir, spawn } as unknown as AgentInput;
  const api = createApiHandler({
    office,
    hub,
    accounts,
    sources: () => [],
    version: '9.9.9',
    inDocker: false,
    terminal: opts.terminal ?? true,
    input: opts.spawn === false ? undefined : input,
    missions: engine,
  });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) res.end();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((ok) => {
        hub.stop();
        engine.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
    tmp.cleanup,
  );
  return { base, engine, spawn, send, projectsDir, office };
}

function req(base: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const r = http.request(
      { host: u.hostname, port: u.port, path, method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(JSON.stringify(body))) } : {}), ...headers } },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => {
          let json: any = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = text;
          }
          ok({ status: res.statusCode ?? 0, json });
        });
      },
    );
    r.on('error', fail);
    r.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

describe('/api/missions', () => {
  it('GET devolve o quadro', async () => {
    const { base } = await start();
    const r = await req(base, 'GET', '/api/missions');
    expect(r.status).toBe(200);
    const v = r.json as MissionsView;
    expect(v.missions.map((m) => m.state)).toEqual(['done', 'available', 'locked', 'locked', 'locked', 'locked']);
  });

  it('GET confere a Missão 0 na hora: quem já tem login a vê concluída ao abrir o quadro', async () => {
    const { base } = await start({ auth: false });
    const before = (await req(base, 'GET', '/api/missions')).json as MissionsView;
    expect(before.missions[0]).toMatchObject({ id: 'conta-claude', state: 'active' });
    expect(before.missions[1].state).toBe('locked');
    expect((await req(base, 'POST', '/api/missions/primeiro-site/start', {})).status).toBe(409);
  });

  it('trava: desligada sem bind local; Host de rede, Origin de fora e corpo sem JSON são barrados', async () => {
    const off = await start({ terminal: false });
    expect((await req(off.base, 'GET', '/api/missions')).status).toBe(403);
    const { base } = await start();
    expect((await req(base, 'GET', '/api/missions', undefined, { Host: 'habblaud.lan' })).status).toBe(403);
    expect((await req(base, 'POST', '/api/missions/primeiro-site/start', {}, { Host: 'habblaud.lan' })).status).toBe(403);
    expect((await req(base, 'POST', '/api/missions/primeiro-site/start', {}, { Origin: 'http://attacker.example' })).status).toBe(403);
    expect((await req(base, 'POST', '/api/missions/primeiro-site/start', {}, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await req(base, 'DELETE', '/api/missions', {})).status).toBe(405);
    expect((await req(base, 'GET', '/api/missions/primeiro-site/start')).status).toBe(405);
  });

  it('Começar: cria ~/projetos/meu-site e abre um agente lá, sem pedido pronto', async () => {
    const { base, spawn, projectsDir } = await start();
    const r = await req(base, 'POST', '/api/missions/primeiro-site/start', {});
    expect(r.status).toBe(201);
    const j = r.json as MissionStartResult;
    expect(j).toMatchObject({ project: join(projectsDir, 'meu-site'), agentId: '.claude:321', spawn: 'ok' });
    expect(JSON.stringify(j)).not.toContain('prefill');
    expect(spawn).toHaveBeenCalledWith(join(projectsDir, 'meu-site'));
    expect(existsSync(join(projectsDir, 'meu-site'))).toBe(true);
    expect(j.view.missions[1].state).toBe('active');
  });

  it('Começar com um agente já na pasta: reaproveita, sem abrir outro', async () => {
    const { base, spawn, projectsDir, engine } = await start();
    engine.ingest({ rooms: [{ id: 'r', path: join(projectsDir, 'meu-site'), name: 'meu-site' }], agents: [{ id: '.claude:9', kind: 'main', status: 'idle', roomId: 'r' }] } as never);
    const j = (await req(base, 'POST', '/api/missions/primeiro-site/start', {})).json as MissionStartResult;
    expect(j).toMatchObject({ agentId: '.claude:9', spawn: 'reused' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('sem tmux (input desligado): a missão começa mesmo assim, sem agente', async () => {
    const { base } = await start({ spawn: false });
    const r = await req(base, 'POST', '/api/missions/primeiro-site/start', {});
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ spawn: 'unavailable' });
    expect(r.json.agentId).toBeUndefined();
  });

  it('Missão 0 não abre agente (login no tmux ficaria invisível)', async () => {
    const { base, spawn } = await start({ auth: false });
    const r = await req(base, 'POST', '/api/missions/conta-claude/start', {});
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ spawn: 'skipped' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('trancada: 409; desconhecida: 404', async () => {
    const { base } = await start();
    expect((await req(base, 'POST', '/api/missions/jogo-pixel/start', {})).status).toBe(409);
    expect((await req(base, 'POST', '/api/missions/nao-existe/start', {})).status).toBe(404);
    expect((await req(base, 'POST', '/api/missions/%E0%A4%A/start', {})).status).toBe(400);
  });

  it('"Concluí" pede confirmação explícita e paga uma vez', async () => {
    const { base } = await start();
    await req(base, 'POST', '/api/missions/primeiro-site/start', {});
    expect((await req(base, 'POST', '/api/missions/primeiro-site/complete', {})).status).toBe(400);
    const ok = await req(base, 'POST', '/api/missions/primeiro-site/complete', { confirm: true });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ coins: 100, view: { wallet: { coins: 150 } } });
    expect(ok.json.view.celebrate).toContain('primeiro-site');
    expect((await req(base, 'POST', '/api/missions/primeiro-site/complete', { confirm: true })).status).toBe(409);
    const seen = await req(base, 'POST', '/api/missions/primeiro-site/seen', {});
    expect(seen.status).toBe(200);
    expect(seen.json.view.celebrate).not.toContain('primeiro-site');
  });

  it('mensagem pelo escritório vira fato da Missão 2', async () => {
    const { base, engine } = await start();
    const note = vi.spyOn(engine, 'noteInput');
    const r = await req(base, 'POST', `/api/agents/${encodeURIComponent('.claude:1')}/input`, { text: 'oi' });
    expect(r.status).toBe(200);
    expect(note).toHaveBeenCalledWith('.claude:1');
  });
});
