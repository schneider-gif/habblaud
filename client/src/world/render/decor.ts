// Decoração opcional do escritório (Configurações › Escritório › Decoração). Desligada por padrão: só aparece para
// quem escolhe. "Brasil": varal de bandeirinhas verde e amarelo, bandeira do Brasil na parede de cada sala, mastro com
// bandeira tremulando, balões verde e amarelo, bandeirinha em cada mesa (renderer.drawFurniture) e futebol nas TVs.
import { FURNITURE, TILE } from '../../art/api';
import type { WallItemPlacement, WallSegment } from '../layout/types';

export type Decoration = 'none' | 'brasil';
export const DECORATIONS: readonly Decoration[] = ['none', 'brasil'];

export const BR_GREEN = '#009C3B';
export const BR_YELLOW = '#FFDF00';
export const BR_BLUE = '#002776';
const BR_WHITE = '#FFFFFF';
const STRING = '#5b4a36';
const POLE = '#c9c9c9';
const POLE_DARK = '#8a8a8a';
const WALL_CAP_H = 4;
const WALL_FACE_H = 2 * TILE;
/** Distância entre bandeirinhas do varal (px de mundo). */
const STEP = 9;
/** Trecho de parede mais curto que ainda ganha varal. */
const MIN_RUN = 2 * TILE;
/** Bandeira de parede (px). */
export const WALL_FLAG = { w: 24, h: 17 };
/** Bandeira do mastro (px). */
const POLE_FLAG = { w: 15, h: 11 };
const POLE_H = 34;

export interface Pennant { x: number; y: number; color: string; run: number }
export interface DecorPlan {
  strings: { x0: number; x1: number; y: number; sag: number }[];
  pennants: Pennant[];
  /** Bandeiras penduradas na parede (canto superior esquerdo). */
  flags: { x: number; y: number }[];
  /** Mastro: base no chão (x do mastro, y do pé). */
  pole: { x: number; y: number } | null;
  /** Cacho de balões: ponto onde os barbantes se juntam no chão. */
  balloons: { x: number; y: number } | null;
}

