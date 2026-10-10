// Mandar mensagens para um agente pelo escritório. Só funciona para sessões do Claude Code que rodam dentro do
// tmux (o processo herda TMUX e TMUX_PANE do pane): o texto entra por um buffer colado com bracketed paste
// (várias linhas chegam como um bloco, sem disparar Enter no meio) e um Enter envia. Também abre agentes novos
// numa sessão tmux própria. Linux (lê /proc/<pid>/environ); em outro sistema, nada fica disponível.
import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, relative, resolve } from 'node:path';

/** Maior mensagem aceita (caracteres). */
export const INPUT_MAX_CHARS = 8000;

export interface TmuxTarget {
  /** Socket do servidor tmux (primeiro campo de TMUX). */
  socket: string;
  /** Pane do agente, ex.: "%3". */
  pane: string;
}

export interface AgentInputDeps {
  readEnviron?: (pid: number) => Promise<string>;
  run?: (args: string[]) => Promise<void>;
  home?: string;
  /** Comando (string de shell) que abre um agente novo; padrão: shell de login, para o PATH do usuário achar o claude. */
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
  const run =
    deps.run ??
    ((args: string[]) =>
      new Promise<void>((ok, fail) => {
        execFile('tmux', args, { timeout: 5000 }, (err) => (err ? fail(err) : ok()));
      }));
  const home = deps.home ?? homedir();
  const claude = deps.claudeCommand ?? "bash -lc 'exec claude'";
  const now = deps.now ?? Date.now;

  const targetOf = async (id: string): Promise<TmuxTarget | undefined> => {
    const pid = pidOfAgent(id);
    if (pid === undefined) return undefined;
    try {
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

    /** Abre um agente novo (claude numa sessão tmux própria) numa pasta dentro do HOME. */
    async spawn(cwd: unknown): Promise<{ session: string; cwd: string }> {
      const wanted = typeof cwd === 'string' && cwd.trim() ? resolve(home, cwd.trim()) : home;
      let dir: string;
      try {
        dir = await realpath(wanted);
      } catch {
        throw new InputError(400, 'pasta não encontrada');
      }
      const rel = relative(await realpath(home), dir);
      if (rel.startsWith('..') || isAbsolute(rel)) throw new InputError(400, 'a pasta precisa estar dentro do seu HOME');
      const session = `agente-${now().toString(36)}`;
      await run(['new-session', '-d', '-s', session, '-c', dir, claude]);
      return { session, cwd: dir };
    },
  };
}

export type AgentInput = ReturnType<typeof createAgentInput>;
