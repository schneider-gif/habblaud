// Decoração opcional do escritório (Configurações › Escritório › Decoração). Desligada por padrão: só aparece para
// quem escolhe. "Brasil": varal de bandeirinhas verde e amarelo no alto das paredes e um coração verde e amarelo
// pendurado no meio do maior trecho de parede de cada sala. Só as cores, sem bandeira nem símbolo.
import { TILE } from '../../art/api';
import type { WallSegment } from '../layout/types';

export type Decoration = 'none' | 'brasil';
export const DECORATIONS: readonly Decoration[] = ['none', 'brasil'];

export const BR_GREEN = '#009C3B';
export const BR_YELLOW = '#FFDF00';
const STRING = '#5b4a36';
const WALL_CAP_H = 4;
/** Distância entre bandeirinhas (px de mundo). */
const STEP = 6;
/** Trecho de parede mais curto que ainda ganha varal. */
const MIN_RUN = 2 * TILE;

export interface Pennant { x: number; y: number; color: string; run: number }
export interface DecorPlan {
  strings: { x0: number; x1: number; y: number; sag: number }[];
  pennants: Pennant[];
  heart: { x: number; y: number } | null;
}

/** Trechos sólidos [a, b) de uma parede com passagens. */
function solidRuns(x: number, w: number, doorways: readonly { x: number; w: number }[] | undefined): [number, number][] {
  let runs: [number, number][] = [[x, x + w]];
  for (const d of doorways ?? []) {
    const next: [number, number][] = [];
    for (const [a, b] of runs) {
      if (d.x + d.w <= a || d.x >= b) next.push([a, b]);
      else {
        if (d.x > a) next.push([a, d.x]);
        if (d.x + d.w < b) next.push([d.x + d.w, b]);
      }
    }
    runs = next;
  }
  return runs;
}

/** Barriga do varal no ponto x de um trecho [a, b): 0 nas pontas, `sag` no meio. */
export function sagAt(x: number, a: number, b: number, sag: number): number {
  const t = (x - a) / Math.max(1, b - a);
  return Math.round(4 * sag * t * (1 - t));
}

/** Onde vai cada bandeirinha e o coração de uma área. Puro (testável sem canvas). */
export function planDecor(walls: readonly WallSegment[]): DecorPlan {
  const plan: DecorPlan = { strings: [], pennants: [], heart: null };
  let longest: { a: number; b: number; y: number; sag: number; run: number } | null = null;
  for (const w of walls) {
    if (w.kind !== 'face') continue;
    for (const [ra, rb] of solidRuns(w.x, w.w, w.doorways)) {
      const a = ra + 2;
      const b = rb - 2;
      if (b - a < MIN_RUN) continue;
      const y = w.y + WALL_CAP_H + 1;
      const sag = Math.min(4, Math.max(2, Math.round((b - a) / 40)));
      const run = plan.strings.push({ x0: a, x1: b, y, sag }) - 1;
      let i = 0;
      for (let x = a + 2; x + 4 <= b - 1; x += STEP, i++) plan.pennants.push({ x, y: y + sagAt(x + 2, a, b, sag), color: i % 2 ? BR_YELLOW : BR_GREEN, run });
      if (!longest || b - a > longest.b - longest.a) longest = { a, b, y, sag, run };
    }
  }
  if (longest) {
    const cx = Math.round((longest.a + longest.b) / 2);
    plan.heart = { x: cx - 4, y: longest.y + sagAt(cx, longest.a, longest.b, longest.sag) + 3 };
    // abre espaço no varal para o coração
    const run = longest.run;
    plan.pennants = plan.pennants.filter((p) => p.run !== run || p.x + 5 <= cx - 6 || p.x >= cx + 6);
  }
  return plan;
}

// Coração 9×8: metade esquerda verde, direita amarela, com brilho e contorno escuro.
const HEART = [
  '.##...##.',
  '#gg#.#yy#',
  '#gwggyyy#',
  '#ggggyyy#',
  '.#gggyy#.',
  '..#ggy#..',
  '...#g#...',
  '....#....',
];
const HEART_COLORS: Record<string, string> = { '#': '#1d3b22', g: BR_GREEN, y: BR_YELLOW, w: '#bff5cf' };

/** Desenha o plano sobre as paredes já pintadas. `t` (ms) balança as bandeirinhas de leve. */
export function drawDecor(ctx: CanvasRenderingContext2D, plan: DecorPlan, dy: number, t: number): void {
  ctx.fillStyle = STRING;
  for (const s of plan.strings) {
    for (let x = s.x0; x < s.x1; x++) ctx.fillRect(x, s.y + dy + sagAt(x, s.x0, s.x1, s.sag), 1, 1);
  }
  for (const p of plan.pennants) {
    const sway = Math.sin(t / 900 + p.x * 0.7) > 0.6 ? 1 : 0; // vento de ar-condicionado: uma ou outra mexe
    const y = p.y + dy + 1;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, y, 5, 1);
    ctx.fillRect(p.x + 1, y + 1, 3, 1);
    ctx.fillRect(p.x + 1 + sway, y + 2, 2, 1);
    ctx.fillRect(p.x + 2 + sway, y + 3, 1, 1);
  }
  if (plan.heart) {
    const { x, y } = plan.heart;
    ctx.fillStyle = STRING;
    ctx.fillRect(x + 4, y + dy - 2, 1, 2);
    for (let j = 0; j < HEART.length; j++) {
      const row = HEART[j];
      for (let i = 0; i < row.length; i++) {
        const c = HEART_COLORS[row[i]];
        if (!c) continue;
        ctx.fillStyle = c;
        ctx.fillRect(x + i, y + dy + j, 1, 1);
      }
    }
  }
}
