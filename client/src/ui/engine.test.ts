import { describe, expect, it } from 'vitest';
import { arrivingText, engineOf, pickEngine } from './engine';

describe('Claude ou Codex no "+ Novo agente"', () => {
  it('lembra a última escolha enquanto ela estiver instalada', () => {
    expect(pickEngine('codex', { claude: true, codex: true })).toBe('codex');
    expect(pickEngine('claude', { claude: true, codex: true })).toBe('claude');
    expect(pickEngine('codex', { claude: true, codex: false })).toBe('claude');
    expect(pickEngine(null, { claude: false, codex: true })).toBe('codex');
    expect(pickEngine('lixo', { claude: true, codex: true })).toBe('claude');
    // servidor antigo (sem a lista): só Claude
    expect(pickEngine('codex', undefined)).toBe('claude');
  });

  it('selo e aviso', () => {
    expect(engineOf({ engine: 'codex' })).toBe('codex');
    expect(engineOf({})).toBe('claude');
    expect(engineOf(undefined)).toBe('claude');
    expect(arrivingText('Bia', 'codex')).toBe('Bia (Codex) está chegando: aparece no escritório em alguns segundos.');
    expect(arrivingText('', 'claude')).toBe('O novo agente está chegando: aparece no escritório em alguns segundos.');
  });
});
