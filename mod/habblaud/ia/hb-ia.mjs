#!/usr/bin/env node
// Motores de IA: liga os agentes do escritório na chave OpenRouter do cliente (add-on do portal Habblaude).
// A cada 5 min pede a chave ao portal (POST /api/escritorio/ia/chave {agentToken}), grava ~/.habblaude/ia-chave (600)
// e põe apiKeyHelper + env no ~/.claude/settings.json, marcando "hbIaGerenciado" para tirar só o que é dele.
// Seletor da barra (servidor do escritório): ~/.habblaude/ia-escolha.json {modo: motores|conta, modelo?} decide entre os
// Motores e a conta Claude do cliente; sem escolha, a conta própria vence (como antes). ~/.habblaude/claude-token (do
// `claude setup-token`) vira env CLAUDE_CODE_OAUTH_TOKEN. O estado vai para ~/.habblaude/ia-estado.json (sem segredos).
// Mudou a escolha ou o token: roda na hora (fs.watch), reaproveitando a última resposta do portal.
// A chave nunca vai para env de processo, argv nem log. Sobe com o escritório (hb-supervise ia) ou pelo systemd (VM).
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, watch, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INTERVALO_MS = 300_000;
// depois de religar o 1º pedido costuma dar 401 (token do agente novo): tenta de novo logo (portal aceita 1/min)
const RETENTE_MS = 65_000, RETENTES = 5;
// tirados do seletor (voltavam vazios no Claude Code); quem já tinha escolhido cai no padrão
const MODELOS_FORA = new Set(['google/gemini-3.5-flash-lite']);
const MARCA = 'hbIaGerenciado';
const HELPER = 'cat ~/.habblaude/ia-chave';
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS',
  'CLAUDE_CODE_MAX_OUTPUT_TOKENS'];

const CRED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];
// estas passam na frente do apiKeyHelper (ordem de credenciais do Claude Code): com elas os Motores não valeriam
const CRED_ACIMA = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const MARCA_TOKEN = 'hbIaToken'; // hash do token que pusemos em env.CLAUDE_CODE_OAUTH_TOKEN
const ESCOLHA = 'ia-escolha.json', ESTADO = 'ia-estado.json', TOKEN_ARQ = 'claude-token';
const RE_MODELO = /^[\w./:-]{3,100}$/;
const RE_TOKEN = /^sk-ant-[\w-]{20,400}$/;
const hb = (home, nome) => join(home, '.habblaude', nome);
const hash = (t) => createHash('sha256').update(t).digest('hex').slice(0, 16);

