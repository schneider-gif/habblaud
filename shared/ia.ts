// Seletor de IA da barra (Motores de IA Habblaude + conta Claude do cliente). O catálogo vale no servidor (só estes
// ids são aceitos em POST /api/ia) e no cliente (nome, descrição, logo). Ids do OpenRouter, todos com ferramentas
// (o Claude Code precisa). Preços conferidos em 12/11/2026 (US$ por milhão de tokens, entrada/saída).
export interface IaModelo {
  id: string;
  nome: string;
  desc: string;
  /** arquivo em /assets/ia/ */
  logo: string;
  /** gasta o limite do dia bem mais rápido */
  premium?: boolean;
}

export const IA_MODELOS: readonly IaModelo[] = [
  { id: 'minimax/minimax-m2.7', nome: 'Prisma', desc: 'Padrão. Bom e barato para o dia a dia.', logo: 'prisma.svg' }, // 0,21/0,84
  { id: 'deepseek/deepseek-v3.2', nome: 'DeepSeek V3.2', desc: 'Forte em código e matemática.', logo: 'deepseek.svg' }, // 0,26/0,38
  { id: 'qwen/qwen3-coder-next', nome: 'Qwen3 Coder', desc: 'Da Alibaba. Feito para programar.', logo: 'qwen.svg' }, // 0,12/0,80
  { id: 'anthropic/claude-sonnet-5.5', nome: 'Claude Sonnet 5.5', desc: 'Premium. O melhor em código.', logo: 'claude.svg', premium: true }, // 2/10
];
export const IA_PADRAO = IA_MODELOS[0]!.id;

export type IaModo = 'motores' | 'conta' | 'nenhum';

/** GET /api/ia */
export interface IaEstado {
  /** daemon hb-ia rodando (publicou estado); sem ele o botão some */
  disponivel: boolean;
  /** adicional Motores de IA ativo */
  motores: boolean;
  /** conta Claude conectada (login, chave ou token do setup-token) */
  conta: boolean;
  modo: IaModo;
  /** id do modelo em uso (modo motores) */
  modelo: string | null;
  uso: { hoje: number; limite: number | null } | null;
  /** token do setup-token salvo pelo escritório */
  token: boolean;
  /** "config-do-cliente": configuração própria impede os Motores */
  bloqueio?: string;
}

/** Token do `claude setup-token` (sk-ant-oat01-…). */
export const RE_CLAUDE_TOKEN = /^sk-ant-[\w-]{20,400}$/;

export const iaModelo = (id: string | null | undefined): IaModelo | undefined => IA_MODELOS.find((m) => m.id === id);
