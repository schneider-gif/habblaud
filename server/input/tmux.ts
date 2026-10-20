// Mandar mensagens para um agente pelo escritório. Só funciona para sessões do Claude Code que rodam dentro do
// tmux (o processo herda TMUX e TMUX_PANE do pane): o texto entra por um buffer colado com bracketed paste
// (várias linhas chegam como um bloco, sem disparar Enter no meio) e um Enter envia. Também abre agentes novos
// numa sessão tmux própria, inclusive retomando uma sessão encerrada (claude --resume <sessionId>). Linux (lê
// /proc/<pid>/environ); em outro sistema, nada fica disponível.
import { execFile } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/** Maior mensagem aceita (caracteres). */
export const INPUT_MAX_CHARS = 8000;

/** sessionId do Claude Code: UUID em minúsculas (é também o nome do transcript). Única coisa que entra no --resume. */
const RESUME_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Comando padrão de um agente novo: shell de login, para o PATH do usuário achar o claude. */
const DEFAULT_CLAUDE = "bash -lc 'exec claude'";
/**
 * Agente novo do Codex: `--no-daemon` faz o próprio TUI gravar a conversa e segurar a trava dela
 * (thread-writer-locks/<id>.lock), que é como o Habblaude acha o agente e o pid dele (ver server/codex/proc.ts).
 */
const DEFAULT_CODEX = "bash -lc 'exec codex --no-daemon'";

/** Ferramenta de um agente aberto pelo escritório. */
export type SpawnEngine = 'claude' | 'codex';

export function cleanEngine(v: unknown): SpawnEngine {
  if (v === undefined || v === null || v === '' || v === 'claude') return 'claude';
  if (v === 'codex') return 'codex';
  throw new InputError(400, 'ferramenta inválida: use "claude" ou "codex"');
}

/** Comando do pane de um agente do Codex; para retomar, `codex resume --no-daemon <uuid>` (mesma validação do Claude). */
export function codexShellCommand(resume?: string, base?: string): string {
  if (resume !== undefined && !RESUME_ID.test(resume)) throw new InputError(400, 'id de sessão inválido para retomar');
  if (base !== undefined) return resume ? `${base} resume ${resume}` : base;
  return resume ? `bash -lc 'exec codex resume --no-daemon ${resume}'` : DEFAULT_CODEX;
}

