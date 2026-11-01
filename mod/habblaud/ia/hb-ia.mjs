#!/usr/bin/env node
// Motores de IA: liga os agentes do escritório na chave OpenRouter do cliente (add-on do portal Habblaude).
// A cada 5 min pede a chave ao portal (POST /api/escritorio/ia/chave {agentToken}), grava ~/.habblaude/ia-chave (600)
// e põe apiKeyHelper + env no ~/.claude/settings.json, marcando "hbIaGerenciado" para tirar só o que é dele.
// Login próprio do Claude vence sempre (o apiKeyHelper passaria na frente dele): aí tira o nosso e não pede nada.
// A chave nunca vai para env de processo, argv nem log. Sobe com o escritório (hb-supervise ia) ou pelo systemd (VM).
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const INTERVALO_MS = 300_000;
const MARCA = 'hbIaGerenciado';
const HELPER = 'cat ~/.habblaude/ia-chave';
const ENV_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_MAX_CONTEXT_TOKENS', 'CLAUDE_CODE_API_KEY_HELPER_TTL_MS'];

const ler = (p) => { try { return readFileSync(p, 'utf8'); } catch { return null; } };
/** objeto JSON do arquivo; {} se não existe; null se existe e não é JSON (aí não mexemos) */
function lerJson(p) {
  const t = ler(p);
  if (t === null) return {};
  try { const j = JSON.parse(t); return j && typeof j === 'object' && !Array.isArray(j) ? j : null; } catch { return null; }
}
// escrita atômica: o Claude Code lê o settings a qualquer hora
function gravarJson(p, j, mode = 0o644) {
  writeFileSync(`${p}.hb-ia.tmp`, JSON.stringify(j, null, 2) + '\n', { mode });
  renameSync(`${p}.hb-ia.tmp`, p);
}

/** Login próprio: OAuth do Pro/Max ou chave do /login (mesma regra do Habblaud, server/missions/auth.ts). */
export function contaPropria(home) {
  const o = lerJson(join(home, '.claude', '.credentials.json'))?.claudeAiOauth;
  return !!(o?.accessToken || o?.refreshToken) || !!lerJson(join(home, '.claude.json'))?.primaryApiKey;
}

export function aplicar(home, { chave, baseUrl, modelo }) {
  const sp = join(home, '.claude', 'settings.json');
  const s = lerJson(sp);
  if (!s) return 'settings-invalido';
  if (s.apiKeyHelper && !s[MARCA]) return 'helper-do-cliente';
  mkdirSync(join(home, '.habblaude'), { recursive: true, mode: 0o700 });
  const arq = join(home, '.habblaude', 'ia-chave');
  if (ler(arq) !== chave) writeFileSync(arq, chave, { mode: 0o600 });
  chmodSync(arq, 0o600);
  const env = { ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_MODEL: modelo, ANTHROPIC_DEFAULT_OPUS_MODEL: modelo,
    ANTHROPIC_DEFAULT_SONNET_MODEL: modelo, ANTHROPIC_DEFAULT_HAIKU_MODEL: modelo, CLAUDE_CODE_SUBAGENT_MODEL: modelo,
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '190000', CLAUDE_CODE_API_KEY_HELPER_TTL_MS: '300000' };
  const novo = { ...s, apiKeyHelper: HELPER, env: { ...(s.env ?? {}), ...env }, [MARCA]: true };
  mkdirSync(join(home, '.claude'), { recursive: true });
  if (JSON.stringify(novo) !== JSON.stringify(s)) gravarJson(sp, novo);
  // sem o onboarding marcado o Claude Code abre a tela de login mesmo com a chave
  const cj = join(home, '.claude.json');
  const c = lerJson(cj);
  if (c && !c.hasCompletedOnboarding) gravarJson(cj, { ...c, hasCompletedOnboarding: true }, 0o600);
  return 'gravou';
}

export function remover(home) {
  rmSync(join(home, '.habblaude', 'ia-chave'), { force: true });
  const sp = join(home, '.claude', 'settings.json');
  const s = lerJson(sp);
  if (!s?.[MARCA]) return 'nada';
  const { apiKeyHelper: _h, [MARCA]: _m, env: envAntes, ...resto } = s;
  const env = { ...(envAntes ?? {}) };
  for (const k of ENV_KEYS) delete env[k];
  gravarJson(sp, Object.keys(env).length ? { ...resto, env } : resto);
  return 'removeu';
}

/** Uma conferência. Erro de rede, 401, 429 e 5xx não mexem em nada (a próxima rodada tenta de novo). */
export async function rodada({ home = homedir(), portal, agentToken, fetch: f = fetch }) {
  if (contaPropria(home)) return remover(home) === 'removeu' ? 'propria-removeu' : 'propria';
  if (!agentToken) return 'sem-token';
  let r;
  try {
    r = await f(`${portal}/api/escritorio/ia/chave`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentToken }), signal: AbortSignal.timeout(30_000),
    });
  } catch { return 'erro'; }
  if (r.status === 404) return remover(home);
  if (r.status !== 200) return 'erro';
  const j = await r.json().catch(() => null);
  // a chave vai para um arquivo lido por `cat`: só o formato das chaves do OpenRouter
  if (!/^[\w-]{10,200}$/.test(j?.chave ?? '') || !/^https:\/\//.test(j?.baseUrl ?? '') || typeof j?.modelo !== 'string' || !j.modelo) return 'erro';
  return aplicar(home, j);
}

async function main() {
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
