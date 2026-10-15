// Publicação: detecção, segredos, empacotamento, cliente do portal (contra o portal falso) e rotas /api/publish/*.
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { createRequestGuard } from '../http/guard';
import { readJson, sendJson } from '../http/app';
import { detectProject, findNodePort } from './detect';
import { startFakePortal, type FakePortal } from './fake-portal';
import { createPublishRoutes } from './http';
import { listProjectFiles, packProject } from './pack';
import { parseSse, PortalClient } from './portal';
import { parseDotenv, readEnvFiles, scanSecrets } from './secrets';
import { PublishService } from './service';
import { readToken, saveToken } from './token';

setQuiet(true);

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function tmp(): string {
  const t = tempDir();
  cleanups.push(t.cleanup);
  return t.dir;
}

/** Cria arquivos (caminho relativo -> conteúdo) numa pasta nova. */
function project(files: Record<string, string | Buffer>, dir = tmp()): string {
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, ...rel.split('/'));
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

/** Lê um tar.gz (ustar + PAX) -> mapa nome -> conteúdo. */
function untar(gz: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(gz);
  const out = new Map<string, Buffer>();
  let off = 0;
  let paxPath: string | undefined;
  while (off + 512 <= tar.length) {
    const h = tar.subarray(off, off + 512);
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/s, '').trim() || '0', 8);
    const type = String.fromCharCode(h[156]);
    // checksum confere
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
    expect(parseInt(h.subarray(148, 156).toString('ascii'), 8)).toBe(sum);
    const data = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      paxPath = m?.[1];
      continue;
    }
    out.set(paxPath ?? name, Buffer.from(data));
    paxPath = undefined;
  }
  return out;
}

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- detecção

describe('detecção do tipo', () => {
  it('estático com index.html na raiz', async () => {
    const d = await detectProject(project({ 'index.html': '<h1>oi</h1>', 'style.css': '' }));
    expect(d.tipo).toBe('static');
    expect(d.config).toMatchObject({ porta: 8080, saida: '.' });
  });

  it('estático com index.html em public/', async () => {
    const d = await detectProject(project({ 'public/index.html': '<h1>oi</h1>' }));
    expect(d.tipo).toBe('static');
    expect(d.config.saida).toBe('public');
  });

  it('vite com pnpm e outDir próprio', async () => {
    const d = await detectProject(
      project({
        'package.json': JSON.stringify({ scripts: { build: 'vite build' }, devDependencies: { vite: '^8' } }),
        'pnpm-lock.yaml': '',
        'vite.config.ts': "export default { build: { outDir: 'saida' } }",
      }),
    );
    expect(d.tipo).toBe('vite');
    expect(d.config).toMatchObject({ install: 'pnpm install --frozen-lockfile', build: 'pnpm run build', saida: 'saida', spa: true, porta: 8080 });
  });

  it('next com yarn', async () => {
    const d = await detectProject(project({ 'package.json': JSON.stringify({ scripts: { build: 'next build', start: 'next start' }, dependencies: { next: '15' } }), 'yarn.lock': '' }));
    expect(d.tipo).toBe('next');
    expect(d.config).toMatchObject({ install: 'yarn install --frozen-lockfile', build: 'yarn build', start: 'yarn start', porta: 3000 });
  });

  it('node com porta do process.env.PORT || 8081 e npm ci', async () => {
    const d = await detectProject(
      project({
        'package.json': JSON.stringify({ main: 'server.js', scripts: { start: 'node server.js' }, dependencies: { express: '4' } }),
        'package-lock.json': '{}',
        'server.js': "const app = require('express')();\nconst port = process.env.PORT || 8081;\napp.listen(port);",
      }),
    );
    expect(d.tipo).toBe('node');
    expect(d.config).toMatchObject({ install: 'npm ci', start: 'npm start', porta: 8081 });
    expect(d.avisos.join(' ')).not.toMatch(/process\.env\.PORT/);
  });

  it('node sem start: usa node <main> e avisa sobre PORT', async () => {
    const d = await detectProject(project({ 'package.json': JSON.stringify({ main: 'app.js' }), 'app.js': 'require("http").createServer().listen(5000)' }));
    expect(d.tipo).toBe('node');
    expect(d.config.start).toBe('node app.js');
    expect(d.config.porta).toBe(5000);
    expect(d.avisos.join(' ')).toMatch(/process\.env\.PORT/);
  });

  it('findNodePort reconhece as formas comuns', () => {
    expect(findNodePort('const PORT = process.env.PORT ?? 4000').porta).toBe(4000);
    expect(findNodePort("app.listen(3001, () => {})").porta).toBe(3001);
    expect(findNodePort('nada aqui').porta).toBeUndefined();
  });

  it('python flask -> gunicorn com $PORT (acrescenta gunicorn)', async () => {
    const d = await detectProject(project({ 'requirements.txt': 'Flask==3.0\n', 'app.py': 'from flask import Flask\nservidor = Flask(__name__)\n' }));
    expect(d.tipo).toBe('python');
    expect(d.config.start).toBe('gunicorn -b 0.0.0.0:$PORT app:servidor');
    expect(d.config.install).toBe('pip install -r requirements.txt && pip install gunicorn');
    expect(d.config.porta).toBe(8000);
  });

  it('python fastapi -> uvicorn', async () => {
    const d = await detectProject(project({ 'requirements.txt': 'fastapi\nuvicorn[standard]\n', 'app/main.py': 'from fastapi import FastAPI\napp = FastAPI()\n' }));
    expect(d.config.start).toBe('uvicorn app.main:app --host 0.0.0.0 --port $PORT');
    expect(d.config.install).toBe('pip install -r requirements.txt');
  });

  it('python django (pyproject) -> gunicorn <proj>.wsgi', async () => {
    const d = await detectProject(
      project({
        'pyproject.toml': '[project]\ndependencies = ["django>=5", "gunicorn"]\n',
        'manage.py': "os.environ.setdefault('DJANGO_SETTINGS_MODULE', 'loja.settings')",
      }),
    );
    expect(d.tipo).toBe('python');
    expect(d.config.start).toBe('gunicorn -b 0.0.0.0:$PORT loja.wsgi');
    expect(d.config.install).toBe('pip install .');
  });

  it('dockerfile com EXPOSE', async () => {
    const d = await detectProject(project({ Dockerfile: 'FROM nginx\nEXPOSE 9000\n' }));
    expect(d.tipo).toBe('dockerfile');
    expect(d.config.porta).toBe(9000);
  });

  it('dockerfile junto de package.json: detecta o framework e avisa do Dockerfile', async () => {
    const d = await detectProject(project({ Dockerfile: 'FROM node', 'package.json': JSON.stringify({ dependencies: { next: '1' }, scripts: { build: 'x' } }) }));
    expect(d.tipo).toBe('next');
    expect(d.avisos.join(' ')).toMatch(/Dockerfile/);
  });

  it('pasta desconhecida', async () => {
    const d = await detectProject(project({ 'notas.txt': 'oi' }));
    expect(d.avisos.join(' ')).toMatch(/Não reconhecemos/);
  });
});

