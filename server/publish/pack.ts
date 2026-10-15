// Empacotamento do projeto em tar.gz (raiz do tar = raiz do projeto), em JS puro (ustar + PAX para nomes longos;
// zlib do Node): igual no Linux, no macOS e no Windows, sem depender do tar do sistema.
// Lista: repositório git -> `git ls-files -co --exclude-standard -z`; senão, tudo menos as pastas de dependências e
// de build. Sempre fora: .env*, node_modules, .git, __pycache__, .venv/venv. Links simbólicos nunca são seguidos.
import { execFile } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { SiteConfig, Tipo } from '../../shared/publish';

export const DEFAULT_MAX_UPLOAD_MB = 50;
/** Um arquivo sozinho acima disto nem é lido (o pacote estouraria o limite de qualquer jeito). */
const MAX_FILE_BYTES = 512 * 1024 * 1024;

/** Pastas que nunca entram (em qualquer nível). */
const ALWAYS_SKIP_DIRS = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', '.pytest_cache', '.mypy_cache']);
/** Pastas de build que só ficam fora quando não é repositório git (exceto a saída de um site estático). */
const BUILD_DIRS = new Set(['.next', 'dist', 'build', '.turbo', '.cache', '.parcel-cache', '.svelte-kit', '.nuxt', '.output']);

export class PackError extends Error {
  constructor(
    message: string,
    readonly code: 'too_large' | 'empty' | 'io' = 'io',
  ) {
    super(message);
  }
}

/** `.env`, `.env.local`, `.env.production`... (nunca vão no pacote). */
export function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

function skippedByRule(rel: string): boolean {
  const parts = rel.split('/');
  if (isEnvFile(parts[parts.length - 1])) return true;
  return parts.slice(0, -1).some((p) => ALWAYS_SKIP_DIRS.has(p));
}

function git(dir: string, args: string[]): Promise<Buffer> {
  return new Promise((ok, fail) => {
    execFile('git', ['-C', dir, ...args], { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout) => (err ? fail(err) : ok(stdout)));
  });
}

async function gitFiles(dir: string): Promise<string[] | undefined> {
  try {
    const inside = (await git(dir, ['rev-parse', '--is-inside-work-tree'])).toString().trim();
    if (inside !== 'true') return undefined;
    const out = await git(dir, ['-c', 'core.quotepath=off', 'ls-files', '-co', '--exclude-standard', '-z']);
    return out
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .map((p) => p.replace(/\\/g, '/'));
  } catch {
    return undefined;
  }
}

async function walk(dir: string, keepDir: string | undefined): Promise<string[]> {
  const out: string[] = [];
  const visit = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (ALWAYS_SKIP_DIRS.has(e.name)) continue;
        if (BUILD_DIRS.has(e.name) && r !== keepDir && !(keepDir && keepDir.startsWith(`${r}/`))) continue;
        await visit(r);
      } else out.push(r);
    }
  };
  await visit('');
  return out;
}

export interface FileList {
  files: string[];
  /** Arquivos pulados com motivo (links simbólicos, sumidos...). */
  avisos: string[];
  git: boolean;
}

/** Arquivos que vão no pacote (caminhos relativos com "/", ordenados). */
export async function listProjectFiles(dir: string, opts: { tipo?: Tipo; config?: SiteConfig } = {}): Promise<FileList> {
  const keepDir = opts.tipo === 'static' && opts.config?.saida && opts.config.saida !== '.' ? opts.config.saida.replace(/^\.\//, '').replace(/\/+$/, '') : undefined;
  const fromGit = await gitFiles(dir);
  const raw = fromGit ?? (await walk(dir, keepDir));
  const avisos: string[] = [];
  const files: string[] = [];
  let links = 0;
  for (const rel of raw) {
    if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) continue;
    if (skippedByRule(rel)) continue;
    let st;
    try {
      st = await lstat(join(dir, ...rel.split('/')));
    } catch {
      continue; // apagado mas ainda no índice do git
    }
    if (st.isSymbolicLink()) {
      links++;
      continue;
    }
    if (!st.isFile()) continue;
    files.push(rel);
  }
  if (links) avisos.push(`${links} link(s) simbólico(s) ficaram fora do pacote.`);
  files.sort();
  return { files, avisos, git: !!fromGit };
}

// ---------------------------------------------------------------- tar (ustar + PAX)

function octal(n: number, width: number): string {
  return n.toString(8).padStart(width - 1, '0') + '\0';
}

