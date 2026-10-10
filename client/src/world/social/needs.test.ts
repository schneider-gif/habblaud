import { describe, expect, it } from 'vitest';
import { Needs } from './needs';

const mem = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

describe('necessidades (água, comida, lazer)', () => {
  it('começa em 60, ~3 vezes de 34 enchem, cai 100 em 24 h e nunca passa de 0..100', () => {
    const n = new Needs(null);
    const t0 = 1_000_000;
    expect(n.get('Bia', t0)).toMatchObject({ agua: 60, comida: 60, lazer: 60 });
    for (let i = 0; i < 3; i++) n.bump('Bia', 'agua', 34, t0);
    expect(n.get('Bia', t0).agua).toBe(100);
    expect(n.get('Bia', t0 + 12 * 3_600_000).agua).toBeCloseTo(50, 5);
    expect(n.get('Bia', t0 + 48 * 3_600_000).agua).toBe(0);
  });
  it('persiste por nome no armazenamento e relê', () => {
    const s = mem();
    const a = new Needs(s);
    a.bump('Leo', 'lazer', 34, 5_000);
    a.save();
    const b = new Needs(s);
    expect(b.get('Leo', 5_000).lazer).toBe(94);
  });
});
