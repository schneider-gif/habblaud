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

function setup(files: Partial<FileFacts> = {}, opts: { zeroDone?: boolean } = {}) {
  tmp = tempDir();
  const projectsDir = join(tmp.dir, 'projetos');
  let t = 1000;
  const state = { files: { ...NO_FILES, ...files }, github: { remote: false, pushed: false } as { remote: boolean; pushed: boolean; project?: string }, auth: false };
  const probe: MissionsProbe = {
    files: vi.fn(async () => state.files),
    github: vi.fn(async () => state.github),
    ports: vi.fn(async (dirs: readonly string[]) => new Map(dirs.map((d) => [d, [] as number[]]))),
    auth: vi.fn(async () => ({ connected: state.auth })),
  };
  const store = new MissionsStore(null);
  // Por padrão a Missão 0 (conta do Claude) já está concluída: os testes abaixo são das missões de criação.
  if (opts.zeroDone !== false) store.update((s) => void (s.completed['conta-claude'] = { at: 0, by: 'auto' }));
  const changes: number[] = [];
  const engine = new MissionsEngine({ store, projectsDir, home: tmp.dir, probe, now: () => t, onChange: () => changes.push(t) });
  const site = join(projectsDir, 'meu-site');
  const snap = (status: string, room = site, id = '.claude:1') =>
    ({ rooms: [{ id: room, path: room, name: 'x' }], agents: [{ id, kind: 'main', status, roomId: room }] }) as unknown as OfficeSnapshot;
  return { engine, probe, state, projectsDir, site, snap, changes, tick: (ms = 1000) => (t += ms) };
}

describe('MissionsEngine', () => {
  it('quadro inicial: 1 liberada, o resto trancado sem título (silhueta)', () => {
    const { engine } = setup();
    const v = engine.view();
    expect(v.missions.map((m) => m.state)).toEqual(['done', 'available', 'locked', 'locked', 'locked', 'locked']);
    expect(v.missions[1].title).toBe('Seu primeiro site');
    expect(v.missions[1].example).toBeTruthy();
    expect(v.missions[2].title).toBeUndefined();
    expect(v.missions[2].goal).toBeUndefined();
    expect(v.missions[2].coins).toBe(100);
    expect(v).toMatchObject({ wallet: { coins: 0 }, xp: 0, level: { level: 1 }, streak: 0, celebrate: [] });
  });

  it('começar cria a pasta (sem sobrescrever) e ativa a missão', async () => {
    const { engine, site } = setup();
    expect(await engine.start('primeiro-site')).toEqual({ ok: true, project: site });
    expect(existsSync(site)).toBe(true);
    expect(engine.view().missions[1].state).toBe('active');
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
    expect(engine.view().missions[1].state).toBe('active'); // ainda sem index.html
    expect(engine.view().missions[1].steps?.map((s) => s.ok)).toEqual([true, true, false]);
    state.files = { ...state.files, index: true };
    expect(await engine.evaluate()).toBe('primeiro-site');
    const v = engine.view();
    expect(v.missions[1]).toMatchObject({ state: 'done', doneBy: 'auto' });
    expect(v.missions[2].state).toBe('available');
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
    expect(engine.view().missions[1].state).toBe('done');
    tick();
    await engine.start('peca-melhoria');
    tick();
    engine.noteInput('.claude:1');
    tick();
    engine.ingest(snap('working'));
    tick();
    engine.ingest(snap('idle'));
    await engine.settled();
    expect(engine.view().missions[2].state).toBe('done');
    expect(engine.view().wallet.coins).toBe(200);
  });

  it('"Concluí" (manual) só na missão ativa; detecção automática tem preferência', async () => {
    const { engine } = setup();
    expect(await engine.complete('primeiro-site')).toMatchObject({ status: 409 });
    await engine.start('primeiro-site');
    expect(await engine.complete('peca-melhoria')).toMatchObject({ status: 409 });
    expect(await engine.complete('primeiro-site')).toEqual({ ok: true, coins: 100 });
    expect(engine.view().missions[1].doneBy).toBe('manual');
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
    expect(engine.view().missions[4].state).toBe('active');
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

describe('Missão 0 (conta do Claude)', () => {
  it('ativa desde o início; credencial encontrada conclui sozinha ao carregar o quadro e libera a 1', async () => {
    const { engine, state } = setup({}, { zeroDone: false });
    expect(engine.view().missions.map((m) => m.state)).toEqual(['active', 'locked', 'locked', 'locked', 'locked', 'locked']);
    expect(await engine.evaluate()).toBeUndefined();
    state.auth = true;
    expect(await engine.evaluate()).toBe('conta-claude');
    const v = engine.view();
    expect(v.missions[0]).toMatchObject({ state: 'done', doneBy: 'auto' });
    expect(v.missions[1].state).toBe('available');
    expect(v.wallet.coins).toBe(50);
  });
  it('um agente que terminou um turno também prova a conta (macOS guarda o login no Keychain)', async () => {
    const { engine, snap, tick } = setup({}, { zeroDone: false });
    engine.ingest(snap('working', '/qualquer'));
    tick();
    engine.ingest(snap('idle', '/qualquer'));
    await engine.settled();
    expect(engine.view().missions[0].state).toBe('done');
  });
  it('conta que sai depois: aviso no quadro, sem desfazer a missão', async () => {
    const { engine, state } = setup({}, { zeroDone: false });
    state.auth = true;
    await engine.evaluate();
    await engine.refreshAuth();
    expect(engine.view().authLost).toBeFalsy();
    state.auth = false;
    await engine.refreshAuth();
    expect(engine.view().authLost).toBe(true);
    expect(engine.view().missions[0].state).toBe('done');
    state.auth = true;
    await engine.refreshAuth();
    expect(engine.view().authLost).toBeFalsy();
  });
  it('o GET do quadro (freshView) também confere se a conta saiu', async () => {
    const { engine, state } = setup({}, { zeroDone: false });
    state.auth = true;
    expect((await engine.freshView()).missions[0].state).toBe('done');
    state.auth = false;
    expect((await engine.freshView()).authLost).toBe(true);
  });
  it('sem nunca ter visto credencial (ex.: Keychain), nunca avisa que saiu', async () => {
    const { engine } = setup();
    await engine.refreshAuth();
    expect(engine.view().authLost).toBeFalsy();
  });
  it('"Começar" da Missão 0 não cria pasta: a "pasta" é o HOME', async () => {
    const { engine } = setup({}, { zeroDone: false });
    const r = await engine.start('conta-claude');
    expect(r).toMatchObject({ ok: true });
    expect((r as { project: string }).project).toBe(engine.projectDir(null));
  });
});
