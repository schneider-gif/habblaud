// TUI falso do diálogo AskUserQuestion do Claude Code 2.1.295, só para testes: reproduz as telas (texto do
// capture-pane) e as reações às teclas observadas no TUI real (ver docs/perguntas.md). Serve para validar a sequência
// de teclas do askStep sem um Claude de verdade; o teste ponta a ponta com o TUI real fica em scripts/e2e-perguntas.
import type { AskQuestion } from '../../shared/types';

const SEP = '─'.repeat(100);

export class FakeAskTui {
  tab = 0;
  cursor = 0;
  review = false;
  reviewCursor = 0;
  closed = false;
  /** Respostas por pergunta como o Claude Code grava no tool_result ("A, B, texto"). */
  result: Record<string, string> | null = null;
  checked: Set<number>[];
  chosen: (number | null)[];
  other: string[];
  readonly log: string[] = [];

  constructor(readonly questions: AskQuestion[]) {
    this.checked = questions.map(() => new Set<number>());
    this.chosen = questions.map(() => null);
    this.other = questions.map(() => '');
  }

  private q(): AskQuestion {
    return this.questions[this.tab];
  }

  /** Itens navegáveis da aba: opções, "Type something" e (multiSelect) "Submit". */
  private count(): number {
    const q = this.q();
    return q.options.length + 1 + (q.multiSelect ? 1 : 0);
  }

  private advance(): void {
    if (this.questions.length === 1 && !this.q().multiSelect) return this.submit();
    if (this.tab < this.questions.length - 1) {
      this.tab++;
      this.cursor = 0;
    } else {
      this.review = true;
      this.reviewCursor = 0;
    }
  }

  private submit(): void {
    this.closed = true;
    const out: Record<string, string> = {};
    this.questions.forEach((q, i) => {
      const parts: string[] = [];
      if (q.multiSelect) {
        for (const n of [...this.checked[i]].sort((a, b) => a - b)) parts.push(n < q.options.length ? q.options[n].label : this.other[i]);
      } else {
        const c = this.chosen[i];
        if (c !== null) parts.push(c < q.options.length ? q.options[c].label : this.other[i]);
      }
      out[q.question] = parts.join(', ');
    });
    this.result = out;
  }

  key(k: string): void {
    this.log.push(k);
    if (this.closed) return;
    if (this.review) {
      if (k === 'Up') this.reviewCursor = 0;
      else if (k === 'Down') this.reviewCursor = 1;
      else if (k === 'Enter') {
        if (this.reviewCursor === 0) this.submit();
        else this.closed = true; // cancelado
      }
      return;
    }
    const q = this.q();
    const k1 = q.options.length;
    if (k === 'Down') this.cursor = Math.min(this.count() - 1, this.cursor + 1);
    else if (k === 'Up') this.cursor = Math.max(0, this.cursor - 1);
    else if (k === 'BSpace') {
      if (this.cursor === k1) this.other[this.tab] = this.other[this.tab].slice(0, -1);
    } else if (k === 'Space' || k === 'Enter') {
      if (this.cursor === k1 && k === 'Space') return this.type(' ');
      if (q.multiSelect) {
        if (this.cursor === k1 + 1) {
          if (k === 'Enter') this.advance();
          return;
        }
        const set = this.checked[this.tab];
        if (set.has(this.cursor)) set.delete(this.cursor);
        else set.add(this.cursor);
      } else if (k === 'Enter') {
        if (this.cursor === k1 && !this.other[this.tab]) return;
        this.chosen[this.tab] = this.cursor;
        this.advance();
      }
    } else throw new Error(`tecla inesperada no diálogo: ${k}`);
  }

  type(text: string): void {
    this.log.push(`text:${text}`);
    if (this.closed || this.review) return;
    const k1 = this.q().options.length;
    if (this.cursor !== k1) return; // fora do campo: o TUI ignora
    this.other[this.tab] += text;
    if (this.q().multiSelect) this.checked[this.tab].add(k1);
  }

  screen(): string {
    const lines = ['', '❯ me faça perguntas', SEP];
    if (this.closed) {
      return ['', '❯ me faça perguntas', '', "● User answered Claude's questions:", '', SEP, '❯ ', SEP, '  ⏵⏵ auto mode on'].join('\n');
    }
    const tabs = this.questions.map((q, i) => `${(q.multiSelect ? this.checked[i].size : this.chosen[i] !== null) ? '☒' : '☐'} ${q.header ?? `Q${i + 1}`}`);
    lines.push(this.questions.length > 1 || this.q().multiSelect ? `←  ${tabs.join('  ')}  ✔ Submit  →` : ` ${tabs[0]}`, '');
    if (this.review) {
      lines.push('Review your answers', '');
      this.questions.forEach((q) => lines.push(` ● ${q.question}`, '   → …'));
      lines.push('', 'Ready to submit your answers?', '', `${this.reviewCursor === 0 ? '❯' : ' '} 1. Submit answers`, `${this.reviewCursor === 1 ? '❯' : ' '} 2. Cancel`);
      return lines.join('\n');
    }
    const q = this.q();
    lines.push(q.question, '');
    const k1 = q.options.length;
    const mark = (i: number) => (this.cursor === i ? '❯' : ' ');
    q.options.forEach((o, i) => {
      const box = q.multiSelect ? `[${this.checked[this.tab].has(i) ? '✔' : ' '}] ` : '';
      lines.push(`${mark(i)} ${i + 1}. ${box}${o.label}`);
      if (o.description) lines.push(`     ${q.multiSelect ? '    ' : ''}${o.description}`);
    });
    const otherText = this.other[this.tab] || (q.multiSelect ? 'Type something' : 'Type something.');
    lines.push(`${mark(k1)} ${k1 + 1}. ${q.multiSelect ? `[${this.checked[this.tab].has(k1) ? '✔' : ' '}] ` : ''}${otherText}`);
    if (q.multiSelect) lines.push(`${mark(k1 + 1)}    Submit`);
    lines.push(SEP, `  ${k1 + 2}. Chat about this`, '', 'Enter to select · ↑/↓ to navigate · Esc to cancel');
    return lines.join('\n');
  }
}
