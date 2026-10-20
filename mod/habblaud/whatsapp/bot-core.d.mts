// Tipos de bot-core.mjs (os testes importam o módulo em JS puro).
export interface MensagemWa { id: number; de: string; nome?: string | null; texto: string; recebidaEm: string }
export interface ConfigBot { ativo?: boolean; pausado?: boolean; instrucoes?: string; ignorar?: string[]; numero?: string | null }
export interface ItemHistorico { quem: 'cliente' | 'bot'; texto: string; em?: string }
export declare const CHAMAR_DONO: string;
export declare const ESPERA_PADRAO: string;
export declare const IDADE_MAX_MS: number;
export declare const HISTORICO_PROMPT: number;
export declare const HISTORICO_MAX: number;
export declare const SYSTEM_PROMPT: string;
export declare function claudeArgs(prompt: string): string[];
export declare function soDigitos(s: unknown): string;
export declare function mascarar(numero: unknown): string;
export declare function filtrar(mensagens: MensagemWa[], cfg: ConfigBot, agora: number): MensagemWa[];
export declare function montarPrompt(instrucoes: string | undefined, historico: ItemHistorico[], msg: Pick<MensagemWa, 'nome' | 'texto'>): string;
export declare function lerResposta(texto: string): { chamarDono: boolean; resposta: string };
export declare function lerSaidaClaude(stdout: string): string | null;
export declare function backoff(n: number): number;
export declare function aparar<T>(historico: T[]): T[];
