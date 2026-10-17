// Cartão de boas-vindas (puro): leitura defensiva do GET /api/welcome, quando o cartão aparece e os textos dos
// avisos. Comportamento em docs/BOAS-VINDAS.md.
import type { WelcomeDelivery, WelcomeState, WelcomeSuggestion, WelcomeView } from '../../../shared/welcome';

const STATES = new Set<WelcomeState>(['off', 'done', 'login', 'ready']);
const CHOICES = new Set(['site', 'explicar', 'organizar']);

/** Cópia local do "já pulei/usei": só para o cartão não piscar antes da resposta do servidor (quem manda é ele). */
export const WELCOME_LOCAL_KEY = 'habblaud.boasvindas.local';

export function parseWelcomeView(raw: unknown): WelcomeView | null {
  const o = raw as Partial<WelcomeView> | null;
  if (!o || !STATES.has(o.state as WelcomeState)) return null;
  const suggestions = Array.isArray(o.suggestions)
    ? o.suggestions.filter((s): s is WelcomeSuggestion => !!s && CHOICES.has((s as WelcomeSuggestion).id) && typeof (s as WelcomeSuggestion).text === 'string')
    : [];
  const d = o.delivery as Partial<WelcomeDelivery> | undefined;
  const delivery = d && typeof d.agentId === 'string' && (d.state === 'waiting' || d.state === 'sent' || d.state === 'failed') ? { agentId: d.agentId, state: d.state } : undefined;
  return { state: o.state as WelcomeState, suggestions, ...(delivery ? { delivery } : {}) };
}

export interface WelcomeShowInput {
  view: WelcomeView | null;
  /** Escritório conectado, fora do timelapse e sem agentes nem salas (officeIsEmpty). */
  officeEmpty: boolean;
  /** O cartão já apareceu nesta página (fica até escolher ou pular, mesmo com agentes chegando). */
  shown: boolean;
  /** Terminal embutido aberto por cima (login em andamento): o cartão espera ele fechar. */
  shellOpen: boolean;
  /** Pulou/usou neste navegador e o servidor ainda não respondeu. */
  dismissed: boolean;
  /** Página de demonstração/mock (sem servidor de verdade). */
  mock: boolean;
}

/** O cartão aparece agora? */
export function shouldShowWelcome(i: WelcomeShowInput): boolean {
  if (i.mock || i.dismissed || i.shellOpen || !i.view) return false;
  if (i.view.state !== 'login' && i.view.state !== 'ready') return false;
  return i.shown || i.officeEmpty;
}

/** Aviso quando a entrega da primeira mensagem termina (undefined = ainda esperando). */
export function deliveryNotice(d: WelcomeDelivery | undefined, name: string | undefined): { text: string; level: 'info' | 'warn' } | undefined {
  if (!d || d.state === 'waiting') return undefined;
  const who = name || 'Seu agente';
  if (d.state === 'sent') return { text: `${who} recebeu o primeiro pedido e já está trabalhando. Clique nele para acompanhar.`, level: 'info' };
  return { text: `${who} abriu, mas não consegui mandar o primeiro pedido. Clique nele e escreva na caixa de mensagem.`, level: 'warn' };
}
