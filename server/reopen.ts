// Reabre os agentes quando o escritório religa (ex.: desligou sozinho por inatividade e o container/VM voltou).
// Enquanto roda, grava em <dataDir>/abertos.json os agentes principais vivos; no boot, lê essa lista ANTES de
// sobrescrever e retoma (claude/codex --resume) os que não voltaram sozinhos. HABBLAUD_REOPEN=0 desliga.
import { readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OfficeSnapshot } from '../shared/types';
import { errMsg, log } from './log';

export interface OpenAgent {
  account: string;
  sessionId: string;
  cwd?: string;
  name?: string;
  appearance?: unknown;
}

/** Contas que o POST /api/agents/new sabe retomar (a padrão do Claude e a do Codex). */
const REOPENABLE = new Set(['.claude', '.codex']);

/** Agentes principais vivos do snapshot (sem demo, sem os que já saíram). */
export function openAgents(snap: OfficeSnapshot): OpenAgent[] {
  const rooms = new Map(snap.rooms.map((r) => [r.id, r.path]));
  const seen = new Set<string>();
  const out: OpenAgent[] = [];
  for (const a of snap.agents) {
    if (a.kind !== 'main' || !a.sessionId || a.id.startsWith('demo:') || a.status === 'offline' || a.status === 'done') continue;
    if (seen.has(a.sessionId)) continue;
    seen.add(a.sessionId);
    out.push({ account: a.account, sessionId: a.sessionId, cwd: rooms.get(a.roomId), name: a.name, appearance: a.appearance });
  }
  return out;
}

/** Lê a lista salva; arquivo ausente, corrompido ou com formato estranho = nada a reabrir. */
export function readOpen(file: string): OpenAgent[] {
  try {
    const j = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(j)) return [];
    return j.filter((e): e is OpenAgent => !!e && typeof e.account === 'string' && typeof e.sessionId === 'string');
  } catch {
    return [];
  }
}

/** Quais reabrir: só contas retomáveis, sem repetir e sem os que já estão vivos (serviço reiniciou, tmux seguiu). */
export function toReopen(saved: OpenAgent[], live: Set<string>): { reopen: OpenAgent[]; skipped: OpenAgent[] } {
  const reopen: OpenAgent[] = [];
  const skipped: OpenAgent[] = [];
  const seen = new Set<string>();
  for (const e of saved) {
    if (live.has(e.sessionId) || seen.has(e.sessionId)) continue;
    seen.add(e.sessionId);
    (REOPENABLE.has(e.account) ? reopen : skipped).push(e);
  }
  return { reopen, skipped };
}

function isClaudeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('claude');
  } catch {
    return false;
  }
}

/**
 * Remove ~/.claude*\/sessions/<pid>.json de processos mortos: sobram do boot anterior e, com o pid reaproveitado,
 * viram agente fantasma. Só faz sentido com o Habblaud no mesmo espaço de pids do claude (não no modo Docker).
 */
export function cleanDeadSessions(claudeDirs: string[], alive = isClaudeAlive): number {
  let n = 0;
  for (const dir of claudeDirs) {
    const sdir = join(dir, 'sessions');
    let files: string[];
    try {
      files = readdirSync(sdir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      let pid = NaN;
      try {
        pid = Number((JSON.parse(readFileSync(join(sdir, f), 'utf8')) as { pid?: unknown }).pid);
      } catch {
        // ilegível: morto
      }
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) continue;
      const base = f.slice(0, -5);
      for (const g of files) if (g === f || (g.startsWith(`${base}.`) && g.endsWith('.key'))) rmSync(join(sdir, g), { force: true });
      n++;
    }
  }
  return n;
}

type Post = (body: Record<string, unknown>) => Promise<{ ok?: boolean; error?: string }>;

