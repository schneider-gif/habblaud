// Perguntas com opções (ferramenta AskUserQuestion do Claude Code) respondidas pelo chat do Habblaud. Peças puras:
// - a pergunta pendente sai do transcript: o Claude Code 2.1.295 grava o tool_use do AskUserQuestion assim que o
//   diálogo abre, e o tool_result só quando a pessoa responde (no terminal ou por aqui);
// - a tela do diálogo (capture-pane do tmux) vira um modelo: opções numeradas, caixas [✔] do multiSelect, o
//   "Type something" (campo "Outro"), o "Submit" do multiSelect e a tela final "Review your answers";
// - askStep decide a próxima tecla a partir da tela atual e das respostas escolhidas. Quem dirige o TUI (service.ts)
//   lê a tela de novo depois de cada passo, então a sequência se ajusta ao que o Claude Code realmente mostra.
//
// Sequência observada no Claude Code 2.1.295 (testada com o TUI real, ver docs/perguntas.md):
// - escolha única: setas até a opção e Enter (com várias perguntas, Enter já passa para a próxima aba; na última
//   abre a revisão; com uma pergunta só, Enter já envia);
// - multiSelect: Espaço (ou Enter) marca/desmarca a opção sob o cursor; "Submit" (sem número, depois do
//   "Type something") com Enter passa para a próxima aba ou para a revisão;
// - "Type something": com o cursor nele, o texto digitado vai direto para o campo (no multiSelect, já marca a caixa);
// - revisão: "1. Submit answers" / "2. Cancel"; Enter no 1 envia.
import type { AskAnswer, AskQuestion, AskQuestionInfo } from '../../shared/types';

export const ASK_TOOL = 'AskUserQuestion';
/** Limites do próprio AskUserQuestion (1–4 perguntas, 2–4 opções); um pouco de folga para versões futuras. */
const MAX_QUESTIONS = 8;
const MAX_OPTIONS = 12;
const TEXT_MAX = 2_000;
/** Texto do "Outro" (vai digitado no TUI). */
export const OTHER_MAX = 1_000;

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec | undefined {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined;
}

function str(v: unknown, max = TEXT_MAX): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
}

/** `input` do tool_use AskUserQuestion -> perguntas normalizadas (undefined se não tiver o formato esperado). */
export function parseAskInput(input: unknown): AskQuestion[] | undefined {
  const qs = rec(input)?.questions;
  if (!Array.isArray(qs) || !qs.length || qs.length > MAX_QUESTIONS) return undefined;
  const out: AskQuestion[] = [];
  for (const raw of qs) {
    const q = rec(raw);
    const question = str(q?.question);
    if (!q || !question || !Array.isArray(q.options) || !q.options.length || q.options.length > MAX_OPTIONS) return undefined;
    const options = [];
    for (const o of q.options) {
      const label = str(rec(o)?.label, 300);
      if (!label) return undefined;
      const description = str(rec(o)?.description, 600);
      options.push(description ? { label, description } : { label });
    }
    const header = str(q.header, 60);
    out.push({ question, ...(header ? { header } : {}), multiSelect: q.multiSelect === true, options });
  }
  return out;
}

/**
 * Pergunta pendente nas linhas do fim de um transcript: a chamada de AskUserQuestion mais recente que ainda não tem
 * tool_result. (Uma mais antiga sem resultado é de um turno interrompido: só a última vale.)
 */
export function pendingAskFromLines(lines: readonly string[]): AskQuestionInfo | undefined {
  let last: AskQuestionInfo | undefined;
  const results = new Set<string>();
  for (const line of lines) {
    if (!line.includes('"tool_result"') && !line.includes(ASK_TOOL)) continue;
    let j: Rec | undefined;
    try {
      j = rec(JSON.parse(line));
    } catch {
      continue;
    }
    const content = rec(j?.message)?.content;
    if (!Array.isArray(content)) continue;
    const at = typeof j?.timestamp === 'string' ? Date.parse(j.timestamp) : Number.NaN;
    for (const raw of content) {
      const b = rec(raw);
      if (!b) continue;
      if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') results.add(b.tool_use_id);
      else if (b.type === 'tool_use' && b.name === ASK_TOOL && typeof b.id === 'string') {
        const questions = parseAskInput(b.input);
        if (questions) last = { toolUseId: b.id, questions, createdAt: Number.isFinite(at) ? at : 0 };
      }
    }
  }
  return last && !results.has(last.toolUseId) ? last : undefined;
}

/** O tool_result de `toolUseId` está nas linhas? (a pergunta foi respondida) */
export function answeredInLines(lines: readonly string[], toolUseId: string): boolean {
  const needle = `"tool_use_id":"${toolUseId}"`;
  return lines.some((l) => l.includes(needle) && l.includes('"tool_result"'));
}

