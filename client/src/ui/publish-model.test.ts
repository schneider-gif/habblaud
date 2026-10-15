import { describe, expect, it } from 'vitest';
import { slugSite } from '../../../shared/publish';
import { addressPreview, cleanConfig, configProblems, domainProblem, envProblems, mergeEnv, normalizeDomain, siteForProject, takeNewLines } from './publish-model';

describe('assistente Publicar (regras)', () => {
  it('slug do site a partir da pasta', () => {
    expect(slugSite('Minha Loja Ção!')).toBe('minha-loja-cao');
    expect(slugSite('---')).toBe('site');
    expect(slugSite('a'.repeat(40))).toHaveLength(30);
  });

  it('configuração limpa por tipo', () => {
    expect(cleanConfig('static', { porta: 3000, install: 'npm ci', saida: ' public ', spa: true })).toEqual({ porta: 8080, saida: 'public', spa: true });
    expect(cleanConfig('node', { porta: 3001, install: 'npm ci', start: ' ', saida: 'dist' })).toEqual({ porta: 3001, install: 'npm ci' });
  });

  it('problemas de configuração', () => {
    expect(configProblems('node', { porta: 70000 })).toHaveLength(1);
    expect(configProblems('node', { porta: 3000, start: 'a\nb' })[0]).toMatch(/quebra de linha/);
    expect(configProblems('static', { porta: 0, saida: '../x' })[0]).toMatch(/dentro do projeto/);
    expect(configProblems('vite', { porta: 8080, build: 'x'.repeat(301) })[0]).toMatch(/300/);
  });

  it('variáveis: nomes, repetidas e valores salvos', () => {
    expect(envProblems([{ key: 'API_KEY', value: '1' }], true)).toEqual([]);
    expect(envProblems([{ key: 'api', value: '1' }], true)).toHaveLength(1);
    expect(envProblems([{ key: 'A', value: '1' }, { key: 'A', value: '2' }], true)).toHaveLength(1);
    expect(envProblems([{ key: 'A', value: '', saved: true }], false)).toEqual([]);
    expect(envProblems([{ key: 'A', value: '', saved: true }], true)).toHaveLength(1);
    expect(envProblems([{ key: '', value: '' }], true)).toEqual([]);
    expect(envProblems([{ key: 'PORT', value: '1' }], true)[0]).toMatch(/reservada/);
  });

  it('importar do .env junta e sobrescreve', () => {
    expect(mergeEnv([{ key: 'A', value: '1', saved: true }, { key: '', value: '' }], { A: '2', B: '3' })).toEqual([
      { key: 'A', value: '2', saved: false },
      { key: 'B', value: '3' },
    ]);
  });

  it('endereço e domínio', () => {
    expect(addressPreview('loja', 'fulano')).toBe('loja-fulano.habblaude.app');
    expect(normalizeDomain(' https://WWW.Loja.com/ ')).toBe('www.loja.com');
    expect(domainProblem('www.loja.com.br')).toBeUndefined();
    expect(domainProblem('loja')).toBeDefined();
    expect(domainProblem('x-y.habblaude.app')).toBeDefined();
  });

  it('casa projeto com site pelo nome', () => {
    const site = { nome: 'minha-loja', status: 'no_ar' } as never;
    expect(siteForProject([site], 'Minha Loja')).toBe(site);
    expect(siteForProject([site], 'outra')).toBeUndefined();
  });

  it('log ao reconectar não repete linhas', () => {
    const st = { idx: 0, seen: 0 };
    expect(takeNewLines(st, ['a', 'b'])).toEqual(['a', 'b']);
    st.idx = 0; // reconectou: o stream recomeça
    expect(takeNewLines(st, ['a', 'b', 'c'])).toEqual(['c']);
  });
});
