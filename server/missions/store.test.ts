import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { tempDir } from '../test/fixtures';
import { activeMission, completeMission, currentMission, dayKey, emptyState, markSeen, MissionsStore, missionState, recordMessage, recordTurns, startMission, streak } from './store';

setQuiet(true);
let tmp: ReturnType<typeof tempDir> | undefined;
afterEach(() => tmp?.cleanup());

describe('ordem e estados', () => {
  it('só a primeira não concluída fica liberada; o resto trancado', () => {
    const s = emptyState();
    expect(currentMission(s)?.id).toBe('primeiro-site');
    expect(missionState(s, 'primeiro-site')).toBe('available');
    expect(missionState(s, 'peca-melhoria')).toBe('locked');
    expect(activeMission(s)).toBeUndefined();
  });
  it('começar: só a liberada; trancada → 409; desconhecida → 404', () => {
    const s = emptyState();
    expect(startMission(s, 'peca-melhoria', 1)).toEqual({ status: 409, error: expect.any(String) });
    expect(startMission(s, 'nao-existe', 1)).toEqual({ status: 404, error: expect.any(String) });
    expect(startMission(s, 'primeiro-site', 5)).toEqual({ ok: true });
    expect(missionState(s, 'primeiro-site')).toBe('active');
    expect(activeMission(s)?.id).toBe('primeiro-site');
    // começar de novo não reinicia o relógio da missão
    startMission(s, 'primeiro-site', 9);
    expect(s.started['primeiro-site']).toBe(5);
  });
  it('concluir libera a próxima, paga moedas e XP', () => {
    const s = emptyState();
    startMission(s, 'primeiro-site', 1);
    expect(completeMission(s, 'primeiro-site', 10, 'auto')).toBe(100);
    expect(missionState(s, 'primeiro-site')).toBe('done');
    expect(missionState(s, 'peca-melhoria')).toBe('available');
    expect(missionState(s, 'jogo-pixel')).toBe('locked');
    expect(s.wallet.coins).toBe(100);
    expect(s.xp).toBe(100);
    expect(s.wallet.ledger).toEqual([{ at: 10, delta: 100, mission: 'primeiro-site', text: 'Missão 1: Seu primeiro site' }]);
  });
  it('crédito idempotente por missão: concluir de novo não paga', () => {
    const s = emptyState();
    startMission(s, 'primeiro-site', 1);
    completeMission(s, 'primeiro-site', 10, 'auto');
    expect(completeMission(s, 'primeiro-site', 11, 'manual')).toBe(0);
    // mesmo com o registro de conclusão perdido, a carteira lembra quem já pagou
    delete s.completed['primeiro-site'];
    startMission(s, 'primeiro-site', 12);
    expect(completeMission(s, 'primeiro-site', 13, 'manual')).toBe(0);
    expect(s.wallet.coins).toBe(100);
    expect(s.wallet.ledger).toHaveLength(1);
  });
  it('não conclui missão que não está ativa (trancada ou não começada)', () => {
    const s = emptyState();
    expect(completeMission(s, 'primeiro-site', 1, 'manual')).toBe(0);
    expect(completeMission(s, 'jogo-pixel', 1, 'manual')).toBe(0);
    expect(s.completed).toEqual({});
  });
  it('comemoração pendente até ser vista', () => {
    const s = emptyState();
    startMission(s, 'primeiro-site', 1);
    completeMission(s, 'primeiro-site', 2, 'auto');
    expect(s.celebrate).toEqual(['primeiro-site']);
    markSeen(s, 'primeiro-site');
    expect(s.celebrate).toEqual([]);
  });
});

describe('registros da detecção', () => {
  it('fins de turno e mensagens só com missão ativa, com limite', () => {
    const s = emptyState();
    recordTurns(s, [{ agentId: 'a', dir: '/d', at: 1 }]);
    recordMessage(s, { agentId: 'a', dir: '/d', at: 1 });
    expect(s.turns).toEqual([]);
    expect(s.messages).toEqual([]);
    startMission(s, 'primeiro-site', 1);
    for (let i = 0; i < 100; i++) recordTurns(s, [{ agentId: 'a', dir: '/d', at: i }]);
    expect(s.turns.length).toBeLessThanOrEqual(50);
    expect(s.turns.at(-1)?.at).toBe(99);
  });
});

describe('sequência de dias', () => {
  it('dias seguidos até hoje (ou ontem)', () => {
    expect(streak(['2026-10-12', '2026-10-13', '2026-10-14'], '2026-10-14')).toBe(3);
    expect(streak(['2026-10-12', '2026-10-13'], '2026-10-14')).toBe(2);
    expect(streak(['2026-10-10', '2026-10-13', '2026-10-14'], '2026-10-14')).toBe(2);
    expect(streak(['2026-10-11'], '2026-10-14')).toBe(0);
    expect(streak([], '2026-10-14')).toBe(0);
    expect(streak(['2026-09-30', '2026-10-01'], '2026-10-01')).toBe(2);
  });
  it('dayKey no fuso local', () => {
    expect(dayKey(new Date(2026, 9, 4, 23, 59).getTime())).toBe('2026-10-04');
  });
  it('começar e concluir marcam o dia', () => {
    const s = emptyState();
    const t = new Date(2026, 9, 14, 12).getTime();
    startMission(s, 'primeiro-site', t);
    expect(s.days).toEqual(['2026-10-14']);
  });
});

describe('MissionsStore (missions.json)', () => {
  it('grava, relê depois de reiniciar e mantém a versão', () => {
    tmp = tempDir();
    const file = join(tmp.dir, 'sub', 'missions.json');
    const a = new MissionsStore(file);
    a.load();
    a.update((s) => {
      startMission(s, 'primeiro-site', 1);
      completeMission(s, 'primeiro-site', 2, 'auto');
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).version).toBe(1);
    const b = new MissionsStore(file);
    b.load();
    expect(b.get().completed['primeiro-site']).toEqual({ at: 2, by: 'auto' });
    expect(b.get().wallet.coins).toBe(100);
  });
  it('arquivo corrompido ou de versão desconhecida: começa vazio (e guarda o ruim como .corrupt)', () => {
    tmp = tempDir();
    const file = join(tmp.dir, 'missions.json');
    writeFileSync(file, '{x');
    const a = new MissionsStore(file);
    a.load();
    expect(a.get()).toEqual(emptyState());
    expect(readFileSync(`${file}.corrupt`, 'utf8')).toBe('{x');
    writeFileSync(file, JSON.stringify({ version: 99 }));
    const b = new MissionsStore(file);
    b.load();
    expect(b.get()).toEqual(emptyState());
  });
  it('campos tortos no arquivo são descartados', () => {
    tmp = tempDir();
    const file = join(tmp.dir, 'missions.json');
    writeFileSync(file, JSON.stringify({ version: 1, started: { 'primeiro-site': 'x', hack: 3 }, completed: { 'primeiro-site': { at: 5, by: 'auto' } }, wallet: { coins: 'mil' }, xp: -5 }));
    const a = new MissionsStore(file);
    a.load();
    const s = a.get();
    expect(s.started).toEqual({});
    expect(s.completed).toEqual({ 'primeiro-site': { at: 5, by: 'auto' } });
    expect(s.wallet.coins).toBe(0);
    expect(s.xp).toBe(0);
  });
  it('sem arquivo (null): só memória', () => {
    const a = new MissionsStore(null);
    a.load();
    a.update((s) => void startMission(s, 'primeiro-site', 1));
    expect(a.get().started['primeiro-site']).toBe(1);
  });
});
