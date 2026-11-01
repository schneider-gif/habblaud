// node --test mod/habblaud/ia/hb-ia.test.mjs   (HOME temporário, portal falso; nada de rede)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
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
const rodar = (home, f) => rodada({ home, portal: 'https://portal.teste', agentToken: TOKEN, fetch: f });
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
  assert.equal(s.hbIaGerenciado, true);
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
  assert.equal(await rodar(home, portal(200, OK)), 'helper-do-cliente');
  assert.equal(texto(home, '.claude/settings.json'), antes);
  assert.equal(existsSync(join(home, '.habblaude/ia-chave')), false);
});

test('erro de rede, 5xx, 429 e resposta ruim não mexem em nada', async () => {
  const home = casa();
  await rodar(home, portal(200, OK));
  const antes = texto(home, '.claude/settings.json');
  const caiu = async () => { throw new TypeError('fetch failed'); };
  assert.equal(await rodar(home, caiu), 'erro');
  assert.equal(await rodar(home, portal(500, {})), 'erro');
  assert.equal(await rodar(home, portal(429, {})), 'erro');
  assert.equal(await rodar(home, portal(200, { ...OK, chave: 'linha\nquebrada' })), 'erro');
  assert.equal(texto(home, '.claude/settings.json'), antes);
  assert.equal(texto(home, '.habblaude/ia-chave'), OK.chave);
});

test('settings.json inválido: não toca', async () => {
  const home = casa({ '.claude/settings.json': '{ quebrado' });
  assert.equal(await rodar(home, portal(200, OK)), 'settings-invalido');
  assert.equal(texto(home, '.claude/settings.json'), '{ quebrado');
});
