import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { escolher, IaError, lerEstado, salvarToken } from './http';
import { IA_PADRAO } from '../../shared/ia';

function casa(estado?: object, escolha?: object) {
  const home = mkdtempSync(join(tmpdir(), 'hb-ia-http-'));
  mkdirSync(join(home, '.habblaude'), { recursive: true });
  if (estado) writeFileSync(join(home, '.habblaude/ia-estado.json'), JSON.stringify(estado));
  if (escolha) writeFileSync(join(home, '.habblaude/ia-escolha.json'), JSON.stringify(escolha));
  return home;
}
const ler = (home: string, n: string) => JSON.parse(readFileSync(join(home, '.habblaude', n), 'utf8'));

describe('seletor de IA (/api/ia)', () => {
  it('sem daemon: indisponível', () => {
    expect(lerEstado(casa()).disponivel).toBe(false);
  });

  it('modelo fora do catálogo (padrão do portal) aparece como o Prisma; uso e conta passam', () => {
    const e = lerEstado(casa({ motores: true, conta: true, modo: 'motores', modelo: 'minimax/minimax-m2.5', uso: { hoje: 0.1, limite: 0.37 }, token: false, resultado: 'gravou' }));
    expect(e).toMatchObject({ disponivel: true, motores: true, conta: true, modo: 'motores', modelo: IA_PADRAO, uso: { hoje: 0.1, limite: 0.37 } });
    expect(e.bloqueio).toBeUndefined();
  });

  it('config do cliente impedindo os Motores vira bloqueio', () => {
    const e = lerEstado(casa({ motores: true, conta: true, modo: 'motores', resultado: 'config-do-cliente' }, { modo: 'motores' }));
    expect(e.bloqueio).toBe('config-do-cliente');
  });

  it('escolher: valida modo e modelo, guarda o último modelo ao ir para a conta', () => {
    const home = casa();
    expect(() => escolher(home, { modo: 'x' })).toThrow(IaError);
    expect(() => escolher(home, { modo: 'motores', modelo: 'qualquer/coisa' })).toThrow(/fora da lista/);
    escolher(home, { modo: 'motores', modelo: 'deepseek/deepseek-v3.2' });
    escolher(home, { modo: 'conta' });
    expect(ler(home, 'ia-escolha.json')).toEqual({ modo: 'conta', modelo: 'deepseek/deepseek-v3.2' });
  });

  it('token: só no formato do setup-token; salvar passa a usar a conta', () => {
    const home = casa(undefined, { modo: 'motores', modelo: 'deepseek/deepseek-v3.2' });
    expect(() => salvarToken(home, 'abc')).toThrow(/token inválido/);
    expect(() => salvarToken(home, 'sk-ant-oat01-aaa\nrm -rf ~')).toThrow(/token inválido/);
    const tok = 'sk-ant-oat01-' + 'b'.repeat(40);
    salvarToken(home, `  ${tok}  `);
    expect(readFileSync(join(home, '.habblaude/claude-token'), 'utf8')).toBe(tok + '\n');
    expect(ler(home, 'ia-escolha.json')).toEqual({ modo: 'conta', modelo: 'deepseek/deepseek-v3.2' });
  });
});
