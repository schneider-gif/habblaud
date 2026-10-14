import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { MissionsEngine, type MissionsProbe } from './engine';
import type { FileFacts } from './probe';
import { MissionsStore } from './store';

setQuiet(true);
let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => {
  tmp?.cleanup();
  tmp = undefined;
  vi.useRealTimers();
});

const NO_FILES: FileFacts = { exists: true, index: false, canvas: false, api: false, db: false };

function setup(files: Partial<FileFacts> = {}) {
  tmp = tempDir();
  const projectsDir = join(tmp.dir, 'projetos');
  let t = 1000;
  const state = { files: { ...NO_FILES, ...files }, github: { remote: false, pushed: false } as { remote: boolean; pushed: boolean; project?: string } };
  const probe: MissionsProbe = {
    files: vi.fn(async () => state.files),
    github: vi.fn(async () => state.github),
    ports: vi.fn(async (dirs: readonly string[]) => new Map(dirs.map((d) => [d, [] as number[]]))),
  };
  const changes: number[] = [];
  const engine = new MissionsEngine({ store: new MissionsStore(null), projectsDir, probe, now: () => t, onChange: () => changes.push(t) });
  const site = join(projectsDir, 'meu-site');
  const snap = (status: string, room = site, id = '.claude:1') =>
    ({ rooms: [{ id: room, path: room, name: 'x' }], agents: [{ id, kind: 'main', status, roomId: room }] }) as unknown as OfficeSnapshot;
  return { engine, probe, state, projectsDir, site, snap, changes, tick: (ms = 1000) => (t += ms) };
}

describe('MissionsEngine', () => {
  it('quadro inicial: 1 liberada, o resto trancado sem título (silhueta)', () => {
    const { engine } = setup();
    const v = engine.view();
    expect(v.missions.map((m) => m.state)).toEqual(['available', 'locked', 'locked', 'locked', 'locked']);
    expect(v.missions[0].title).toBe('Seu primeiro site');
    expect(v.missions[0].example).toBeTruthy();
    expect(v.missions[1].title).toBeUndefined();
    expect(v.missions[1].goal).toBeUndefined();
    expect(v.missions[1].coins).toBe(100);
    expect(v).toMatchObject({ wallet: { coins: 0 }, xp: 0, level: { level: 1 }, streak: 0, celebrate: [] });
  });

  it('começar cria a pasta (sem sobrescrever) e ativa a missão', async () => {
    const { engine, site } = setup();
    expect(await engine.start('primeiro-site')).toEqual({ ok: true, project: site });
    expect(existsSync(site)).toBe(true);
    expect(engine.view().missions[0].state).toBe('active');
    expect(await engine.start('jogo-pixel')).toMatchObject({ status: 409 });
  });

  it('Missão 1 automática: fim de turno na pasta + index.html; paga uma vez e libera a 2', async () => {
    const { engine, snap, tick, state, changes } = setup();
    await engine.start('primeiro-site');
    tick();
    engine.ingest(snap('working'));
    tick();
    engine.ingest(snap('idle'));
    await engine.settled();
    expect(engine.view().missions[0].state).toBe('active'); // ainda sem index.html
    expect(engine.view().missions[0].steps?.map((s) => s.ok)).toEqual([true, true, false]);
    state.files = { ...state.files, index: true };
    expect(await engine.evaluate()).toBe('primeiro-site');
    const v = engine.view();
    expect(v.missions[0]).toMatchObject({ state: 'done', doneBy: 'auto' });
    expect(v.missions[1].state).toBe('available');
    expect(v.wallet.coins).toBe(100);
    expect(v.celebrate).toEqual(['primeiro-site']);
    expect(await engine.evaluate()).toBeUndefined();
    expect(engine.view().wallet.coins).toBe(100);
    expect(changes.length).toBeGreaterThan(0);
  });

  it('Missão 2: mensagem pelo escritório ao agente da pasta e o fim do turno dele', async () => {
    const { engine, snap, tick } = setup({ index: true });
    await engine.start('primeiro-site');
    engine.ingest(snap('working'));
    tick();
    engine.ingest(snap('idle'));
    await engine.settled();
    expect(engine.view().missions[0].state).toBe('done');
    tick();
    await engine.start('peca-melhoria');
    tick();
    engine.noteInput('.claude:1');
    tick();
    engine.ingest(snap('working'));
    tick();
    engine.ingest(snap('idle'));
    await engine.settled();
    expect(engine.view().missions[1].state).toBe('done');
    expect(engine.view().wallet.coins).toBe(200);
  });

  it('"Concluí" (manual) só na missão ativa; detecção automática tem preferência', async () => {
    const { engine } = setup();
    expect(await engine.complete('primeiro-site')).toMatchObject({ status: 409 });
    await engine.start('primeiro-site');
    expect(await engine.complete('peca-melhoria')).toMatchObject({ status: 409 });
    expect(await engine.complete('primeiro-site')).toEqual({ ok: true, coins: 100 });
    expect(engine.view().missions[0].doneBy).toBe('manual');
    expect(await engine.complete('primeiro-site')).toMatchObject({ status: 409 });
    expect(engine.view().wallet.coins).toBe(100);
  });

  it('Missão 4: o git dos projetos', async () => {
    const { engine, state } = setup();
    for (const id of ['primeiro-site', 'peca-melhoria', 'jogo-pixel'] as const) {
      await engine.start(id);
      await engine.complete(id);
    }
    await engine.start('leve-github');
    expect(engine.view().missions[3].state).toBe('active');
    state.github = { remote: true, pushed: true, project: 'meu-site' };
    expect(await engine.evaluate()).toBe('leve-github');
  });

  it('timer de 30 s só enquanto há missão ativa', async () => {
    vi.useFakeTimers();
    const { engine, probe } = setup();
    engine.startTimer();
    expect(vi.getTimerCount()).toBe(0); // nenhuma ativa
    await engine.start('primeiro-site');
    expect(vi.getTimerCount()).toBe(1);
    const before = vi.mocked(probe.files).mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(vi.mocked(probe.files).mock.calls.length).toBe(before + 1);
    await engine.complete('primeiro-site');
    expect(vi.getTimerCount()).toBe(0);
    engine.stop();
  });

  it('comemoração vista some da fila', async () => {
    const { engine } = setup();
    await engine.start('primeiro-site');
    await engine.complete('primeiro-site');
    expect(engine.seen('primeiro-site')).toBe(true);
    expect(engine.view().celebrate).toEqual([]);
    expect(engine.seen('xx')).toBe(false);
  });

  it('agentIn: agente principal vivo dentro da pasta (para reaproveitar na Missão 2)', () => {
    const { engine, snap, site } = setup();
    engine.ingest(snap('idle'));
    expect(engine.agentIn(site)).toBe('.claude:1');
    engine.ingest(snap('offline'));
    expect(engine.agentIn(site)).toBeUndefined();
  });
});