// ---------------------------------------------------------------- segredos e .env

describe('segredos no código', () => {
  it('acha os padrões e nunca devolve o valor', async () => {
    const stripe = 'sk_live_' + 'a1B2c3D4e5F6g7H8';
    const dir = project({
      'src/pay.js': `const k = "${stripe}";\n`,
      'config/aws.json': '{"key": "AKIAABCDEFGHIJKLMNOP"}',
      'deploy.sh': 'TOKEN=ghp_' + 'x'.repeat(36),
      'chat.py': "SLACK = 'xoxb-1234567890-abcdef'",
      'id_rsa.txt': '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n',
      'maps.html': '<script src="https://maps.googleapis.com/?key=AIza' + 'B'.repeat(35) + '"></script>',
      'settings.yml': 'db:\n  password: superSecreta123\n',
      'ok.js': 'const password = process.env.DB_PASSWORD;\nconst senha = "changeme";\n',
      'img.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]),
    });
    const files = (await listProjectFiles(dir)).files;
    const found = await scanSecrets(dir, files);
    const tipos = Object.fromEntries(found.map((f) => [f.arquivo, f.tipo]));
    expect(tipos).toMatchObject({
      'src/pay.js': 'stripe_live',
      'config/aws.json': 'aws',
      'deploy.sh': 'github',
      'chat.py': 'slack',
      'id_rsa.txt': 'private_key',
      'maps.html': 'google',
      'settings.yml': 'password',
    });
    expect(tipos['ok.js']).toBeUndefined();
    expect(found.find((f) => f.arquivo === 'settings.yml')?.linha).toBe(2);
    expect(JSON.stringify(found)).not.toContain(stripe);
    expect(JSON.stringify(found)).not.toContain('superSecreta123');
  });

  it('.env nunca é varrido nem empacotado, mas pode ser importado', async () => {
    const dir = project({ '.env': 'export API_KEY="sk_live_abcdefghijklmnop"\n# comentário\nDEBUG=1 # fim\nnome-ruim=x\nPORT=3000\n', '.env.production': "DEBUG='0'\nMULTI=\"a\\nb\"\n", 'index.html': 'oi' });
    const files = (await listProjectFiles(dir)).files;
    expect(files).toEqual(['index.html']);
    expect(await scanSecrets(dir, files)).toEqual([]);
    const imp = await readEnvFiles(dir);
    expect(imp.vars).toEqual({ API_KEY: 'sk_live_abcdefghijklmnop', DEBUG: '0', MULTI: 'a\nb' });
    expect(imp.arquivos).toEqual(['.env', '.env.production']);
    expect(imp.ignoradas).toEqual(['nome-ruim', 'PORT']);
  });

  it('parseDotenv: aspas simples são literais', () => {
    expect(parseDotenv("A='x\\ny'\nB=  valor  \n")).toEqual({ A: 'x\\ny', B: 'valor' });
  });
});

