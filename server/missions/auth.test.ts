import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { claudeAuth } from './auth';

let tmp: ReturnType<typeof tempDir>;
afterEach(() => tmp?.cleanup());

function home(files: Record<string, unknown> = {}) {
  tmp = tempDir();
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(tmp.dir, name, '..'), { recursive: true });
    writeFileSync(join(tmp.dir, name), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return tmp.dir;
}

describe('conta do Claude conectada (Claude Code 2.x no Linux)', () => {
  it('sem nada: desconectado', async () => {
    const h = home();
    expect(await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: {} })).toEqual({ connected: false });
  });
  it('login Pro/Max: <config>/.credentials.json com claudeAiOauth', async () => {
    const h = home({ '.claude/.credentials.json': { claudeAiOauth: { accessToken: 'sk-ant-oat-x', refreshToken: 'r', expiresAt: 1 } } });
    expect(await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: {} })).toEqual({ connected: true, how: 'oauth' });
  });
  it('credenciais vazias (deslogou) não contam', async () => {
    const h = home({ '.claude/.credentials.json': { claudeAiOauth: { accessToken: '', refreshToken: '' } } });
    expect((await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: {} })).connected).toBe(false);
    const h2 = home({ '.claude/.credentials.json': '{quebrado' });
    expect((await claudeAuth({ home: h2, configDirs: [join(h2, '.claude')], env: {} })).connected).toBe(false);
  });
  it('chave de API pelo /login: primaryApiKey no ~/.claude.json (conta padrão) ou <config>/.claude.json', async () => {
    const h = home({ '.claude.json': { primaryApiKey: 'sk-ant-api-x' } });
    expect(await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: {} })).toEqual({ connected: true, how: 'apiKey' });
    const h2 = home({ 'outra/.claude.json': { primaryApiKey: 'sk-ant-api-x' } });
    expect((await claudeAuth({ home: h2, configDirs: [join(h2, 'outra')], env: {} })).connected).toBe(true);
  });
  it('apiKeyHelper no settings.json', async () => {
    const h = home({ '.claude/settings.json': { apiKeyHelper: '~/bin/chave.sh' } });
    expect(await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: {} })).toEqual({ connected: true, how: 'helper' });
  });
  it('variáveis de ambiente do usuário', async () => {
    const h = home();
    for (const k of ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'])
      expect(await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: { [k]: 'x' } })).toEqual({ connected: true, how: 'env' });
    expect((await claudeAuth({ home: h, configDirs: [join(h, '.claude')], env: { ANTHROPIC_API_KEY: '  ' } })).connected).toBe(false);
  });
});