/** Trechos livres [a, b) de [x, x+w) depois de tirar os intervalos ocupados. */
export function freeRuns(x: number, w: number, taken: readonly { x: number; w: number }[] | undefined): [number, number][] {
  let runs: [number, number][] = [[x, x + w]];
  for (const d of taken ?? []) {
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

/** Largura (px) que um item de parede ocupa na face, com folga. */
function itemSpan(it: WallItemPlacement): { x: number; w: number } {
  const tiles = it.kind === 'painting' && it.variant === 'wide' ? 4 : FURNITURE[it.kind]?.footprint.w || 1;
  const w = tiles * TILE + 4;
  return { x: it.cx - w / 2, w };
}

/** Onde vai cada enfeite de uma área. Puro (testável sem canvas). */
export function planDecor(walls: readonly WallSegment[], items: readonly WallItemPlacement[] = []): DecorPlan {
  const plan: DecorPlan = { strings: [], pennants: [], flags: [], pole: null, balloons: null };
  let longest: { a: number; b: number; y: number } | null = null;
  const flagSpots: { x: number; y: number; room: number }[] = [];
  for (const w of walls) {
    if (w.kind !== 'face') continue;
    // itens presos nesta face (quadro, janela, TV...): a bandeira não fica por cima deles
    const onWall = items.filter((it) => it.on === 'face' && it.baseY > w.y && it.baseY <= w.y + WALL_FACE_H + 2 && it.cx >= w.x && it.cx <= w.x + w.w).map(itemSpan);
    for (const [ra, rb] of freeRuns(w.x, w.w, w.doorways)) {
      const a = ra + 2;
      const b = rb - 2;
      if (b - a < MIN_RUN) continue;
      const y = w.y + WALL_CAP_H + 1;
      const sag = Math.min(4, Math.max(2, Math.round((b - a) / 40)));
      const run = plan.strings.push({ x0: a, x1: b, y, sag }) - 1;
      let i = 0;
      for (let x = a + 3; x + 7 <= b - 2; x += STEP, i++) plan.pennants.push({ x, y: y + sagAt(x + 3, a, b, sag), color: i % 2 ? BR_YELLOW : BR_GREEN, run });
      if (!longest || b - a > longest.b - longest.a) longest = { a, b, y: w.y };
      // bandeira na maior folga livre deste trecho
      let best: [number, number] | null = null;
      for (const g of freeRuns(a, b - a, onWall)) if (g[1] - g[0] >= WALL_FLAG.w + 6 && (!best || g[1] - g[0] > best[1] - best[0])) best = g;
      if (best) flagSpots.push({ x: Math.round((best[0] + best[1] - WALL_FLAG.w) / 2), y: w.y + WALL_CAP_H + 10, room: best[1] - best[0] });
    }
  }
  // no máximo duas bandeiras de parede por área (as maiores folgas)
  plan.flags = flagSpots.sort((p, q) => q.room - p.room).slice(0, 2).map(({ x, y }) => ({ x, y }));
  if (longest && longest.b - longest.a >= 4 * TILE) {
    const floorY = longest.y + WALL_FACE_H + 9;
    plan.pole = { x: longest.a + 4, y: floorY };
    plan.balloons = { x: longest.b - 8, y: floorY };
  }
  return plan;
}

// ------------------------------------------------------------------ desenho

type Canvasish = HTMLCanvasElement;
const flagCache = new Map<string, Canvasish>();

/** Bandeira do Brasil em pixel art (verde, losango amarelo, círculo azul com a faixa branca e estrelas). */
export function flagCanvas(w: number, h: number): Canvasish {
  const key = `${w}x${h}`;
  const hit = flagCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const g = c.getContext('2d')!;
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const hw = w / 2 - Math.max(1.5, w * 0.085);
  const hh = h / 2 - Math.max(1.5, h * 0.12);
  const r = Math.max(2, h * 0.25);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let col = BR_GREEN;
      if (Math.abs(x - cx) / hw + Math.abs(y - cy) / hh <= 1) col = BR_YELLOW;
      const dx = x - cx;
      const dy = y - cy;
      if (dx * dx + dy * dy <= r * r) {
        col = BR_BLUE;
        // faixa branca: arco levemente curvo passando um pouco acima do centro
        const arc = cy - r * 0.15 + (dx * dx) / (r * 5) - (dx / r) * 0.6;
        if (r >= 3 && Math.abs(y - arc) < 0.55) col = BR_WHITE;
        // estrelas: alguns pontos brancos abaixo da faixa
        else if (r >= 3 && y > arc + 1 && ((x * 7 + y * 13) % 9 === 0)) col = BR_WHITE;
      }
      g.fillStyle = col;
      g.fillRect(x, y, 1, 1);
    }
  }
  // sombra leve na borda de baixo/direita (relevo de pano)
  g.fillStyle = 'rgba(0,0,0,0.18)';
  g.fillRect(0, h - 1, w, 1);
  g.fillRect(w - 1, 0, 1, h);
  flagCache.set(key, c);
  return c;
}

/** Bandeira tremulando: cada coluna sobe/desce um pouco conforme a distância do mastro. */
function drawWaving(ctx: CanvasRenderingContext2D, c: Canvasish, x: number, y: number, t: number, amp: number): void {
  for (let i = 0; i < c.width; i++) {
    const off = Math.round(Math.sin(t / 260 - i * 0.55) * amp * (i / c.width));
    ctx.drawImage(c, i, 0, 1, c.height, x + i, y + off, 1, c.height);
  }
}

