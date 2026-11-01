// node --test mod/habblaud/ia/hb-ia.test.mjs   (HOME temporário, portal falso; nada de rede)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { rodada } from './hb-ia.mjs';

const OK = { chave: 'sk-or-v1-abc123', baseUrl: 'https://openrouter.ai/api', modelo: 'minimax/minimax-m2.5' };
const TOKEN = 'agent-token-0123456789';
function casa(arquivos = {}) {
  const home = mkdtempSync(join(tmpdir(), 'hb-ia-'));
  for (const [p, v] of Object.entries(arquivos)) {
    mkdirSync(dirname(join(home, p)), { recursive: true });
    writeFileSync(join(home, p), typeof v === 'string' ? v : JSON.stringify(v));
  }
  return home;
}
function portal(status, corpo) {
  const f = async (url, init) => { f.chamadas.push({ url, corpo: JSON.parse(init.body) }); return new Response(JSON.stringify(corpo ?? {}), { status }); };
  f.chamadas = [];
  return f;
}
const ler = (home, p) => JSON.parse(readFileSync(join(home, p), 'utf8'));
const texto = (home, p) => readFileSync(join(home, p), 'utf8');
const rodar = (home, f) => rodada({ home, portal: 'https://portal.teste', agentToken: TOKEN, fetch: f, env: {} });
const MODELOS = ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL'];

test('200: grava a chave (600) e o settings, sem perder o que já estava', async () => {
  const home = casa({ '.claude/settings.json': { skillOverrides: { 'auto-mode-setup': 'off' } } });
  const f = portal(200, OK);
  assert.equal(await rodar(home, f), 'gravou');
  assert.deepEqual(f.chamadas, [{ url: 'https://portal.teste/api/escritorio/ia/chave', corpo: { agentToken: TOKEN } }]);
  assert.equal(texto(home, '.habblaude/ia-chave'), OK.chave);
  assert.equal(statSync(join(home, '.habblaude/ia-chave')).mode & 0o777, 0o600);
  const s = ler(home, '.claude/settings.json');
  assert.equal(s.apiKeyHelper, 'cat ~/.habblaude/ia-chave');
  assert.ok(s.hbIaGerenciado);
  assert.deepEqual(s.hbIaGerenciado.env.ANTHROPIC_MODEL, OK.modelo);
  assert.deepEqual(s.skillOverrides, { 'auto-mode-setup': 'off' });
  assert.equal(s.env.ANTHROPIC_BASE_URL, OK.baseUrl);
  for (const k of MODELOS) assert.equal(s.env[k], OK.modelo);
  assert.equal(s.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '190000');
  assert.equal(s.env.CLAUDE_CODE_API_KEY_HELPER_TTL_MS, '300000');
  assert.equal(JSON.stringify(s).includes(OK.chave), false); // a chave só fica no arquivo 600
  assert.equal(ler(home, '.claude.json').hasCompletedOnboarding, true);
});

test('404: tira só o que é dele', async () => {
  const home = casa({ '.claude/settings.json': { skillOverrides: { x: 'off' }, env: { FOO: '1' } } });
  await rodar(home, portal(200, OK));
  assert.equal(await rodar(home, portal(404, {})), 'removeu');
  assert.deepEqual(ler(home, '.claude/settings.json'), { skillOverrides: { x: 'off' }, env: { FOO: '1' } });
  assert.equal(existsSync(join(home, '.habblaude/ia-chave')), false);
});

test('404 sem nada nosso: não mexe', async () => {
  const antes = JSON.stringify({ apiKeyHelper: 'meu-helper' });
  const home = casa({ '.claude/settings.json': antes });
  assert.equal(await rodar(home, portal(404, {})), 'nada');
  assert.equal(texto(home, '.claude/settings.json'), antes);
});

test('login próprio vence: não pede chave e tira a nossa', async () => {
  const home = casa();
  await rodar(home, portal(200, OK));
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'r' } }));
  const f = portal(200, OK);
  assert.equal(await rodar(home, f), 'propria-removeu');
  assert.equal(f.chamadas.length, 0);
  assert.equal(ler(home, '.claude/settings.json').apiKeyHelper, undefined);
  assert.equal(existsSync(join(home, '.habblaude/ia-chave')), false);
  assert.equal(await rodar(home, f), 'propria');
  const home2 = casa({ '.claude.json': { primaryApiKey: 'sk-ant-do-cliente' } });
  assert.equal(await rodar(home2, f), 'propria');
  assert.equal(f.chamadas.length, 0);
});

