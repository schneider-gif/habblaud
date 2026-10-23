import { describe, expect, it } from 'vitest';
import { BR_GREEN, BR_YELLOW, freeRuns, planDecor, sagAt, WALL_FLAG } from './decor';
import type { WallItemPlacement, WallSegment } from '../layout/types';
import { DEFAULT_PREFS, sanitizePrefs, worldOptionsFrom } from '../../ui/prefs';

const style = { base: '#ccc' };

describe('decoração Brasil', () => {
  it('vem desligada e só aceita valores conhecidos', () => {
    expect(DEFAULT_PREFS.decoration).toBe('none');
    expect(sanitizePrefs({ decoration: 'brasil' }).decoration).toBe('brasil');
    expect(sanitizePrefs({ decoration: 'natal' }).decoration).toBe('none');
    expect(worldOptionsFrom(sanitizePrefs({ decoration: 'brasil' })).decoration).toBe('brasil');
  });

  it('varal só nas paredes de face, pulando as passagens, alternando verde e amarelo', () => {
    const walls: WallSegment[] = [
      { kind: 'face', x: 0, y: 0, w: 160, style, doorways: [{ x: 64, w: 32 }] },
      { kind: 'south', x: 0, y: 200, w: 160, style },
      { kind: 'cap', x: 0, y: 0, w: 16, h: 100, style },
    ];
    const p = planDecor(walls);
    expect(p.strings.map((s) => [s.x0, s.x1])).toEqual([[2, 62], [98, 158]]);
    for (const pen of p.pennants) expect(pen.x + 7 > 64 && pen.x < 96).toBe(false);
    expect(new Set(p.pennants.map((x) => x.color))).toEqual(new Set([BR_GREEN, BR_YELLOW]));
  });

  it('bandeira de parede fica fora dos quadros e janelas; mastro e balões nas pontas da maior parede', () => {
    const walls: WallSegment[] = [{ kind: 'face', x: 0, y: 0, w: 192, style }];
    const items: WallItemPlacement[] = [{ id: 'j', kind: 'window', cx: 40, baseY: 24, on: 'face', order: 0 }];
    const p = planDecor(walls, items);
    expect(p.flags.length).toBeGreaterThan(0);
    for (const f of p.flags) expect(f.x < 40 + 18 && f.x + WALL_FLAG.w > 40 - 18).toBe(false);
    expect(p.pole?.x).toBeLessThan(20);
    expect(p.balloons?.x).toBeGreaterThan(170);
  });

  it('parede curta fica sem varal, sem mastro e sem balões', () => {
    const p = planDecor([{ kind: 'face', x: 0, y: 0, w: 30, style }]);
    expect(p.strings).toEqual([]);
    expect(p.pole).toBeNull();
    expect(p.balloons).toBeNull();
  });

  it('a barriga do varal é zero nas pontas e máxima no meio; trechos livres', () => {
    expect(sagAt(0, 0, 100, 3)).toBe(0);
    expect(sagAt(100, 0, 100, 3)).toBe(0);
    expect(sagAt(50, 0, 100, 3)).toBe(3);
    expect(freeRuns(0, 100, [{ x: 10, w: 20 }, { x: 50, w: 10 }])).toEqual([[0, 10], [30, 50], [60, 100]]);
  });
});
