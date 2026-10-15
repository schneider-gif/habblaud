// Regras puras do assistente "Publicar" (sem DOM): rótulos, validações e o casamento projeto <-> site.
import {
  COMMAND_MAX,
  ENV_KEY_RE,
  ENV_MAX_VALUE,
  ENV_MAX_VARS,
  HANDLE_RE,
  SITE_NAME_RE,
  commandProblem,
  envKeyReserved,
  slugSite,
  type DeployStatus,
  type MotivoInativo,
  type SiteConfig,
  type SiteStatus,
  type SiteView,
  type Tipo,
} from '../../../shared/publish';

export const TIPO_LABEL: Record<Tipo, string> = {
  static: 'Site estático (HTML pronto)',
  vite: 'Site com build (Vite, React…)',
  next: 'Next.js',
  node: 'App Node.js',
  python: 'App Python',
  dockerfile: 'Dockerfile próprio',
};

export const SITE_STATUS_LABEL: Record<SiteStatus, string> = {
  novo: 'Novo',
  publicando: 'Publicando…',
  no_ar: 'No ar',
  falhou: 'Falhou',
  suspenso: 'Suspenso',
  removido: 'Removido',
};

export const DEPLOY_STATUS_LABEL: Record<DeployStatus, string> = {
  queued: 'Na fila',
  building: 'Construindo',
  ok: 'Publicado',
  failed: 'Falhou',
  canceled: 'Cancelado',
};

export const MOTIVO_LABEL: Record<MotivoInativo, string> = {
  sem_complemento: 'Sua assinatura ainda não tem o complemento Hospedagem Habblaude.',
  assinatura_inativa: 'Sua assinatura está suspensa ou cancelada. Regularize no portal para publicar.',
  desligado: 'A hospedagem está temporariamente desligada. Tente de novo mais tarde.',
};

/** Que campos de configuração fazem sentido para cada tipo. */
export function fieldsFor(tipo: Tipo): { install: boolean; build: boolean; start: boolean; porta: boolean; saida: boolean; spa: boolean } {
  switch (tipo) {
    case 'static':
      return { install: false, build: false, start: false, porta: false, saida: true, spa: true };
    case 'vite':
      return { install: true, build: true, start: false, porta: false, saida: true, spa: true };
    case 'next':
    case 'node':
    case 'python':
      return { install: true, build: true, start: true, porta: true, saida: false, spa: false };
    case 'dockerfile':
      return { install: false, build: false, start: true, porta: true, saida: false, spa: false };
  }
}

/** Configuração limpa para o tipo (sem campos que não se aplicam, sem vazios). */
export function cleanConfig(tipo: Tipo, c: SiteConfig): SiteConfig {
  const f = fieldsFor(tipo);
  const out: SiteConfig = { porta: f.porta ? Math.floor(Number(c.porta)) : 8080 };
  const put = (k: 'install' | 'build' | 'start' | 'saida', on: boolean) => {
    const v = (c[k] ?? '').trim();
    if (on && v) out[k] = v;
  };
  put('install', f.install);
  put('build', f.build);
  put('start', f.start);
  put('saida', f.saida);
  if (f.spa) out.spa = !!c.spa;
  return out;
}

/** Problemas da configuração (vazio = ok). */
export function configProblems(tipo: Tipo, c: SiteConfig): string[] {
  const out: string[] = [];
  const f = fieldsFor(tipo);
  for (const [k, label] of [
    ['install', 'instalação'],
    ['build', 'build'],
    ['start', 'início'],
  ] as const) {
    const p = commandProblem(c[k]);
    if (p) out.push(`Comando de ${label}: ${p}.`);
  }
  if (f.porta) {
    const n = Number(c.porta);
    if (!Number.isInteger(n) || n < 1 || n > 65535) out.push('A porta precisa ser um número entre 1 e 65535.');
  }
  if (f.saida && c.saida && (c.saida.includes('..') || c.saida.startsWith('/'))) out.push('A pasta de saída precisa ficar dentro do projeto.');
  return out;
}

export { COMMAND_MAX };

