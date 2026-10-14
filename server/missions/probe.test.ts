import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { fileFacts, githubFacts, parseGithubRemotes, pushedInReflog } from './probe';

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp?.cleanup());

function project(files: Record<string, string>): string {
  tmp = tempDir();
  const dir = join(tmp.dir, 'p');
  mkdirSync(dir);
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), body);
  }
  return dir;
}

describe('fileFacts', () => {
  it('pasta inexistente: tudo falso', async () => {
    tmp = tempDir();
    expect(await fileFacts(join(tmp.dir, 'nao-existe'))).toEqual({ exists: false, index: false, canvas: false, api: false, db: false });
  });
  it('site: index.html na raiz ou em dist/', async () => {
    expect((await fileFacts(project({ 'index.html': '<h1>oi</h1>' }))).index).toBe(true);
    expect((await fileFacts(project({ 'dist/index.html': '<h1>oi</h1>' }))).index).toBe(true);
    expect((await fileFacts(project({ 'README.md': '# x' }))).index).toBe(false);
  });
  it('jogo: <canvas> no html ou getContext num script', async () => {
    expect((await fileFacts(project({ 'index.html': '<canvas id="c"></canvas>' }))).canvas).toBe(true);
    expect((await fileFacts(project({ 'index.html': '<div></div>', 'src/game.js': "const g = c.getContext('2d');" }))).canvas).toBe(true);
    expect((await fileFacts(project({ 'index.html': '<div></div>' }))).canvas).toBe(false);
  });
  it('API com banco: dependências do package.json', async () => {
    const f = await fileFacts(project({ 'package.json': JSON.stringify({ dependencies: { express: '^5', 'better-sqlite3': '^11' } }) }));
    expect(f).toMatchObject({ api: true, db: true });
  });
  it('API com banco: Python (requirements) e arquivo .sqlite', async () => {
    const f = await fileFacts(project({ 'requirements.txt': 'fastapi\nuvicorn\n', 'data/app.sqlite': 'x' }));
    expect(f).toMatchObject({ api: true, db: true });
  });
  it('API com node puro: createServer + node:sqlite no código', async () => {
    const f = await fileFacts(project({ 'server.js': "import http from 'node:http';\nimport { DatabaseSync } from 'node:sqlite';\nhttp.createServer(() => {});" }));
    expect(f).toMatchObject({ api: true, db: true });
  });
  it('node_modules não conta', async () => {
    const f = await fileFacts(project({ 'node_modules/x/index.js': 'http.createServer(); getContext("2d")', 'node_modules/x/a.db': 'x' }));
    expect(f).toMatchObject({ api: false, db: false, canvas: false });
  });
});

describe('git', () => {
  it('parseGithubRemotes: só github.com (https e ssh), sem repetir', () => {
    const out = [
      'origin\thttps://github.com/ana/site.git (fetch)',
      'origin\thttps://github.com/ana/site.git (push)',
      'gl\tgit@gitlab.com:ana/site.git (fetch)',
      'gh\tgit@github.com:ana/site.git (push)',
      'falso\thttps://github.com.evil.io/x (push)',
    ].join('\n');
    expect(parseGithubRemotes(out)).toEqual(['origin', 'gh']);
  });
  it('pushedInReflog: "update by push" no reflog do ramo remoto', () => {
    expect(pushedInReflog('update by push\nfetch: fast-forward\n')).toBe(true);
    expect(pushedInReflog('clone: from https://github.com/a/b\n')).toBe(false);
  });
  it('githubFacts percorre os projetos com .git e para no primeiro com push', async () => {
    tmp = tempDir();
    for (const p of ['a', 'b', 'c']) mkdirSync(join(tmp.dir, p, '.git'), { recursive: true });
    mkdirSync(join(tmp.dir, 'sem-git'));
    const calls: string[] = [];
    const git = async (cwd: string, args: string[]) => {
      const name = cwd.split(/[\\/]/).pop()!;
      calls.push(`${name}:${args[0]}`);
      if (args[0] === 'remote') return name === 'a' ? '' : 'origin\thttps://github.com/x/y (push)\n';
      if (args[0] === 'for-each-ref') return 'refs/remotes/origin/main\n';
      return name === 'c' ? 'update by push\n' : 'clone: from x\n';
    };
    expect(await githubFacts(tmp.dir, git)).toEqual({ remote: true, pushed: true, project: 'c' });
    expect(calls.some((c) => c.startsWith('sem-git'))).toBe(false);
  });
  it('githubFacts sem nenhum remoto do GitHub', async () => {
    tmp = tempDir();
    mkdirSync(join(tmp.dir, 'a', '.git'), { recursive: true });
    expect(await githubFacts(tmp.dir, async () => '')).toEqual({ remote: false, pushed: false });
    expect(await githubFacts(join(tmp.dir, 'nao-existe'), async () => '')).toEqual({ remote: false, pushed: false });
  });
});
