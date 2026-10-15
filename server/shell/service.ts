// Terminal embutido: shell de verdade dentro do escritório, como o usuário que roda o Habblaud (nunca root).
//
// Cada aba é uma sessão tmux própria, `terminal-N`, no servidor tmux padrão do usuário: sobrevive a recarregar a
// página (e a fechar o navegador) e aparece no VS Code (`tmux attach -t terminal-1`). Sessão por aba, e não janelas
// de uma sessão única: clientes anexados à mesma sessão dividem a "janela atual", então duas abas (ou dois
// navegadores) pulariam juntos de uma janela para outra.
//
// PTY sem dependência nativa: o pacote da release é um tgz sem node_modules (nada de node-pty, que exige compilar no
// destino). Quem cria o pseudo-terminal é o script(1) do util-linux (pacote bsdutils, essencial no Debian/Ubuntu):
// `script -qfec "tmux attach -t =terminal-N" /dev/null` liga o PTY aos pipes do Node. O tamanho inicial vai por
// `stty rows/cols` antes do attach e o redimensionamento por `stty -F /dev/pts/N` no PTY do cliente tmux (o kernel
// manda SIGWINCH e o tmux redesenha). Também anexa às sessões `agente-*` que o escritório abre (primeira execução do
// Claude: tema e login).
import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Sessões das abas do terminal embutido. */
export const SHELL_SESSION = /^terminal-(\d{1,4})$/;
/** Sessões abertas pelo escritório ("+ Novo agente": agente-<base36>). */
export const AGENT_SESSION = /^agente-(codex-)?[a-z0-9]{1,16}$/;
/** Máximo de abas abertas ao mesmo tempo. */
export const SHELL_MAX_TABS = 12;

/**
 * Programas que uma aba nova pode rodar antes do shell (lista fechada: nada vem do corpo da requisição):
 * - claude: primeira execução do Claude (tema e login) — Missão 0;
 * - codex: login da conta OpenAI no Codex com código de dispositivo (`codex login --device-auth`, mostra link e código);
 * - gh: login no GitHub (`gh auth login --web`, código de dispositivo) e, logado, `gh auth setup-git` e o nome/e-mail
 *   do git a partir do `gh api user` (ver GH_LOGIN_SCRIPT).
 */
export type ShellProgram = 'claude' | 'codex' | 'gh';

export function cleanProgram(v: unknown, login?: unknown): ShellProgram | undefined {
  if (login === true) return 'claude';
  if (v === undefined || v === null || v === '') return undefined;
  if (v === 'claude' || v === 'codex' || v === 'gh') return v;
  throw new ShellError(400, 'programa inválido');
}

/**
 * Login no GitHub pelo terminal embutido. Tudo pelo gh no shell do usuário: o token fica com o gh (keyring/arquivo
 * dele), nunca passa pelo Habblaud. Depois do login: credential helper do git e user.name/user.email (e-mail público
 * ou o noreply do GitHub), só se ainda não houver.
 */
export const GH_LOGIN_SCRIPT = [
  'gh auth status >/dev/null 2>&1 || gh auth login --web --git-protocol https --hostname github.com || exit 1',
  'gh auth setup-git',
  'login=$(gh api user --jq .login 2>/dev/null)',
  'if [ -n "$login" ]; then',
  '  [ -n "$(git config --global user.name)" ] || git config --global user.name "$(gh api user --jq ".name // .login")"',
  '  if [ -z "$(git config --global user.email)" ]; then',
  '    email=$(gh api user --jq ".email // empty")',
  '    [ -n "$email" ] || email="$(gh api user --jq .id)+$login@users.noreply.github.com"',
  '    git config --global user.email "$email"',
  '  fi',
  '  echo; echo "GitHub conectado como @$login. Pode fechar esta aba e voltar ao escritório."',
  'fi',
].join('\n');

export interface ShellTab {
  /** Nome da sessão tmux (terminal-N). */
  id: string;
  /** Número da aba (o N). */
  n: number;
  /** Programa em primeiro plano (bash, vim, claude...). */
  command: string;
  /** Pasta atual do shell. */
  cwd: string;
  createdAt: number;
  /** Clientes anexados agora (outra aba do navegador, o VS Code...). */
  attached: number;
}