export interface ReopenOptions {
  file: string;
  snapshot: () => OfficeSnapshot;
  post: Post;
  claudeDirs: string[];
  cleanSessions: boolean;
  /** Espera o watcher achar o que já está vivo antes de decidir (ms). */
  settleMs?: number;
  saveEveryMs?: number;
  /** Depois de pedir a última reabertura, ainda espera os agentes aparecerem no escritório (ms). */
  graceMs?: number;
  /** A reabertura terminou: o escritório deixa de mostrar "Retomando seus agentes". */
  onDone?: () => void;
}

export interface ReopenState {
  /** Agentes da lista salva sendo retomados agora; 0 = nada a esperar (ver OfficeSnapshot.meta.reopening). */
  pending(): number;
}

/** Liga a reabertura (no boot) e depois a gravação periódica da lista. */
export function startReopen(o: ReopenOptions): ReopenState {
  const saved = readOpen(o.file); // antes de qualquer gravação
  if (o.cleanSessions) {
    const n = cleanDeadSessions(o.claudeDirs);
    if (n) log.info(`   Reabrir agentes: ${n} registro(s) de sessão morta removido(s).`);
  }
  // Até os agentes voltarem o escritório fica uns segundos sem ninguém: a tela diz "Retomando", não "vazio".
  let pending = toReopen(saved, new Set()).reopen.length;
  const done = (): void => {
    if (!pending) return;
    pending = 0;
    o.onDone?.();
  };
  const t = setTimeout(() => void run(), o.settleMs ?? 15_000);
  t.unref?.();

  async function run(): Promise<void> {
    const live = new Set(openAgents(o.snapshot()).map((a) => a.sessionId));
    const { reopen, skipped } = toReopen(saved, live);
    if (!reopen.length) done();
    for (const e of skipped) log.info(`   Reabrir agentes: ${e.name ?? e.sessionId.slice(0, 8)} na conta ${e.account} fica para retomar à mão.`);
    for (const e of reopen) {
      const profile = { name: e.name, appearance: e.appearance };
      try {
        let r = await o.post({ resume: e.sessionId, account: e.account, ...profile });
        // sessão que nunca recebeu mensagem não tem histórico: abre um agente novo com o mesmo nome e visual
        if (!r.ok && e.account === '.claude') r = await o.post({ cwd: e.cwd, ...profile });
        log.info(r.ok ? `   Reabrir agentes: ${e.name ?? '?'} reaberto (${e.sessionId.slice(0, 8)}).` : `   Reabrir agentes: ${e.name ?? '?'} não reabriu: ${r.error ?? '?'}`);
      } catch (err) {
        log.warn(`   Reabrir agentes: ${e.name ?? '?'} não reabriu: ${errMsg(err)}`);
      }
      await new Promise((ok) => setTimeout(ok, 2_000));
    }
    if (reopen.length) setTimeout(done, o.graceMs ?? 20_000).unref?.();
    const save = openListSaver(o.file, saved);
    const tick = () => save(openAgents(o.snapshot()));
    tick();
    setInterval(tick, o.saveEveryMs ?? 10_000).unref?.();
  }
  return { pending: () => pending };
}

/**
 * Grava a lista (tmp + rename) só quando muda. Ao desligar, os agentes morrem antes do Habblaud: uma lista que
 * perdeu alguém só é gravada se vier igual duas vezes seguidas (o usuário fechou mesmo, não é o desligamento).
 */
export function openListSaver(file: string, initial: OpenAgent[] = []): (now: OpenAgent[]) => void {
  let last = '';
  let lastIds = new Set(initial.map((a) => a.sessionId));
  let shrink = '';
  return (now) => {
    const data = JSON.stringify(now);
    if (data === last) return;
    const ids = new Set(now.map((a) => a.sessionId));
    if ([...lastIds].some((id) => !ids.has(id)) && shrink !== data) {
      shrink = data;
      return;
    }
    shrink = '';
    try {
      writeFileSync(`${file}.tmp`, data);
      renameSync(`${file}.tmp`, file);
      last = data;
      lastIds = ids;
    } catch (err) {
      log.warnOnce(`reopen-save:${errMsg(err)}`, `Reabrir agentes: não gravei ${file}: ${errMsg(err)}`);
    }
  };
}