export interface EnvRow {
  key: string;
  value: string;
  /** Já salva no portal (o valor não volta): fica como está se ninguém mexer. */
  saved?: boolean;
}

/** Valida as variáveis. `changed` = alguém mexeu (então todas vão de novo, porque o portal troca tudo). */
export function envProblems(rows: readonly EnvRow[], changed: boolean): string[] {
  const out: string[] = [];
  const used = rows.filter((r) => r.key.trim() || r.value);
  if (used.length > ENV_MAX_VARS) out.push(`No máximo ${ENV_MAX_VARS} variáveis.`);
  const seen = new Set<string>();
  for (const r of used) {
    const k = r.key.trim();
    if (!ENV_KEY_RE.test(k)) out.push(`"${k || '(sem nome)'}": use só LETRAS_MAIÚSCULAS, números e _ (sem começar por número).`);
    else if (envKeyReserved(k)) out.push(`"${k}" é reservada: a porta e o nome do servidor são definidos pela hospedagem.`);
    else if (seen.has(k)) out.push(`"${k}" aparece duas vezes.`);
    seen.add(k);
    if (r.value.length > ENV_MAX_VALUE) out.push(`"${k}": valor grande demais (máximo 4 KB).`);
    if (changed && r.saved && !r.value) out.push(`"${k}": digite o valor de novo (por segurança o portal não mostra valores salvos) ou remova a linha.`);
  }
  return out;
}

export function envObject(rows: readonly EnvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

/** Junta variáveis importadas do .env às linhas atuais (o .env vence nas chaves repetidas). */
export function mergeEnv(rows: readonly EnvRow[], vars: Record<string, string>): EnvRow[] {
  const out = rows.filter((r) => r.key.trim() || r.value).map((r) => ({ ...r }));
  for (const [key, value] of Object.entries(vars)) {
    const cur = out.find((r) => r.key.trim() === key);
    if (cur) {
      cur.value = value;
      cur.saved = false;
    } else out.push({ key, value });
  }
  return out;
}

export function siteNameProblem(nome: string): string | undefined {
  if (!SITE_NAME_RE.test(nome)) return 'Use de 1 a 30 letras minúsculas, números e hífen.';
  return undefined;
}

export function handleProblem(handle: string): string | undefined {
  if (!HANDLE_RE.test(handle)) return 'Use de 3 a 20 letras minúsculas e números, começando por letra.';
  return undefined;
}

/** "<nome>-<handle>.habblaude.app" */
export function addressPreview(nome: string, handle: string, base = 'habblaude.app'): string {
  return `${nome || 'nome'}-${handle || 'voce'}.${base}`;
}

/** Site que já corresponde a este projeto (mesmo nome da pasta). */
export function siteForProject(sites: readonly SiteView[], projectName: string): SiteView | undefined {
  const slug = slugSite(projectName);
  return sites.find((s) => s.nome === slug && s.status !== 'removido');
}

/** Domínio válido (para o campo "domínio próprio"). */
export function domainProblem(d: string): string | undefined {
  const v = d.trim().toLowerCase();
  if (!/^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(v)) return 'Digite só o domínio, ex.: www.minhaloja.com.br (sem https://).';
  if (v.endsWith('.habblaude.app')) return 'Esse já é o endereço grátis: use um domínio seu.';
  return undefined;
}

/** Normaliza o que a pessoa colou (tira https://, barra e espaços). */
export function normalizeDomain(d: string): string {
  return d
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .replace(/\.$/, '');
}

/** Tamanho legível (KB/MB). */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1048576).toFixed(1).replace('.', ',')} MB`;
}

/**
 * Linhas novas de um evento de log, descartando as já vistas (o stream recomeça do início ao reconectar).
 * `state.idx` conta as linhas desta conexão; `state.seen` as já mostradas.
 */
export function takeNewLines(state: { idx: number; seen: number }, linhas: readonly string[]): string[] {
  const out: string[] = [];
  for (const l of linhas) {
    state.idx++;
    if (state.idx > state.seen) {
      out.push(l);
      state.seen++;
    }
  }
  return out;
}