export interface AgentTmuxSession {
  session: string;
  pid: number;
  cwd: string;
  createdAt: number;
  command: string;
  /** Clientes tmux anexados agora (alguém olhando a sessão: terminal embutido, VS Code). */
  attached?: number;
}

export interface PtyHandle {
  onData(cb: (chunk: Buffer) => void): void;
  onExit(cb: (code: number | null) => void): void;
  write(data: string | Buffer): void;
  resize(cols: number, rows: number): void;
  pause(): void;
  resume(): void;
  kill(): void;
}

export class ShellError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ShellDeps {
  home: string;
  /** Shell de login das abas (do passwd; padrão /bin/bash). */
  shell?: string;
  /** Ambiente base dos processos (padrão: process.env, sem as variáveis do tmux pai nem tokens). */
  env?: NodeJS.ProcessEnv;
  /** Roda o tmux e devolve o stdout (testes trocam). */
  tmux?: (args: string[]) => Promise<string>;
  /** Cria o PTY anexado a uma sessão (testes trocam). */
  spawnPty?: (session: string, cols: number, rows: number, env: NodeJS.ProcessEnv) => PtyHandle;
}

/** Variáveis que não descem para o shell: tmux do pai (attach aninhado recusa) e credenciais do agente do Coder. */
const DROP_ENV = /^(TMUX|TMUX_PANE|CODER_AGENT_TOKEN.*|CODER_AGENT_AUTH|HB_AGENT_INIT|HABBLAUD_.*)$/;

export function shellEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !DROP_ENV.test(k)) out[k] = v;
  out.TERM = 'xterm-256color';
  out.COLORTERM = 'truecolor';
  if (!/utf-?8/i.test(out.LC_ALL ?? out.LC_CTYPE ?? out.LANG ?? '')) out.LANG = 'C.UTF-8';
  return out;
}

export function clampSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
  const c = Number(cols);
  const r = Number(rows);
  return {
    cols: Number.isFinite(c) ? Math.max(20, Math.min(500, Math.round(c))) : 100,
    rows: Number.isFinite(r) ? Math.max(5, Math.min(200, Math.round(r))) : 30,
  };
}

/** Comando do script(1): ajusta o tamanho do PTY e troca o shell pelo cliente tmux. Só nomes validados entram aqui. */
export function attachCommand(session: string, cols: number, rows: number): string {
  if (!SHELL_SESSION.test(session) && !AGENT_SESSION.test(session)) throw new ShellError(400, 'sessão inválida');
  return `stty rows ${rows | 0} cols ${cols | 0} 2>/dev/null; exec tmux -u attach-session -t '=${session}'`;
}

function realTmux(env: NodeJS.ProcessEnv): (args: string[]) => Promise<string> {
  return (args) =>
    new Promise((ok, fail) => {
      execFile('tmux', args, { timeout: 5000, env }, (err, stdout, stderr) => {
        if (err) fail(Object.assign(err, { stderr: String(stderr) }));
        else ok(String(stdout));
      });
    });
}

function realPty(session: string, cols: number, rows: number, env: NodeJS.ProcessEnv): PtyHandle {
  const child: ChildProcessWithoutNullStreams = spawn('script', ['-qfec', attachCommand(session, cols, rows), '/dev/null'], {
    env: { ...env, SHELL: '/bin/sh' },
    stdio: 'pipe',
  });
  let tty: string | undefined;
  let exited = false;
  const exitCbs: ((code: number | null) => void)[] = [];
  child.on('exit', (code) => {
    exited = true;
    for (const cb of exitCbs) cb(code);
  });
  child.on('error', () => {
    if (exited) return;
    exited = true;
    for (const cb of exitCbs) cb(null);
  });
  child.stdin.on('error', () => undefined);
  // O cliente tmux é o filho direto do script (o sh fez exec): o fd 0 dele é o lado escravo do PTY.
  const findTty = async (): Promise<string | undefined> => {
    if (tty) return tty;
    try {
      const kids = (await readFile(`/proc/${child.pid}/task/${child.pid}/children`, 'utf8')).trim().split(/\s+/).filter(Boolean);
      for (const k of kids) {
        const link = await readlink(`/proc/${k}/fd/0`);
        if (/^\/dev\/pts\/\d+$/.test(link)) return (tty = link);
      }
    } catch {
      // processo ainda nascendo ou já saiu
    }
    return undefined;
  };
  return {
    onData: (cb) => child.stdout.on('data', cb),
    onExit: (cb) => void exitCbs.push(cb),
    write: (data) => {
      if (!exited) child.stdin.write(data);
    },
    resize: (c, r) => {
      void findTty().then((t) => {
        if (t && !exited) execFile('stty', ['-F', t, 'rows', String(r | 0), 'cols', String(c | 0)], { timeout: 3000 }, () => undefined);
      });
    },
    pause: () => child.stdout.pause(),
    resume: () => child.stdout.resume(),
    kill: () => {
      if (!exited) child.kill('SIGHUP');
    },
  };
}

