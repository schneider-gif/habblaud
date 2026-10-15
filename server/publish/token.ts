// Token do escritório para o portal (hbp_...) e endereço do portal.
// Fontes: HB_PUBLISH_TOKEN (template do Coder) ou ~/.habblaude/publish-token (pareamento pelo wizard, 0600).
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const DEFAULT_PORTAL_URL = 'https://app.habblaude.com';
const TOKEN_RE = /^hbp_[A-Za-z0-9_-]{20,200}$/;

export function tokenFile(home: string): string {
  return join(home, '.habblaude', 'publish-token');
}

/** URL base do portal (HB_PORTAL_URL, sem barra no fim). */
export function portalUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.HB_PORTAL_URL ?? '').trim();
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString().replace(/\/+$/, '');
    } catch {
      // inválida: usa o padrão
    }
  }
  return DEFAULT_PORTAL_URL;
}

export function isTokenLike(v: string): boolean {
  return TOKEN_RE.test(v);
}

export interface TokenInfo {
  token: string;
  source: 'env' | 'file';
}

/** Token atual: a variável de ambiente vence o arquivo. */
export function readToken(home: string, env: NodeJS.ProcessEnv = process.env): TokenInfo | undefined {
  const fromEnv = (env.HB_PUBLISH_TOKEN ?? '').trim();
  if (fromEnv) return { token: fromEnv, source: 'env' };
  try {
    const t = readFileSync(tokenFile(home), 'utf8').trim();
    if (t) return { token: t, source: 'file' };
  } catch {
    // sem arquivo
  }
  return undefined;
}

/** Grava o token do pareamento (pasta 0700, arquivo 0600). */
export function saveToken(home: string, token: string): void {
  const file = tokenFile(home);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: sem permissões POSIX
  }
}

export function clearToken(home: string): void {
  rmSync(tokenFile(home), { force: true });
}