const ler = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
function parse(t) {
  try { const j = JSON.parse(t); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
/** objeto JSON do arquivo; {} se não existe; null se existe e não é JSON (aí não mexemos) */
function lerJson(p) { const t = ler(p); return t === null ? {} : parse(t); }

// escrita atômica (tmp + rename): o Claude Code lê o settings a qualquer hora. Segue symlink e mantém o modo do arquivo.
function gravar(p, texto, modePadrao) {
  let real = p, mode = modePadrao;
  try { real = realpathSync(p); mode = statSync(real).mode & 0o777; } catch { /* ainda não existe */ }
  const tmp = `${real}.hb-ia.tmp`;
  writeFileSync(tmp, texto, { mode });
  chmodSync(tmp, mode); // o umask pode ter tirado bits
  renameSync(tmp, real);
}
const gravarJson = (p, j, mode = 0o644) => gravar(p, JSON.stringify(j, null, 2) + '\n', mode);

/** Lê o JSON, deixa fn(s) decidir ({r, novo?}) e grava `novo`; se o arquivo mudou entre a leitura e a gravação, refaz 1 vez. */
function editar(p, fn, mode = 0o644) {
  for (let i = 0; i < 2; i++) {
    const t0 = ler(p);
    const s = t0 === null ? {} : parse(t0);
    if (!s) return 'settings-invalido';
    const { r, novo } = fn(s);
    if (!novo) return r;
    if (JSON.stringify(novo) === JSON.stringify(s)) return r; // nada mudou: não mexe no arquivo
    if (ler(p) !== t0) continue;
    gravarJson(p, novo, mode);
    return r;
  }
  return 'erro-concorrencia';
}

// o que gravamos por último: { chave: valor }
const gravado = (s) => s?.[MARCA]?.env ?? {};

/** Login/credencial própria: OAuth do Pro/Max, chave do /login, ou token/chave em env (settings do cliente ou processo). */
export function contaPropria(home, env = process.env) {
  const o = lerJson(join(home, '.claude', '.credentials.json'))?.claudeAiOauth;
  if (o?.accessToken || o?.refreshToken || lerJson(join(home, '.claude.json'))?.primaryApiKey) return true;
  const senv = lerJson(join(home, '.claude', 'settings.json'))?.env ?? {};
  return CRED_ENV.some((k) => !!env[k] || !!(typeof senv === 'object' && senv[k]));
}

export function aplicar(home, { chave, baseUrl, modelo }) {
  const sp = join(home, '.claude', 'settings.json');
  const valores = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: modelo, ANTHROPIC_DEFAULT_OPUS_MODEL: modelo,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelo, ANTHROPIC_DEFAULT_HAIKU_MODEL: modelo, CLAUDE_CODE_SUBAGENT_MODEL: modelo,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '190000', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '300000',
    // o Claude Code pede até 128k de saída; o OpenRouter recusa (402) se o crédito do dia não cobre esse máximo
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '16000' };
  mkdirSync(join(home, '.claude'), { recursive: true });
  const r = editar(sp, (s) => {
    const rec = gravado(s);
    const env = s.env && typeof s.env === 'object' ? s.env : {};
    // qualquer valor que não fomos nós que gravamos é configuração do cliente: não mexe em nada
    // (valor igual ao nosso conta como nosso: o limite de saída foi posto à mão no escritório do dono em 12/11, antes da 0.12.11)
    if (ENV_KEYS.some((k) => k in env && env[k] !== rec[k] && env[k] !== valores[k])) return { r: 'config-do-cliente' };
    if ('apiKeyHelper' in s && !(s[MARCA] && s.apiKeyHelper === HELPER)) return { r: 'config-do-cliente' };
    return { r: 'gravou', novo: { ...s, apiKeyHelper: HELPER, env: { ...env, ...valores }, [MARCA]: { env: valores } } };
  });
  if (r !== 'gravou') return r;
  // a chave só entra depois do settings ter sido aceito (sem arquivo sobrando em config-do-cliente/erro-concorrencia)
  mkdirSync(join(home, '.habblaude'), { recursive: true, mode: 0o700 });
  const arq = join(home, '.habblaude', 'ia-chave');
  if (ler(arq) !== chave) gravar(arq, chave, 0o600);
  chmodSync(arq, 0o600);
  // sem o onboarding marcado o Claude Code abre a tela de login mesmo com a chave
  const cj = join(home, '.claude.json');
  const c = lerJson(cj);
  if (c && !c.hasCompletedOnboarding) gravarJson(cj, { ...c, hasCompletedOnboarding: true }, 0o600);
  return r;
}

/** Tira só o que ainda tem o valor que gravamos; settings primeiro, arquivo da chave só depois. */
export function remover(home) {
  const sp = join(home, '.claude', 'settings.json');
  const r = editar(sp, (s) => {
    if (!s[MARCA]) {
      if (s.apiKeyHelper !== HELPER) rmSync(join(home, '.habblaude', 'ia-chave'), { force: true }); // chave órfã
      return { r: 'nada' };
    }
    const rec = gravado(s);
    const { apiKeyHelper, [MARCA]: _m, env: envAntes, ...resto } = s;
    const env = { ...(envAntes && typeof envAntes === 'object' ? envAntes : {}) };
    for (const k of ENV_KEYS) if (k in rec && env[k] === rec[k]) delete env[k];
    const novo = apiKeyHelper === HELPER ? resto : { ...resto, apiKeyHelper };
    if (Object.keys(env).length) novo.env = env;
    return { r: 'removeu', novo };
  });
  if (r === 'removeu') rmSync(join(home, '.habblaude', 'ia-chave'), { force: true });
  return r;
}

/** Escolha do seletor (servidor do escritório). Valor fora do formato conta como "sem escolha". */
export function lerEscolha(home) {
  const j = lerJson(hb(home, ESCOLHA)) ?? {};
  return {
    modo: j.modo === 'motores' || j.modo === 'conta' ? j.modo : undefined,
    modelo: typeof j.modelo === 'string' && RE_MODELO.test(j.modelo) && !MODELOS_FORA.has(j.modelo) ? j.modelo : undefined,
  };
}

/** ~/.habblaude/claude-token -> env.CLAUDE_CODE_OAUTH_TOKEN (settings vira 600). Token posto pelo próprio cliente não é tocado. */
export function sincronizarToken(home) {
  const t = (ler(hb(home, TOKEN_ARQ)) ?? '').trim();
  const token = RE_TOKEN.test(t) ? t : null;
  const sp = join(home, '.claude', 'settings.json');
  if (!token && ler(sp) === null) return 'sem-token';
  mkdirSync(join(home, '.claude'), { recursive: true });
  const r = editar(sp, (s) => {
    const env = s.env && typeof s.env === 'object' ? s.env : {};
    const nosso = s[MARCA_TOKEN];
    const atual = env.CLAUDE_CODE_OAUTH_TOKEN;
    if (atual !== undefined && (!nosso || hash(String(atual)) !== nosso)) return { r: 'token-do-cliente' };
    if (!token) {
      if (!nosso) return { r: 'sem-token' };
      const { [MARCA_TOKEN]: _t, env: _e, ...resto } = s;
      const { CLAUDE_CODE_OAUTH_TOKEN: _c, ...e } = env;
      return { r: 'tirou-token', novo: Object.keys(e).length ? { ...resto, env: e } : resto };
    }
    return { r: 'token', novo: { ...s, env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: token }, [MARCA_TOKEN]: hash(token) } };
  }, 0o600);
  if (r === 'token') { try { chmodSync(realpathSync(sp), 0o600); } catch { /* sem settings */ } }
  return r;
}

