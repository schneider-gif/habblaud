// Estado das missões do escritório em <dataDir>/missions.json (versionado), mais as transições puras:
// uma missão por vez, recompensa paga uma vez por missão (Caixa do escritório), XP e dias seguidos.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MissionId } from '../../shared/missions';
import { errMsg, log } from '../log';
import { MISSIONS, missionById, type Mission } from './catalog';
import type { SentMessage, TurnEnd } from './detect';

export interface MissionsState {
  /** 2: entrou a Missão 0 (conta do Claude); a v1 é migrada em sanitize(). */
  version: 2;
  /** Quando cada missão foi começada. */
  started: Partial<Record<MissionId, number>>;
  completed: Partial<Record<MissionId, { at: number; by: 'auto' | 'manual' }>>;
  /** Caixa do escritório: `credited` = missões já pagas (o crédito nunca se repete). */
  wallet: { coins: number; credited: MissionId[]; ledger: { at: number; delta: number; mission: MissionId; text: string }[] };
  xp: number;
  /** Fins de turno e mensagens pelo escritório vistos com missão ativa (os mais recentes). */
  turns: TurnEnd[];
  messages: SentMessage[];
  /** Dias (AAAA-MM-DD, fuso do servidor) com missão começada/concluída ou mensagem pelo escritório. */
  days: string[];
  /** Concluídas cuja comemoração o quadro ainda não mostrou. */
  celebrate: MissionId[];
}

const MAX_EVENTS = 50;
const MAX_DAYS = 60;

export function emptyState(): MissionsState {
  return { version: 2, started: {}, completed: {}, wallet: { coins: 0, credited: [], ledger: [] }, xp: 0, turns: [], messages: [], days: [], celebrate: [] };
}

export function dayKey(at: number): string {
  const d = new Date(at);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function markDay(s: MissionsState, at: number): void {
  const k = dayKey(at);
  if (!s.days.includes(k)) s.days = [...s.days, k].sort().slice(-MAX_DAYS);
}

/** Dias seguidos terminando hoje ou ontem (ontem ainda vale: o dia de hoje pode não ter terminado). */
export function streak(days: readonly string[], today: string): number {
  const set = new Set(days);
  const prev = (k: string) => {
    const [y, m, d] = k.split('-').map(Number);
    return dayKey(new Date(y, m - 1, d - 1, 12).getTime());
  };
  let k = set.has(today) ? today : prev(today);
  let n = 0;
  while (set.has(k)) {
    n++;
    k = prev(k);
  }
  return n;
}

/** Primeira missão não concluída (a única liberada). */
export function currentMission(s: MissionsState): Mission | undefined {
  return MISSIONS.find((m) => !s.completed[m.id]);
}

/** A liberada, se já foi começada (ou se ativa sozinha, como a Missão 0). */
export function activeMission(s: MissionsState): Mission | undefined {
  const m = currentMission(s);
  return m && (m.auto || s.started[m.id] !== undefined) ? m : undefined;
}

export function missionState(s: MissionsState, id: MissionId): 'locked' | 'available' | 'active' | 'done' {
  if (s.completed[id]) return 'done';
  if (currentMission(s)?.id !== id) return 'locked';
  return s.started[id] !== undefined || missionById(id)?.auto ? 'active' : 'available';
}

export function startMission(s: MissionsState, id: unknown, now: number): { ok: true } | { status: 404 | 409; error: string } {
  const m = missionById(id);
  if (!m) return { status: 404, error: 'missão desconhecida' };
  const st = missionState(s, m.id);
  if (st === 'locked') return { status: 409, error: 'conclua a missão anterior primeiro' };
  if (st === 'done') return { status: 409, error: 'missão já concluída' };
  s.started[m.id] ??= now;
  markDay(s, now);
  return { ok: true };
}

/** Conclui a missão ativa e paga a recompensa (uma vez por missão). Devolve as moedas pagas agora. */
export function completeMission(s: MissionsState, id: MissionId, now: number, by: 'auto' | 'manual'): number {
  const m = missionById(id);
  if (!m || missionState(s, m.id) !== 'active') return 0;
  s.completed[m.id] = { at: now, by };
  if (!s.celebrate.includes(m.id)) s.celebrate.push(m.id);
  markDay(s, now);
  if (s.wallet.credited.includes(m.id)) return 0;
  s.wallet.credited.push(m.id);
  s.wallet.coins += m.coins;
  s.wallet.ledger.push({ at: now, delta: m.coins, mission: m.id, text: `Missão ${m.number}: ${m.text.pt.title}` });
  s.xp += m.xp;
  return m.coins;
}

export function markSeen(s: MissionsState, id: MissionId): void {
  s.celebrate = s.celebrate.filter((x) => x !== id);
}

export function recordTurns(s: MissionsState, ends: readonly TurnEnd[]): void {
  if (!activeMission(s) || !ends.length) return;
  s.turns = [...s.turns, ...ends].slice(-MAX_EVENTS);
}

export function recordMessage(s: MissionsState, msg: SentMessage): void {
  if (!activeMission(s)) return;
  s.messages = [...s.messages, msg].slice(-MAX_EVENTS);
  markDay(s, msg.at);
}

// ---------------------------------------------------------------- leitura defensiva do arquivo

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const str = (v: unknown): v is string => typeof v === 'string' && v.length <= 4096;
const isId = (v: unknown): v is MissionId => !!missionById(v);

function events(v: unknown): TurnEnd[] {
  if (!Array.isArray(v)) return [];
  return v.filter((e) => e && str(e.agentId) && str(e.dir) && num(e.at)).map((e) => ({ agentId: e.agentId, dir: e.dir, at: e.at })).slice(-MAX_EVENTS);
}

export function sanitize(raw: unknown): MissionsState {
  const s = emptyState();
  const j = raw as Record<string, unknown> | null;
  if (!j || typeof j !== 'object' || (j.version !== 1 && j.version !== 2)) return s;
  const started = (j.started ?? {}) as Record<string, unknown>;
  for (const m of MISSIONS) if (num(started[m.id])) s.started[m.id] = started[m.id] as number;
  const completed = (j.completed ?? {}) as Record<string, { at?: unknown; by?: unknown } | undefined>;
  for (const m of MISSIONS) {
    const c = completed[m.id];
    if (c && num(c.at) && (c.by === 'auto' || c.by === 'manual')) s.completed[m.id] = { at: c.at, by: c.by };
  }
  const w = (j.wallet ?? {}) as { coins?: unknown; credited?: unknown; ledger?: unknown };
  if (num(w.coins)) s.wallet.coins = Math.floor(w.coins);
  if (Array.isArray(w.credited)) s.wallet.credited = [...new Set(w.credited.filter(isId))];
  if (Array.isArray(w.ledger))
    s.wallet.ledger = w.ledger
      .filter((e) => e && num(e.at) && typeof e.delta === 'number' && isId(e.mission) && str(e.text))
      .map((e) => ({ at: e.at, delta: e.delta, mission: e.mission, text: e.text }));
  if (num(j.xp)) s.xp = Math.floor(j.xp);
  s.turns = events(j.turns);
  s.messages = events(j.messages);
  if (Array.isArray(j.days)) s.days = [...new Set(j.days.filter((d): d is string => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)))].sort().slice(-MAX_DAYS);
  if (Array.isArray(j.celebrate)) s.celebrate = [...new Set(j.celebrate.filter(isId))].filter((id) => !!s.completed[id]);
  if (j.version === 1) migrateV1(s);
  return s;
}

