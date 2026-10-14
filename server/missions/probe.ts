// Coleta leve dos fatos das missões (I/O): arquivos da pasta do projeto e o git dos projetos de ~/projetos.
// Rodada pelo motor só enquanto há missão ativa (a cada 30 s e logo depois de um fim de turno).
import { execFile } from 'node:child_process';
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface FileFacts {
  exists: boolean;
  index: boolean;
  canvas: boolean;
  api: boolean;
  db: boolean;
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', '.cache']);
const CODE_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py']);
const DB_EXT = new Set(['.db', '.sqlite', '.sqlite3']);
const MAX_FILES = 300;
const MAX_READ = 60;
const MAX_BYTES = 256 * 1024;

const API_DEPS = /^(express|fastify|koa|hono|@hono\/node-server|restify|@nestjs\/core|polka|h3|elysia)$/;
const DB_DEPS = /^(sqlite3?|better-sqlite3|pg|postgres|mysql2?|mongodb|mongoose|prisma|@prisma\/client|knex|sequelize|drizzle-orm|typeorm|lowdb|nedb|@libsql\/client|kysely|redis|ioredis)$/;
const API_PY = /^\s*(flask|fastapi|django|bottle|starlette|sanic|aiohttp)\b/im;
const DB_PY = /^\s*(sqlalchemy|psycopg2?(-binary)?|pymysql|peewee|pymongo|tortoise-orm|sqlmodel|aiosqlite)\b/im;
const API_CODE = /\bcreateServer\s*\(|\b(Deno|Bun)\.serve\s*\(|\bapp\.(get|post|put|delete)\s*\(\s*['"`]\/|@app\.(get|post|route)\s*\(/;
const DB_CODE = /\bnode:sqlite\b|\bimport\s+sqlite3\b|\bnew\s+Database\s*\(|\bCREATE\s+TABLE\b/i;
const CANVAS = /<canvas\b|\.getContext\s*\(\s*['"`]2d/i;

/** Arquivos do projeto (até 3 níveis, sem node_modules/.git), em ordem estável. */
async function walk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 3 || out.length >= MAX_FILES) return out;
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  ents.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of ents) {
    if (out.length >= MAX_FILES) break;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) await walk(p, depth + 1, out);
    } else if (e.isFile()) out.push(p);
  }
  return out;
}

async function readSmall(path: string): Promise<string> {
  try {
    const s = await stat(path);
    if (s.size > MAX_BYTES) return '';
    return await readFile(path, 'utf8');
  } catch {
    return '';
  }
}

export async function fileFacts(dir: string): Promise<FileFacts> {
  const f: FileFacts = { exists: false, index: false, canvas: false, api: false, db: false };
  try {
    f.exists = (await stat(dir)).isDirectory();
  } catch {
    return f;
  }
  if (!f.exists) return f;
  const files = await walk(dir);
  const rel = (p: string) => p.slice(dir.length + 1).replace(/\\/g, '/');
  f.index = files.some((p) => ['index.html', 'dist/index.html', 'build/index.html', 'public/index.html'].includes(rel(p)));
  for (const p of files) if (DB_EXT.has(extname(p).toLowerCase())) f.db = true;
  if (files.some((p) => rel(p) === 'prisma/schema.prisma')) f.db = true;

  const pkg = files.find((p) => rel(p) === 'package.json');
  if (pkg) {
    try {
      const j = JSON.parse(await readSmall(pkg)) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      const deps = Object.keys({ ...j.dependencies, ...j.devDependencies });
      if (deps.some((d) => API_DEPS.test(d))) f.api = true;
      if (deps.some((d) => DB_DEPS.test(d))) f.db = true;
    } catch {
      // package.json inválido: segue pelos arquivos
    }
  }
  for (const p of files.filter((p) => /(^|\/)(requirements[^/]*\.txt|pyproject\.toml|Pipfile)$/.test(rel(p)))) {
    const t = await readSmall(p);
    if (API_PY.test(t)) f.api = true;
    if (DB_PY.test(t)) f.db = true;
  }
  let read = 0;
  for (const p of files) {
    if (f.canvas && f.api && f.db) break;
    if (!CODE_EXT.has(extname(p).toLowerCase()) || read >= MAX_READ) continue;
    read++;
    const t = await readSmall(p);
    if (CANVAS.test(t)) f.canvas = true;
    if (API_CODE.test(t)) f.api = true;
    if (DB_CODE.test(t)) f.db = true;
  }
  return f;
}

// ---------------------------------------------------------------- git

/** Nomes dos remotos que apontam para o github.com (https ou ssh). */
export function parseGithubRemotes(out: string): string[] {
  const names: string[] = [];
  for (const line of out.split('\n')) {
    const m = /^(\S+)\s+(\S+)/.exec(line.trim());
    if (!m) continue;
    if (/^(https?:\/\/([^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)/i.test(m[2]) && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

/** O ramo remoto foi atualizado por um push daqui (o clone escreve "clone: from", o fetch "fetch: ..."). */
export function pushedInReflog(out: string): boolean {
  return /^update by push\b/m.test(out);
}

export type GitRunner = (cwd: string, args: string[]) => Promise<string>;

export const runGit: GitRunner = (cwd, args) =>
  new Promise((ok) => {
    execFile('git', ['-C', cwd, ...args], { timeout: 5000, maxBuffer: 512 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (err, stdout) => ok(err ? '' : String(stdout)));
  });

/** Algum projeto de `projectsDir` (até 30) tem remoto do GitHub? E já recebeu push daqui? */
export async function githubFacts(projectsDir: string, git: GitRunner = runGit): Promise<{ remote: boolean; pushed: boolean; project?: string }> {
  let names: string[] = [];
  try {
    names = (await readdir(projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort().slice(0, 30);
  } catch {
    return { remote: false, pushed: false };
  }
  let remote = false;
  for (const name of names) {
    const dir = join(projectsDir, name);
    try {
      await stat(join(dir, '.git'));
    } catch {
      continue;
    }
    const remotes = parseGithubRemotes(await git(dir, ['remote', '-v']));
    if (!remotes.length) continue;
    remote = true;
    for (const r of remotes) {
      const refs = (await git(dir, ['for-each-ref', '--format=%(refname)', `refs/remotes/${r}`])).split('\n').map((s) => s.trim()).filter((s) => s && !s.endsWith('/HEAD'));
      for (const ref of refs.slice(0, 10)) {
        if (pushedInReflog(await git(dir, ['reflog', 'show', '--format=%gs', ref, '--']))) return { remote: true, pushed: true, project: name };
      }
    }
  }
  return { remote, pushed: false };
}