/** "no server running" / sessão inexistente: o tmux ainda não tem nada para listar. */
function isNoServer(err: unknown): boolean {
  const s = `${(err as { stderr?: string })?.stderr ?? ''} ${(err as Error)?.message ?? ''}`;
  return /no server running|error connecting|no sessions|can't find session|No such file or directory/i.test(s);
}

export class ShellService {
  private readonly env: NodeJS.ProcessEnv;
  private readonly tmux: (args: string[]) => Promise<string>;
  private readonly spawnPty: NonNullable<ShellDeps['spawnPty']>;
  private readonly shell: string;

  constructor(private readonly deps: ShellDeps) {
    this.env = shellEnv(deps.env ?? process.env);
    this.tmux = deps.tmux ?? realTmux(this.env);
    this.spawnPty = deps.spawnPty ?? realPty;
    this.shell = deps.shell && /^\/[\w./+-]+$/.test(deps.shell) ? deps.shell : '/bin/bash';
  }

  /** Por que o terminal embutido não funciona nesta máquina (tmux ou script ausentes); undefined = ok. */
  async probe(): Promise<string | undefined> {
    const has = (cmd: string, args: string[]) =>
      new Promise<boolean>((ok) => execFile(cmd, args, { timeout: 3000, env: this.env }, (err) => ok(!err || (err as NodeJS.ErrnoException).code !== 'ENOENT')));
    if (!(await has('tmux', ['-V']))) return 'o tmux não está instalado';
    if (!(await has('script', ['--version']))) return 'o script (util-linux) não está instalado';
    return undefined;
  }

  private async sessions(): Promise<string[]> {
    try {
      const out = await this.tmux(['list-sessions', '-F', '#{session_name}\t#{session_created}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}']);
      return out.split('\n').filter(Boolean);
    } catch (err) {
      if (isNoServer(err)) return [];
      throw err;
    }
  }

  async list(): Promise<ShellTab[]> {
    const tabs: ShellTab[] = [];
    for (const line of await this.sessions()) {
      const [name, created, attached, command, cwd] = line.split('\t');
      const m = SHELL_SESSION.exec(name);
      if (!m) continue;
      tabs.push({ id: name, n: Number(m[1]), command: command ?? '', cwd: cwd ?? '', createdAt: Number(created) * 1000 || 0, attached: Number(attached) || 0 });
    }
    return tabs.sort((a, b) => a.n - b.n);
  }

  async has(session: string): Promise<boolean> {
    return (await this.sessions()).some((l) => l.split('\t')[0] === session);
  }

  /** Sessões `agente-*` vivas (o escritório abriu um Claude ali), com o pid do pane (= pid do Claude: `exec claude`). */
  async agentSessions(): Promise<AgentTmuxSession[]> {
    const out: AgentTmuxSession[] = [];
    for (const line of await this.sessions()) {
      const [name, created, attached, command, cwd, pid] = line.split('\t');
      if (!AGENT_SESSION.test(name)) continue;
      const p = Number(pid);
      if (!Number.isSafeInteger(p) || p <= 1) continue;
      out.push({ session: name, pid: p, cwd: cwd ?? '', createdAt: Number(created) * 1000 || 0, command: command ?? '', attached: Number(attached) || 0 });
    }
    return out;
  }