/** Gasto de hoje da chave do cliente no OpenRouter (US$). null se não deu para saber. */
async function usoHoje(f, chave) {
  try {
    const r = await f('https://openrouter.ai/api/v1/key', { headers: { Authorization: `Bearer ${chave}` }, signal: AbortSignal.timeout(10_000) });
    if (!r.ok) return null;
    const d = (await r.json().catch(() => null))?.data;
    return typeof d?.usage_daily === 'number' ? { hoje: d.usage_daily, limite: typeof d.limit === 'number' ? d.limit : null } : null;
  } catch { return null; }
}

// a chave vai para um arquivo lido por `cat`: só o formato das chaves do OpenRouter
const valida = (j) => /^[\w-]{10,200}$/.test(j?.chave ?? '') && /^https:\/\//.test(j?.baseUrl ?? '') && typeof j?.modelo === 'string' && !!j.modelo;

/**
 * Uma conferência. Erro de rede, 401, 429 e 5xx não mexem em nada (a próxima rodada tenta de novo).
 * `cache` guarda a última resposta boa do portal; com usarCache (troca no seletor) não pergunta de novo (o portal
 * aceita 1 pedido por minuto por escritório).
 */
export async function rodada({ home = homedir(), portal, agentToken, fetch: f = fetch, env = process.env, cache = {}, usarCache = false, agora = Date.now }) {
  const tk = sincronizarToken(home);
  const conta = contaPropria(home, env);
  const esc = lerEscolha(home);
  let status, resp = null;
  if (usarCache && cache.status) ({ status, resp } = cache);
  else if (!agentToken) status = 'sem-token';
  else {
    try {
      const x = await f(`${portal}/api/escritorio/ia/chave`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentToken }), signal: AbortSignal.timeout(30_000),
      });
      status = x.status;
      if (status === 200) resp = await x.json().catch(() => null);
    } catch { status = 'erro-rede'; }
    if (status === 200 && !valida(resp)) { status = 'erro-resposta'; resp = null; }
    if (status === 200 || status === 404) Object.assign(cache, { status, resp });
  }
  const motores = status === 200 || (status !== 404 && cache.status === 200);
  // sem escolha (ou escolha que não dá mais): conta própria vence, como antes do seletor
  const modo = esc.modo === 'conta' && conta ? 'conta' : esc.modo === 'motores' && motores ? 'motores' : conta ? 'conta' : motores ? 'motores' : 'nenhum';
  const modelo = esc.modelo ?? resp?.modelo;
  const senv = lerJson(join(home, '.claude', 'settings.json'))?.env;
  let r;
  if (status === 404) r = remover(home);
  else if (modo === 'conta') { const x = remover(home); r = x === 'removeu' ? 'propria-removeu' : x === 'settings-invalido' ? x : 'propria'; }
  else if (status !== 200) r = typeof status === 'number' ? `erro-${status}` : status;
  else if (CRED_ACIMA.some((k) => !!env[k] || !!(senv && typeof senv === 'object' && senv[k]))) r = 'config-do-cliente';
  else r = aplicar(home, { ...resp, modelo });
  const uso = modo === 'motores' && resp?.chave ? await usoHoje(f, resp.chave) : null;
  try {
    mkdirSync(join(home, '.habblaude'), { recursive: true, mode: 0o700 });
    gravarJson(hb(home, ESTADO), {
      motores, conta, modo, escolha: esc.modo ?? null, modelo: modo === 'motores' ? modelo : null, padrao: resp?.modelo ?? null,
      uso, token: tk === 'token', resultado: r, em: new Date(agora()).toISOString(),
    }, 0o600);
  } catch { /* o estado é só para o seletor */ }
  return r;
}