test('helper do próprio cliente: 200 não sobrescreve', async () => {
  const antes = JSON.stringify({ apiKeyHelper: 'meu-helper' });
  const home = casa({ '.claude/settings.json': antes });
  assert.equal(await rodar(home, portal(200, OK)), 'config-do-cliente');
  assert.equal(texto(home, '.claude/settings.json'), antes);
  assert.equal(existsSync(join(home, '.habblaude/ia-chave')), false);
});

test('erro de rede, 5xx, 429 e resposta ruim não mexem em nada', async () => {
  const home = casa();
  await rodar(home, portal(200, OK));
  const antes = texto(home, '.claude/settings.json');
  const caiu = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await rodar(home, caiu), 'erro-rede');
  assert.equal(await rodar(home, portal(500, {})), 'erro-500');
  assert.equal(await rodar(home, portal(429, {})), 'erro-429');
  assert.equal(await rodar(home, portal(200, { ...OK, chave: 'linha\nquebrada' })), 'erro-resposta');
  assert.equal(texto(home, '.claude/settings.json'), antes);
  assert.equal(texto(home, '.habblaude/ia-chave'), OK.chave);
});

test('settings.json inválido: não toca', async () => {
  const home = casa({ '.claude/settings.json': '{ quebrado' });
  assert.equal(await rodar(home, portal(200, OK)), 'settings-invalido');
  assert.equal(texto(home, '.claude/settings.json'), '{ quebrado');
});

test('dono por valor: 404 tira só o que ainda tem o valor que gravamos', async () => {
  const home = casa();
  await rodar(home, portal(200, OK));
  const sp = join(home, '.claude/settings.json');
  const s = ler(home, '.claude/settings.json');
  s.env.ANTHROPIC_MODEL = 'do-cliente';
  writeFileSync(sp, JSON.stringify(s));
  assert.equal(await rodar(home, portal(404, {})), 'removeu');
  const d = ler(home, '.claude/settings.json');
  assert.deepEqual(d, { env: { ANTHROPIC_MODEL: 'do-cliente' } });
});

test('chave de env já existente que não gravamos: config do cliente, nada muda', async () => {
  const antes = JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://meu.proxy' } });
  const home = casa({ '.claude/settings.json': antes });
  assert.equal(await rodar(home, portal(200, OK)), 'config-do-cliente');
  assert.equal(texto(home, '.claude/settings.json'), antes);
  assert.equal(existsSync(join(home, '.habblaude/ia-chave')), false);
});

test('credencial própria em env (settings ou processo) vence', async () => {
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    const f = portal(200, OK);
    const home = casa({ '.claude/settings.json': { env: { [k]: 'x' } } });
    assert.equal(await rodar(home, f), 'propria');
    const home2 = casa();
    assert.equal(await rodada({ home: home2, portal: 'https://portal.teste', agentToken: TOKEN, fetch: f, env: { [k]: 'x' } }), 'propria');
    assert.equal(f.chamadas.length, 0);
  }
});

test('remoção com settings inválido: não toca em nada, chave fica', async () => {
  const home = casa();
  await rodar(home, portal(200, OK));
  writeFileSync(join(home, '.claude/settings.json'), '{ quebrado');
  assert.equal(await rodar(home, portal(404, {})), 'settings-invalido');
  assert.equal(texto(home, '.habblaude/ia-chave'), OK.chave);
  writeFileSync(join(home, '.claude/.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a' } }));
  assert.equal(await rodar(home, portal(200, OK)), 'settings-invalido');
  assert.equal(texto(home, '.habblaude/ia-chave'), OK.chave);
});

test('settings por symlink e modo preservados; sem .tmp sobrando', async () => {
  const home = casa({ 'dotfiles/settings.json': { skillOverrides: { x: 'off' } } });
  const real = join(home, 'dotfiles/settings.json');
  chmodSync(real, 0o600);
  mkdirSync(join(home, '.claude'), { recursive: true });
  symlinkSync(real, join(home, '.claude/settings.json'));
  assert.equal(await rodar(home, portal(200, OK)), 'gravou');
  assert.equal(statSync(join(home, '.claude')).isDirectory(), true);
  assert.equal(readFileSync(real, 'utf8').includes('hbIaGerenciado'), true);
  assert.equal(statSync(real).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readFileSync(join(home, '.claude/settings.json'), 'utf8')).apiKeyHelper, 'cat ~/.habblaude/ia-chave');
  assert.equal(readdirSync(join(home, 'dotfiles')).concat(readdirSync(join(home, '.habblaude'))).some((n) => n.endsWith('.tmp')), false);
});
