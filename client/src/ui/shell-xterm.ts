// xterm.js e addons, carregados só quando o terminal embutido abre (import dinâmico em ui/shell.ts): o bundle
// principal do escritório não cresce para quem nunca usa o terminal.
import '@xterm/xterm/css/xterm.css';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal, type ILink, type ITheme } from '@xterm/xterm';
import { linksAt } from './shell-links';

/** Tema combinando com o escritório (roxo-noite do painel, limão de ação, rosa e laranja de acento). */
export const SHELL_THEME: ITheme = {
  background: '#0b0a12',
  foreground: '#e6e1f0',
  cursor: '#c8ff32',
  cursorAccent: '#0b0a12',
  selectionBackground: 'rgba(200, 255, 50, 0.32)',
  black: '#1c1828',
  red: '#ff6b6b',
  green: '#4fd18b',
  yellow: '#ffb547',
  blue: '#6fa8ff',
  magenta: '#ff5cad',
  cyan: '#3cd8d2',
  white: '#d8d2e6',
  brightBlack: '#6b6380',
  brightRed: '#ff8a8a',
  brightGreen: '#c8ff32',
  brightYellow: '#ffd27a',
  brightBlue: '#9cc3ff',
  brightMagenta: '#ff8cc6',
  brightCyan: '#7ef0eb',
  brightWhite: '#ffffff',
};

export interface XtermBundle {
  term: Terminal;
  fit: FitAddon;
}

/** Quantas linhas acima/abaixo olhar para juntar uma URL quebrada. */
const LINK_SPAN = 24;

export function createXterm(opts: { fontSize: number; onLink: (url: string) => void; onLinkHover: (url: string | null) => void }): XtermBundle {
  const term = new Terminal({
    theme: SHELL_THEME,
    fontFamily: "ui-monospace, 'SF Mono', SFMono-Regular, Menlo, Consolas, 'DejaVu Sans Mono', monospace",
    fontSize: opts.fontSize,
    lineHeight: 1.15,
    cursorBlink: true,
    cursorStyle: 'bar',
    allowProposedApi: true,
    // O histórico fica no tmux (a roda do mouse rola pelo modo cópia dele, ver ui/shell.ts).
    scrollback: 1000,
    macOptionIsMeta: true,
    macOptionClickForcesSelection: true,
    rightClickSelectsWord: false,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  // OSC 52: o que um programa copia (ex.: modo cópia do tmux) vai para a área de transferência do navegador.
  term.loadAddon(new ClipboardAddon());
  // Links que atravessam linhas (ver ui/shell-links.ts): a URL inteira abre, não só o pedaço da linha clicada.
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const buf = term.buffer.active;
      const first = Math.max(0, y - 1 - LINK_SPAN);
      const last = Math.min(buf.length - 1, y - 1 + LINK_SPAN);
      const rows: string[] = [];
      for (let i = first; i <= last; i++) rows.push(buf.getLine(i)?.translateToString(true) ?? '');
      const links: ILink[] = linksAt(rows, y - 1 - first, term.cols).map((l) => ({
        text: l.url,
        range: { start: { x: l.start.col + 1, y: l.start.row + first + 1 }, end: { x: l.end.col + 1, y: l.end.row + first + 1 } },
        decorations: { underline: true, pointerCursor: true },
        activate: (ev) => {
          ev.preventDefault();
          opts.onLink(l.url);
        },
        hover: () => opts.onLinkHover(l.url),
        leave: () => opts.onLinkHover(null),
      }));
      callback(links.length ? links : undefined);
    },
  });
  return { term, fit };
}