/** Chave TOML (string básica) para um caminho: aspas e barras escapadas; caracteres de controle recusados. */
export function tomlKey(path: string): string {
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(path)) throw new InputError(400, 'pasta com caracteres inválidos');
  return `"${path.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Marca a pasta como confiável no config.toml do Codex (`[projects."<pasta>"] trust_level = "trusted"`, o mesmo que
 * o Codex grava ao responder "Trust and continue"). Devolve o texto novo, ou undefined se já estava marcada.
 */
export function withCodexTrust(config: string, dir: string): string | undefined {
  const header = `[projects.${tomlKey(dir)}]`;
  const idx = config.indexOf(header);
  if (idx >= 0) {
    const start = idx + header.length;
    const rest = config.slice(start);
    const end = rest.search(/^\s*\[/m);
    const block = end >= 0 ? rest.slice(0, end) : rest;
    const tail = end >= 0 ? rest.slice(end) : '';
    if (/^\s*trust_level\s*=\s*"trusted"/m.test(block)) return undefined;
    if (/^\s*trust_level\s*=/m.test(block)) return config.slice(0, start) + block.replace(/^(\s*)trust_level\s*=.*$/m, '$1trust_level = "trusted"') + tail;
    return `${config.slice(0, start)}\ntrust_level = "trusted"${rest}`;
  }
  const sep = config.length === 0 || config.endsWith('\n\n') ? '' : config.endsWith('\n') ? '\n' : '\n\n';
  return `${config}${sep}${header}\ntrust_level = "trusted"\n`;
}

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
  /** Comando que abre um agente novo do Codex (padrão: `bash -lc 'exec codex --no-daemon'`). */
  codexCommand?: string;
  /** config.toml do Codex (confiança por pasta; padrão: $CODEX_HOME/config.toml ou ~/.codex/config.toml). */
  codexConfig?: string;
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

/** Pasta dos projetos novos dentro do HOME (a mesma das missões e do painel do GitHub). */
export const NEW_PROJECTS_DIRNAME = 'projetos';

/** `p` é `root` ou fica dentro dele (os dois já com links resolvidos). */
function isInside(root: string, p: string): boolean {
  const rel = relative(root, p);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

/**
 * Pasta de um agente novo a partir do que foi digitado em "Pasta do projeto" (texto livre):
 * - vazio ou "~" = o HOME; "~/x" = x dentro do HOME; relativo = a partir do HOME;
 * - pasta que existe: usada como está (precisa ficar dentro do HOME, com links resolvidos);
 * - não existe e `create`: um nome simples, sem barra ("meu-site"), vira ~/projetos/meu-site; um caminho vira ele
 *   mesmo. Antes de criar, sobe até o pai que existe e confere o realpath dele dentro do HOME (um link simbólico
 *   para fora é recusado sem criar nada); só então `mkdir -p`.
 * Caracteres de controle são recusados antes de tudo. Erros são InputError 400.
 */
export async function resolveSpawnDir(home: string, cwd: unknown, opts: { create: boolean }): Promise<{ dir: string; created: boolean }> {
  const raw = typeof cwd === 'string' ? cwd.trim() : '';
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) throw new InputError(400, 'pasta com caracteres inválidos');
  const realHome = await realpath(home);
  const typed = raw === '~' ? '' : raw.startsWith('~/') ? raw.slice(2) : raw;
  const wanted = typed ? resolve(home, typed) : home;
  const outside = () => new InputError(400, 'a pasta precisa estar dentro do seu HOME');

  let existing: string | undefined;
  try {
    existing = await realpath(wanted);
  } catch {
    // não existe (ou link quebrado): pode ser um projeto novo, abaixo
  }
  if (existing !== undefined) {
    if (!isInside(realHome, existing)) throw outside();
    if (!(await stat(existing)).isDirectory()) throw new InputError(400, 'isso é um arquivo, não uma pasta');
    return { dir: existing, created: false };
  }
  if (!opts.create) throw new InputError(400, 'pasta não encontrada');

  const simple = raw !== '' && !raw.includes('/') && typed !== '.' && typed !== '..';
  const target = simple ? resolve(home, NEW_PROJECTS_DIRNAME, typed) : wanted;
  // Pai existente mais próximo, com links resolvidos: é ele que decide se a pasta nova fica dentro do HOME.
  const missing: string[] = [];
  let base = target;
  let realBase: string | undefined;
  while (realBase === undefined) {
    try {
      realBase = await realpath(base);
    } catch {
      const parent = dirname(base);
      if (parent === base) throw new InputError(400, 'pasta não encontrada');
      missing.unshift(basename(base));
      base = parent;
    }
  }
  if (!isInside(realHome, realBase)) throw outside();
  if (!missing.length) return { dir: realBase, created: false }; // ~/projetos/<nome> já existia
  const dir = join(realBase, ...missing);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    throw new InputError(400, 'não foi possível criar a pasta');
  }
  const real = await realpath(dir);
  if (!isInside(realHome, real)) throw outside();
  return { dir: real, created: true };
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
  const codexConfig = deps.codexConfig ?? resolve(process.env.CODEX_HOME?.trim() || resolve(home, '.codex'), 'config.toml');

  // Mesmo raciocínio do Claude: a pasta foi escolhida no escritório, então "Trust this folder?" já foi respondido.
  const markCodexTrusted = async (dir: string) => {
    let config = '';
    try {
      config = await readFile(codexConfig, 'utf8');
    } catch {
      // sem config ainda: nasce só com esta pasta
    }
    const next = withCodexTrust(config, dir);
    if (next === undefined) return;
    await mkdir(dirname(codexConfig), { recursive: true });
    const tmp = `${codexConfig}.habblaud-${now()}`;
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, codexConfig);
  };

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
      if (!/claude|codex/i.test((await readCmdline(pid)).replace(/\0/g, ' '))) return undefined;
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

    /**
     * Teclas para o pane do agente (responder um pedido de aprovação do Codex: "y", "p", "a", "Escape"). Só nomes de
     * tecla de uma lista fechada: nada de texto livre por aqui.
     */
    async sendKeys(id: string, keys: readonly string[]): Promise<void> {
      if (!keys.length || keys.some((k) => !/^(y|p|a|n|Escape|Enter)$/.test(k))) throw new InputError(400, 'tecla inválida');
      const t = await targetOf(id);
      if (!t) throw new InputError(409, 'este agente não roda no tmux: responda no terminal dele');
      for (const k of keys) await run(['-S', t.socket, 'send-keys', '-t', t.pane, k]);
    },

    /**
     * Teclas de navegação para dirigir o diálogo de uma pergunta com opções (AskUserQuestion): setas, Espaço, Enter e
     * Backspace. Lista fechada: Esc, Ctrl+C e texto livre nunca passam por aqui.
     */
    async driveKeys(id: string, keys: readonly string[]): Promise<void> {
      if (!keys.length || keys.length > 40 || keys.some((k) => !/^(Up|Down|Space|Enter|BSpace)$/.test(k))) throw new InputError(400, 'tecla inválida');
      const t = await targetOf(id);
      if (!t) throw new InputError(409, 'este agente não roda no tmux: responda no terminal dele');
      await run(['-S', t.socket, 'send-keys', '-t', t.pane, ...keys]);
    },

    /**
     * Uma tecla dos botões do escritório para um diálogo desconhecido na tela do agente (↑ ↓ Enter Esc). Esc só passa
     * por aqui, e uma por vez: quem chama (DialogWatcher) confere antes que a tela mostra um diálogo de seleção.
     */
    async navKeys(id: string, keys: readonly string[]): Promise<void> {
      if (keys.length !== 1 || !/^(Up|Down|Enter|Escape)$/.test(keys[0])) throw new InputError(400, 'tecla inválida');
      const t = await targetOf(id);
      if (!t) throw new InputError(409, 'este agente não roda no tmux: responda no terminal dele');
      await run(['-S', t.socket, 'send-keys', '-t', t.pane, keys[0]]);
    },

    /** Texto literal (send-keys -l) no pane: o campo "Outro" de uma pergunta. Uma linha, sem caracteres de controle. */
    async typeText(id: string, text: string): Promise<void> {
      // eslint-disable-next-line no-control-regex
      if (!text || text.length > INPUT_MAX_CHARS || /[\u0000-\u001f\u007f]/.test(text)) throw new InputError(400, 'texto inválido');
      const t = await targetOf(id);
      if (!t) throw new InputError(409, 'este agente não roda no tmux: responda no terminal dele');
      await run(['-S', t.socket, 'send-keys', '-t', t.pane, '-l', '--', text]);
    },

    /** Tela atual do pane do agente (texto puro), para conferir o que o Codex está pedindo. */
    async screen(id: string): Promise<string | undefined> {
      const t = await targetOf(id);
      if (!t) return undefined;
      try {
        return await capture(['-S', t.socket, 'capture-pane', '-p', '-J', '-t', t.pane]);
      } catch {
        return undefined;
      }
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

    /**
     * Ferramentas instaladas (o "+ Novo agente" oferece Claude e/ou Codex): procura os executáveis no PATH do
     * servidor e nas pastas comuns de instalação do usuário (o agente abre com shell de login, que pode ter outro PATH).
     */
    async engines(): Promise<{ claude: boolean; codex: boolean }> {
      const dirs = [...(process.env.PATH ?? '').split(':'), resolve(home, '.local/bin'), resolve(home, '.npm-global/bin'), resolve(home, 'bin'), '/usr/local/bin', '/usr/bin'];
      const has = async (name: string) => {
        for (const d of dirs) {
          if (!d) continue;
          try {
            await access(resolve(d, name), fsConstants.X_OK);
            return true;
          } catch {
            // não está aqui
          }
        }
        return false;
      };
      return { claude: await has('claude'), codex: await has('codex') };
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
     * Pasta nova (só sem `resume`) é criada dentro do HOME (ver resolveSpawnDir); `created` diz que nasceu agora.
     */
    async spawn(cwd: unknown, opts: { resume?: unknown; engine?: unknown } = {}): Promise<{ session: string; cwd: string; pid?: number; engine: SpawnEngine; created?: boolean }> {
      const resume = cleanResumeId(opts.resume);
      const engine = cleanEngine(opts.engine);
      const command = engine === 'codex' ? codexShellCommand(resume, deps.codexCommand) : claudeShellCommand(resume, deps.claudeCommand);
      // Retomar nunca cria pasta: a conversa é de uma pasta que existia (se sumiu, 400 como antes).
      const { dir, created } = await resolveSpawnDir(home, cwd, { create: resume === undefined });
      if (engine === 'codex') await markCodexTrusted(dir);
      else await markTrusted(dir);
      const session = engine === 'codex' ? `agente-codex-${now().toString(36)}` : `agente-${now().toString(36)}`;
      await run(['new-session', '-d', '-s', session, '-c', dir, command]);
      // `exec claude` no shell do pane: o pid do pane é o do Claude, e o id do agente será "<conta>:<pid>"
      let pid: number | undefined;
      try {
        const n = Number((await capture(['display-message', '-p', '-t', session, '#{pane_pid}'])).trim());
        if (Number.isSafeInteger(n) && n > 1) pid = n;
      } catch {
        // sem o pid o agente chega com nome sorteado
      }
      return { session, cwd: dir, pid, engine, ...(created ? { created: true } : {}) };
    },
  };
}

export type AgentInput = ReturnType<typeof createAgentInput>;
