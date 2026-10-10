import { describe, expect, it } from 'vitest';
import { cleanAppearance, cleanName, cleanProfile, ProfileError } from './profile';

describe('perfil do agente', () => {
  it('cleanName: aceita acento e espaço, recusa vazio, longo e símbolos', () => {
    expect(cleanName('  Ana   Júlia ')).toBe('Ana Júlia');
    expect(cleanName("D'Ávila-2")).toBe("D'Ávila-2");
    for (const bad of ['', '   ', 'x'.repeat(21), '<script>', 'a/b', 7]) expect(() => cleanName(bad)).toThrow(ProfileError);
  });
  it('cleanAppearance: só enums e cores válidas; look f tira a barba; campo desconhecido recusa', () => {
    expect(cleanAppearance({ hairStyle: 'afro', hair: '#FF5CAD', accessory: 'cap' })).toEqual({ hairStyle: 'afro', hair: '#ff5cad', accessory: 'cap' });
    expect(cleanAppearance({ look: 'f', facialHair: 'beard' })).toEqual({ look: 'f', facialHair: 'none' });
    expect(cleanAppearance(undefined)).toEqual({});
    for (const bad of [{ hairStyle: 'dread' }, { hair: 'red' }, { hair: '#fff' }, { lanyard: '#ffffff' }, { top: 1 }, ['x']]) expect(() => cleanAppearance(bad)).toThrow(ProfileError);
  });
  it('cleanProfile: nome vazio = sem nome', () => {
    expect(cleanProfile({ name: '', appearance: { shoes: '#123456' } })).toEqual({ appearance: { shoes: '#123456' } });
  });
});