/**
 * v1 → v2: a Missão 0 (conta do Claude) passou a vir antes de tudo. Quem já concluiu alguma missão claramente já
 * tinha a conta conectada: a 0 entra como concluída na data da primeira conclusão, sem pagar nem comemorar.
 */
function migrateV1(s: MissionsState): void {
  const ats = Object.values(s.completed).map((c) => c!.at);
  if (!ats.length || s.completed['conta-claude']) return;
  s.completed['conta-claude'] = { at: Math.min(...ats), by: 'auto' };
  if (!s.wallet.credited.includes('conta-claude')) s.wallet.credited.push('conta-claude');
}

export class MissionsStore {
  private s: MissionsState = emptyState();

  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file || !existsSync(this.file)) return;
    let text = '';
    try {
      text = readFileSync(this.file, 'utf8');
      this.s = sanitize(JSON.parse(text));
    } catch (err) {
      this.s = emptyState();
      try {
        writeFileSync(`${this.file}.corrupt`, text);
      } catch {
        // sem disco: segue vazio
      }
      log.warn(`missions.json ilegível (${errMsg(err)}); as missões recomeçam (cópia em missions.json.corrupt).`);
    }
  }

  get(): MissionsState {
    return structuredClone(this.s);
  }

  /** Muda o estado e grava na hora (as mudanças são raras: começar, concluir, fim de turno com missão ativa). */
  update<T>(fn: (s: MissionsState) => T): T {
    const r = fn(this.s);
    this.flush();
    return r;
  }

  flush(): void {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.s));
      renameSync(tmp, this.file);
      log.clearOnce('missions-write');
    } catch (err) {
      log.warnOnce('missions-write', `Não foi possível gravar ${this.file} (${errMsg(err)}); as missões valem só nesta execução.`);
    }
  }
}
