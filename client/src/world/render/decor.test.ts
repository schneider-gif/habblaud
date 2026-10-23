import { describe, expect, it } from 'vitest';
import { BR_GREEN, BR_YELLOW, planDecor, sagAt } from './decor';
import type { WallSegment } from '../layout/types';
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
    for (const pen of p.pennants) expect(pen.x >= 64 && pen.x < 96).toBe(false);
    expect(new Set(p.pennants.map((x) => x.color))).toEqual(new Set([BR_GREEN, BR_YELLOW]));
    expect(p.heart).not.toBeNull();
    // o coração fica no meio do maior trecho, sem bandeirinha por cima
    const h = p.heart!;
    expect(p.pennants.some((x) => x.run === 0 && x.x + 5 > h.x - 2 && x.x < h.x + 11)).toBe(false);
  });

  it('parede curta demais fica sem varal; sem parede de face, sem coração', () => {
    expect(planDecor([{ kind: 'face', x: 0, y: 0, w: 30, style }]).strings).toEqual([]);
    expect(planDecor([{ kind: 'south', x: 0, y: 0, w: 300, style }]).heart).toBeNull();
  });

  it('a barriga do varal é zero nas pontas e máxima no meio', () => {
    expect(sagAt(0, 0, 100, 3)).toBe(0);
    expect(sagAt(100, 0, 100, 3)).toBe(0);
    expect(sagAt(50, 0, 100, 3)).toBe(3);
  });
});
