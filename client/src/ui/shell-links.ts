// Links do terminal embutido que atravessam linhas. O tmux (e o próprio Claude Code) quebra uma URL longa em várias
// linhas da tela, e o xterm não sabe que elas são uma só (para ele não há "linha continuada"): o detector padrão
// pegava só o pedaço da linha clicada e abria a URL cortada. Aqui as linhas cheias até a última coluna, seguidas de
// uma linha que começa colada na margem, são juntadas antes de procurar as URLs. Puro (testado em shell-links.test.ts).
import { splitUrls } from './linkify';

export interface CellPos {
  /** Linha (índice na lista recebida). */
  row: number;
  /** Coluna (0 = primeira). */
  col: number;
}

export interface RowLink {
  url: string;
  start: CellPos;
  /** Última célula da URL (inclusiva). */
  end: CellPos;
}

/** A linha `text` (sem os espaços do fim) ocupa a tela até a margem direita? (tolerância de 1 coluna) */
export function isFullRow(text: string, cols: number): boolean {
  return text.length >= cols - 1;
}

/** Primeira e última linha do bloco "continuado" que contém `row`. */
export function wrappedBlock(rows: readonly string[], row: number, cols: number): [number, number] {
  const continues = (i: number) => i >= 0 && i + 1 < rows.length && isFullRow(rows[i], cols) && /^\S/.test(rows[i + 1]);
  let a = row;
  while (continues(a - 1)) a--;
  let b = row;
  while (continues(b)) b++;
  return [a, b];
}

/** URLs do bloco que contém `row`, com as posições de começo e fim (podem estar em linhas diferentes). */
export function linksAt(rows: readonly string[], row: number, cols: number): RowLink[] {
  const [a, b] = wrappedBlock(rows, row, cols);
  // Texto do bloco: cada linha cheia entra inteira (sem o espaço final da margem, se houver).
  const offsets: number[] = [];
  let text = '';
  for (let i = a; i <= b; i++) {
    offsets.push(text.length);
    text += i < b ? rows[i].replace(/\s$/, '') : rows[i];
  }
  const posOf = (k: number): CellPos => {
    let i = offsets.length - 1;
    while (i > 0 && offsets[i] > k) i--;
    return { row: a + i, col: k - offsets[i] };
  };
  const out: RowLink[] = [];
  let k = 0;
  for (const part of splitUrls(text)) {
    if ('text' in part) {
      k += part.text.length;
      continue;
    }
    const start = posOf(k);
    const end = posOf(k + part.url.length - 1);
    if (start.row <= row && end.row >= row) out.push({ url: part.url, start, end });
    k += part.url.length;
  }
  return out;
}
