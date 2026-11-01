#!/usr/bin/env node
// Motores de IA: liga os agentes do escritório na chave OpenRouter do cliente (add-on do portal Habblaude).
// A cada 5 min pede a chave ao portal (POST /api/escritorio/ia/chave {agentToken}), grava ~/.habblaude/ia-chave (600)
// e põe apiKeyHelper + env no ~/.claude/settings.json, marcando "hbIaGerenciado" para tirar só o que é dele.
// Login próprio do Claude vence sempre (o apiKeyHelper passaria na frente dele): aí tira o nosso e não pede nada.
// A chave nunca vai para env de processo, argv nem log. Sobe com o escritório (hb-supervise ia) ou pelo systemd (VM).
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INTERVALO_MS = 300_000;
const MARCA = 'hbIaGerenciado';
const HELPER = 'cat ~/.habblaude/ia-chave';
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'];

const CRED_ENV = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'];

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
    if (ler(p) !== t0) continue;
    gravarJson(p, novo, mode);
    return r;
  }
  return 'erro-concorrencia';
}

// o que gravamos por último: { chave: valor }. `hbIaGerenciado: true` (formato antigo) não registra env.
const gravado = (s) => (s?.[MARCA] && typeof s[MARCA] === 'object' && s[MARCA].env) || {};

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
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '190000', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '300000' };
  mkdirSync(join(home, '.claude'), { recursive: true });
  const r = editar(sp, (s) => {
    const rec = gravado(s);
    const env = s.env && typeof s.env === 'object' ? s.env : {};
    // qualquer valor que não fomos nós que gravamos é configuração do cliente: não mexe em nada
    if (ENV_KEYS.some((k) => k in env && env[k] !== rec[k])) return { r: 'config-do-cliente' };
    if ('apiKeyHelper' in s && !(s[MARCA] && s.apiKeyHelper === HELPER)) return { r: 'config-do-cliente' };
    mkdirSync(join(home, '.habblaude'), { recursive: true, mode: 0o700 });
    const arq = join(home, '.habblaude', 'ia-chave');
    if (ler(arq) !== chave) gravar(arq, chave, 0o600);
    chmodSync(arq, 0o600);
    return { r: 'gravou', novo: { ...s, apiKeyHelper: HELPER, env: { ...env, ...valores }, [MARCA]: { env: valores } } };
  });
  if (r !== 'gravou') return r;
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
    if (!s[MARCA]) return { r: 'nada' };
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

/** Uma conferência. Erro de rede, 401, 429 e 5xx não mexem em nada (a próxima rodada tenta de novo). */
export async function rodada({ home = homedir(), portal, agentToken, fetch: f = fetch, env = process.env }) {
  if (contaPropria(home, env)) {
    const r = remover(home);
    return r === 'removeu' ? 'propria-removeu' : r === 'settings-invalido' ? r : 'propria';
  }
  if (!agentToken) return 'sem-token';
  let r;
  try {
    r = await f(`${portal}/api/escritorio/ia/chave`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentToken }), signal: AbortSignal.timeout(30_000),
    });
  } catch { return 'erro-rede'; }
  if (r.status === 404) return remover(home);
  if (r.status !== 200) return `erro-${r.status}`;
  const j = await r.json().catch(() => null);
  // a chave vai para um arquivo lido por `cat`: só o formato das chaves do OpenRouter
  if (!/^[\w-]{10,200}$/.test(j?.chave ?? '') || !/^https:\/\//.test(j?.baseUrl ?? '') || typeof j?.modelo !== 'string' || !j.modelo) return 'erro-resposta';
  return aplicar(home, j);
}

async function main() {
  if (process.getuid?.() === 0) { console.error('hb-ia: não rode como root (gravaria em /root); rode como o usuário do escritório.'); process.exit(1); }
  const portal = (process.env.HABBLAUDE_PORTAL_URL || 'https://app.habblaude.com').replace(/\/$/, '');
  let ultimo = '';
  for (;;) {
    const r = await rodada({ portal, agentToken: process.env.CODER_AGENT_TOKEN }).catch((e) => `erro: ${e.message}`);
    if (r !== ultimo) { console.log(`${new Date().toISOString()} ${r}`); ultimo = r; } // só mudanças (log do supervisor)
    await new Promise((ok) => setTimeout(ok, INTERVALO_MS));
  }
}

// rodado direto (não importado pelo teste); realpath porque /opt/habblaud aponta para o release por symlink
const direto = (() => { try { return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href; } catch { return false; } })();
if (direto) main();
