// Missões no escritório (quadro de missões): o que o servidor manda para o quadro (GET /api/missions).
// Uma missão por vez: as seguintes ficam trancadas (silhueta + "?") até a atual ser concluída.

export type MissionId = 'primeiro-site' | 'peca-melhoria' | 'jogo-pixel' | 'leve-github' | 'api-banco';

/**
 * - locked: ainda não liberada (o quadro só mostra a silhueta, sem título nem objetivo);
 * - available: a próxima da fila, esperando o "Começar";
 * - active: começada, com a detecção automática rodando;
 * - done: concluída (recompensa paga uma vez).
 */
export type MissionState = 'locked' | 'available' | 'active' | 'done';

/** Um passo do objetivo, conferido pela detecção automática. */
export interface MissionStep {
  label: string;
  ok: boolean;
}

export interface MissionView {
  id: MissionId;
  number: number;
  state: MissionState;
  coins: number;
  xp: number;
  /** Só fora de `locked`. */
  title?: string;
  /** Por que vale a pena (1 linha). */
  why?: string;
  /** O objetivo, nunca um pedido pronto. */
  goal?: string;
  /** Exemplo de pedido, mostrado só se a pessoa abrir "exemplo". */
  example?: string;
  /** Pasta do projeto da missão (~/projetos/<slug>). */
  project?: string;
  /** Passos conferidos (missão ativa). */
  steps?: MissionStep[];
  /** Informação extra da detecção (ex.: "servidor no ar na porta 41873"). */
  info?: string;
  startedAt?: number;
  doneAt?: number;
  doneBy?: 'auto' | 'manual';
}

export interface MissionLevel {
  level: number;
  name: string;
  /** XP no início deste nível e do próximo (undefined = nível máximo). */
  floor: number;
  next?: number;
}

export interface MissionsView {
  missions: MissionView[];
  /** Caixa do escritório: moedas das missões (cada missão paga uma vez). */
  wallet: { coins: number; ledger: { at: number; delta: number; mission: MissionId; text: string }[] };
  xp: number;
  level: MissionLevel;
  /** Dias seguidos com missão começada, concluída ou mensagem pelo escritório. */
  streak: number;
  /** Concluídas cuja comemoração ainda não foi vista (POST /api/missions/:id/seen). */
  celebrate: MissionId[];
}

/** Resposta de POST /api/missions/:id/start. */
export interface MissionStartResult {
  view: MissionsView;
  /** Pasta do projeto (criada se não existia; nunca sobrescreve). */
  project: string;
  /** Agente da missão: aberto agora ("ok"), já presente na pasta ("reused") ou nenhum. */
  agentId?: string;
  spawn: 'ok' | 'reused' | 'unavailable' | 'failed';
}
