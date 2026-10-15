import { describe, expect, it } from 'vitest';
import { createConfirmText, githubHeadline } from './github';

describe('painel do GitHub (textos)', () => {
  it('cabeçalho por estado', () => {
    expect(githubHeadline(null)).toBe('Conferindo o GitHub…');
    expect(githubHeadline({ available: false, reason: 'HABBLAUD_GITHUB=0' })).toBe('GitHub indisponível: HABBLAUD_GITHUB=0');
    expect(githubHeadline({ available: true, installed: false, error: 'o GitHub CLI (gh) não está instalado neste escritório' })).toMatch(/não está instalado/);
    expect(githubHeadline({ available: true, installed: true, loggedIn: false })).toBe('GitHub não conectado');
    expect(githubHeadline({ available: true, installed: true, loggedIn: true, login: 'dev-teste', name: 'Dev' })).toBe('Conectado como @dev-teste (Dev)');
  });
  it('confirmação diz se é privado ou público e o que vai ser enviado', () => {
    expect(createConfirmText('dev', 'site', 'private')).toBe('Criar o repositório privado dev/site no GitHub e enviar (push) o conteúdo de ~/projetos/site?');
    expect(createConfirmText(undefined, 'site', 'public')).toMatch(/PÚBLICO/);
  });
});
