// Codex no "+ Novo agente" (bonecos em configuração/login), no histórico (Retomar com `codex resume`) e nas abas do
// terminal embutido (login da OpenAI e do GitHub).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { setupAgents, WAIT_LOGIN, WAIT_LOGIN_CODEX } from '../shell/setup';
import { AGENT_SESSION, cleanProgram, GH_LOGIN_SCRIPT, ShellService } from '../shell/service';
import { readCodexMeta, SessionHistory } from '../sources/history';
import { tempDir } from '../test/fixtures';

setQuiet(true);

const FIX = join(__dirname, 'fixtures');
const MULTI = 'rollout-2026-10-15T00-26-07-01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef.jsonl';
const ID = '01a13cf3-b5ff-7cb3-8cf2-61b25572c4ef';

describe('Codex sem login no "+ Novo agente"', () => {
  it('sessão agente-codex-* vira boneco "conectar sua conta OpenAI" com selo Codex; Claude continua com o texto dele', () => {
    const s = [{ session: 'agente-codex-mv8x1', pid: 900, cwd: '/home/dev/projetos/loja', createdAt: 1, command: 'node' }];
    const codex = setupAgents(s, { account: '.codex', hasAgentPid: () => false, connected: false, now: 10, engine: 'codex' });
    expect(codex).toEqual([{ id: '.codex:900', session: 'agente-codex-mv8x1', cwd: '/home/dev/projetos/loja', createdAt: 1, engine: 'codex', status: 'waiting', waitingFor: WAIT_LOGIN_CODEX }]);
    const claude = setupAgents([{ ...s[0], session: 'agente-mv8x2' }], { account: '.claude', hasAgentPid: () => false, connected: false, now: 10 });
    expect(claude[0].waitingFor).toBe(WAIT_LOGIN);
    expect(AGENT_SESSION.test('agente-codex-mv8x1')).toBe(true);
    expect(AGENT_SESSION.test('agente-codex-')).toBe(false);
  });

  it('Office: bonecos do Claude e do Codex convivem (cada observador troca só os seus)', () => {
    const office = new Office({ names: new NameStore(null), version: 't', startedAt: 0, accounts: () => [], sources: () => [], accountName: () => undefined, now: () => 5 });
    office.setSetupAgents([{ id: '.claude:1', session: 'agente-a', cwd: '/p', createdAt: 0, status: 'waiting', waitingFor: WAIT_LOGIN }]);
    office.setSetupAgents([{ id: '.codex:2', session: 'agente-codex-b', cwd: '/p', createdAt: 0, status: 'waiting', waitingFor: WAIT_LOGIN_CODEX }], 'codex');
    const agents = office.commit().snapshot.agents;
    expect(agents.map((a) => [a.id, a.engine ?? 'claude'])).toEqual([
      ['.claude:1', 'claude'],
      ['.codex:2', 'codex'],
    ]);
    expect(agents[1].activity?.text).toMatch(/OpenAI/);
    office.setSetupAgents([], 'codex');
    expect(office.commit().snapshot.agents.map((a) => a.id)).toEqual(['.claude:1']);
    // o agente de verdade chega com o mesmo id: o boneco provisório some e o selo Codex fica
    office.setSetupAgents([{ id: '.codex:3', session: 'agente-codex-c', cwd: '/p', createdAt: 0, status: 'idle' }], 'codex');
    office.addMain({ id: '.codex:3', account: '.codex', sessionId: ID, cwd: '/p', role: 'Agente principal', startedAt: 0, status: 'idle', engine: 'codex' });
    office.setSetupAgents([{ id: '.codex:3', session: 'agente-codex-c', cwd: '/p', createdAt: 0, status: 'idle' }], 'codex');
    const real = office.commit().snapshot.agents.filter((a) => a.id === '.codex:3');
    expect(real).toHaveLength(1);
    expect(real[0].setup).toBeUndefined();
    expect(real[0].engine).toBe('codex');
  });
});

describe('histórico com conversas do Codex', () => {
  it('lista o rollout (título, pasta, horários, selo) e resolve para Retomar na pasta original', async () => {
    const tmp = tempDir();
    try {
      const dir = join(tmp.dir, '.codex');
      const day = join(dir, 'sessions', '2026', '10', '15');
      mkdirSync(day, { recursive: true });
      writeFileSync(join(day, MULTI), readFileSync(join(FIX, MULTI)));
      const now = Date.parse('2026-10-15T12:00:00Z');
      const h = new SessionHistory({ accounts: () => [{ id: '.codex', dir }], openAgentOf: () => undefined, now: () => now, maxAgeMs: 10 * 365 * 86_400_000 });
      const list = await h.list();
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({ account: '.codex', sessionId: ID, engine: 'codex', title: 'liste os arquivos do projeto', project: '/home/dev/projetos/loja', open: false, projectDir: join('2026', '10', '15') });
      expect(h.resolve('.codex', ID)).toEqual({ path: expect.stringContaining(MULTI) });
      expect(h.resolve('.codex', '01a13cf6-0e3c-7053-bd16-136a0ae57a99')).toMatchObject({ status: 404 });
      expect(await h.resumeTarget('.codex', ID)).toEqual({ cwd: '/home/dev/projetos/loja' });
      const meta = await readCodexMeta(join(day, MULTI), readFileSync(join(day, MULTI)).length);
      expect(meta.lastAt).toBe(Date.parse('2026-10-15T00:29:20.387Z'));
    } finally {
      tmp.cleanup();
    }
  });
});

describe('abas do terminal embutido com programa', () => {
  it('lista fechada: claude, codex (login com código de dispositivo) e gh (login do GitHub)', async () => {
    expect(cleanProgram(undefined, true)).toBe('claude');
    expect(cleanProgram('codex')).toBe('codex');
    expect(cleanProgram('gh')).toBe('gh');
    expect(() => cleanProgram('rm -rf ~')).toThrow();
    const calls: string[][] = [];
    const tmp = tempDir();
    try {
      const svc = new ShellService({ home: tmp.dir, shell: '/bin/bash', tmux: async (args) => (calls.push(args), args[0] === 'list-sessions' ? '' : '') });
      await svc.create({ program: 'codex' }).catch(() => undefined);
      await svc.create({ program: 'gh' }).catch(() => undefined);
      const cmds = calls.filter((c) => c[0] === 'new-session').map((c) => c[c.indexOf(tmp.dir) + 5]);
      expect(cmds[0]).toBe("/bin/bash -lc 'codex login --device-auth; exec /bin/bash -l'");
      expect(cmds[1]).toContain('.habblaud/gh-login.sh');
      expect(readFileSync(join(tmp.dir, '.habblaud', 'gh-login.sh'), 'utf8')).toContain('gh auth login --web --git-protocol https --hostname github.com');
      expect(GH_LOGIN_SCRIPT).toContain('gh auth setup-git');
      expect(GH_LOGIN_SCRIPT).not.toMatch(/token/i);
    } finally {
      tmp.cleanup();
    }
  });
});
