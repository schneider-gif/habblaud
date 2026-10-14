// Quadro de missões (puro): leitura defensiva do GET /api/missions e os textos/valores que o quadro mostra.
import type { MissionsView, MissionView } from '../../../shared/missions';

const STATES = new Set(['locked', 'available', 'active', 'done']);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function okMission(v: unknown): v is MissionView {
  const o = v as Partial<MissionView> | null;
  return !!o && typeof o.id === 'string' && isNum(o.number) && STATES.has(o.state as string) && isNum(o.coins) && isNum(o.xp);
}

export function parseMissionsView(raw: unknown): MissionsView | null {
  const o = raw as Partial<MissionsView> | null;
  if (!o || !Array.isArray(o.missions) || !o.missions.every(okMission)) return null;
  if (!o.wallet || !isNum(o.wallet.coins) || !Array.isArray(o.wallet.ledger)) return null;
  if (!isNum(o.xp) || !o.level || !isNum(o.level.level) || !isNum(o.streak) || !Array.isArray(o.celebrate)) return null;
  return o as MissionsView;
}

/** A missão da vez: liberada (esperando o "Começar") ou em andamento. */
export function currentMission(v: MissionsView): MissionView | undefined {
  return v.missions.find((m) => m.state === 'available' || m.state === 'active');
}

/** Balão sobre o quadro de cortiça da recepção (undefined = nada a dizer). */
export function boardHint(v: MissionsView): string | undefined {
  if (v.celebrate.length) return '🏆 Missão concluída!';
  const c = currentMission(v);
  if (!c) return undefined;
  return c.state === 'available' ? `📋 Missão nova: ${c.title ?? `nº ${c.number}`}` : `📋 Missão ${c.number} em andamento`;
}

export function stepsText(m: MissionView): string {
  if (!m.steps?.length) return '';
  return `${m.steps.filter((s) => s.ok).length} de ${m.steps.length} passos`;
}

/** 0..1 até o próximo nível (1 no nível máximo). */
export function levelProgress(v: MissionsView): number {
  const { floor, next } = v.level;
  if (next === undefined || next <= floor) return 1;
  return Math.max(0, Math.min(1, (v.xp - floor) / (next - floor)));
}

const CONFETTI_COLORS = ['#ffd75e', '#e05a5a', '#3f7fd8', '#4cae6a', '#f08a3c', '#b36be0'];

/** Pedaços do confete em pixel (posição em % da largura, atraso em ms, deriva lateral em px, cor). */
export function confetti(seed: number, n: number): { x: number; delay: number; dx: number; color: string; size: number }[] {
  let s = seed >>> 0 || 1;
  const rnd = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x1_0000_0000;
  };
  return Array.from({ length: n }, () => ({
    x: Math.round(rnd() * 100),
    delay: Math.round(rnd() * 600),
    dx: Math.round((rnd() - 0.5) * 120),
    color: CONFETTI_COLORS[Math.floor(rnd() * CONFETTI_COLORS.length)],
    size: rnd() < 0.3 ? 8 : 6,
  }));
}
