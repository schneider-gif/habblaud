// Tipos da publicação ("Hospedagem Habblaude"): o contrato com o portal (docs do portal:
// 2026-10-14-publicar-contrato.md) e as respostas das rotas locais /api/publish/* do escritório.

// ---------------------------------------------------------------- contrato com o portal

export type Tipo = 'static' | 'vite' | 'next' | 'node' | 'python' | 'dockerfile';
export const TIPOS: readonly Tipo[] = ['static', 'vite', 'next', 'node', 'python', 'dockerfile'];

export interface SiteConfig {
  /** Comando de instalação (ex. "npm ci"); vazio = padrão do tipo. */
  install?: string;
  /** Ex. "npm run build". */
  build?: string;
  /** Ex. "npm start" (node/next/python/dockerfile opcional). */
  start?: string;
  /** Porta HTTP que o app escuta (static/vite: 8080, ignorado). */
  porta: number;
  /** Pasta gerada pelo build (vite: "dist"); static: pasta com o index.html ("." padrão). */
  saida?: string;
  /** static/vite: toda rota cai no index.html. */
  spa?: boolean;
}

export interface Registro {
  tipo: 'CNAME' | 'A' | 'TXT';
  /** Host completo. */
  nome: string;
  valor: string;
}

export interface DominioView {
  nome: string;
  status: 'pendente' | 'ok';
  registros: Registro[];
  erro?: string;
  verificadoEm?: string;
}

export type DeployStatus = 'queued' | 'building' | 'ok' | 'failed' | 'canceled';

export interface DeployView {
  id: string;
  status: DeployStatus;
  erro?: string;
  criadoEm: string;
  terminouEm?: string;
  tamanho?: number;
}

export type SiteStatus = 'novo' | 'publicando' | 'no_ar' | 'falhou' | 'suspenso' | 'removido';

export interface SiteView {
  id: string;
  nome: string;
  tipo: Tipo;
  status: SiteStatus;
  /** "loja-fulano.habblaude.app" */
  subdominio: string;
  /** "https://loja-fulano.habblaude.app" (ou o domínio próprio verificado). */
  url: string;
  dominios: DominioView[];
  config: SiteConfig;
  envKeys: string[];
  ultimoDeploy?: DeployView;
  criadoEm: string;
}

export interface PlanoView {
  id: 'vitrine' | 'estudio';
  nome: string;
  maxSites: number;
  memoriaMB: number;
  cpus: number;
  maxDominios: number;
  maxUploadMB: number;
}

export type MotivoInativo = 'sem_complemento' | 'assinatura_inativa' | 'desligado';

export interface Conta {
  /** Parte do endereço depois do hífen; null = ainda não escolheu. */
  handle: string | null;
  /** Sugestão (do e-mail) para o passo 4. */
  handleSugerido: string;
  /** "habblaude.app" */
  dominioBase: string;
  ativo: boolean;
  motivo?: MotivoInativo;
  plano: PlanoView | null;
  sites: SiteView[];
  /** Página do portal para contratar o complemento. */
  contratarUrl: string;
  /** IP para registro A (domínio raiz). */
  ipServidor?: string;
}

/** Nome do site: 1–30 de [a-z0-9-]. */
export const SITE_NAME_RE = /^[a-z0-9-]{1,30}$/;
/** Handle: 3–20 de [a-z0-9], começando por letra. */
export const HANDLE_RE = /^[a-z][a-z0-9]{2,19}$/;
/** Chave de variável de ambiente aceita pelo portal. */
export const ENV_KEY_RE = /^[A-Z_][A-Z0-9_]*$/;
export const ENV_MAX_VARS = 50;
export const ENV_MAX_VALUE = 4096;
/** Comandos: o portal recusa quebras de linha e mais de 300 caracteres. */
export const COMMAND_MAX = 300;

/** Transforma um nome qualquer (pasta do projeto) num nome de site válido. */
export function slugSite(name: string): string {
  const s = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
  return s || 'site';
}

/** Comando aceitável para o portal? (undefined = ok; senão o motivo) */
export function commandProblem(cmd: string | undefined): string | undefined {
  if (!cmd) return undefined;
  if (/[\r\n]/.test(cmd)) return 'o comando não pode ter quebra de linha';
  if (cmd.length > COMMAND_MAX) return `o comando passa de ${COMMAND_MAX} caracteres`;
  return undefined;
}

// ---------------------------------------------------------------- rotas locais (/api/publish/*)

export interface Deteccao {
  tipo: Tipo;
  config: SiteConfig;
  /** Por que achamos que é desse tipo (texto simples, pt-BR). */
  motivo: string;
  avisos: string[];
}

export interface SegredoEncontrado {
  /** Caminho relativo à raiz do projeto (com "/"). */
  arquivo: string;
  linha: number;
  /** Código do padrão (stripe_live, aws, github, ...). */
  tipo: string;
  /** Rótulo para leigos ("Chave secreta do Stripe (produção)"). */
  rotulo: string;
}

export interface ProjetoLocal {
  /** Nome da pasta. */
  nome: string;
  /** Caminho absoluto. */
  path: string;
}

export interface PublishPairing {
  code: string;
  url: string;
  status: 'pending' | 'ok' | 'expired' | 'error';
  erro?: string;
  expiresAt: number;
}

export interface PublishStatus {
  /** Rotas locais ligadas (bind local + Host local). */
  available: true;
  portalUrl: string;
  /** Há token guardado (arquivo ou HB_PUBLISH_TOKEN). */
  connected: boolean;
  tokenSource: 'env' | 'file' | null;
  pairing?: PublishPairing;
  conta?: Conta;
  /** Falha ao falar com o portal (rede, token recusado...). */
  erro?: string;
  /** Código do erro do portal (unauthenticated, ...). */
  erroCode?: string;
}

export interface EnvImport {
  vars: Record<string, string>;
  /** Arquivos lidos (".env", ".env.production"). */
  arquivos: string[];
  /** Chaves ignoradas (nome inválido para o portal). */
  ignoradas: string[];
}

export interface PacoteInfo {
  tamanho: number;
  arquivos: number;
  avisos: string[];
}

export type PublishRequestStatus = 'pending' | 'publishing' | 'ok' | 'failed' | 'rejected' | 'expired';

/** Pedido de publicação feito por um agente (CLI habblaud-publicar), esperando o "Publicar" do usuário. */
export interface PublishRequest {
  id: string;
  path: string;
  /** Nome da pasta (para mostrar). */
  projeto: string;
  siteId?: string;
  /** Quem pediu (texto livre do CLI, ex. "Claude"). */
  origem?: string;
  status: PublishRequestStatus;
  criadoEm: number;
  deployId?: string;
  url?: string;
  erro?: string;
}
