// Painel do GitHub: leitura do `gh auth status`/JSON do gh, serviço com um gh falso (sem rede, sem login real),
// travas das rotas e a missão "Leve para o GitHub" detectando um push de verdade (repositório remoto local).
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJson, sendJson } from '../http/app';
import { githubFacts } from '../missions/probe';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { createGithubRoutes, githubOffReason } from './http';
import { GithubService, parseAuthStatus, parsePrs, parseRepos, type Runner } from './service';

setQuiet(true);

const STATUS_OK = `github.com
  ✓ Logged in to github.com account dev-teste (keyring)
  - Active account: true
  - Git operations protocol: https
  - Token: gho_************************************
  - Token scopes: 'gist', 'read:org', 'repo'`;
const STATUS_OFF = 'You are not logged into any GitHub hosts. To log in, run: gh auth login';

/** gh/git falsos: respondem como o gh 2.x, guardam as chamadas. */
function fakeGh(o: { logged?: boolean; installed?: boolean } = {}) {
  const calls: string[][] = [];
  const run: Runner = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'gh' && o.installed === false) return { code: 127, stdout: '', stderr: 'not found' };
    const a = args.join(' ');
    if (cmd === 'gh' && a.startsWith('auth status')) return o.logged ? { code: 0, stdout: '', stderr: STATUS_OK } : { code: 1, stdout: '', stderr: STATUS_OFF };
    if (cmd === 'gh' && a.startsWith('api user')) return { code: 0, stdout: '{"login":"dev-teste","name":"Dev Teste"}', stderr: '' };
    if (cmd === 'gh' && a.startsWith('repo list'))
      return { code: 0, stdout: JSON.stringify([{ name: 'loja', nameWithOwner: 'dev-teste/loja', updatedAt: '2026-10-14T10:00:00Z', isPrivate: true, url: 'https://github.com/dev-teste/loja' }, { name: 'x', nameWithOwner: 'bad name/x' }]), stderr: '' };
    if (cmd === 'gh' && a.startsWith('search prs')) return { code: 0, stdout: JSON.stringify([{ number: 7, title: 'feat: codex', url: 'https://github.com/dev-teste/loja/pull/7', repository: { nameWithOwner: 'dev-teste/loja' } }]), stderr: '' };
    if (cmd === 'gh' && a.startsWith('repo clone')) {
      mkdirSync(args[3], { recursive: true });
      return { code: 0, stdout: '', stderr: '' };
    }
    if (cmd === 'gh' && a.startsWith('repo create')) return { code: 0, stdout: 'https://github.com/dev-teste/site\n', stderr: '' };
    if (cmd === 'git' && args.includes('rev-parse')) return { code: 128, stdout: '', stderr: 'no HEAD' };
    if (cmd === 'git' && args.includes('get-url')) return { code: 2, stdout: '', stderr: '' };
    return { code: 0, stdout: '', stderr: '' };
  };
  return { run, calls };
}

describe('saída do gh', () => {
  it('gh auth status: logado (conta) ou não', () => {
    expect(parseAuthStatus(0, STATUS_OK)).toEqual({ loggedIn: true, login: 'dev-teste' });
    expect(parseAuthStatus(1, STATUS_OFF)).toEqual({ loggedIn: false });
    expect(parseAuthStatus(0, '✓ Logged in to github.com as velho (oauth_token)')).toEqual({ loggedIn: true, login: 'velho' });
  });
  it('JSON de repos e PRs: só o que tem formato válido; URLs só do github.com', () => {
    expect(parseRepos('[{"name":"a","nameWithOwner":"o/a","url":"https://evil.com/x"},{"nameWithOwner":"../x"}]')).toEqual([{ name: 'a', nameWithOwner: 'o/a' }]);
    expect(parseRepos('lixo')).toEqual([]);
    expect(parsePrs('[{"number":1,"title":"t","url":"javascript:alert(1)"},{"number":2,"title":"ok","url":"https://github.com/o/r/pull/2","repository":{"nameWithOwner":"o/r"}}]')).toEqual([
      { number: 2, title: 'ok', url: 'https://github.com/o/r/pull/2', repo: 'o/r' },
    ]);
  });
});

