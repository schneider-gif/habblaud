// Perguntas com opções (AskUserQuestion): leitura do transcript, validação das respostas, leitura da tela do diálogo
// e a sequência de teclas do askStep, dirigindo o TUI falso (fake-tui.ts, que reproduz o Claude Code 2.1.295) até o
// fim. O teste com o TUI real fica em scripts/e2e-perguntas. Tudo com dados sintéticos.
import { describe, expect, it } from 'vitest';
import type { AskAnswer, AskQuestion } from '../../shared/types';
import { AnswerError, answeredInLines, askStep, classifyAskScreen, cleanAnswers, matchQuestion, parseAskInput, pendingAskFromLines } from './ask';
import { FakeAskTui } from './fake-tui';

const q = (question: string, multiSelect: boolean, labels: string[], header?: string): AskQuestion => ({
  question,
  ...(header ? { header } : {}),
  multiSelect,
  options: labels.map((label) => ({ label, description: `sobre ${label}` })),
});

const useLine = (id: string, input: unknown, ts = '2026-10-16T05:00:00.000Z') =>
  JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input }] } });
const resultLine = (id: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

const INPUT = { questions: [{ question: 'Qual banco?', header: 'Banco', multiSelect: false, options: [{ label: 'Postgres', description: 'relacional' }, { label: 'SQLite' }] }] };

describe('parseAskInput', () => {
  it('normaliza perguntas e opções', () => {
    expect(parseAskInput(INPUT)).toEqual([{ question: 'Qual banco?', header: 'Banco', multiSelect: false, options: [{ label: 'Postgres', description: 'relacional' }, { label: 'SQLite' }] }]);
  });
  it('recusa formatos inesperados', () => {
    expect(parseAskInput(undefined)).toBeUndefined();
    expect(parseAskInput({ questions: [] })).toBeUndefined();
    expect(parseAskInput({ questions: [{ question: 'x', options: [] }] })).toBeUndefined();
    expect(parseAskInput({ questions: [{ question: 'x', options: [{ label: '' }] }] })).toBeUndefined();
  });
});

describe('pendingAskFromLines / answeredInLines', () => {
  it('acha a pergunta sem tool_result', () => {
    const p = pendingAskFromLines([useLine('t1', INPUT)]);
    expect(p?.toolUseId).toBe('t1');
    expect(p?.createdAt).toBe(Date.parse('2026-10-16T05:00:00.000Z'));
  });
  it('some quando o tool_result chega', () => {
    const lines = [useLine('t1', INPUT), resultLine('t1')];
    expect(pendingAskFromLines(lines)).toBeUndefined();
    expect(answeredInLines(lines, 't1')).toBe(true);
    expect(answeredInLines(lines, 't2')).toBe(false);
  });
  it('só a última chamada vale (uma antiga sem resultado é de turno interrompido)', () => {
    expect(pendingAskFromLines([useLine('t1', INPUT), useLine('t2', INPUT), resultLine('t2')])).toBeUndefined();
    expect(pendingAskFromLines([useLine('t1', INPUT), useLine('t2', INPUT)])?.toolUseId).toBe('t2');
  });
  it('ignora linhas quebradas', () => {
    expect(pendingAskFromLines(['{"AskUserQuestion', useLine('t1', INPUT)])?.toolUseId).toBe('t1');
  });
});

describe('cleanAnswers', () => {
  const qs = [q('A?', false, ['x', 'y']), q('B?', true, ['m', 'n', 'o'])];
  it('aceita respostas válidas', () => {
    expect(cleanAnswers([{ selected: [1] }, { selected: [2, 0], other: '  mais   um ' }], qs)).toEqual([{ selected: [1] }, { selected: [0, 2], other: 'mais um' }]);
  });
  it('recusa respostas inválidas', () => {
    const bad = (raw: unknown) => expect(() => cleanAnswers(raw, qs)).toThrow(AnswerError);
    bad([{ selected: [0] }]);
    bad([{ selected: [0, 1] }, { selected: [0] }]);
    bad([{ selected: [] }, { selected: [0] }]);
    bad([{ selected: [0], other: 'e outro' }, { selected: [0] }]);
    bad([{ selected: [5] }, { selected: [0] }]);
    bad([{ selected: [0] }, { selected: [] }]);
    bad([{ selected: [0] }, { selected: [0], other: 'a\u0007b' }]);
  });
});

describe('classifyAskScreen', () => {
  it('lê a tela de escolha única', () => {
    const tui = new FakeAskTui([q('Qual banco?', false, ['Postgres', 'SQLite'], 'Banco')]);
    const s = classifyAskScreen(tui.screen());
    expect(s).toMatchObject({ kind: 'question', multi: false, cursor: 0 });
    expect(s?.kind === 'question' && s.items.map((i) => (i.type === 'option' ? i.label : 'submit'))).toEqual(['Postgres', 'SQLite', 'Type something.']);
  });
  it('lê caixas marcadas e o Submit do multiSelect', () => {
    const tui = new FakeAskTui([q('Quais?', true, ['a', 'b'])]);
    tui.key('Space');
    const s = classifyAskScreen(tui.screen());
    expect(s).toMatchObject({ kind: 'question', multi: true });
    expect(s?.kind === 'question' && s.items).toEqual([
      { type: 'option', n: 1, label: 'a', checked: true },
      { type: 'option', n: 2, label: 'b', checked: false },
      { type: 'option', n: 3, label: 'Type something', checked: false },
      { type: 'submit' },
    ]);
  });
  it('lê a revisão', () => {
    const tui = new FakeAskTui([q('A?', false, ['x', 'y']), q('B?', false, ['m', 'n'])]);
    tui.key('Enter');
    tui.key('Enter');
    expect(classifyAskScreen(tui.screen())).toEqual({ kind: 'review', cursor: 0 });
  });
  it('tela real do Claude Code 2.1.295 (com abas e rodapé Tab/Arrow)', () => {
    const real = [
      '❯ PERGUNTE agora',
      '─'.repeat(120),
      '←  ☒ Banco  ☐ Recursos  ✔ Submit  →',
      '',
      'Quais recursos ligar?',
      '',
      '❯ 1. [ ] Cache',
      '         redis',
      '  2. [✔] Fila',
      '  3. [ ] Type something',
      '     Submit',
      '─'.repeat(120),
      '  4. Chat about this',
      '',
      'Enter to select · Tab/Arrow keys to navigate · Esc to cancel',
    ].join('\n');
    const s = classifyAskScreen(real);
    expect(s).toMatchObject({ kind: 'question', multi: true, cursor: 0 });
    expect(s?.kind === 'question' && s.head).toContain('Quais recursos ligar?');
    expect(s?.kind === 'question' && s.items).toHaveLength(4);
  });
  it('sem diálogo: undefined', () => {
    expect(classifyAskScreen('❯ \n' + '─'.repeat(50) + '\n  ⏵⏵ auto mode on')).toBeUndefined();
  });
});

describe('matchQuestion', () => {
  it('escolhe a pergunta mais longa contida no cabeçalho', () => {
    const qs = [q('Banco?', false, ['a', 'b']), q('Qual Banco?', false, ['a', 'b'])];
    expect(matchQuestion('☐ X Qual Banco?', qs)).toBe(1);
    expect(matchQuestion('nada', qs)).toBe(-1);
  });
});

/** Dirige o TUI falso com askStep até fechar; devolve o resultado gravado. */
function drive(questions: AskQuestion[], answers: AskAnswer[]): { result: Record<string, string> | null; log: string[] } {
  const tui = new FakeAskTui(questions);
  for (let i = 0; i < 100 && !tui.closed; i++) {
    const s = classifyAskScreen(tui.screen());
    if (!s) throw new Error('sem diálogo');
    const step = askStep(s, questions, answers);
    if ('error' in step) throw new Error(step.error);
    if ('text' in step) {
      for (let e = 0; e < step.erase; e++) tui.key('BSpace');
      tui.type(step.text);
    } else for (const k of step.keys) tui.key(k);
  }
  if (!tui.closed) throw new Error('não fechou');
  return { result: tui.result, log: tui.log };
}

describe('askStep dirigindo o TUI falso', () => {
  it('escolha única, uma pergunta: setas e Enter', () => {
    const r = drive([q('Qual?', false, ['a', 'b', 'c'])], [{ selected: [2] }]);
    expect(r.result).toEqual({ 'Qual?': 'c' });
    expect(r.log).toEqual(['Down', 'Down', 'Enter']);
  });
  it('"Outro" na escolha única', () => {
    expect(drive([q('Qual?', false, ['a', 'b'])], [{ selected: [], other: 'meu texto' }]).result).toEqual({ 'Qual?': 'meu texto' });
  });
  it('multiSelect com "Outro"', () => {
    expect(drive([q('Quais?', true, ['a', 'b', 'c'])], [{ selected: [0, 2], other: 'd' }]).result).toEqual({ 'Quais?': 'a, c, d' });
  });
  it('várias perguntas passam pela revisão e enviam', () => {
    const qs = [q('Um?', false, ['a', 'b']), q('Dois?', true, ['x', 'y']), q('Três?', false, ['p', 'q'])];
    const r = drive(qs, [{ selected: [1] }, { selected: [0, 1] }, { selected: [], other: 'r' }]);
    expect(r.result).toEqual({ 'Um?': 'b', 'Dois?': 'x, y', 'Três?': 'r' });
    expect(r.log).not.toContain('Escape');
  });
  it('na revisão com o cursor em Cancel, sobe antes de enviar', () => {
    expect(askStep({ kind: 'review', cursor: 1 }, [], [])).toEqual({ keys: ['Up'] });
    expect(askStep({ kind: 'review', cursor: 0 }, [], [])).toEqual({ keys: ['Enter'] });
  });
  it('pergunta diferente da esperada: erro (não aperta nada)', () => {
    const tui = new FakeAskTui([q('Outra coisa?', false, ['a', 'b'])]);
    const step = askStep(classifyAskScreen(tui.screen())!, [q('Qual?', false, ['a', 'b'])], [{ selected: [0] }]);
    expect(step).toHaveProperty('error');
  });
  it('quantidade de opções diferente: erro', () => {
    const tui = new FakeAskTui([q('Qual?', false, ['a', 'b', 'c'])]);
    expect(askStep(classifyAskScreen(tui.screen())!, [q('Qual?', false, ['a', 'b'])], [{ selected: [0] }])).toHaveProperty('error');
  });
});