function drawBalloons(ctx: CanvasRenderingContext2D, bx: number, by: number, t: number): void {
  const list = [
    { dx: -6, h: 26, col: BR_GREEN, ph: 0 },
    { dx: 0, h: 31, col: BR_YELLOW, ph: 1.7 },
    { dx: 6, h: 25, col: BR_BLUE, ph: 3.1 },
    { dx: -2, h: 20, col: BR_YELLOW, ph: 4.4 },
    { dx: 4, h: 18, col: BR_GREEN, ph: 5.2 },
  ];
  for (const b of list) {
    const sway = Math.round(Math.sin(t / 700 + b.ph));
    const top = by - b.h + Math.round(Math.sin(t / 900 + b.ph) * 0.8);
    const cx = bx + b.dx + sway;
    // barbante
    ctx.fillStyle = '#e8e8e8';
    for (let y = top + 6; y < by; y++) ctx.fillRect(Math.round(bx + (cx - bx) * ((by - y) / (by - top))), y, 1, 1);
    // balão 5x6 com brilho e nózinho
    ctx.fillStyle = b.col;
    ctx.fillRect(cx - 1, top - 1, 3, 1);
    ctx.fillRect(cx - 2, top, 5, 4);
    ctx.fillRect(cx - 1, top + 4, 3, 1);
    ctx.fillRect(cx, top + 5, 1, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillRect(cx - 1, top, 1, 1);
  }
  // pesinho no chão
  ctx.fillStyle = BR_BLUE;
  ctx.fillRect(bx - 1, by - 1, 3, 2);
}

function drawPole(ctx: CanvasRenderingContext2D, px: number, py: number, t: number): void {
  const top = py - POLE_H;
  // pé
  ctx.fillStyle = POLE_DARK;
  ctx.fillRect(px - 2, py - 1, 5, 2);
  // mastro com ponteira
  ctx.fillStyle = POLE;
  ctx.fillRect(px, top, 1, POLE_H);
  ctx.fillStyle = POLE_DARK;
  ctx.fillRect(px + 1, top, 1, POLE_H);
  ctx.fillStyle = BR_YELLOW;
  ctx.fillRect(px - 1 + 1, top - 2, 2, 2);
  drawWaving(ctx, flagCanvas(POLE_FLAG.w, POLE_FLAG.h), px + 2, top + 1, t, 1.6);
}

/** Bandeirinha de mesa (palito + bandeira 7×5), com a base na posição dada. */
export function drawDeskFlag(ctx: CanvasRenderingContext2D, x: number, y: number, t: number, seed: number): void {
  ctx.fillStyle = '#6b5a45';
  ctx.fillRect(x, y - 8, 1, 8);
  ctx.fillRect(x - 1, y - 1, 3, 1);
  drawWaving(ctx, flagCanvas(7, 5), x + 1, y - 8, t + (seed % 997) * 37, 0.8);
}

/** Desenha os enfeites de parede e de chão da área (por baixo dos móveis e personagens). */
export function drawDecor(ctx: CanvasRenderingContext2D, plan: DecorPlan, dy: number, t: number): void {
  for (const f of plan.flags) {
    const c = flagCanvas(WALL_FLAG.w, WALL_FLAG.h);
    // dois preguinhos e a bandeira esticada na parede (balança bem pouco)
    ctx.fillStyle = 'rgba(0,0,0,0.22)';
    ctx.fillRect(f.x + 1, f.y + dy + 1, WALL_FLAG.w, WALL_FLAG.h);
    drawWaving(ctx, c, f.x, f.y + dy, t, 0.6);
    ctx.fillStyle = '#444';
    ctx.fillRect(f.x, f.y + dy - 1, 1, 1);
    ctx.fillRect(f.x + WALL_FLAG.w - 1, f.y + dy - 1, 1, 1);
  }
  ctx.fillStyle = STRING;
  for (const s of plan.strings) {
    for (let x = s.x0; x < s.x1; x++) ctx.fillRect(x, s.y + dy + sagAt(x, s.x0, s.x1, s.sag), 1, 1);
  }
  for (const p of plan.pennants) {
    const sway = Math.sin(t / 900 + p.x * 0.7) > 0.7 ? 1 : 0; // vento do ar-condicionado: uma ou outra mexe
    const y = p.y + dy + 1;
    ctx.fillStyle = p.color;
    ctx.fillRect(p.x, y, 7, 2);
    ctx.fillRect(p.x + 1, y + 2, 5, 1);
    ctx.fillRect(p.x + 1 + sway, y + 3, 5 - sway, 1);
    ctx.fillRect(p.x + 2 + sway, y + 4, 3, 1);
    ctx.fillRect(p.x + 3 + sway, y + 5, 1, 1);
    ctx.fillStyle = 'rgba(255,255,255,0.35)';
    ctx.fillRect(p.x, y, 7, 1);
  }
  if (plan.pole) drawPole(ctx, plan.pole.x, plan.pole.y + dy, t);
  if (plan.balloons) drawBalloons(ctx, plan.balloons.x, plan.balloons.y + dy, t);
}

// ------------------------------------------------------------------ por cima (varais cruzando a sala) e no chão

export interface OverheadPlan {
  strings: { x0: number; y0: number; x1: number; y1: number; sag: number }[];
  balloons: { x: number; y: number }[];
}

/** Varais que atravessam a área de parede a parede e cachos de balões nos cantos (desenhados por cima de tudo). */
export function planOverhead(kind: string, px: { x: number; y: number; w: number; h: number }): OverheadPlan {
  const plan: OverheadPlan = { strings: [], balloons: [] };
  if (kind === 'restroom') return plan;
  const x0 = px.x + 6;
  const x1 = px.x + px.w - 6;
  if (x1 - x0 < 3 * TILE) return plan;
  if (kind === 'corridor') {
    // corredor: um varal comprido no meio, em lances de ~8 tiles (preso nas luminárias)
    const y = px.y + Math.round(px.h * 0.35);
    const span = 8 * TILE;
    for (let a = x0; a < x1 - TILE; a += span) plan.strings.push({ x0: a, y0: y, x1: Math.min(x1, a + span), y1: y, sag: 7 });
    return plan;
  }
  const top = px.y + WALL_FACE_H + 6;
  const bottom = px.y + px.h - 10;
  if (bottom - top < 3 * TILE) return plan;
  // dois varais cruzando a sala em X (festa), e um reto no meio
  plan.strings.push({ x0, y0: top, x1, y1: bottom - 8, sag: 10 });
  plan.strings.push({ x0, y0: bottom - 8, x1, y1: top, sag: 10 });
  plan.strings.push({ x0, y0: top + Math.round((bottom - top) * 0.45), x1, y1: top + Math.round((bottom - top) * 0.45), sag: 8 });
  plan.balloons.push({ x: x0 + 10, y: top + 22 }, { x: x1 - 10, y: top + 22 }, { x: x0 + 10, y: bottom }, { x: x1 - 10, y: bottom });
  return plan;
}

/** Ponto do varal em t (0..1): reta entre as pontas mais a barriga. */
function along(s: OverheadPlan['strings'][number], t: number): { x: number; y: number } {
  return { x: s.x0 + (s.x1 - s.x0) * t, y: s.y0 + (s.y1 - s.y0) * t + 4 * s.sag * t * (1 - t) };
}

const OVER_COLORS = [BR_GREEN, BR_YELLOW, BR_GREEN, BR_YELLOW, BR_BLUE];

export function drawOverhead(ctx: CanvasRenderingContext2D, plan: OverheadPlan, t: number): void {
  for (let si = 0; si < plan.strings.length; si++) {
    const s = plan.strings[si];
    const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
    const n = Math.max(2, Math.round(len));
    ctx.fillStyle = 'rgba(70,55,40,0.85)';
    for (let i = 0; i <= n; i++) {
      const p = along(s, i / n);
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    const count = Math.floor(len / 11);
    for (let k = 1; k < count; k++) {
      const p = along(s, k / count);
      const x = Math.round(p.x) - 3;
      const y = Math.round(p.y);
      const sway = Math.sin(t / 650 + k * 1.3 + si) > 0.55 ? 1 : 0;
      ctx.fillStyle = 'rgba(0,0,0,0.18)';
      ctx.fillRect(x + 2, y + 3, 6, 5);
      ctx.fillStyle = OVER_COLORS[(k + si) % OVER_COLORS.length];
      ctx.fillRect(x, y, 7, 2);
      ctx.fillRect(x + 1, y + 2, 5, 1);
      ctx.fillRect(x + 1 + sway, y + 3, 5 - sway, 1);
      ctx.fillRect(x + 2 + sway, y + 4, 3, 1);
      ctx.fillRect(x + 3 + sway, y + 5, 1, 1);
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x, y, 7, 1);
    }
  }
  for (const b of plan.balloons) drawBalloons(ctx, b.x, b.y, t);
}

/** Enfeites de chão: bandeira estendida como tapete (lounge e recepção) e confete verde e amarelo espalhado. */
export function drawFloorDecor(ctx: CanvasRenderingContext2D, kind: string, px: { x: number; y: number; w: number; h: number }, seed: number): void {
  if (kind === 'lounge' || kind === 'reception') {
    const w = Math.min(96, px.w - 4 * TILE);
    if (w >= 40) {
      const h = Math.round(w * 0.7);
      const c = flagCanvas(w, h);
      const x = Math.round(px.x + (px.w - w) / 2);
      const y = Math.round(px.y + WALL_FACE_H + (px.h - WALL_FACE_H - h) / 2 + 6);
      ctx.globalAlpha = 0.9;
      ctx.drawImage(c, x, y);
      ctx.globalAlpha = 1;
    }
  }
  // confete: posições fixas por área (hash simples), mais no corredor e no lounge
  const n = kind === 'corridor' || kind === 'lounge' ? Math.round((px.w * px.h) / 900) : Math.round((px.w * px.h) / 2600);
  let h = (seed ^ 0x9e3779b9) >>> 0;
  for (let i = 0; i < n; i++) {
    h = (Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
    const x = px.x + 4 + (h % Math.max(1, px.w - 8));
    const y = px.y + WALL_FACE_H + 2 + ((h >>> 12) % Math.max(1, px.h - WALL_FACE_H - 6));
    ctx.fillStyle = OVER_COLORS[(h >>> 24) % OVER_COLORS.length];
    ctx.fillRect(x, y, (h >>> 20) & 1 ? 2 : 1, 1);
  }
}
