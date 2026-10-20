// Quais conversas do Codex estão ABERTAS agora e qual processo é o agente de cada uma.
//
// O Codex não tem um registro de sessões como o ~/.claude/sessions/<pid>.json do Claude Code. O que existe (0.162.1):
// <CODEX_HOME>/thread-writer-locks/<threadId>.lock, criado assim que a conversa abre (antes da primeira mensagem, quando
// o rollout ainda nem existe) com um flock de escrita do processo que grava a conversa; o arquivo some quando o
// Codex fecha direito. No Linux o dono do flock está em /proc/locks (pid + inode), o que separa travas vivas das que
// sobraram de um processo morto.
//
// Quem segura a trava: o próprio TUI quando ele roda sem o servidor compartilhado (`codex --no-daemon`, que é como o
// Habblaude abre o Codex, ou `features.daemon_auto_start = false` no config.toml); com o servidor compartilhado
// ("app-server daemon", padrão do 0.162), é o daemon — que segura a conversa um tempo depois de o TUI fechar e não
// está no tmux. Nesse caso o agente aparece, mas não recebe mensagens pelo escritório.
import { readdirSync, readFileSync, readlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** UUID (v7) de uma conversa do Codex: o nome do .lock e o fim do nome do rollout. */
export const THREAD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface ProcReader {
  /** Conteúdo de /proc/locks (undefined fora do Linux). */
  locks(): string | undefined;
  cmdline(pid: number): string | undefined;
  ppid(pid: number): number | undefined;
  cwd(pid: number): string | undefined;
}

export const realProc: ProcReader = {
  locks() {
    try {
      return readFileSync('/proc/locks', 'utf8');
    } catch {
      return undefined;
    }
  },
  cmdline(pid) {
    try {
      return readFileSync(`/proc/${pid}/cmdline`, 'latin1').replace(/\0+$/, '').replace(/\0/g, ' ');
    } catch {
      return undefined;
    }
  },
  ppid(pid) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
      // "pid (comm) state ppid ..." — comm pode ter espaços e parênteses: corta no último ")".
      const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      const n = Number(rest[1]);
      return Number.isSafeInteger(n) && n > 0 ? n : undefined;
    } catch {
      return undefined;
    }
  },
  cwd(pid) {
    try {
      return readlinkSync(`/proc/${pid}/cwd`);
    } catch {
      return undefined;
    }
  },
};

/** inode -> pid dos flocks de escrita em /proc/locks ("12: FLOCK  ADVISORY  WRITE 1896 00:3c:2015937 0 EOF"). */
export function parseProcLocks(text: string): Map<number, number> {
  const out = new Map<number, number>();
  for (const line of text.split('\n')) {
    const f = line.trim().split(/\s+/);
    // f: ["12:", "FLOCK", "ADVISORY", "WRITE", "1896", "00:3c:2015937", "0", "EOF"]; linhas "->" (bloqueadas) têm um campo a mais.
    const i = f[1] === '->' ? 1 : 0;
    if (f[1 + i] !== 'FLOCK' || f[3 + i] !== 'WRITE') continue;
    const pid = Number(f[4 + i]);
    const inode = Number((f[5 + i] ?? '').split(':')[2]);
    if (Number.isSafeInteger(pid) && pid > 0 && Number.isSafeInteger(inode) && inode > 0) out.set(inode, pid);
  }
  return out;
}

export interface OpenThread {
  threadId: string;
  /** Processo que segura a trava (undefined fora do Linux). */
  holder?: number;
}

/** Conversas abertas numa pasta do Codex. Fora do Linux, todo .lock presente conta como aberto (sem pid). */
export function openThreads(dir: string, proc: ProcReader = realProc): OpenThread[] {
  const lockDir = join(dir, 'thread-writer-locks');
  let names: string[];
  try {
    names = readdirSync(lockDir);
  } catch {
    return [];
  }
  const ids = names.filter((n) => n.endsWith('.lock') && THREAD_ID.test(n.slice(0, -5)));
  if (!ids.length) return [];
  const locks = proc.locks();
  if (locks === undefined) return ids.map((n) => ({ threadId: n.slice(0, -5) }));
  const byInode = parseProcLocks(locks);
  const out: OpenThread[] = [];
  for (const n of ids) {
    let ino: number;
    try {
      ino = statSync(join(lockDir, n)).ino;
    } catch {
      continue;
    }
    const holder = byInode.get(ino);
    if (holder !== undefined) out.push({ threadId: n.slice(0, -5), holder });
  }
  return out;
}

