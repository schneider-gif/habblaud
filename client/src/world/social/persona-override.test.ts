import { describe, expect, it } from 'vitest';
import { bindSocialStorage, bondBetween, noteSeedName, personaFor, setSocialOverride } from './persona';

describe('personalidade e vínculos escolhidos no escritório', () => {
  it('traços e vínculos por nome vencem o sorteio e são salvos', () => {
    const m = new Map<string, string>();
    bindSocialStorage({ getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) });
    noteSeedName(111, 'Bia');
    noteSeedName(222, 'Leo');
    noteSeedName(333, 'Ana');
    setSocialOverride('Bia', { traits: ['games', 'cafeina'], friends: ['Ana'], rivals: ['Leo'] });
    expect(personaFor(111).traits).toEqual(['games', 'cafeina']);
    expect(bondBetween(111, 222)).toBe('rivalidade');
    expect(bondBetween(222, 111)).toBe('rivalidade');
    expect(bondBetween(111, 333)).toBe('amizade');
    expect(JSON.parse(m.get('habblaude.social.v1')!).Bia.rivals).toEqual(['Leo']);
    // amigo e rival ao mesmo tempo: rival vence e amigo sai
    setSocialOverride('Bia', { friends: ['Leo'], rivals: ['Leo'] });
    expect(bondBetween(111, 222)).toBe('rivalidade');
  });
});