describe('GithubService (gh falso)', () => {
  it('deslogado: status mostra "Conectar"; ações pedem login', async () => {
    const tmp = tempDir();
    try {
      const svc = new GithubService({ home: tmp.dir, projectsDir: join(tmp.dir, 'projetos'), run: fakeGh().run });
      expect(await svc.status()).toEqual({ installed: true, loggedIn: false });
      await expect(svc.repos()).rejects.toMatchObject({ status: 409 });
      const none = new GithubService({ home: tmp.dir, projectsDir: tmp.dir, run: fakeGh({ installed: false }).run });
      expect((await none.status()).installed).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it('logado: @usuário, repos, PRs, clonar em ~/projetos/<nome> (sem sobrescrever)', async () => {
    const tmp = tempDir();
    try {
      const projects = join(tmp.dir, 'projetos');
      mkdirSync(projects);
      const gh = fakeGh({ logged: true });
      const svc = new GithubService({ home: tmp.dir, projectsDir: projects, run: gh.run });
      expect(await svc.status()).toEqual({ installed: true, loggedIn: true, login: 'dev-teste', name: 'Dev Teste' });
      expect((await svc.repos()).map((r) => r.nameWithOwner)).toEqual(['dev-teste/loja']);
      expect((await svc.prs())[0]).toMatchObject({ number: 7, repo: 'dev-teste/loja' });
      expect(await svc.clone('dev-teste/loja')).toEqual({ dir: join(projects, 'loja'), name: 'loja' });
      await expect(svc.clone('dev-teste/loja')).rejects.toMatchObject({ status: 409 });
      await expect(svc.clone('dev-teste/loja; rm -rf ~')).rejects.toMatchObject({ status: 400 });
      await expect(svc.clone('../../etc/passwd')).rejects.toMatchObject({ status: 400 });
      // nunca pede nem imprime token
      expect(gh.calls.some((c) => c.includes('token'))).toBe(false);
    } finally {
      tmp.cleanup();
    }
  });

  it('criar repositório: exige confirmação, privado por padrão, faz o primeiro commit e o push', async () => {
    const tmp = tempDir();
    try {
      const projects = join(tmp.dir, 'projetos');
      mkdirSync(join(projects, 'site'), { recursive: true });
      writeFileSync(join(projects, 'site', 'index.html'), '<h1>oi</h1>');
      const gh = fakeGh({ logged: true });
      const svc = new GithubService({ home: tmp.dir, projectsDir: projects, run: gh.run });
      await expect(svc.create({ folder: 'site' })).rejects.toMatchObject({ status: 400 });
      await expect(svc.create({ folder: '../x', confirm: true })).rejects.toMatchObject({ status: 400 });
      await expect(svc.create({ folder: 'nao-existe', confirm: true })).rejects.toMatchObject({ status: 404 });
      const r = await svc.create({ folder: 'site', confirm: true });
      expect(r.url).toBe('https://github.com/dev-teste/site');
      const create = gh.calls.find((c) => c[0] === 'gh' && c[1] === 'repo' && c[2] === 'create')!;
      expect(create).toContain('--private');
      expect(create).toContain('--push');
      expect(gh.calls.some((c) => c[0] === 'git' && c.includes('commit'))).toBe(true);
    } finally {
      tmp.cleanup();
    }
  });
});

describe('rotas /api/github: travas', () => {
  async function serve(off: string | undefined) {
    const tmp = tempDir();
    const svc = new GithubService({ home: tmp.dir, projectsDir: tmp.dir, run: fakeGh({ logged: true }).run });
    const routes = createGithubRoutes({ service: svc, offReason: () => off, allowedHosts: new Set(), sendJson, readJson });
    const server = http.createServer((req, res) => {
      if (!routes(req, res, new URL(req.url ?? '/', 'http://x'))) res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return { base, close: () => new Promise<void>((ok) => server.close(() => (tmp.cleanup(), ok()))) };
  }

  it('ligado: status e repos; desligado (env ou terminal embutido): 403 e status "indisponível"', async () => {
    const on = await serve(undefined);
    try {
      expect(await (await fetch(`${on.base}/api/github/status`)).json()).toMatchObject({ available: true, loggedIn: true, login: 'dev-teste' });
      expect((await fetch(`${on.base}/api/github/repos`)).status).toBe(200);
      expect((await fetch(`${on.base}/api/github/clone`)).status).toBe(405);
    } finally {
      await on.close();
    }
    const off = await serve('HABBLAUD_GITHUB=0');
    try {
      expect(await (await fetch(`${off.base}/api/github/status`)).json()).toMatchObject({ available: false });
      expect((await fetch(`${off.base}/api/github/repos`)).status).toBe(403);
    } finally {
      await off.close();
    }
    expect(githubOffReason({ HABBLAUD_GITHUB: '0' }, undefined)).toBe('HABBLAUD_GITHUB=0');
    expect(githubOffReason({}, 'rodando como root')).toMatch(/terminal embutido/);
    expect(githubOffReason({}, undefined)).toBeUndefined();
  });
});

describe('missão "Leve para o GitHub" com git de verdade', () => {
  it('remoto configurado sem push não conclui; depois do push, conclui', async () => {
    const tmp = tempDir();
    try {
      const git = (cwd: string, ...a: string[]) => execFileSync('git', ['-C', cwd, ...a], { env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
      const bare = join(tmp.dir, 'remoto.git');
      execFileSync('git', ['init', '--bare', '-q', bare]);
      const projects = join(tmp.dir, 'projetos');
      const dir = join(projects, 'site');
      mkdirSync(dir, { recursive: true });
      git(dir, 'init', '-q', '-b', 'main');
      writeFileSync(join(dir, 'index.html'), 'oi');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'primeiro');
      // URL do GitHub para a detecção; o push vai de fato para o repositório local (pushurl)
      git(dir, 'remote', 'add', 'origin', 'https://github.com/dev-teste/site.git');
      git(dir, 'config', 'remote.origin.pushurl', bare);
      expect(await githubFacts(projects)).toEqual({ remote: true, pushed: false });
      git(dir, 'push', '-q', '-u', 'origin', 'main');
      expect(await githubFacts(projects)).toEqual({ remote: true, pushed: true, project: 'site' });
    } finally {
      tmp.cleanup();
    }
  });
});