// ---------------------------------------------------------------- empacotamento

describe('empacotamento', () => {
  it('sem git: pula dependências, builds e .env*; nomes longos via PAX', async () => {
    const long = `src/${'pasta-com-nome-bem-comprido/'.repeat(4)}arquivo-çã.txt`;
    const dir = project({
      'index.js': 'console.log(1)',
      'node_modules/x/index.js': 'x',
      '.next/cache': 'x',
      'dist/a.js': 'x',
      'build/b.js': 'x',
      '__pycache__/a.pyc': 'x',
      '.venv/bin/python': 'x',
      'venv/lib.py': 'x',
      '.env': 'S=1',
      '.env.local': 'S=1',
      'config/.env.production': 'S=1',
      'src/app.js': 'app',
      [long]: 'longo',
    });
    const pack = await packProject(dir);
    cleanups.push(pack.cleanup);
    const entries = untar(readFileSync(pack.file));
    expect([...entries.keys()].sort()).toEqual(['index.js', long, 'src/app.js'].sort());
    expect(entries.get(long)?.toString()).toBe('longo');
    expect(pack.count).toBe(3);
  });

  it('estático com saída em dist: a pasta dist entra', async () => {
    const dir = project({ 'dist/index.html': '<h1/>', 'node_modules/a': 'x' });
    const list = await listProjectFiles(dir, { tipo: 'static', config: { porta: 8080, saida: 'dist' } });
    expect(list.files).toEqual(['dist/index.html']);
  });

  it.skipIf(!hasGit())('repositório git: respeita o .gitignore e nunca leva .env', async () => {
    const dir = project({ '.gitignore': 'segredo.txt\nlogs/\n', 'a.js': 'a', 'segredo.txt': 's', 'logs/x.log': 'l', '.env': 'X=1', 'dist/keep.js': 'k', 'novo.js': 'n' });
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['-c', 'core.autocrlf=false', 'add', 'a.js', '.gitignore', 'dist/keep.js'], { cwd: dir });
    const list = await listProjectFiles(dir);
    expect(list.git).toBe(true);
    expect(list.files).toEqual(['.gitignore', 'a.js', 'dist/keep.js', 'novo.js']);
  });

  it('limite de tamanho com erro claro', async () => {
    const { randomBytes } = await import('node:crypto');
    const dir = project({ 'video.bin': randomBytes(1_300_000) });
    await expect(packProject(dir, { maxMB: 1 })).rejects.toThrow(/passou de 1 MB/);
  });

  it.skipIf(process.platform === 'win32')('links simbólicos ficam fora', async () => {
    const outside = project({ 'senha.txt': 'x' });
    const dir = project({ 'a.txt': 'a' });
    symlinkSync(join(outside, 'senha.txt'), join(dir, 'link.txt'));
    const list = await listProjectFiles(dir);
    expect(list.files).toEqual(['a.txt']);
    expect(list.avisos.join(' ')).toMatch(/link/);
  });
});

// ---------------------------------------------------------------- cliente do portal

async function portal(opts: Parameters<typeof startFakePortal>[0] = {}): Promise<FakePortal> {
  const p = await startFakePortal({ stepMs: 5, ...opts });
  cleanups.push(() => p.close());
  return p;
}