async function main() {
  if (process.getuid?.() === 0) { console.error('hb-ia: não rode como root (gravaria em /root); rode como o usuário do escritório.'); process.exit(1); }
  const portal = (process.env.HABBLAUDE_PORTAL_URL || 'https://app.habblaude.com').replace(/\/$/, '');
  let ultimo = '', rodando = false, deNovo = false, espera;
  const cache = {};
  const vez = async (usarCache) => {
    if (rodando) { deNovo = true; return; }
    rodando = true;
    try {
      do {
        deNovo = false;
        const r = await rodada({ portal, agentToken: process.env.CODER_AGENT_TOKEN, cache, usarCache }).catch((e) => `erro: ${e.message}`);
        if (r !== ultimo) { console.log(`${new Date().toISOString()} ${r}`); ultimo = r; } // só mudanças (log do supervisor)
        usarCache = true;
      } while (deNovo);
    } finally { rodando = false; }
  };
  // o seletor da barra grava a escolha/token: aplica na hora, sem esperar os 5 min
  try {
    const dir = join(homedir(), '.habblaude');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    watch(dir, (_ev, nome) => {
      if (nome !== ESCOLHA && nome !== TOKEN_ARQ) return;
      clearTimeout(espera);
      espera = setTimeout(() => vez(true), 300);
    });
  } catch (e) { console.error(`hb-ia: sem fs.watch (${e.message}); a troca vale na próxima rodada`); }
  for (let falhas = 0; ;) {
    await vez(false);
    falhas = /^erro|^sem-token/.test(ultimo) && cache.status !== 200 ? falhas + 1 : 0;
    await new Promise((ok) => setTimeout(ok, falhas && falhas <= RETENTES ? RETENTE_MS : INTERVALO_MS));
  }
}

// rodado direto (não importado pelo teste); realpath porque /opt/habblaud aponta para o release por symlink
const direto = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (direto) main();
