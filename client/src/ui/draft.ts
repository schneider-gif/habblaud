/** Troca de agente no terminal: guarda o texto do agente que sai e devolve o rascunho do que entra (sessão do histórico = null, sem rascunho). */
export function swapDraft(drafts: Map<string, string>, from: string | null, text: string, to: string | null): string {
  if (from) drafts.set(from, text);
  return to ? (drafts.get(to) ?? '') : '';
}
