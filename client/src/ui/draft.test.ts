import { describe, expect, it } from 'vitest';
import { swapDraft } from './draft';

describe('rascunho por agente', () => {
  it('texto digitado no A não vai para o B e volta ao reabrir o A', () => {
    const d = new Map<string, string>();
    expect(swapDraft(d, null, '', 'A')).toBe('');
    expect(swapDraft(d, 'A', 'oi A', 'B')).toBe('');
    expect(swapDraft(d, 'B', 'oi B', 'A')).toBe('oi A');
    expect(swapDraft(d, 'A', 'oi A', 'B')).toBe('oi B');
  });
  it('sessão do histórico abre vazia e não apaga o rascunho', () => {
    const d = new Map<string, string>();
    expect(swapDraft(d, 'A', 'oi A', null)).toBe('');
    expect(swapDraft(d, null, 'lixo', 'A')).toBe('oi A');
  });
});
