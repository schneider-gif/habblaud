// Onde o Codex CLI guarda as coisas e se a conta OpenAI está conectada. Conferido no Codex CLI 0.162.1:
// - pasta do Codex ("CODEX_HOME", padrão ~/.codex): config.toml, auth.json, history.jsonl, sessions/AAAA/MM/DD/
//   rollout-*.jsonl, thread-writer-locks/<threadId>.lock (trava de escrita da conversa aberta), state_5.sqlite...;
// - login: `codex login` (ChatGPT Plus/Pro pelo navegador ou "Sign in with Device Code") ou chave de API
//   (`codex login --with-api-key`) gravam <CODEX_HOME>/auth.json: {"auth_mode": "chatgpt"|"apikey",
//   "OPENAI_API_KEY": ..., "tokens": {...}}.
// Privacidade: do auth.json só conferimos se há credencial (e o auth_mode); o conteúdo nunca é guardado nem logado.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { AccountInfo } from '../../shared/types';

/** Cor da "Conta OpenAI" (verde da OpenAI), distinta da paleta das contas do Claude. */
export const CODEX_COLOR = '#10a37f';
/** Prefixo das contas do Codex (= basename da pasta: ".codex", ".codex-trabalho"). */
export const CODEX_ACCOUNT_PREFIX = '.codex';

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isTruthy(v: string): boolean {
  return !/^(0|false|off|no|nao|não|desligado)$/i.test(v.trim());
}

/** Parece uma pasta do Codex? (sessions/, config.toml, auth.json ou as travas de conversa). */
export function isCodexDir(p: string): boolean {
  return isDir(join(p, 'sessions')) || existsSync(join(p, 'config.toml')) || existsSync(join(p, 'auth.json')) || isDir(join(p, 'thread-writer-locks'));
}

/**
 * Pastas do Codex observadas: HABBLAUD_CODEX_DIRS (lista separada por vírgula) manda; senão CODEX_HOME, ~/.codex e
 * ~/.codex-* que pareçam do Codex. HABBLAUD_CODEX=0 desliga a fonte.
 */
export function discoverCodexDirs(env: NodeJS.ProcessEnv, home: string): string[] {
  const flag = env.HABBLAUD_CODEX?.trim();
  if (flag && !isTruthy(flag)) return [];
  const explicit = (env.HABBLAUD_CODEX_DIRS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) return [...new Set(explicit.map((p) => resolve(p.replace(/^~(?=\/|$)/, home))))].filter(isDir);
  const out: string[] = [];
  const add = (p: string) => {
    const abs = resolve(p);
    if (!out.includes(abs) && isDir(abs) && isCodexDir(abs)) out.push(abs);
  };
  if (env.CODEX_HOME?.trim()) add(env.CODEX_HOME.trim());
  add(join(home, '.codex'));
  try {
    for (const ent of readdirSync(home, { withFileTypes: true })) {
      if (ent.isDirectory() && ent.name.startsWith('.codex-')) add(join(home, ent.name));
    }
  } catch {
    // HOME ilegível
  }
  return out;
}

export interface CodexAuth {
  connected: boolean;
  how?: 'chatgpt' | 'apiKey';
}

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

/** Interpreta o auth.json (só diz se há credencial). */
export function parseCodexAuth(raw: string): CodexAuth {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return { connected: false };
  }
  if (!j || typeof j !== 'object') return { connected: false };
  const tokens = j.tokens && typeof j.tokens === 'object' ? (j.tokens as Record<string, unknown>) : undefined;
  if (tokens && (filled(tokens.access_token) || filled(tokens.refresh_token))) return { connected: true, how: 'chatgpt' };
  if (filled(j.OPENAI_API_KEY)) return { connected: true, how: 'apiKey' };
  return { connected: false };
}

/** A conta OpenAI está conectada em alguma pasta do Codex? */
export async function codexAuth(dirs: readonly string[]): Promise<CodexAuth> {
  for (const dir of dirs) {
    try {
      const a = parseCodexAuth(await readFile(join(dir, 'auth.json'), 'utf8'));
      if (a.connected) return a;
    } catch {
      // sem auth.json nesta pasta
    }
  }
  return { connected: false };
}

export function codexAuthSync(dir: string): CodexAuth {
  try {
    return parseCodexAuth(readFileSync(join(dir, 'auth.json'), 'utf8'));
  } catch {
    return { connected: false };
  }
}

/** Nome amigável da conta: "Conta OpenAI" (a padrão) ou "Conta OpenAI (trabalho)" para ~/.codex-trabalho. */
export function codexAccountName(id: string): string {
  const suffix = id.startsWith(`${CODEX_ACCOUNT_PREFIX}-`) ? id.slice(CODEX_ACCOUNT_PREFIX.length + 1) : '';
  return suffix ? `Conta OpenAI (${suffix})` : 'Conta OpenAI';
}

export function isCodexAccount(id: string | undefined): boolean {
  return !!id && (id === CODEX_ACCOUNT_PREFIX || id.startsWith(`${CODEX_ACCOUNT_PREFIX}-`));
}

/** Contas do Codex no formato do protocolo. */
export function codexAccounts(dirs: readonly string[], sessions: ReadonlyMap<string, number>): AccountInfo[] {
  return dirs.map((dir) => {
    const id = basename(dir);
    const auth = codexAuthSync(dir);
    const info: AccountInfo = {
      id,
      short: 'AI',
      name: codexAccountName(id),
      color: CODEX_COLOR,
      configDir: dir,
      sessions: sessions.get(id) ?? 0,
      usageStatus: 'disabled',
      engine: 'codex',
    };
    if (auth.how) info.plan = auth.how === 'chatgpt' ? 'ChatGPT' : 'chave de API';
    return info;
  });
}
