// Teclado do navegador → tecla do tmux no cartão de tela do terminal (ex.: /permissions: ←/→ e Tab trocam de aba).
import { describe, expect, it } from 'vitest';
import { dialogKeyOf } from './question';

const k = (key: string, mod: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
  dialogKeyOf({ key, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mod });

describe('dialogKeyOf', () => {
  it('setas, Enter, Esc e Backspace', () => {
    expect([k('ArrowUp'), k('ArrowDown'), k('ArrowLeft'), k('ArrowRight')]).toEqual(['Up', 'Down', 'Left', 'Right']);
    expect([k('Enter'), k('Escape'), k('Backspace')]).toEqual(['Enter', 'Escape', 'BSpace']);
  });
  it('Tab e Shift+Tab', () => {
    expect(k('Tab')).toBe('Tab');
    expect(k('Tab', { shiftKey: true })).toBe('BTab');
  });
  it('letras e atalhos com Ctrl/Alt/Cmd ficam com o navegador', () => {
    expect(k('a')).toBeUndefined();
    expect(k('ArrowLeft', { altKey: true })).toBeUndefined();
    expect(k('Enter', { ctrlKey: true })).toBeUndefined();
    expect(k('Tab', { metaKey: true })).toBeUndefined();
  });
});
