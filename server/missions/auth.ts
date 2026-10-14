// A conta do Claude está conectada nesta máquina? (Missão 0.) Conferido no binário do Claude Code 2.1.299 (Linux):
// - login Pro/Max: <config>/.credentials.json com `claudeAiOauth` (accessToken/refreshToken), sendo <config> o
//   CLAUDE_CONFIG_DIR ou ~/.claude;
// - chave de API pelo /login: `primaryApiKey` no estado global (~/.claude.json da conta padrão, ou
//   <config>/.claude.json com CLAUDE_CONFIG_DIR);
// - `apiKeyHelper` no <config>/settings.json; ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN ou ANTHROPIC_AUTH_TOKEN.
// No macOS o login fica no Keychain: aí a prova é um agente terminar um turno (ver detect.ts).
// Só devolve se há credencial, nunca o conteúdo dela.
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface ClaudeAuth {
  connected: boolean;
  how?: 'oauth' | 'apiKey' | 'helper' | 'env';
}

const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'] as const;

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    const j = JSON.parse(await readFile(path, 'utf8'));
    return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const filled = (v: unknown) => typeof v === 'string' && v.trim().length > 0;

export async function claudeAuth(o: { home: string; configDirs: readonly string[]; env: NodeJS.ProcessEnv }): Promise<ClaudeAuth> {
  if (ENV_KEYS.some((k) => filled(o.env[k]))) return { connected: true, how: 'env' };
  const defaultDir = resolve(o.home, '.claude');
  for (const dir of o.configDirs) {
    const oauth = (await readJson(join(dir, '.credentials.json')))?.claudeAiOauth as { accessToken?: unknown; refreshToken?: unknown } | undefined;
    if (oauth && (filled(oauth.accessToken) || filled(oauth.refreshToken))) return { connected: true, how: 'oauth' };
    const state = resolve(dir) === defaultDir ? join(o.home, '.claude.json') : join(dir, '.claude.json');
    if (filled((await readJson(state))?.primaryApiKey)) return { connected: true, how: 'apiKey' };
    if (filled((await readJson(join(dir, 'settings.json')))?.apiKeyHelper)) return { connected: true, how: 'helper' };
  }
  return { connected: false };
}