  /**
   * Abre uma aba nova (sessão terminal-N no HOME, shell de login). `login`: roda o `claude` primeiro (Missão 0:
   * escolher o tema e entrar com a conta) e, ao sair dele, fica o shell.
   */
  async create(opts: { login?: boolean; program?: ShellProgram; cols?: unknown; rows?: unknown } = {}): Promise<ShellTab> {
    const tabs = await this.list();
    if (tabs.length >= SHELL_MAX_TABS) throw new ShellError(409, `limite de ${SHELL_MAX_TABS} abas abertas: feche alguma antes`);
    const used = new Set(tabs.map((t) => t.n));
    let n = 1;
    while (used.has(n)) n++;
    const name = `terminal-${n}`;
    const { cols, rows } = clampSize(opts.cols, opts.rows);
    const sh = this.shell.replace(/'/g, '');
    const program = opts.program ?? (opts.login ? 'claude' : undefined);
    let cmd = `exec ${sh} -l`;
    if (program === 'claude') cmd = `${sh} -lc 'claude; exec ${sh} -l'`;
    else if (program === 'codex') cmd = `${sh} -lc 'codex login --device-auth; exec ${sh} -l'`;
    else if (program === 'gh') {
      // O script vai num arquivo do próprio usuário (aspas e quebras de linha sem passar por escape de shell).
      const file = join(this.deps.home, '.habblaud', 'gh-login.sh');
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${GH_LOGIN_SCRIPT}\n`, { mode: 0o700 });
      cmd = `${sh} -lc '${sh} ${file.replace(/'/g, '')}; exec ${sh} -l'`;
    }
    await this.tmux([
      'new-session', '-d', '-s', name, '-c', this.deps.home, '-x', String(cols), '-y', String(rows), cmd,
      // sem -t: na mesma sequência, o alvo é a sessão recém-criada. Mouse do tmux desligado: arrastar seleciona no
      // navegador (Ctrl+C copia) e os links ficam clicáveis; a roda rola o histórico pelo modo cópia (scroll()).
      ';', 'set-option', 'status', 'off',
      ';', 'set-option', 'mouse', 'off',
    ]);
    return { id: name, n, command: opts.login ? 'claude' : sh.split('/').pop() ?? 'bash', cwd: this.deps.home, createdAt: Date.now(), attached: 0 };
  }

  /**
   * Roda do mouse: rola o histórico da sessão pelo modo cópia do tmux (o xterm não tem o que rolar: o tmux redesenha a
   * tela inteira). Para cima entra no modo cópia (`-e`: sai sozinho ao voltar ao fim); para baixo só rola se já estiver nele.
   */
  async scroll(session: string, lines: number): Promise<void> {
    if (!SHELL_SESSION.test(session) && !AGENT_SESSION.test(session)) return;
    const n = Math.max(1, Math.min(200, Math.abs(Math.round(lines))));
    const t = `=${session}:`;
    if (lines < 0) await this.tmux(['copy-mode', '-e', '-t', t, ';', 'send-keys', '-t', t, '-X', '-N', String(n), 'scroll-up']);
    else await this.tmux(['send-keys', '-t', t, '-X', '-N', String(n), 'scroll-down']).catch(() => undefined); // fora do modo cópia: nada a rolar
  }

  /** Encerra uma sessão agente-* (reinício depois do login, ver shell/setup.ts). */
  async killAgentSession(session: string): Promise<void> {
    if (!AGENT_SESSION.test(session)) throw new ShellError(400, 'sessão inválida');
    await this.tmux(['kill-session', '-t', `=${session}`]).catch(() => undefined);
  }

  async close(session: string): Promise<void> {
    if (!SHELL_SESSION.test(session)) throw new ShellError(400, 'aba inválida');
    try {
      await this.tmux(['kill-session', '-t', `=${session}`]);
    } catch (err) {
      if (isNoServer(err)) throw new ShellError(404, 'aba não encontrada');
      throw err;
    }
  }

  /** Anexa um PTY à sessão (aba terminal-N ou agente-*); a sessão precisa existir. */
  async attach(session: string, size: { cols?: unknown; rows?: unknown }): Promise<PtyHandle> {
    if (!SHELL_SESSION.test(session) && !AGENT_SESSION.test(session)) throw new ShellError(400, 'sessão inválida');
    if (!(await this.has(session))) throw new ShellError(404, 'sessão não encontrada (o terminal foi fechado?)');
    // Abas antigas (0.7.0 de teste) nasciam com o mouse do tmux ligado: desliga para a seleção do navegador funcionar.
    if (SHELL_SESSION.test(session)) await this.tmux(['set-option', '-t', `=${session}:`, 'mouse', 'off']).catch(() => undefined);
    const { cols, rows } = clampSize(size.cols, size.rows);
    return this.spawnPty(session, cols, rows, this.env);
  }
}
