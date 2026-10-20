// Tipos de bot-core.mjs (os testes importam o módulo em JS puro).
export interface MidiaWa { tipo: 'imagem' | 'audio'; id?: string; legenda?: string; transcricao?: string }
export interface MensagemWa { id: number; de: string; nome?: string | null; texto: string; recebidaEm: string; midia?: MidiaWa; imagemFalhou?: boolean }
export interface ConfigBot { ativo?: boolean; pausado?: boolean; instrucoes?: string; conhecimento?: string; conhecimentoVersao?: string; ignorar?: string[]; assumidas?: string[]; somente?: string[]; numero?: string | null }
export interface ItemHistorico { quem: 'cliente' | 'bot'; texto: string; em?: string }
export interface Registro { tipo: 'pedido' | 'orcamento' | 'agendamento' | 'contato'; resumo: string; dados?: Record<string, unknown> }
export interface Imagem { mime: string; base64: string }
export declare const CHAMAR_DONO: string;
export declare const REGISTRO: string;
export declare const ESPERA_PADRAO: string;
export declare const PEDIR_TEXTO: string;
export declare const IDADE_MAX_MS: number;
export declare const RAJADA_MS: number;
export declare const HISTORICO_PROMPT: number;
export declare const HISTORICO_MAX: number;
export declare const CONHECIMENTO_MAX: number;
export declare const IMAGENS_MAX: number;
export declare const TIPOS_REGISTRO: string[];
export declare const SYSTEM_PROMPT: string;
export declare function claudeArgs(): string[];
export declare function mensagemClaude(prompt: string, imagens?: Imagem[]): string;
export declare function soDigitos(s: unknown): string;
export declare function chaveNumero(numero: unknown): string;
export declare function mascarar(numero: unknown): string;
export declare function filtrar<T extends MensagemWa>(mensagens: T[], cfg: ConfigBot, agora: number): T[];
export declare function textoDaMensagem(m: MensagemWa): string;
export declare function soAudioSemTexto(msgs: MensagemWa[]): boolean;
export declare function montarPrompt(cfg: ConfigBot, historico: ItemHistorico[], msgs: MensagemWa[]): string;
export declare function validarRegistro(json: string): Registro | null;
export declare function lerResposta(texto: string): { chamarDono: boolean; mensagens: string[]; registros: Registro[] };
export declare function lerSaidaClaude(stdout: string): string | null;
export declare function prontos(fila: Record<string, { ultimaEm: number; msgs: unknown[] }>, agora: number): string[];
export declare function backoff(n: number): number;
export declare function aparar<T>(historico: T[]): T[];
