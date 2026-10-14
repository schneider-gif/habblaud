import { describe, expect, it } from 'vitest';
import { FURNITURE, TILE } from '../../art/api';
import { renderFurniture } from '../../art/furniture';
import { layoutReception, missionBoardRect } from './core';

describe('quadro de missões na recepção', () => {
  it('é um item de parede de 2 tiles com a área dos bilhetes', () => {
    expect(FURNITURE.mission_board).toMatchObject({ mount: 'wall', footprint: { w: 2 } });
    const s = renderFurniture('mission_board').base;
    expect(s.buf.countOpaque()).toBeGreaterThan(100);
    expect(s.rects?.board).toBeDefined();
  });

  it('fica na parede da recepção e tem um retângulo clicável em px de mundo', () => {
    const rec = layoutReception();
    expect(rec.wallItems.filter((w) => w.kind === 'mission_board')).toHaveLength(1);
    const r = missionBoardRect(rec)!;
    const it = rec.wallItems.find((w) => w.kind === 'mission_board')!;
    expect(r.w).toBe(2 * TILE);
    expect(r.x + r.w / 2).toBe(it.cx);
    expect(r.y + r.h).toBeLessThanOrEqual(it.baseY);
    expect(r.y).toBeGreaterThanOrEqual(it.baseY - 2 * TILE);
  });

  it('não encosta nos outros itens da parede', () => {
    const rec = layoutReception();
    const half = (k: keyof typeof FURNITURE) => (FURNITURE[k].footprint.w * TILE) / 2;
    const items = rec.wallItems.filter((w) => w.on === 'face').map((w) => [w.cx - half(w.kind), w.cx + half(w.kind), w.kind] as const);
    const board = items.find((i) => i[2] === 'mission_board')!;
    for (const o of items) if (o !== board) expect(o[1] <= board[0] || o[0] >= board[1], o[2]).toBe(true);
  });
});
