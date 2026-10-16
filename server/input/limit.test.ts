import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentLimitFromEnv, agentPids, classifyArgv, isQuickCommand, limitMessage, type ProcInfo, readProcs } from './limit';

const procs = (list: [number, number, string[]][]) => new Map<number, ProcInfo>(list.map(([pid, ppid, argv]) => [pid, { ppid, argv }]));

describe('limite de agentes do plano', () => {
  it('agentLimitFromEnv: HABBLAUD_MAX_AGENTS ou HB_MAX_AGENTES; vazio/0/inválido = sem limite', () => {
    expect(agentLimitFromEnv({})).toBeUndefined();
    expect(agentLimitFromEnv({ HB_MAX_AGENTES: '0' })).toBeUndefined();
    expect(agentLimitFromEnv({ HB_MAX_AGENTES: 'dois' })).toBeUndefined();
    expect(agentLimitFromEnv({ HB_MAX_AGENTES: '-1' })).toBeUndefined();
    expect(agentLimitFromEnv({ HB_MAX_AGENTES: '2', HB_PLANO: 'sala' })).toEqual({ max: 2, plan: 'sala', upgradeUrl: 'app.habblaude.com/planos' });
    expect(agentLimitFromEnv({ HABBLAUD_MAX_AGENTS: '4', HB_MAX_AGENTES: '1', HB_PLANO: 'Andar' })).toEqual({ max: 4, plan: 'andar', upgradeUrl: 'app.habblaude.com/planos' });
    expect(agentLimitFromEnv({ HB_MAX_AGENTES: '1', HB_PLANO: 'ouro' })).toEqual({ max: 1, plan: undefined, upgradeUrl: 'app.habblaude.com/planos' });
  });

  it('limitMessage: mesmo texto do porteiro da imagem', () => {
    expect(limitMessage({ max: 2, plan: 'sala', upgradeUrl: 'app.habblaude.com/planos' }, 2)).toBe(
      'Seu plano Sala permite 2 agentes ao mesmo tempo e já há 2 rodando. Feche um deles ou faça upgrade em app.habblaude.com/planos.',
    );
    expect(limitMessage({ max: 1, plan: 'recepcao', upgradeUrl: 'app.habblaude.com/planos' }, 1)).toBe(
      'Seu plano Recepção permite 1 agente por vez e já há 1 rodando. Feche o outro agente ou faça upgrade em app.habblaude.com/planos.',
    );
    expect(limitMessage({ max: 4, upgradeUrl: 'x/planos' }, 5)).toMatch(/^Seu plano permite 4 agentes ao mesmo tempo e já há 5 rodando/);
  });

  it('classifyArgv: binário nativo, lançador Node e o vendorizado do Codex; o resto não é agente', () => {
    expect(classifyArgv(['claude', '--resume', 'x'])).toEqual({ engine: 'claude', args: ['--resume', 'x'] });
    expect(classifyArgv(['/usr/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe'])).toEqual({ engine: 'claude', args: [] });
    expect(classifyArgv(['/usr/bin/node', '/usr/lib/node_modules/@anthropic-ai/claude-code/cli.js', '-p', 'oi'])?.engine).toBe('claude');
    expect(classifyArgv(['node', '/usr/bin/codex', '--no-daemon'])).toEqual({ engine: 'codex', args: ['--no-daemon'] });
    expect(classifyArgv(['/usr/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-x64/vendor/x86_64-unknown-linux-musl/bin/codex', '--no-daemon'])?.engine).toBe('codex');
    for (const argv of [[], ['bash', '-lc', 'exec claude'], ['/usr/bin/python3', '-I', '/usr/local/bin/claude'], ['node', '/opt/habblaud/dist/server/index.js'], ['less', '/usr/bin/claude']])
      expect(classifyArgv(argv)).toBeUndefined();
  });

  it('isQuickCommand: versão, ajuda, plugin/mcp e login não contam; sessão, -p, resume e exec contam', () => {
    for (const a of [['--version'], ['-v'], ['plugin', 'list'], ['mcp', 'add', 'x'], ['doctor'], ['agents'], ['--model', 'opus', '--help']]) expect(isQuickCommand('claude', a)).toBe(true);
    for (const a of [[], ['-p', 'oi'], ['--resume', 'abc'], ['-c'], ['--bg'], ['conserte o bug'], ['-p', '--help']]) expect(isQuickCommand('claude', a)).toBe(false);
    for (const a of [['--version'], ['login', '--device-auth'], ['login', 'status'], ['logout'], ['mcp', 'list'], ['app-server']]) expect(isQuickCommand('codex', a)).toBe(true);
    for (const a of [[], ['--no-daemon'], ['exec', 'oi'], ['review'], ['resume', '--no-daemon', 'x']]) expect(isQuickCommand('codex', a)).toBe(false);
  });

  it('agentPids: só top-level; subprocesso/aninhado e comandos rápidos não contam', () => {
    const table = procs([
      [1, 0, ['/usr/bin/tini', '--', 'hb-entrypoint']],
      [10, 1, ['tmux', 'new-session']],
      [100, 10, ['claude']], // agente 1
      [101, 100, ['bash', '-c', 'npm test']],
      [102, 101, ['claude', '-p', 'sub']], // aninhado: não conta
      [200, 10, ['node', '/usr/bin/codex', '--no-daemon']], // agente 2 (lançador)
      [201, 200, ['/usr/lib/node_modules/@openai/codex/vendor/x/bin/codex', '--no-daemon']], // nativo: filho do lançador
      [300, 10, ['claude', '--version']], // rápido
      [301, 10, ['node', '/usr/bin/codex', 'login', '--device-auth']], // rápido
      [400, 10, ['/usr/bin/python3', '-I', '/usr/local/bin/claude']], // porteiro ainda decidindo
    ]);
    expect(agentPids(table)).toEqual([100, 200]);
  });

  it('readProcs: lê stat (ppid, comm com espaço/parêntese) e cmdline do /proc', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hb-proc-'));
    await mkdir(join(root, '42'));
    await writeFile(join(root, '42', 'stat'), '42 (node (x) y) S 7 42 42 0 -1 4194560');
    await writeFile(join(root, '42', 'cmdline'), 'claude\0--resume\0abc\0');
    await mkdir(join(root, 'self'));
    expect(readProcs(root)).toEqual(new Map([[42, { ppid: 7, argv: ['claude', '--resume', 'abc'] }]]));
    expect(readProcs(join(root, 'nao-existe')).size).toBe(0);
  });
});
