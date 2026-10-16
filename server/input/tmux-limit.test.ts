import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createAgentInput } from './tmux';

describe('limite de agentes do plano no spawn', () => {
  const limit = { max: 2, plan: 'sala', upgradeUrl: 'app.habblaude.com/planos' };

  it('recusa com 409 e a mensagem do plano quando já há o máximo rodando, sem abrir tmux', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hb-home-'));
    const calls: string[][] = [];
    const input = createAgentInput({ home, run: async (a) => void calls.push(a), capture: async () => '5000\n', claudeCommand: 'claude', agentLimit: limit, agentPids: () => [11, 12] });
    await expect(input.spawn('')).rejects.toMatchObject({
      status: 409,
      message: 'Seu plano Sala permite 2 agentes ao mesmo tempo e já há 2 rodando. Feche um deles ou faça upgrade em app.habblaude.com/planos.',
    });
    await expect(input.spawn('', { engine: 'codex' })).rejects.toMatchObject({ status: 409 });
    expect(calls).toEqual([]);
    // recusado não marca a pasta como confiável
    await expect(access(join(home, '.claude.json'))).rejects.toThrow();
    expect(input.limitStatus()).toEqual({ running: 2, max: 2, plan: 'sala' });
  });

  it('libera quando um fecha; sem limite não conta nada', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hb-home-'));
    let running = [11, 12];
    let n = 0;
    const input = createAgentInput({ home, run: async () => undefined, capture: async () => `${6000 + n++}\n`, claudeCommand: 'claude', agentLimit: limit, agentPids: () => running, pidAlive: () => false });
    await expect(input.spawn('')).rejects.toMatchObject({ status: 409 });
    running = [11];
    expect((await input.spawn('')).pid).toBe(6000);
    const free = createAgentInput({
      home,
      run: async () => undefined,
      capture: async () => '1\n',
      claudeCommand: 'claude',
      agentPids: () => {
        throw new Error('não devia contar');
      },
    });
    await expect(free.spawn('')).resolves.toBeTruthy();
    expect(free.limitStatus()).toBeUndefined();
  });

  it('corrida: três "+ Novo agente" juntos com 1 vaga: só um abre (o pane recém-aberto conta antes do exec)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'hb-home-'));
    const calls: string[][] = [];
    let pid = 7000;
    let t = 1_000_000;
    const input = createAgentInput({
      home,
      run: async (a) => {
        await new Promise((ok) => setTimeout(ok, 20));
        calls.push(a);
      },
      capture: async () => `${pid++}\n`,
      now: () => t++,
      claudeCommand: 'claude',
      agentLimit: limit,
      agentPids: () => [11], // a varredura ainda não vê os panes novos (bash/porteiro antes do exec)
      pidAlive: () => true,
    });
    const results = await Promise.allSettled([input.spawn(''), input.spawn(''), input.spawn('', { engine: 'codex' })]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'rejected']);
    expect(calls.filter((c) => c[0] === 'new-session')).toHaveLength(1);
    expect(input.limitStatus()?.running).toBe(2);
    // pane recém-aberto conta só por PENDING_MS (depois vale a varredura do /proc)
    t += 20_000;
    expect(input.limitStatus()?.running).toBe(1);
  });
});