export class AnswerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Valida as respostas da página contra as perguntas: uma por pergunta, posições existentes, "Outro" sem controle. */
export function cleanAnswers(raw: unknown, questions: readonly AskQuestion[]): AskAnswer[] {
  if (!Array.isArray(raw) || raw.length !== questions.length) throw new AnswerError(400, 'esperada uma resposta por pergunta');
  return raw.map((r, i) => {
    const q = questions[i];
    const a = rec(r);
    const sel = Array.isArray(a?.selected) ? a.selected : [];
    const selected = [...new Set(sel.filter((n): n is number => Number.isInteger(n) && n >= 0 && n < q.options.length))].sort((x, y) => x - y);
    if (selected.length !== sel.length) throw new AnswerError(400, `pergunta ${i + 1}: opção inválida`);
    const other = typeof a?.other === 'string' ? a.other.replace(/\s+/g, ' ').trim() : '';
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(other)) throw new AnswerError(400, `pergunta ${i + 1}: o texto tem caracteres de controle`);
    if (other.length > OTHER_MAX) throw new AnswerError(413, `pergunta ${i + 1}: texto longo demais (máx. ${OTHER_MAX})`);
    if (!q.multiSelect && selected.length + (other ? 1 : 0) !== 1) throw new AnswerError(400, `pergunta ${i + 1}: escolha uma opção (ou escreva em "Outro")`);
    if (q.multiSelect && !selected.length && !other) throw new AnswerError(400, `pergunta ${i + 1}: marque ao menos uma opção`);
    return other ? { selected, other } : { selected };
  });
}

// ---------------------------------------------------------------- tela do diálogo

export type AskScreenItem =
  | {
      type: 'option';
      n: number;
      label: string;
      checked?: boolean;
      /** Linhas recuadas logo abaixo (descrição da opção ou, no "Outro", a continuação do texto que quebrou a linha). */
      extra?: string;
    }
  | { type: 'submit' };

export type AskScreen =
  | {
      kind: 'question';
      /** Texto acima das opções (abas e a pergunta), com espaços colapsados. */
      head: string;
      multi: boolean;
      items: AskScreenItem[];
      /** Posição do cursor (❯) em `items`; -1 se não achou. */
      cursor: number;
    }
  | { kind: 'review'; /** 0 = "Submit answers", 1 = "Cancel", -1 = não achou. */ cursor: number };

const CURSOR = '❯';
const SEP = /^\s*─{8,}/;
const FOOTER = /Enter to select|to navigate .*Esc to cancel/;
const NUMBERED = /^\s*(❯)?\s*(\d+)\.\s(.*)$/;
const SUBMIT = /^\s*(❯)?\s*Submit\s*$/;

export function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Lê a tela do pane (texto puro do capture-pane). undefined = não há diálogo de pergunta aberto. */
export function classifyAskScreen(text: string): AskScreen | undefined {
  const lines = text.replace(/\r/g, '').split('\n');
  const review = lines.findIndex((l) => /Review your answers/.test(l));
  if (review >= 0) {
    let submit = -1;
    let cancel = -1;
    let cursor = -1;
    for (let i = review + 1; i < lines.length; i++) {
      const m = NUMBERED.exec(lines[i]);
      if (!m) continue;
      if (m[2] === '1' && /^Submit answers/.test(m[3].trim())) {
        submit = i;
        if (m[1]) cursor = 0;
      } else if (m[2] === '2' && /^Cancel/.test(m[3].trim())) {
        cancel = i;
        if (m[1]) cursor = 1;
      }
    }
    if (submit >= 0 && cancel >= 0) return { kind: 'review', cursor };
  }
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return undefined;
  const seps: number[] = [];
  for (let i = 0; i < footer; i++) if (SEP.test(lines[i])) seps.push(i);
  if (seps.length < 2) return undefined;
  const bottom = seps[seps.length - 1];
  const top = seps[seps.length - 2];
  const items: AskScreenItem[] = [];
  let cursor = -1;
  let first = -1;
  let multi = false;
  for (let i = top + 1; i < bottom; i++) {
    const line = lines[i];
    const m = NUMBERED.exec(line);
    if (m) {
      if (first < 0) first = i;
      let label = m[3].trim();
      let checked: boolean | undefined;
      const box = /^\[(.)\]\s?(.*)$/.exec(label);
      if (box) {
        multi = true;
        checked = box[1] !== ' ';
        label = box[2].trim();
      }
      if (m[1]) cursor = items.length;
      items.push(checked === undefined ? { type: 'option', n: Number(m[2]), label } : { type: 'option', n: Number(m[2]), label, checked });
      continue;
    }
    const s = SUBMIT.exec(line);
    if (s && first >= 0) {
      if (s[1]) cursor = items.length;
      items.push({ type: 'submit' });
      continue;
    }
    const prev = items[items.length - 1];
    const more = collapse(line);
    if (prev?.type === 'option' && more) prev.extra = prev.extra ? `${prev.extra} ${more}` : more;
  }
  if (first < 0) return undefined;
  const head = collapse(lines.slice(top + 1, first).join(' '));
  return { kind: 'question', head, multi, items, cursor };
}

