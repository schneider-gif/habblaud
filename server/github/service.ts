// GitHub no escritório: tudo pelo GitHub CLI (`gh`) no shell do próprio usuário. O Habblaud nunca vê, guarda nem
// mostra token: o login acontece no terminal embutido (`gh auth login --web`, código de dispositivo) e o gh guarda a
// credencial dele. Aqui só rodamos comandos de leitura (`gh auth status`, `gh api user`, `gh repo list`,
// `gh search prs`) e, com confirmação explícita na página, `gh repo clone` e `gh repo create --source --push`.
import { execFile } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export class GithubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Roda um programa (sem shell) e devolve stdout/stderr/código. */
export type Runner = (cmd: string, args: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const realRunner: Runner = (cmd, args, opts = {}) =>
  new Promise((ok) => {
    execFile(cmd, args, { cwd: opts.cwd, timeout: opts.timeoutMs ?? 20_000, maxBuffer: 4 * 1024 * 1024, env: ghEnv() }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as NodeJS.ErrnoException).code === 'number' ? Number((err as NodeJS.ErrnoException).code) : (err as { code?: unknown }).code === 'ENOENT' ? 127 : 1) : 0;
      ok({ code, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });

/** Ambiente do gh: sem as variáveis do Habblaud/Coder; GH_PROMPT_DISABLED para nunca travar esperando teclado. */
function ghEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(HABBLAUD_.*|CODER_AGENT_TOKEN.*|CODER_AGENT_AUTH|TMUX|TMUX_PANE)$/.test(k)) env[k] = v;
  env.GH_PROMPT_DISABLED = '1';
  env.NO_COLOR = '1';
  return env;
}

export interface GithubStatus {
  /** gh instalado nesta máquina. */
  installed: boolean;
  /** Logado no github.com. */
  loggedIn: boolean;
  login?: string;
  name?: string;
  /** Motivo, quando não deu para conferir. */
  error?: string;
}

export interface GithubRepo {
  name: string;
  nameWithOwner: string;
  updatedAt?: string;
  isPrivate?: boolean;
  url?: string;
  description?: string;
}

export interface GithubPr {
  number: number;
  title: string;
  url: string;
  repo: string;
  updatedAt?: string;
}

export interface ProjectFolder {
  name: string;
  /** Já tem um remoto (origin). */
  remote?: string;
  git: boolean;
}

/** Nome de repositório "dono/nome" aceito (o que o GitHub permite). */
export const REPO_FULL = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
/** Pasta de ~/projetos aceita para criar repositório / destino de clone. */
export const FOLDER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `gh auth status` (texto, varia entre versões): logado se o código de saída for 0 e citar a conta. */
export function parseAuthStatus(code: number, out: string): { loggedIn: boolean; login?: string } {
  const login = /Logged in to github\.com (?:account|as) ([A-Za-z0-9-]+)/i.exec(out)?.[1];
  if (code !== 0) return { loggedIn: false };
  return login ? { loggedIn: true, login } : { loggedIn: /Logged in to/i.test(out) };
}

