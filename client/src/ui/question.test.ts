// Cartão da pergunta com opções: rascunho das respostas (escolha única, várias, "Outro"), o que falta para enviar e o
// corpo de POST /answer. Sem DOM.
import { describe, expect, it } from 'vitest';
import type { AskQuestion } from '../../../shared/types';
import { draftsToAnswers, emptyDrafts, missingAnswer, toggleOption } from './question';

const single: AskQuestion = { question: 'Banco?', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] };
const multi: AskQuestion = { question: 'Recursos?', multiSelect: true, options: [{ label: 'x' }, { label: 'y' }, { label: 'z' }] };

describe('toggleOption', () => {
  it('escolha única troca a opção e o "Outro"', () => {
    let d = emptyDrafts([single])[0];
    d = toggleOption(single, d, 1);
    expect(d).toMatchObject({ selected: [1], otherOn: false });
    d = toggleOption(single, d, 2);
    expect(d).toMatchObject({ selected: [], otherOn: true });
    d = toggleOption(single, d, 0);
    expect(d).toMatchObject({ selected: [0], otherOn: false });
  });
  it('várias: marca e desmarca, em ordem', () => {
    let d = emptyDrafts([multi])[0];
    d = toggleOption(multi, d, 2);
    d = toggleOption(multi, d, 0);
    d = toggleOption(multi, d, 3);
    expect(d).toMatchObject({ selected: [0, 2], otherOn: true });
    d = toggleOption(multi, d, 2);
    expect(d.selected).toEqual([0]);
  });
});

describe('missingAnswer / draftsToAnswers', () => {
  it('pede o que falta', () => {
    expect(missingAnswer([single], emptyDrafts([single]))).toBe('escolha uma opção.');
    expect(missingAnswer([single, multi], [{ selected: [0], otherOn: false, other: '' }, { selected: [], otherOn: false, other: '' }])).toBe('Pergunta 2: marque ao menos uma opção.');
    expect(missingAnswer([single], [{ selected: [], otherOn: true, other: '  ' }])).toBe('escreva o texto de “Outro”.');
    expect(missingAnswer([single], [{ selected: [1], otherOn: false, other: '' }])).toBeUndefined();
  });
  it('monta as respostas (o "Outro" só se marcado)', () => {
    expect(draftsToAnswers([{ selected: [1], otherOn: false, other: 'ignorado' }, { selected: [0], otherOn: true, other: ' mais  um ' }])).toEqual([{ selected: [1] }, { selected: [0], other: 'mais um' }]);
  });
});
