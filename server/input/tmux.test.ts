import { mkdtemp, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cleanInput, createAgentInput, InputError, pidOfAgent, tmuxTargetFromEnviron } from './tmux';

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
    const input = createAgentInput({ home, run: async (a) => void calls.push(a), now: () => 36 ** 2, claudeCommand: 'claude' });
    const r = await input.spawn('projeto');
    expect(r.session).toBe('agente-100');
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
});
