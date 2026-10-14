import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { claudeShellCommand, cleanInput, cleanResumeId, createAgentInput, InputError, pidOfAgent, tmuxTargetFromEnviron } from './tmux';

const env = (vars: Record<string, string>) => Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\0') + '\0';

describe('input pelo tmux', () => {
  it('pidOfAgent: só principais "<conta>:<pid>", nunca demo nem subagente', () => {
    expect(pidOfAgent('.claude:7039')).toBe(7039);
    expect(pidOfAgent('.claude-conta2:12')).toBe(12);
    for (const id of ['demo:mv1-2', 'sess-abc:a9b1921a67b', '.claude:1', '.claude:', 'x', '.claude:12:3']) expect(pidOfAgent(id)).toBeUndefined();
  });

  it('tmuxTargetFromEnviron: socket e pane do environ; sem tmux ou pane torto -> undefined', () => {
    expect(tmuxTargetFromEnviron(env({ HOME: '/home/u', TMUX: '/tmp/tmux-1000/default,123,0', TMUX_PANE: '%3' }))).toEqual({
      socket: '/tmp/tmux-1000/default',
      pane: '%3',
    });
    expect(tmuxTargetFromEnviron(env({ HOME: '/home/u' }))).toBeUndefined();
    expect(tmuxTargetFromEnviron(env({ TMUX: 'rel/sock,1,0', TMUX_PANE: '%3' }))).toBeUndefined();
    expect(tmuxTargetFromEnviron(env({ TMUX: '/tmp/s,1,0', TMUX_PANE: '%3; rm -rf /' }))).toBeUndefined();
  });

  it('cleanInput: aceita várias linhas, recusa vazio, longo e caracteres de controle', () => {
    expect(cleanInput('  oi\r\nlinha 2\t \n')).toBe('oi\nlinha 2');
    for (const bad of ['', '   ', 'a\u001b[2Jb', 'x'.repeat(8001), 42]) expect(() => cleanInput(bad)).toThrow(InputError);
  });

  it('send: cola num buffer com bracketed paste e manda Enter no pane do agente', async () => {
    const calls: string[][] = [];
    const input = createAgentInput({
      readEnviron: async () => env({ TMUX: '/tmp/tmux-1000/default,9,0', TMUX_PANE: '%7' }),
      readCmdline: async () => 'node\0/usr/bin/claude\0',
      run: async (a) => void calls.push(a),
      now: () => 42,
    });
    expect(await input.available('.claude:500')).toBe(true);
    await input.send('.claude:500', 'faz o deploy\nagora');
    expect(calls).toEqual([
      ['-S', '/tmp/tmux-1000/default', 'set-buffer', '-b', 'habblaud-42', '--', 'faz o deploy\nagora'],
      ['-S', '/tmp/tmux-1000/default', 'paste-buffer', '-d', '-p', '-b', 'habblaud-42', '-t', '%7'],
      ['-S', '/tmp/tmux-1000/default', 'send-keys', '-t', '%7', 'Enter'],
    ]);
  });

  it('send: agente fora do tmux, morto ou demo -> 409 sem rodar nada', async () => {
    const calls: string[][] = [];
    const input = createAgentInput({
      readEnviron: async (pid) => {
        if (pid === 600) throw new Error('ENOENT');
        return env({ HOME: '/home/u' });
      },
      readCmdline: async () => 'claude\0',
      run: async (a) => void calls.push(a),
    });
    for (const id of ['.claude:500', '.claude:600', 'demo:x-1']) {
      expect(await input.available(id)).toBe(false);
      await expect(input.send(id, 'oi')).rejects.toMatchObject({ status: 409 });
    }
    expect(calls).toEqual([]);
  });

  it('spawn: abre claude numa sessão tmux nova, só em pasta dentro do HOME', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hb-home-'));
    await mkdir(join(home, 'projeto'));
    const calls: string[][] = [];
    const input = createAgentInput({ home, run: async (a) => void calls.push(a), capture: async () => '4321\n', now: () => 36 ** 2, claudeCommand: 'claude' });
    const r = await input.spawn('projeto');
    expect(r.session).toBe('agente-100');
    expect(r.pid).toBe(4321);
    expect(calls[0]).toEqual(['new-session', '-d', '-s', 'agente-100', '-c', r.cwd, 'claude']);
    expect(r.cwd.endsWith('/projeto')).toBe(true);
    await expect(input.spawn('../')).rejects.toMatchObject({ status: 400 });
    await expect(input.spawn('/etc')).rejects.toMatchObject({ status: 400 });
    await expect(input.spawn('nao-existe')).rejects.toMatchObject({ status: 400 });
    expect((await input.spawn(undefined)).cwd).toBe(r.cwd.replace(/\/projeto$/, ''));
    const state = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    expect(state.projects[r.cwd].hasTrustDialogAccepted).toBe(true);
  });

  it('spawn: marca a pasta como confiável preservando o resto do ~/.claude.json', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'hb-home-'))); // macOS: /var -> /private/var
    await writeFile(join(home, '.claude.json'), JSON.stringify({ userID: 'u1', projects: { [home]: { allowedTools: ['Bash'] }, '/outro': { x: 1 } } }));
    const input = createAgentInput({ home, run: async () => undefined, claudeCommand: 'claude' });
    const r = await input.spawn('');
    const state = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    expect(state.userID).toBe('u1');
    expect(state.projects['/outro']).toEqual({ x: 1 });
    expect(state.projects[r.cwd]).toMatchObject({ allowedTools: ['Bash'], hasTrustDialogAccepted: true });
  });

  it('nunca digita em pid de outro programa nem em agente de conta remota (ponte)', async () => {
    const calls: string[][] = [];
    const tmuxEnv = env({ TMUX: '/tmp/tmux-1000/default,9,0', TMUX_PANE: '%7' });
    const input = createAgentInput({
      readEnviron: async () => tmuxEnv,
      readCmdline: async (pid) => (pid === 700 ? 'vim\0notas.txt\0' : 'claude\0'),
      remoteAccounts: new Set(['.claude-mac']),
      run: async (a) => void calls.push(a),
    });
    expect(await input.available('.claude:700')).toBe(false);
    expect(await input.available('.claude-mac:500')).toBe(false);
    expect(await input.available('.claude:500')).toBe(true);
    await expect(input.send('.claude-mac:500', 'oi')).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
  });

  const UUID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d';

  it('cleanResumeId: só UUID estrito (normalizado em minúsculas), nada que o shell possa interpretar', () => {
    expect(cleanResumeId(undefined)).toBeUndefined();
    expect(cleanResumeId(null)).toBeUndefined();
    expect(cleanResumeId(UUID)).toBe(UUID);
    expect(cleanResumeId(UUID.toUpperCase())).toBe(UUID);
    for (const bad of [
      '',
      'abc',
      42,
      {},
      `${UUID} `,
      ` ${UUID}`,
      `${UUID}\n`,
      `${UUID}; rm -rf ~`,
      `${UUID}' && id '`,
      '$(id)',
      '`id`',
      '--dangerously-skip-permissions',
      '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4',
      '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4dd',
      '0a1b2c3d_4e5f_4a6b_8c7d_9e0f1a2b3c4d',
      'g0000000-0000-4000-8000-000000000000',
    ]) {
      let err: unknown;
      try {
        cleanResumeId(bad);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(InputError);
      expect((err as InputError).status).toBe(400);
    }
  });

  it('claudeShellCommand: exec claude no shell de login; --resume só com UUID validado', () => {
    expect(claudeShellCommand()).toBe("bash -lc 'exec claude'");
    expect(claudeShellCommand(UUID)).toBe(`bash -lc 'exec claude --resume ${UUID}'`);
    for (const bad of [`x'; id; '`, `${UUID} --print`, '$(id)']) expect(() => claudeShellCommand(bad)).toThrow(InputError);
  });

  it('spawn com resume: claude --resume <uuid> na pasta, com a mesma checagem de HOME e confiança', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'hb-home-')));
    await mkdir(join(home, 'projeto'));
    const calls: string[][] = [];
    const input = createAgentInput({ home, run: async (a) => void calls.push(a), capture: async () => '777\n', now: () => 36 ** 2 });
    const r = await input.spawn(join(home, 'projeto'), { resume: UUID });
    expect(r.pid).toBe(777);
    expect(r.cwd).toBe(join(home, 'projeto'));
    expect(calls[0]).toEqual(['new-session', '-d', '-s', 'agente-100', '-c', join(home, 'projeto'), `bash -lc 'exec claude --resume ${UUID}'`]);
    const state = JSON.parse(await readFile(join(home, '.claude.json'), 'utf8'));
    expect(state.projects[r.cwd].hasTrustDialogAccepted).toBe(true);

    // comando trocado (testes/instalações): o --resume vai no fim
    const custom: string[][] = [];
    const other = createAgentInput({ home, run: async (a) => void custom.push(a), claudeCommand: 'claude' });
    await other.spawn('projeto', { resume: UUID });
    expect(custom[0].at(-1)).toBe(`claude --resume ${UUID}`);
  });

  it('spawn com resume inválido ou pasta fora do HOME: 400 sem rodar nada nem marcar confiança', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'hb-home-')));
    const outside = await realpath(await mkdtemp(join(tmpdir(), 'hb-fora-')));
    const calls: string[][] = [];
    const input = createAgentInput({ home, run: async (a) => void calls.push(a), capture: async () => '1\n' });
    await expect(input.spawn(home, { resume: `${UUID}; rm -rf ~` })).rejects.toMatchObject({ status: 400 });
    await expect(input.spawn(home, { resume: 'nao-e-uuid' })).rejects.toMatchObject({ status: 400 });
    await expect(input.spawn(outside, { resume: UUID })).rejects.toMatchObject({ status: 400 });
    await expect(input.spawn(join(home, 'sumiu'), { resume: UUID })).rejects.toMatchObject({ status: 400 });
    expect(calls).toEqual([]);
    await expect(readFile(join(home, '.claude.json'), 'utf8')).rejects.toThrow();
  });

  it('home: GET de agente novo informa o HOME para o histórico saber o que dá para retomar', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'hb-home-')));
    expect(await createAgentInput({ home }).home()).toBe(home);
  });
});
