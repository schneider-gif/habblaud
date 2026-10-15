// Claude ou Codex: a escolha da ferramenta no "+ Novo agente" (lembrada no navegador) e o selo dos agentes do Codex.
// Código puro (sem DOM), testado em engine.test.ts.
import type { AgentInfo, RecentSession } from '../../../shared/types';

export type Engine = 'claude' | 'codex';

/** Chave do localStorage com a última ferramenta escolhida no "+ Novo agente". */
export const ENGINE_KEY = 'habblaud.novoAgente.ferramenta';

export const ENGINE_LABEL: Record<Engine, string> = { claude: 'Claude', codex: 'Codex' };

/** Cor do selo "Codex" (verde da OpenAI); o Claude não tem selo (é o padrão). */
export const CODEX_BADGE_COLOR = '#10a37f';

export function engineOf(a: Pick<AgentInfo, 'engine'> | Pick<RecentSession, 'engine'> | undefined): Engine {
  return a?.engine === 'codex' ? 'codex' : 'claude';
}

/**
 * Ferramenta que o diálogo abre marcada: a última escolhida, se ainda estiver instalada; senão a primeira instalada
 * (Claude antes). `available` ausente (servidor antigo) = só Claude.
 */
export function pickEngine(saved: string | null | undefined, available?: Partial<Record<Engine, boolean>>): Engine {
  const has = (e: Engine) => (available ? available[e] !== false : e === 'claude');
  if ((saved === 'claude' || saved === 'codex') && has(saved)) return saved;
  if (has('claude')) return 'claude';
  return has('codex') ? 'codex' : 'claude';
}

/** Texto do aviso depois de abrir: o que esperar (o Codex sem login pede a conta OpenAI). */
export function arrivingText(name: string, engine: Engine): string {
  const who = name || 'O novo agente';
  return engine === 'codex' ? `${who} (Codex) está chegando: aparece no escritório em alguns segundos.` : `${who} está chegando: aparece no escritório em alguns segundos.`;
}
