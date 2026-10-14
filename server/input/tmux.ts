// Mandar mensagens para um agente pelo escritório. Só funciona para sessões do Claude Code que rodam dentro do
// tmux (o processo herda TMUX e TMUX_PANE do pane): o texto entra por um buffer colado com bracketed paste
// (várias linhas chegam como um bloco, sem disparar Enter no meio) e um Enter envia. Também abre agentes novos
// numa sessão tmux própria, inclusive retomando uma sessão encerrada (claude --resume <sessionId>). Linux (lê
// /proc/<pid>/environ); em outro sistema, nada fica disponível.
import { execFile } from 'node:child_process';
import { readdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/** Maior mensagem aceita (caracteres). */
export const INPUT_MAX_CHARS = 8000;

/** sessionId do Claude Code: UUID em minúsculas (é também o nome do transcript). Única coisa que entra no --resume. */
const RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comando padrão de um agente novo: shell de login, para o PATH do usuário achar o claude. */
const DEFAULT_CLAUDE = "bash -lc 'exec claude'";

/**
 * Sessão a retomar: ausente (undefined/null) = agente novo; senão precisa ser um UUID exato (maiúsculas viram
 * minúsculas). Qualquer outra coisa (espaço, aspas, $(), opções) é recusada com 400 antes de chegar perto do shell.
 */
export function cleanResumeId(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const id = typeof v === 'string' ? v.toLowerCase() : '';
  if (!RESUME_ID.test(id)) throw new InputError(400, 'id de sessão inválido para retomar');
  return id;
}

/**
 * Comando de shell do pane: `exec claude` (o pid do pane é o do Claude) e, para retomar, `--resume <uuid>`. O id
 * é validado de novo aqui: só [0-9a-f-] entra entre as aspas simples, então não há como fechá-las nem expandir nada.
 */
export function claudeShellCommand(resume?: string, base?: string): string {
  if (resume !== undefined && !RESUME_ID.test(resume)) throw new InputError(400, 'id de sessão inválido para retomar');
  if (base !== undefined) return resume ? `${base} --resume ${resume}` : base;
  return resume ? `bash -lc 'exec claude --resume ${resume}'` : DEFAULT_CLAUDE;
}

export interface TmuxTarget {
  /** Socket do servidor tmux (primeiro campo de TMUX). */
  socket: string;
  /** Pane do agente, ex.: "%3". */
  pane: string;
}

export interface AgentInputDeps {
  readEnviron?: (pid: number) => Promise<string>;
  /** Linha de comando do processo (NUL-separada): o pid só vale se for mesmo um Claude Code. */
  readCmdline?: (pid: number) => Promise<string>;
  /** Contas espelhadas de outra máquina (ponte): o pid é de lá, nunca recebem mensagens. */
  remoteAccounts?: ReadonlySet<string>;
  run?: (args: string[]) => Promise<void>;
  /** Roda tmux e devolve o stdout (pid do pane do agente novo). */
  capture?: (args: string[]) => Promise<string>;
  home?: string;
  /** Arquivo de estado do Claude Code com a confiança por pasta (padrão: ~/.claude.json). */
  claudeJson?: string;
  /**
   * Comando (string de shell) que abre um agente novo; padrão: shell de login, para o PATH do usuário achar o claude.
   * Ao retomar uma sessão, ` --resume <uuid>` vai no fim.
   */
  claudeCommand?: string;
  now?: () => number;
}

export class InputError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** pid do agente principal a partir do id "<conta>:<pid>"; subagentes e demo não recebem mensagens. */
export function pidOfAgent(id: string): number | undefined {
  if (id.startsWith('demo:')) return undefined;
  const m = /^[^:]+:(\d+)$/.exec(id);
  if (!m) return undefined;
  const pid = Number(m[1]);
  return Number.isSafeInteger(pid) && pid > 1 ? pid : undefined;
}

/** TMUX e TMUX_PANE de um environ (NUL-separado). */
export function tmuxTargetFromEnviron(environ: string): TmuxTarget | undefined {
  let tmux: string | undefined;
  let pane: string | undefined;
  for (const kv of environ.split('\0')) {
    if (kv.startsWith('TMUX=')) tmux = kv.slice(5);
    else if (kv.startsWith('TMUX_PANE=')) pane = kv.slice(10);
  }
  const socket = tmux?.split(',')[0];
  if (!socket || !isAbsolute(socket) || !pane || !/^%\d+$/.test(pane)) return undefined;
  return { socket, pane };
}

/** Texto aceito: não vazio, até INPUT_MAX_CHARS, sem caracteres de controle além de \n e \t. */
export function cleanInput(text: unknown): string {
  if (typeof text !== 'string') throw new InputError(400, 'esperado {text: string}');
  const t = text.replace(/\r\n?/g, '\n').trim();
  if (!t) throw new InputError(400, 'mensagem vazia');
  if (t.length > INPUT_MAX_CHARS) throw new InputError(413, `mensagem longa demais (máx. ${INPUT_MAX_CHARS} caracteres)`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) throw new InputError(400, 'a mensagem tem caracteres de controle');
  return t;
}

export function createAgentInput(deps: AgentInputDeps = {}) {
  const readEnviron = deps.readEnviron ?? ((pid: number) => readFile(`/proc/${pid}/environ`, 'latin1'));
  const readCmdline = deps.readCmdline ?? ((pid: number) => readFile(`/proc/${pid}/cmdline`, 'latin1'));
  const run =
    deps.run ??
    ((args: string[]) =>
      new Promise<void>((ok, fail) => {
        execFile('tmux', args, { timeout: 5000 }, (err) => (err ? fail(err) : ok()));
      }));
  const capture =
    deps.capture ??
    ((args: string[]) =>
      new Promise<string>((ok, fail) => {
        execFile('tmux', args, { timeout: 5000 }, (err, stdout) => (err ? fail(err) : ok(String(stdout))));
      }));
  const home = deps.home ?? homedir();
  const now = deps.now ?? Date.now;
  const claudeJson = deps.claudeJson ?? resolve(home, '.claude.json');

  // A pasta foi escolhida no escritório, que avisa que o Claude vai ler, editar e executar ali: equivale a
  // responder "Yes, I trust this folder", pergunta que travaria o agente invisível dentro do tmux.
  // ponytail: read-modify-write do ~/.claude.json sem lock; um Claude gravando no mesmo instante pode perder
  // esta marca (aí a pergunta aparece no terminal dele). Trocar por flag do CLI se um dia existir.
  const markTrusted = async (dir: string) => {
    let state: { projects?: Record<string, Record<string, unknown>> } = {};
    try {
      state = JSON.parse(await readFile(claudeJson, 'utf8'));
    } catch {
      // sem o arquivo ainda: nasce só com esta pasta
    }
    const projects = (state.projects ??= {});
    if (projects[dir]?.hasTrustDialogAccepted === true) return;
    projects[dir] = { ...projects[dir], hasTrustDialogAccepted: true };
    const tmp = `${claudeJson}.habblaud-${now()}`;
    await writeFile(tmp, JSON.stringify(state, null, 2), { mode: 0o600 });
    await rename(tmp, claudeJson);
  };

  const targetOf = async (id: string): Promise<TmuxTarget | undefined> => {
    const pid = pidOfAgent(id);
    if (pid === undefined) return undefined;
    // agente de outra máquina: o mesmo número de pid aqui é outro processo qualquer
    if (deps.remoteAccounts?.has(id.slice(0, id.lastIndexOf(':')))) return undefined;
    try {
      // pid reaproveitado por outro programa: nunca digitar no tmux de quem não é o Claude
      if (!/claude/i.test((await readCmdline(pid)).replace(/\0/g, ' '))) return undefined;
      return tmuxTargetFromEnviron(await readEnviron(pid));
    } catch {
      return undefined; // processo sumiu, de outro usuário ou sistema sem /proc
    }
  };

  return {
    /** O agente recebe mensagens? (principal vivo, rodando no tmux). */
    async available(id: string): Promise<boolean> {
      return (await targetOf(id)) !== undefined;
    },

    async send(id: string, text: unknown): Promise<void> {
      const msg = cleanInput(text);
      const t = await targetOf(id);
      if (!t) throw new InputError(409, 'este agente não roda no tmux: abra o Claude de novo pelo terminal do escritório');
      const buffer = `habblaud-${now()}`;
      await run(['-S', t.socket, 'set-buffer', '-b', buffer, '--', msg]);
      await run(['-S', t.socket, 'paste-buffer', '-d', '-p', '-b', buffer, '-t', t.pane]);
      await run(['-S', t.socket, 'send-keys', '-t', t.pane, 'Enter']);
    },

    /** Pastas do HOME (sem as ocultas), para o diálogo de agente novo sugerir. */
    async folders(): Promise<string[]> {
      try {
        const ents = await readdir(home, { withFileTypes: true });
        return ents.filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name).sort((a, b) => a.localeCompare(b)).slice(0, 100);
      } catch {
        return [];
      }
    },

    /** HOME (com links resolvidos): o histórico só oferece "Retomar" para sessões de pastas dentro dele. */
    async home(): Promise<string> {
      try {
        return await realpath(home);
      } catch {
        return home;
      }
    },

    /**
     * Abre um agente novo (claude numa sessão tmux própria) numa pasta dentro do HOME. Com `resume` (sessionId),
     * retoma aquela conversa (`claude --resume <uuid>`); a pasta passa pelas mesmas checagens e pela confiança.
     */
    async spawn(cwd: unknown, opts: { resume?: unknown } = {}): Promise<{ session: string; cwd: string; pid?: number }> {
      const resume = cleanResumeId(opts.resume);
      const command = claudeShellCommand(resume, deps.claudeCommand);
      const wanted = typeof cwd === 'string' && cwd.trim() ? resolve(home, cwd.trim()) : home;
      let dir: string;
      try {
        dir = await realpath(wanted);
      } catch {
        throw new InputError(400, 'pasta não encontrada');
      }
      const rel = relative(await realpath(home), dir);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new InputError(400, 'a pasta precisa estar dentro do seu HOME');
      await markTrusted(dir);
      const session = `agente-${now().toString(36)}`;
      await run(['new-session', '-d', '-s', session, '-c', dir, command]);
      // `exec claude` no shell do pane: o pid do pane é o do Claude, e o id do agente será "<conta>:<pid>"
      let pid: number | undefined;
      try {
        const n = Number((await capture(['display-message', '-p', '-t', session, '#{pane_pid}'])).trim());
        if (Number.isSafeInteger(n) && n > 1) pid = n;
      } catch {
        // sem o pid o agente chega com nome sorteado
      }
      return { session, cwd: dir, pid };
    },
  };
}

export type AgentInput = ReturnType<typeof createAgentInput>;