/** O processo é o servidor compartilhado do Codex ("codex app-server ..."), não um TUI? */
export function isDaemonCmdline(cmd: string | undefined): boolean {
  return !!cmd && /\bapp-server\b/.test(cmd);
}

/** É um processo do Codex (o binário nativo ou o lançador `node .../bin/codex`)? */
export function isCodexCmdline(cmd: string | undefined): boolean {
  return !!cmd && /(^|[/\s])codex(\.js)?(\s|$)|codex-[a-z0-9-]+\/vendor\/|@openai\/codex/.test(cmd);
}

/**
 * Pid que identifica o agente: o do processo que segura a trava ou, se o pai dele for o lançador do Codex em Node
 * (`node /usr/local/bin/codex` → binário nativo), o do pai — que é o pid do pane no tmux quando o Habblaude abre
 * `exec codex`, o mesmo que o "+ Novo agente" devolve.
 */
export function agentPidOf(holder: number, proc: ProcReader = realProc): number {
  const parent = proc.ppid(holder);
  if (parent && parent > 1 && isCodexCmdline(proc.cmdline(parent)) && !isDaemonCmdline(proc.cmdline(parent))) {
    const cmd = proc.cmdline(parent) ?? '';
    if (/\bnode\b/.test(cmd.split(' ')[0] ?? '') || /\bnode\b/.test(cmd)) return parent;
  }
  return holder;
}

/** Data (UTC) embutida num UUIDv7: os 48 primeiros bits são o instante em ms. */
export function uuidV7Time(id: string): number | undefined {
  const hex = id.replace(/-/g, '').slice(0, 12);
  if (!/^[0-9a-f]{12}$/.test(hex) || id[14] !== '7') return undefined;
  const ms = Number.parseInt(hex, 16);
  return ms > 1_500_000_000_000 && ms < 4_000_000_000_000 ? ms : undefined;
}

/** Pastas sessions/AAAA/MM/DD prováveis para uma conversa (dia do UUIDv7 e os vizinhos, pelo fuso). */
export function candidateDayDirs(sessionsDir: string, threadId: string, now: number): string[] {
  const base = uuidV7Time(threadId) ?? now;
  const out: string[] = [];
  for (const delta of [0, -1, 1]) {
    const d = new Date(base + delta * 86_400_000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    out.push(join(sessionsDir, String(y), m, day));
  }
  return out;
}

/** Acha o rollout de uma conversa (rollout-*-<threadId>.jsonl). `full` varre todas as pastas de dia. */
export function findRollout(dir: string, threadId: string, now: number, full = false): string | undefined {
  const sessions = join(dir, 'sessions');
  const suffix = `-${threadId}.jsonl`;
  const look = (d: string) => {
    try {
      const f = readdirSync(d).find((n) => n.startsWith('rollout-') && n.endsWith(suffix));
      return f ? join(d, f) : undefined;
    } catch {
      return undefined;
    }
  };
  for (const d of candidateDayDirs(sessions, threadId, now)) {
    const hit = look(d);
    if (hit) return hit;
  }
  if (!full) return undefined;
  for (const d of listDayDirs(sessions)) {
    const hit = look(d);
    if (hit) return hit;
  }
  return undefined;
}

/** Todas as pastas sessions/AAAA/MM/DD, da mais recente para a mais antiga. */
export function listDayDirs(sessions: string): string[] {
  const out: string[] = [];
  const sub = (d: string, re: RegExp) => {
    try {
      return readdirSync(d).filter((n) => re.test(n)).sort().reverse();
    } catch {
      return [];
    }
  };
  for (const y of sub(sessions, /^\d{4}$/)) for (const m of sub(join(sessions, y), /^\d{2}$/)) for (const d of sub(join(sessions, y, m), /^\d{2}$/)) out.push(join(sessions, y, m, d));
  return out;
}
