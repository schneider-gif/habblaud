import { describe, expect, it } from 'vitest';
import { limitText } from './agent-limit';

describe('limitText (N/M agentes no Novo agente)', () => {
  it('sem limite não mostra nada; com limite mostra N/M e o plano', () => {
    expect(limitText(undefined)).toBeUndefined();
    expect(limitText({ running: 0, max: 0 })).toBeUndefined();
    expect(limitText({ running: 1, max: 2, plan: 'sala' })).toBe('1/2 agentes rodando (plano Sala)');
    expect(limitText({ running: 1, max: 1, plan: 'recepcao' })).toBe('1/1 agentes rodando (plano Recepção) — feche um agente para abrir outro');
    expect(limitText({ running: 3, max: 4, plan: 'xyz' })).toBe('3/4 agentes rodando');
  });
});
