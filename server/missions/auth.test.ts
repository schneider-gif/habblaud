import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { agentAuth, claudeAuth } from './auth';

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

describe('Missão 0 com Claude ou OpenAI (Codex)', () => {
  it('vale a conta do Claude ou o auth.json do Codex; nenhum dos dois = desconectado', async () => {
    const h = home();
    const o = { home: h, configDirs: [join(h, '.claude')], codexDirs: [join(h, '.codex')], env: {} };
    expect(await agentAuth(o)).toEqual({ connected: false });
    mkdirSync(join(h, '.codex'), { recursive: true });
    writeFileSync(join(h, '.codex', 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: 'a', refresh_token: 'r' } }));
    expect(await agentAuth(o)).toEqual({ connected: true, how: 'codex' });
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    expect(await agentAuth(o)).toEqual({ connected: true, how: 'oauth' });
  });
});
