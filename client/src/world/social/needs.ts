// Necessidades dos personagens (Água, Comida, Lazer): só diversão, nunca impedem o agente de trabalhar.
// Cada barra cai 100% ao longo de 24 h; beber, comer ou jogar enche. Umas 3 vezes por dia de cada coisa
// (~34% cada) mantém a barra cheia. Fica no mesmo armazenamento das carteiras (servidor via /api/state,
// ou o navegador), por NOME do agente: o nome sobrevive a reinícios do Claude Code; o id (pid) não.
import type { StorageLike } from './wallet';

export type NeedKind = 'agua' | 'comida' | 'lazer';
export const NEED_KINDS: readonly NeedKind[] = ['agua', 'comida', 'lazer'];
export const NEED_LABEL: Readonly<Record<NeedKind, { emoji: string; label: string }>> = {
  agua: { emoji: '💧', label: 'Água' },
  comida: { emoji: '🍔', label: 'Comida' },
  lazer: { emoji: '🎮', label: 'Lazer' },
};

/** Queda por milissegundo: 100% em 24 h. */
const DECAY_PER_MS = 100 / (24 * 3_600_000);
/** Quem chega pela primeira vez começa assim (nem cheio, nem vazio). */
const START = 60;
const STORAGE_KEY = 'habblaude.needs.v1';
const MAX_ENTRIES = 400;

export interface NeedsEntry {
  agua: number;
  comida: number;
  lazer: number;
  /** Quando os valores acima foram calculados (a queda conta a partir daqui). */
  at: number;
}

export class Needs {
  private map = new Map<string, NeedsEntry>();
  private dirty = false;

  constructor(private readonly storage: StorageLike | null) {
    this.load();
  }

  private load(): void {
    try {
      const raw = this.storage?.getItem(STORAGE_KEY);
      if (!raw) return;
      for (const [k, v] of Object.entries(JSON.parse(raw) as Record<string, NeedsEntry>)) {
        if (v && typeof v.at === 'number') this.map.set(k, { agua: clamp(v.agua), comida: clamp(v.comida), lazer: clamp(v.lazer), at: v.at });
      }
    } catch {
      // armazenamento corrompido: começa do zero
    }
  }

  /** Valores atuais (já com a queda até `now`). */
  get(name: string, now: number): NeedsEntry {
    const e = this.map.get(name);
    if (!e) return { agua: START, comida: START, lazer: START, at: now };
    const drop = Math.max(0, now - e.at) * DECAY_PER_MS;
    return { agua: clamp(e.agua - drop), comida: clamp(e.comida - drop), lazer: clamp(e.lazer - drop), at: now };
  }

  /** Beber/comer/jogar: soma `amount` (%) à barra, já descontando a queda até agora. */
  bump(name: string, kind: NeedKind, amount: number, now: number): void {
    if (!name) return;
    const cur = this.get(name, now);
    cur[kind] = clamp(cur[kind] + amount);
    this.map.set(name, cur);
    this.dirty = true;
    if (this.map.size > MAX_ENTRIES) {
      const oldest = [...this.map].sort((a, b) => a[1].at - b[1].at)[0];
      if (oldest) this.map.delete(oldest[0]);
    }
  }

  /** Grava se mudou (chamado junto com o salvamento das carteiras). */
  save(): void {
    if (!this.dirty || !this.storage) return;
    this.dirty = false;
    try {
      this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.map)));
    } catch {
      // cheio ou bloqueado: fica só em memória
    }
  }
}

/** Média das três barras (o coração). */
export function needsMood(e: NeedsEntry): number {
  return (e.agua + e.comida + e.lazer) / 3;
}

function clamp(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : START;
  return Math.max(0, Math.min(100, v));
}

/** Quanto cada atividade enche. Copa = um gole e uma beliscada; café conta menos que água. */
export const NEED_GAIN: Readonly<Record<string, Partial<Record<NeedKind, number>>>> = {
  water: { agua: 34 },
  coffee: { agua: 20 },
  snack: { comida: 34 },
  kitchen: { agua: 20, comida: 25 },
  lounge: { lazer: 20 },
  phone: { lazer: 10 },
  pingpong: { lazer: 34 },
  arcade: { lazer: 34 },
  tv: { lazer: 30 },
  videogame: { lazer: 34 },
  rps: { lazer: 20 },
};
