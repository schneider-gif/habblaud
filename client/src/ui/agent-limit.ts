// Limite de agentes do plano ("N/M agentes" no Novo agente), como GET /api/agents/new devolve.
/** Limite do plano que GET /api/agents/new devolve. */
export interface AgentLimitInfo {
  running: number;
  max: number;
  plan?: string;
}

const PLAN_LABEL: Record<string, string> = { recepcao: 'Recepção', sala: 'Sala', andar: 'Andar' };

/** "1/2 agentes rodando (plano Sala)"; undefined = sem limite. */
export function limitText(l: AgentLimitInfo | undefined): string | undefined {
  if (!l || !Number.isFinite(l.max) || l.max < 1) return undefined;
  const plan = l.plan && PLAN_LABEL[l.plan] ? ` (plano ${PLAN_LABEL[l.plan]})` : '';
  const full = l.running >= l.max ? ' — feche um agente para abrir outro' : '';
  return `${l.running}/${l.max} agentes rodando${plan}${full}`;
}
