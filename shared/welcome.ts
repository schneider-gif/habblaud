// Agente de boas-vindas (primeira abertura do escritório): o que o servidor manda para o cartão (GET /api/welcome).
// Comportamento e estados em docs/BOAS-VINDAS.md.

export type WelcomeChoice = 'site' | 'explicar' | 'organizar';

/**
 * - off: desligado (HABBLAUD_BOAS_VINDAS=0) ou o escritório não abre agentes;
 * - done: já pulou, já usou uma sugestão ou já usava o Claude/Codex antes: nunca mais aparece;
 * - login: pendente, mas a conta do Claude ainda não está conectada (o cartão guia o login primeiro);
 * - ready: pendente, com a conta conectada (as sugestões abrem o agente).
 */
export type WelcomeState = 'off' | 'done' | 'login' | 'ready';

export interface WelcomeSuggestion {
  id: WelcomeChoice;
  /** Texto do botão, que é também a primeira mensagem para o agente. */
  text: string;
  /** Onde o agente abre, relativo ao HOME ('' = o próprio HOME). */
  folder: string;
}

/** Entrega da primeira mensagem ao agente aberto pelo cartão. */
export interface WelcomeDelivery {
  agentId: string;
  state: 'waiting' | 'sent' | 'failed';
}

export interface WelcomeView {
  state: WelcomeState;
  suggestions: WelcomeSuggestion[];
  delivery?: WelcomeDelivery;
}

export const WELCOME_SUGGESTIONS: readonly WelcomeSuggestion[] = [
  { id: 'site', text: 'Crie um site simples para mim', folder: 'projetos/primeiro-projeto' },
  { id: 'explicar', text: 'Explique o que você sabe fazer', folder: '' },
  { id: 'organizar', text: 'Organize meus arquivos', folder: '' },
];
