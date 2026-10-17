import { describe, expect, it } from 'vitest';
import type { WelcomeView } from '../../../shared/welcome';
import { deliveryNotice, parseWelcomeView, shouldShowWelcome, type WelcomeShowInput } from './welcome-model';

const view = (state: WelcomeView['state']): WelcomeView => ({ state, suggestions: [{ id: 'site', text: 'Crie um site simples para mim', folder: 'projetos/primeiro-projeto' }] });
const base: WelcomeShowInput = { view: view('ready'), officeEmpty: true, shown: false, shellOpen: false, dismissed: false, mock: false };

describe('cartão de boas-vindas (modelo)', () => {
  it('parseWelcomeView: aceita o formato do servidor e descarta o torto', () => {
    expect(parseWelcomeView({ state: 'login', suggestions: [{ id: 'site', text: 'x', folder: '' }, { id: 'rm', text: 'y' }, null] })).toEqual({
      state: 'login',
      suggestions: [{ id: 'site', text: 'x', folder: '' }],
    });
    expect(parseWelcomeView({ state: 'done', suggestions: [], delivery: { agentId: '.claude:1', state: 'sent' } })?.delivery).toEqual({ agentId: '.claude:1', state: 'sent' });
    expect(parseWelcomeView({ state: 'done', delivery: { agentId: 1, state: 'x' } })).toEqual({ state: 'done', suggestions: [] });
    expect(parseWelcomeView({ state: 'talvez' })).toBeNull();
    expect(parseWelcomeView(null)).toBeNull();
  });

  it('aparece na primeira abertura com o escritório vazio, nos estados login e ready', () => {
    expect(shouldShowWelcome(base)).toBe(true);
    expect(shouldShowWelcome({ ...base, view: view('login') })).toBe(true);
    expect(shouldShowWelcome({ ...base, view: view('done') })).toBe(false);
    expect(shouldShowWelcome({ ...base, view: view('off') })).toBe(false);
    expect(shouldShowWelcome({ ...base, view: null })).toBe(false);
  });

  it('com agentes no escritório só continua se já tinha aparecido (ex.: o claude do login entrou)', () => {
    expect(shouldShowWelcome({ ...base, officeEmpty: false })).toBe(false);
    expect(shouldShowWelcome({ ...base, officeEmpty: false, shown: true })).toBe(true);
  });

  it('some com o terminal aberto por cima, depois de pular/usar e no mock', () => {
    expect(shouldShowWelcome({ ...base, shellOpen: true })).toBe(false);
    expect(shouldShowWelcome({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowWelcome({ ...base, mock: true })).toBe(false);
  });

  it('deliveryNotice: avisa o envio ou a falha, nada enquanto espera', () => {
    expect(deliveryNotice(undefined, 'Bia')).toBeUndefined();
    expect(deliveryNotice({ agentId: 'a', state: 'waiting' }, 'Bia')).toBeUndefined();
    expect(deliveryNotice({ agentId: 'a', state: 'sent' }, 'Bia')).toMatchObject({ level: 'info', text: expect.stringContaining('Bia recebeu o primeiro pedido') });
    expect(deliveryNotice({ agentId: 'a', state: 'failed' }, undefined)).toMatchObject({ level: 'warn', text: expect.stringContaining('Seu agente abriu') });
  });
});
