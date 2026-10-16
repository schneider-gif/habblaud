// Tipos de caixa.mjs (o servidor e os testes importam o módulo em JS puro).
export interface Limites {
  maxBytes: number;
  porMinuto: number;
  porHora: number;
  inline: number;
  porAviso: number;
  guardarLidasMs: number;
}
export declare const LIMITES: Readonly<Limites>;
export declare const PASTAS: readonly ['novas', 'avisadas', 'lidas'];
export type Pasta = 'novas' | 'avisadas' | 'lidas' | 'tmp';

export declare class ErroMsg extends Error {
  codigo: number;
  constructor(message: string, codigo?: number);
}

export interface Ponta {
  sid: string;
  nome: string;
  engine: 'claude' | 'codex';
}
export interface Mensagem {
  v: 1;
  id: string;
  ts: number;
  hora: string;
  de: Ponta;
  para: Ponta;
  texto: string;
  respondeA?: string;
}
export interface Agente {
  id: string;
  sid: string;
  curto: string;
  nome: string;
  engine: 'claude' | 'codex';
  status: string;
  statusSince?: number;
  pasta: string;
  pid?: number;
}

export declare function raizPadrao(home: string, env?: Record<string, string | undefined>): string;
export declare function idSeguro(id: string): string;
export declare function novoIdMensagem(now?: number, rnd?: () => number): string;
export declare function validarTexto(texto: unknown, maxBytes?: number): string;
export declare function comTrava<T>(caminho: string, fn: () => T, opts?: { staleMs?: number; timeoutMs?: number }): T;
export declare function pastaDaCaixa(raiz: string, sid: string, pasta: Pasta): string;
export declare function chaveDoPar(a: string, b: string): string;
export declare function registrarNoPar(
  raiz: string,
  a: string,
  b: string,
  opts?: { now?: number; limites?: Limites },
): { ok: true } | { ok: false; motivo: string; esperarS: number };
export declare function enviarMensagem(
  raiz: string,
  m: { de: Partial<Ponta> & { sid: string }; para: Partial<Ponta> & { sid: string }; texto: unknown; respondeA?: string },
  opts?: { now?: number; limites?: Limites; rnd?: () => number },
): Mensagem;
export declare function listarPasta(raiz: string, sid: string, pasta: Pasta): Mensagem[];
export declare function naoLidas(raiz: string, sid: string): number;
export declare function mover(raiz: string, sid: string, id: string, de: Pasta, para: Pasta): boolean;
export declare function lerCaixa(raiz: string, sid: string, opts?: { now?: number; limites?: Limites }): Mensagem[];
export declare function limparLidas(raiz: string, sid: string, now?: number, maxIdadeMs?: number): void;
export declare function acharMensagem(raiz: string, sid: string, id: string): Mensagem;
export declare function pendentes(raiz: string): Map<string, Mensagem[]>;
export declare function normalizarNome(s: string): string;
export declare function pidDoAgente(id: string): number | undefined;
export declare function agentesDoSnapshot(snap: unknown): Agente[];
export declare function ppidDoStat(stat: string): number | undefined;
export declare function ancestrais(pid: number, lerStat?: (pid: number) => string): number[];
export declare function paneDoEnviron(environ: string): string | undefined;
export declare function quemSouEu(
  agentes: Agente[],
  opts?: { env?: Record<string, string | undefined>; pids?: number[]; paneDe?: (pid: number) => string | undefined },
): Agente | undefined;
export declare function resolverDestino(agentes: Agente[], alvo: string, eu?: Agente): Agente;
export declare function textoDoAviso(msgs: Mensagem[], limites?: Limites): { texto: string; inteiras: string[]; incluidas: string[] };