/** Qual das perguntas a tela mostra (pelo texto acima das opções; a mais longa que couber, se uma contiver a outra). */
export function matchQuestion(head: string, questions: readonly AskQuestion[]): number {
  let best = -1;
  questions.forEach((q, i) => {
    const t = collapse(q.question);
    if (head.includes(t) && (best < 0 || t.length > collapse(questions[best].question).length)) best = i;
  });
  return best;
}

/** Próximo passo para dirigir o diálogo: teclas (nomes do tmux), texto a digitar ou erro. */
export type AskStep =
  | { keys: string[] }
  | { text: string; /** Backspaces antes de digitar (apagar um texto que já estava no campo). */ erase: number }
  | { error: string };

const PLACEHOLDER = /^Type something\.?$/;

function moveKeys(from: number, to: number): string[] {
  const d = to - from;
  return Array.from({ length: Math.abs(d) }, () => (d > 0 ? 'Down' : 'Up'));
}

/**
 * Próximo passo a partir da tela atual. Chamado de novo depois de cada passo (com a tela nova), até o diálogo fechar.
 * Nunca manda Esc nem "Chat about this": só setas, Espaço, Enter e o texto do "Outro".
 */
export function askStep(screen: AskScreen, questions: readonly AskQuestion[], answers: readonly AskAnswer[]): AskStep {
  if (screen.kind === 'review') {
    if (screen.cursor === 0) return { keys: ['Enter'] };
    if (screen.cursor === 1) return { keys: ['Up'] };
    return { error: 'não achei o cursor na tela de revisão' };
  }
  const qi = matchQuestion(screen.head, questions);
  if (qi < 0) return { error: 'o terminal mostra uma pergunta diferente da esperada' };
  const q = questions[qi];
  const a = answers[qi];
  const k = q.options.length;
  const at = (n: number) => screen.items.findIndex((it) => it.type === 'option' && it.n === n);
  const numbered = screen.items.filter((it) => it.type === 'option').length;
  if (numbered !== k + 1 || at(k + 1) < 0) return { error: 'as opções na tela não batem com as da pergunta' };
  if (screen.cursor < 0) return { error: 'não achei o cursor do diálogo' };
  if (q.multiSelect !== screen.multi) return { error: 'o tipo da pergunta na tela não bate (escolha única x várias)' };
  const otherIdx = at(k + 1);
  const otherItem = screen.items[otherIdx] as Extract<AskScreenItem, { type: 'option' }>;
  // O texto do "Outro" pode quebrar a linha num terminal estreito: a continuação vem recuada logo abaixo (extra).
  const shownOther = collapse(otherItem.extra ? `${otherItem.label} ${otherItem.extra}` : otherItem.label);
  const typeOther = (): AskStep | undefined => {
    const want = collapse(a.other ?? '');
    if (!want || shownOther === want) return undefined;
    if (screen.cursor !== otherIdx) return { keys: moveKeys(screen.cursor, otherIdx) };
    return { text: want, erase: PLACEHOLDER.test(shownOther) ? 0 : [...shownOther].length };
  };

  if (!q.multiSelect) {
    const target = a.other ? otherIdx : at((a.selected[0] ?? -1) + 1);
    if (target < 0) return { error: 'opção escolhida não está na tela' };
    if (screen.cursor !== target) return { keys: moveKeys(screen.cursor, target) };
    return typeOther() ?? { keys: ['Enter'] };
  }

  for (let n = 1; n <= k; n++) {
    const idx = at(n);
    const it = screen.items[idx] as Extract<AskScreenItem, { type: 'option' }>;
    const want = a.selected.includes(n - 1);
    if (!!it.checked === want) continue;
    if (screen.cursor !== idx) return { keys: moveKeys(screen.cursor, idx) };
    return { keys: ['Space'] };
  }
  const other = typeOther();
  if (other) return other;
  if (!a.other && otherItem.checked) {
    if (screen.cursor !== otherIdx) return { keys: moveKeys(screen.cursor, otherIdx) };
    return { keys: ['Space'] };
  }
  const submit = screen.items.findIndex((it) => it.type === 'submit');
  if (submit < 0) return { error: 'não achei o "Submit" da pergunta' };
  if (screen.cursor !== submit) return { keys: moveKeys(screen.cursor, submit) };
  return { keys: ['Enter'] };
}