describe('cliente do portal (contra o portal falso)', () => {
  it('pareamento pendente -> token; conta; site; env; upload; SSE até o fim', async () => {
    const fake = await portal({ handle: 'fulano' });
    const anon = new PortalClient({ base: fake.url });
    const c = await anon.conectar('teste');
    expect(c.code).toMatch(/^[A-F0-9]{4}-[A-F0-9]{4}$/);
    expect(c.url).toContain(c.code);
    expect(await anon.conectarToken(c.code)).toEqual({ status: 'pending' });
    fake.confirm(c.code);
    const tok = await anon.conectarToken(c.code);
    expect(tok.status).toBe('ok');
    expect(await anon.conectarToken(c.code)).toEqual({ status: 'expired' });

    const client = new PortalClient({ base: fake.url, token: (tok as { token: string }).token });
    const conta = await client.conta();
    expect(conta).toMatchObject({ handle: 'fulano', ativo: true, dominioBase: 'habblaude.app' });
    const site = await client.criarSite({ nome: 'loja', tipo: 'static', config: { porta: 8080, saida: '.' } });
    expect(site.subdominio).toBe('loja-fulano.habblaude.app');
    expect(await client.putEnv(site.id, { B: '2', A: '1' })).toEqual(['A', 'B']);

    const dir = project({ 'index.html': '<h1>oi</h1>' });
    const pack = await packProject(dir);
    cleanups.push(pack.cleanup);
    const dep = await client.upload(site.id, pack.file, pack.size);
    expect(dep.status).toBe('queued');
    expect(untar(fake.state.deploys.get(dep.id)!.body!).get('index.html')?.toString()).toBe('<h1>oi</h1>');

    const res = await client.deployLogs(dep.id);
    const events: string[] = [];
    let fim: { status: string; url?: string } | undefined;
    for await (const ev of parseSse(res.body!)) {
      events.push(ev.event);
      if (ev.event === 'fim') fim = JSON.parse(ev.data);
    }
    expect(events).toContain('log');
    expect(events).toContain('status');
    expect(fim).toMatchObject({ status: 'ok', url: 'https://loja-fulano.habblaude.app' });

    const dom = await client.addDominio(site.id, 'www.loja.com');
    expect(dom.registros).toEqual([{ tipo: 'CNAME', nome: 'www.loja.com', valor: 'loja-fulano.habblaude.app' }]);
    expect((await client.verificarDominio(site.id, 'www.loja.com')).status).toBe('pendente');
    expect((await client.verificarDominio(site.id, 'www.loja.com')).status).toBe('ok');
    await client.deleteSite(site.id);
    await expect(client.site(site.id)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });

  it('erros do portal viram PortalError com code', async () => {
    const fake = await portal();
    await expect(new PortalClient({ base: fake.url, token: 'hbp_invalido_xxxxxxxxxxxxxxxxxxxx' }).conta()).rejects.toMatchObject({ status: 401, code: 'unauthenticated' });
    await expect(new PortalClient({ base: fake.url }).conta()).rejects.toMatchObject({ code: 'unauthenticated' });
  });
});

// ---------------------------------------------------------------- rotas

async function office(opts: { enabled?: boolean; portal?: FakePortal; token?: boolean } = {}) {
  const home = tmp();
  mkdirSync(join(home, 'projetos'), { recursive: true });
  const env: NodeJS.ProcessEnv = { HB_PORTAL_URL: opts.portal?.url ?? 'http://127.0.0.1:9' };
  const service = new PublishService({ home, env, trackEveryMs: 20 });
  if (opts.token && opts.portal) {
    const t = 'hbp_' + 'k'.repeat(43);
    opts.portal.state.tokens.add(t);
    saveToken(home, t);
  }
  const { api } = createPublishRoutes({ service, enabled: opts.enabled ?? true, sendJson, readJson });
  const guard = createRequestGuard({ allowedHosts: new Set(['habblaud.lan']) });
  const server = http.createServer((req, res) => {
    if (guard(req, res)) return;
    const url = new URL(req.url ?? '/', 'http://x');
    if (!api(req, res, url)) sendJson(res, 404, { error: 'fora' });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  cleanups.push(
    () =>
      new Promise<void>((ok) => {
        service.stop();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  );
  const call = async (method: string, path: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(`${base}${path}`, { method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body !== undefined ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: r.status, json };
  };
  return { home, base, call, service, projects: join(home, 'projetos') };
}

/** GET com cabeçalho Host arbitrário (fetch não deixa trocar o Host). */
function rawGet(base: string, path: string, host: string): Promise<number> {
  const u = new URL(base);
  return new Promise((ok, fail) => {
    const req = http.request({ host: u.hostname, port: u.port, path, headers: { Host: host } }, (res) => {
      res.resume();
      ok(res.statusCode ?? 0);
    });
    req.on('error', fail);
    req.end();
  });
}

describe('rotas /api/publish', () => {
  it('Host não local -> 403; recurso desligado -> 403', async () => {
    const o = await office();
    expect(await rawGet(o.base, '/api/publish/status', 'habblaud.lan')).toBe(403);
    expect(await rawGet(o.base, '/api/publish/status', '192.168.0.5:4747')).toBe(403);
    expect(await rawGet(o.base, '/api/publish/status', `localhost:${new URL(o.base).port}`)).toBe(200);
    const off = await office({ enabled: false });
    expect((await off.call('GET', '/api/publish/status')).status).toBe(403);
  });

  it('POST sem JSON é barrado pelo guard (415)', async () => {
    const o = await office();
    const r = await fetch(`${o.base}/api/publish/detect`, { method: 'POST', body: 'path=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(415);
  });

  it('path fora de ~/projetos -> 400 (inclusive por symlink e ..)', async () => {
    const o = await office();
    const outside = project({ 'index.html': 'x' });
    project({ 'index.html': 'oi' }, join(o.projects, 'site'));
    expect((await o.call('POST', '/api/publish/detect', { path: outside })).status).toBe(400);
    expect((await o.call('POST', '/api/publish/detect', { path: '../' })).status).toBe(400);
    expect((await o.call('POST', '/api/publish/detect', { path: o.projects })).status).toBe(400);
    expect((await o.call('POST', '/api/publish/detect', {})).status).toBe(400);
    if (process.platform !== 'win32') {
      symlinkSync(outside, join(o.projects, 'fuga'));
      expect((await o.call('POST', '/api/publish/detect', { path: 'fuga' })).status).toBe(400);
    }
    const ok = await o.call('POST', '/api/publish/detect', { path: 'site' });
    expect(ok.status).toBe(200);
    expect(ok.json.deteccao.tipo).toBe('static');
    expect(ok.json.projeto.nome).toBe('site');
  });

  it('lista projetos e importa .env', async () => {
    const o = await office();
    project({ '.env': 'A=1' }, join(o.projects, 'b'));
    project({ 'x': '' }, join(o.projects, 'a'));
    const r = await o.call('GET', '/api/publish/projects');
    expect(r.json.projects.map((p: { nome: string }) => p.nome)).toEqual(['a', 'b']);
    expect((await o.call('POST', '/api/publish/env-import', { path: 'b' })).json.vars).toEqual({ A: '1' });
  });

  it('pareamento pelo servidor: connect -> polling -> token gravado', async () => {
    const fake = await portal({ autoConfirm: true });
    const o = await office({ portal: fake });
    expect((await o.call('GET', '/api/publish/status')).json).toMatchObject({ connected: false, tokenSource: null });
    const c = await o.call('POST', '/api/publish/connect', {});
    expect(c.json.status).toBe('pending');
    for (let i = 0; i < 60 && !readToken(o.home, {}); i++) await new Promise((r) => setTimeout(r, 100));
    expect(readToken(o.home, {})?.token).toMatch(/^hbp_/);
    if (process.platform !== 'win32') {
      const { statSync } = await import('node:fs');
      expect(statSync(join(o.home, '.habblaude', 'publish-token')).mode & 0o777).toBe(0o600);
    }
    const st = await o.call('GET', '/api/publish/status');
    expect(st.json).toMatchObject({ connected: true, tokenSource: 'file', pairing: { status: 'ok' }, conta: { ativo: true } });
  }, 15_000);

  it('conta inativa: status traz o motivo; criar site devolve 403 not_active', async () => {
    const fake = await portal({ ativo: false, motivo: 'sem_complemento' });
    const o = await office({ portal: fake, token: true });
    const st = await o.call('GET', '/api/publish/status');
    expect(st.json.conta).toMatchObject({ ativo: false, motivo: 'sem_complemento' });
    const r = await o.call('POST', '/api/publish/sites', { nome: 'x', tipo: 'static', config: { porta: 8080 } });
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'not_active', motivo: 'sem_complemento' });
  });

  it('fluxo completo: site, env, deploy (empacota + envia), SSE repassado, domínio, despublicar', async () => {
    const fake = await portal();
    const o = await office({ portal: fake, token: true });
    project({ 'index.html': '<h1>oi</h1>', '.env': 'X=1' }, join(o.projects, 'loja'));
    expect((await o.call('POST', '/api/publish/account', { handle: 'fulano' })).json.handle).toBe('fulano');
    const s = await o.call('POST', '/api/publish/sites', { nome: 'loja', tipo: 'static', config: { porta: 8080, saida: '.' } });
    expect(s.status).toBe(201);
    const id = s.json.site.id;
    expect((await o.call('PUT', `/api/publish/sites/${id}/env`, { vars: { X: '1' } })).json.envKeys).toEqual(['X']);
    const d = await o.call('POST', '/api/publish/deploy', { siteId: id, path: 'loja' });
    expect(d.status).toBe(202);
    expect(d.json.pacote.arquivos).toBe(1);
    expect([...untar(fake.state.deploys.get(d.json.deploy.id)!.body!).keys()]).toEqual(['index.html']);

    const sse = await fetch(`${o.base}/api/publish/deploys/${d.json.deploy.id}/logs`);
    expect(sse.headers.get('content-type')).toMatch(/text\/event-stream/);
    const evs: { event: string; data: string }[] = [];
    for await (const ev of parseSse(sse.body!)) evs.push(ev);
    expect(evs.at(-1)?.event).toBe('fim');
    expect(JSON.parse(evs.at(-1)!.data).status).toBe('ok');

    const dom = await o.call('POST', `/api/publish/sites/${id}/dominios`, { dominio: 'loja.com' });
    expect(dom.json.dominio.registros.map((r: { tipo: string }) => r.tipo)).toEqual(['A', 'TXT']);
    expect((await o.call('POST', `/api/publish/sites/${id}/dominios/loja.com/verificar`, {})).json.dominio.status).toBe('pendente');
    expect((await o.call('GET', `/api/publish/sites/${id}/logs?linhas=2`)).json.logs.split('\n')).toHaveLength(2);
    expect((await o.call('DELETE', `/api/publish/sites/${id}/dominios/loja.com`, {})).json.ok).toBe(true);
    expect((await o.call('DELETE', `/api/publish/sites/${id}`, {})).json.ok).toBe(true);
    expect((await o.call('GET', `/api/publish/sites/${id}`)).status).toBe(404);
  });

  it('pedido do agente: espera a confirmação, publica e informa o link', async () => {
    const fake = await portal({ handle: 'fulano' });
    const o = await office({ portal: fake, token: true });
    project({ 'index.html': 'oi' }, join(o.projects, 'blog'));
    const s = await o.call('POST', '/api/publish/sites', { nome: 'blog', tipo: 'static', config: { porta: 8080 } });
    const r = await o.call('POST', '/api/publish/requests', { path: 'blog', origem: 'Claude' });
    expect(r.status).toBe(201);
    // Achou o site pelo nome da pasta.
    expect(r.json.request).toMatchObject({ status: 'pending', siteId: s.json.site.id, projeto: 'blog', origem: 'Claude' });
    const list = await o.call('GET', '/api/publish/requests');
    expect(list.json.requests).toHaveLength(1);
    // Long-poll volta na hora quando a versão é outra.
    expect((await o.call('GET', `/api/publish/requests?wait=1&since=${list.json.version - 1}`)).status).toBe(200);
    // Nada foi enviado antes do "Publicar".
    expect(fake.state.deploys.size).toBe(0);
    const a = await o.call('POST', `/api/publish/requests/${r.json.request.id}/approve`, {});
    expect(a.json.request.status).toBe('publishing');
    let final: any;
    for (let i = 0; i < 100; i++) {
      final = (await o.call('GET', `/api/publish/requests/${r.json.request.id}`)).json.request;
      if (final.status !== 'publishing') break;
      await new Promise((ok) => setTimeout(ok, 30));
    }
    expect(final).toMatchObject({ status: 'ok', url: 'https://blog-fulano.habblaude.app' });
  });

  it('pedido recusado e pedido sem conexão', async () => {
    const fake = await portal();
    const sem = await office({ portal: fake });
    project({ 'index.html': 'oi' }, join(sem.projects, 'p'));
    expect((await sem.call('POST', '/api/publish/requests', { path: 'p' })).status).toBe(409);
    const o = await office({ portal: fake, token: true });
    project({ 'index.html': 'oi' }, join(o.projects, 'p'));
    const r = await o.call('POST', '/api/publish/requests', { path: 'p' });
    expect((await o.call('POST', `/api/publish/requests/${r.json.request.id}/reject`, {})).json.request.status).toBe('rejected');
    expect((await o.call('POST', `/api/publish/requests/${r.json.request.id}/approve`, {})).status).toBe(409);
  });
});
