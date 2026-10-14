import { describe, expect, it } from 'vitest';
import { safeHref, splitUrls } from './linkify';
import { isFullRow, linksAt, wrappedBlock } from './shell-links';
import { clampGeom, clipboardKey, parseGeom, wheelLines } from './shell';

const URL_LONGA = 'https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth&state=FIM';

/** Quebra o texto em linhas de `cols` colunas, como o tmux/Claude Code desenham. */
function wrap(text: string, cols: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += cols) out.push(text.slice(i, i + cols));
  return out;
}

describe('links que atravessam linhas (terminal embutido)', () => {
  const cols = 40;
  const rows = ['$ claude', ' Use a url abaixo para entrar:', '', ...wrap(URL_LONGA, cols), '', ' Paste code here >'];
  const first = 3;
  it('linha cheia + próxima colada na margem = mesma linha lógica', () => {
    expect(isFullRow(rows[first], cols)).toBe(true);
    expect(wrappedBlock(rows, first + 1, cols)).toEqual([first, first + wrap(URL_LONGA, cols).length - 1]);
  });
  it('clicar em qualquer pedaço dá a URL inteira, com começo e fim certos', () => {
    const n = wrap(URL_LONGA, cols).length;
    for (let r = first; r < first + n; r++) {
      const links = linksAt(rows, r, cols);
      expect(links).toHaveLength(1);
      expect(links[0].url).toBe(URL_LONGA);
      expect(links[0].start).toEqual({ row: first, col: 0 });
      expect(links[0].end).toEqual({ row: first + n - 1, col: (URL_LONGA.length - 1) % cols });
    }
  });
  it('linha curta não junta com a de baixo', () => {
    expect(linksAt(['veja https://a.com/x', 'outra coisa'], 0, 40)).toEqual([{ url: 'https://a.com/x', start: { row: 0, col: 5 }, end: { row: 0, col: 19 } }]);
    expect(linksAt(['veja https://a.com/x', 'outra coisa'], 1, 40)).toEqual([]);
  });
});

describe('linkify (conversa e markdown)', () => {
  it('URL inteira, sem a pontuação da frase', () => {
    expect(splitUrls(`Abra ${URL_LONGA}.`)).toEqual([{ text: 'Abra ' }, { url: URL_LONGA }, { text: '.' }]);
    expect(splitUrls('(veja https://x.dev/a_(b))')).toEqual([{ text: '(veja ' }, { url: 'https://x.dev/a_(b)' }, { text: ')' }]);
    expect(splitUrls('sem link')).toEqual([{ text: 'sem link' }]);
  });
  it('só http(s), sem credencial embutida', () => {
    expect(safeHref('javascript:alert(1)')).toBeUndefined();
    expect(safeHref('https://user:pw@x.com')).toBeUndefined();
    expect(safeHref('https://x.com/a b')).toBe('https://x.com/a%20b');
  });
});

describe('copiar/colar, roda e janela', () => {
  const k = (key: string, m: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) => ({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...m });
  it('Ctrl+C copia só com seleção; sem seleção é o Ctrl+C do shell', () => {
    expect(clipboardKey(k('c', { ctrlKey: true }), true)).toBe('copy');
    expect(clipboardKey(k('c', { ctrlKey: true }), false)).toBe('pass');
    expect(clipboardKey(k('C', { ctrlKey: true, shiftKey: true }), true)).toBe('copy');
    expect(clipboardKey(k('C', { ctrlKey: true, shiftKey: true }), false)).toBe('swallow');
    expect(clipboardKey(k('c', { metaKey: true }), true)).toBe('copy');
  });
  it('Ctrl+V, Ctrl+Shift+V e Cmd+V colam pelo navegador', () => {
    expect(clipboardKey(k('v', { ctrlKey: true }), false)).toBe('paste');
    expect(clipboardKey(k('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste');
    expect(clipboardKey(k('v', { metaKey: true }), false)).toBe('paste');
    expect(clipboardKey(k('v'), false)).toBe('pass');
    expect(clipboardKey(k('x', { ctrlKey: true }), false)).toBe('pass');
  });
  it('roda: pixels, linhas e páginas viram linhas com sinal', () => {
    expect(wheelLines(-100, 0)).toBe(-5);
    expect(wheelLines(3, 1)).toBe(3);
    expect(wheelLines(1, 2)).toBe(20);
    expect(wheelLines(2, 0)).toBe(1);
    expect(wheelLines(0, 0)).toBe(0);
  });
  it('posição guardada cabe na tela atual', () => {
    expect(clampGeom({ x: 3000, y: -50, w: 2000, h: 1500 }, { w: 1280, h: 800, top: 68 })).toEqual({ x: 4, y: 68, w: 1272, h: 724, max: undefined });
    expect(parseGeom('{"x":1,"y":2,"w":3,"h":4,"max":true}')).toEqual({ x: 1, y: 2, w: 3, h: 4, max: true });
    expect(parseGeom('{oops')).toBeNull();
  });
});