function header(name: string, size: number, mode: number, mtime: number, type: '0' | 'x'): Buffer {
  const b = Buffer.alloc(512);
  b.write(name, 0, 100, 'utf8');
  b.write(octal(mode, 8), 100, 'ascii');
  b.write(octal(0, 8), 108, 'ascii');
  b.write(octal(0, 8), 116, 'ascii');
  b.write(octal(size, 12), 124, 'ascii');
  b.write(octal(mtime, 12), 136, 'ascii');
  b.write('        ', 148, 'ascii');
  b.write(type, 156, 'ascii');
  b.write('ustar\0', 257, 'ascii');
  b.write('00', 263, 'ascii');
  b.write('habblaud', 265, 'ascii');
  b.write('habblaud', 297, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += b[i];
  b.write(octal(sum, 7) + ' ', 148, 'ascii');
  return b;
}

function pad(size: number): Buffer {
  const r = size % 512;
  return r ? Buffer.alloc(512 - r) : Buffer.alloc(0);
}

function paxRecord(key: string, value: string): Buffer {
  const body = ` ${key}=${value}\n`;
  let len = Buffer.byteLength(body) + 1;
  while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
  return Buffer.from(`${len}${body}`, 'utf8');
}

/** Cabeçalho(s) de um arquivo: PAX quando o nome não cabe nos 100 bytes ASCII do ustar. */
export function entryHeader(name: string, size: number, mode: number, mtime: number): Buffer {
  const simple = Buffer.byteLength(name) <= 99 && /^[\x20-\x7e]*$/.test(name);
  if (simple) return header(name, size, mode, mtime, '0');
  const pax = paxRecord('path', name);
  const short = `PaxHeader/${name.replace(/[^\x20-\x7e]/g, '_').slice(-80)}`;
  return Buffer.concat([header(short, pax.length, 0o644, mtime, 'x'), pax, pad(pax.length), header(name.replace(/[^\x20-\x7e]/g, '_').slice(-99), size, mode, mtime, '0')]);
}

async function* tarStream(dir: string, files: string[]): AsyncGenerator<Buffer> {
  for (const rel of files) {
    const full = join(dir, ...rel.split('/'));
    let st;
    try {
      st = await lstat(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_BYTES) throw new PackError(`O arquivo ${rel} é grande demais para publicar (${Math.round(st.size / 1048576)} MB).`, 'too_large');
    const data = await readFile(full);
    const exec = process.platform !== 'win32' && (st.mode & 0o111) !== 0;
    yield entryHeader(rel, data.length, exec ? 0o755 : 0o644, Math.floor(st.mtimeMs / 1000));
    yield data;
    yield pad(data.length);
  }
  yield Buffer.alloc(1024);
}

export interface PackResult {
  /** Arquivo .tgz temporário (apague com cleanup()). */
  file: string;
  size: number;
  count: number;
  avisos: string[];
  cleanup: () => Promise<void>;
}

/** Empacota o projeto num .tgz temporário, parando com erro claro se passar do limite do plano. */
export async function packProject(dir: string, opts: { tipo?: Tipo; config?: SiteConfig; maxMB?: number } = {}): Promise<PackResult> {
  const maxMB = opts.maxMB && opts.maxMB > 0 ? opts.maxMB : DEFAULT_MAX_UPLOAD_MB;
  const maxBytes = maxMB * 1024 * 1024;
  const list = await listProjectFiles(dir, opts);
  if (!list.files.length) throw new PackError('A pasta do projeto não tem nenhum arquivo para publicar.', 'empty');
  const tmp = await mkdtemp(join(tmpdir(), 'hb-publicar-'));
  const file = `${tmp}${sep}projeto.tgz`;
  const cleanup = () => rm(tmp, { recursive: true, force: true });
  let size = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      size += chunk.length;
      if (size > maxBytes) cb(new PackError(`O projeto compactado passou de ${maxMB} MB, o limite do seu plano. Tire arquivos grandes (vídeos, backups, bancos de dados) da pasta ou coloque-os no .gitignore.`, 'too_large'));
      else cb(null, chunk);
    },
  });
  try {
    await pipeline(Readable.from(tarStream(dir, list.files)), createGzip({ level: 6 }), counter, createWriteStream(file));
  } catch (err) {
    await cleanup();
    if (err instanceof PackError) throw err;
    throw new PackError(`Não foi possível empacotar o projeto: ${(err as Error).message}`);
  }
  return { file, size, count: list.files.length, avisos: list.avisos, cleanup };
}
