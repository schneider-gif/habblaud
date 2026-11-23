import { describe, expect, it } from 'vitest';
import { fotoSize, fotoUrl } from './foto-portal';

describe('fotoUrl', () => {
  it('usa a origem do link de bug do portal', () => {
    expect(fotoUrl('https://app.habblaude.com/escritorio?bug=1')).toBe('https://app.habblaude.com/api/escritorio/foto');
  });
  it('sem portal (build aberto), http ou lixo: nada', () => {
    expect(fotoUrl(undefined)).toBeUndefined();
    expect(fotoUrl('')).toBeUndefined();
    expect(fotoUrl('http://app.habblaude.com/')).toBeUndefined();
    expect(fotoUrl('não é url')).toBeUndefined();
  });
});

describe('fotoSize', () => {
  it('reduz para 1280 de largura mantendo a proporção', () => {
    expect(fotoSize(2560, 1440)).toEqual({ w: 1280, h: 720 });
  });
  it('não aumenta canvas pequeno', () => {
    expect(fotoSize(800, 600)).toEqual({ w: 800, h: 600 });
  });
});