export function parseRepos(json: string): GithubRepo[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: GithubRepo[] = [];
  for (const r of arr) {
    if (!r || typeof r !== 'object') continue;
    const o = r as Record<string, unknown>;
    if (typeof o.nameWithOwner !== 'string' || !REPO_FULL.test(o.nameWithOwner)) continue;
    const repo: GithubRepo = { name: typeof o.name === 'string' ? o.name : o.nameWithOwner.split('/')[1], nameWithOwner: o.nameWithOwner };
    if (typeof o.updatedAt === 'string') repo.updatedAt = o.updatedAt;
    if (typeof o.isPrivate === 'boolean') repo.isPrivate = o.isPrivate;
    if (typeof o.url === 'string' && /^https:\/\/github\.com\//.test(o.url)) repo.url = o.url;
    if (typeof o.description === 'string' && o.description) repo.description = o.description.slice(0, 200);
    out.push(repo);
  }
  return out;
}

export function parsePrs(json: string): GithubPr[] {
  let arr: unknown;
  try {
    arr = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(arr)) return [];
  const out: GithubPr[] = [];
  for (const r of arr) {
    const o = (r ?? {}) as Record<string, unknown>;
    const repo = o.repository as Record<string, unknown> | undefined;
    const url = typeof o.url === 'string' && /^https:\/\/github\.com\//.test(o.url) ? o.url : undefined;
    if (typeof o.number !== 'number' || typeof o.title !== 'string' || !url) continue;
    const pr: GithubPr = { number: o.number, title: o.title.slice(0, 200), url, repo: typeof repo?.nameWithOwner === 'string' ? repo.nameWithOwner : '' };
    if (typeof o.updatedAt === 'string') pr.updatedAt = o.updatedAt;
    out.push(pr);
  }
  return out;
}

export interface GithubServiceDeps {
  home: string;
  /** ~/projetos */
  projectsDir: string;
  run?: Runner;
  now?: () => number;
}

export class GithubService {
  private readonly run: Runner;
  private readonly now: () => number;
  private cache: { at: number; status: GithubStatus } | null = null;

  constructor(private readonly deps: GithubServiceDeps) {
    this.run = deps.run ?? realRunner;
    this.now = deps.now ?? Date.now;
  }

  /** Logado? (cache de 20 s; `fresh` confere de novo — depois do login no terminal). */
  async status(fresh = false): Promise<GithubStatus> {
    if (!fresh && this.cache && this.now() - this.cache.at < 20_000) return this.cache.status;
    const r = await this.run('gh', ['auth', 'status', '--hostname', 'github.com']);
    let status: GithubStatus;
    if (r.code === 127) status = { installed: false, loggedIn: false, error: 'o GitHub CLI (gh) não está instalado neste escritório' };
    else {
      const parsed = parseAuthStatus(r.code, `${r.stdout}\n${r.stderr}`);
      status = { installed: true, loggedIn: parsed.loggedIn };
      if (parsed.loggedIn) {
        const u = await this.run('gh', ['api', 'user', '--jq', '{login: .login, name: .name}']);
        try {
          const j = JSON.parse(u.stdout) as { login?: unknown; name?: unknown };
          if (typeof j.login === 'string') status.login = j.login;
          if (typeof j.name === 'string' && j.name) status.name = j.name.slice(0, 100);
        } catch {
          if (parsed.login) status.login = parsed.login;
        }
        status.login ??= parsed.login;
      }
    }
    this.cache = { at: this.now(), status };
    return status;
  }

  private async needLogin(): Promise<GithubStatus> {
    const s = await this.status();
    if (!s.installed) throw new GithubError(503, s.error ?? 'gh não instalado');
    if (!s.loggedIn) throw new GithubError(409, 'conecte o GitHub primeiro (botão Conectar GitHub)');
    return s;
  }

  async repos(): Promise<GithubRepo[]> {
    await this.needLogin();
    const r = await this.run('gh', ['repo', 'list', '--limit', '50', '--json', 'name,nameWithOwner,updatedAt,isPrivate,url,description']);
    if (r.code !== 0) throw new GithubError(502, `gh repo list falhou: ${r.stderr.trim().slice(0, 200)}`);
    return parseRepos(r.stdout);
  }

  async prs(): Promise<GithubPr[]> {
    await this.needLogin();
    const r = await this.run('gh', ['search', 'prs', '--author', '@me', '--state', 'open', '--limit', '30', '--json', 'number,title,url,repository,updatedAt']);
    if (r.code !== 0) throw new GithubError(502, `gh search prs falhou: ${r.stderr.trim().slice(0, 200)}`);
    return parsePrs(r.stdout);
  }

  /** Pastas de ~/projetos (com remoto ou não), para "Novo repositório a partir de uma pasta". */
  async folders(): Promise<ProjectFolder[]> {
    let names: string[];
    try {
      names = (await readdir(this.deps.projectsDir, { withFileTypes: true })).filter((e) => e.isDirectory() && FOLDER.test(e.name)).map((e) => e.name);
    } catch {
      return [];
    }
    const out: ProjectFolder[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b)).slice(0, 100)) {
      const dir = join(this.deps.projectsDir, name);
      const git = await isDir(join(dir, '.git'));
      const f: ProjectFolder = { name, git };
      if (git) {
        const r = await this.run('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeoutMs: 5_000 });
        if (r.code === 0 && r.stdout.trim()) f.remote = r.stdout.trim().replace(/\/\/[^@/]+@/, '//');
      }
      out.push(f);
    }
    return out;
  }

  /** Clona "dono/nome" em ~/projetos/<nome> (nunca sobrescreve). */
  async clone(repo: unknown): Promise<{ dir: string; name: string }> {
    if (typeof repo !== 'string' || !REPO_FULL.test(repo)) throw new GithubError(400, 'repositório inválido (esperado dono/nome)');
    await this.needLogin();
    const name = repo.split('/')[1].replace(/\.git$/, '');
    if (!FOLDER.test(name)) throw new GithubError(400, 'nome de pasta inválido');
    const dir = resolve(this.deps.projectsDir, name);
    if (await exists(dir)) throw new GithubError(409, `já existe ~/${relHome(this.deps.home, dir)}: apague ou renomeie antes de clonar`);
    const r = await this.run('gh', ['repo', 'clone', repo, dir], { timeoutMs: 180_000 });
    if (r.code !== 0) throw new GithubError(502, `não deu para clonar: ${r.stderr.trim().slice(0, 300)}`);
    return { dir, name };
  }

  /**
   * Cria um repositório a partir de uma pasta de ~/projetos e faz o push (`gh repo create <nome> --source <pasta>
   * --push`, privado por padrão). Exige `confirm: true` (a página pergunta antes). Sem git, inicia; sem commit, faz o
   * primeiro com tudo o que houver.
   */
  async create(body: { folder?: unknown; visibility?: unknown; confirm?: unknown }): Promise<{ url?: string; repo: string; dir: string }> {
    if (body.confirm !== true) throw new GithubError(400, 'confirme a criação do repositório');
    const folder = body.folder;
    if (typeof folder !== 'string' || !FOLDER.test(folder)) throw new GithubError(400, 'pasta inválida');
    const visibility = body.visibility === 'public' ? 'public' : 'private';
    await this.needLogin();
    const dir = resolve(this.deps.projectsDir, folder);
    if (!(await isDir(dir))) throw new GithubError(404, 'pasta não encontrada em ~/projetos');
    if (!(await isDir(join(dir, '.git')))) {
      const init = await this.run('git', ['-C', dir, 'init', '-b', 'main']);
      if (init.code !== 0) throw new GithubError(502, `git init falhou: ${init.stderr.trim().slice(0, 200)}`);
    }
    const origin = await this.run('git', ['-C', dir, 'remote', 'get-url', 'origin']);
    if (origin.code === 0 && origin.stdout.trim()) throw new GithubError(409, 'esta pasta já tem um repositório remoto (origin)');
    const head = await this.run('git', ['-C', dir, 'rev-parse', '--verify', 'HEAD']);
    if (head.code !== 0) {
      await this.run('git', ['-C', dir, 'add', '-A']);
      const c = await this.run('git', ['-C', dir, 'commit', '-m', 'Primeiro commit']);
      if (c.code !== 0) throw new GithubError(409, `não deu para fazer o primeiro commit (pasta vazia ou git sem nome/e-mail): ${(c.stderr || c.stdout).trim().slice(0, 200)}`);
    }
    const r = await this.run('gh', ['repo', 'create', folder, `--${visibility}`, '--source', dir, '--remote', 'origin', '--push'], { cwd: dir, timeoutMs: 180_000 });
    if (r.code !== 0) throw new GithubError(502, `gh repo create falhou: ${r.stderr.trim().slice(0, 300)}`);
    const url = /https:\/\/github\.com\/[^\s]+/.exec(`${r.stdout}\n${r.stderr}`)?.[0];
    const s = await this.status();
    return { url, repo: `${s.login ?? ''}/${folder}`, dir };
  }
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function relHome(home: string, p: string): string {
  return p.startsWith(home + '/') ? p.slice(home.length + 1) : p;
}
