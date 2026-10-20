import { mkdtempSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { OfficeSnapshot } from '../shared/types';
import { cleanDeadSessions, openAgents, startReopen, openListSaver, readOpen, toReopen, type OpenAgent } from './reopen';

const tmp = () => mkdtempSync(join(tmpdir(), 'hb-reopen-'));
const a = (sessionId: string, account = '.claude'): OpenAgent => ({ account, sessionId });

describe('reabrir agentes', () => {
  it('openAgents: só principais vivos, sem demo, com a pasta da sala', () => {
    const base = { kind: 'main', roomId: 'r1', name: 'Ana', account: '.claude', status: 'idle' };
    const snap = {
      rooms: [{ id: 'r1', name: 'p', path: '/home/u/p' }],
      agents: [
        { ...base, id: '.claude:1', sessionId: 's1' },
        { ...base, id: '.claude:2', sessionId: 's1' },
        { ...base, id: '.claude:3', sessionId: 's2', status: 'offline' },
        { ...base, id: 'demo:x', sessionId: 's3' },
        { ...base, id: 's1:sub', sessionId: 's1', kind: 'sub' },
      ],
    } as unknown as OfficeSnapshot;
    expect(openAgents(snap)).toEqual([{ account: '.claude', sessionId: 's1', cwd: '/home/u/p', name: 'Ana', appearance: undefined }]);
  });

  it('readOpen: ausente, corrompido ou formato estranho = nada', () => {
    const d = tmp();
    expect(readOpen(join(d, 'nao-existe.json'))).toEqual([]);
    writeFileSync(join(d, 'x.json'), '{oops');
    expect(readOpen(join(d, 'x.json'))).toEqual([]);
    writeFileSync(join(d, 'x.json'), '{"a":1}');
    expect(readOpen(join(d, 'x.json'))).toEqual([]);
    writeFileSync(join(d, 'x.json'), JSON.stringify([a('s1'), { account: 1 }, null]));
    expect(readOpen(join(d, 'x.json'))).toEqual([a('s1')]);
  });

  it('toReopen: pula os vivos e repetidos; contas extras ficam para retomar à mão', () => {
    const r = toReopen([a('s1'), a('s2', '.codex'), a('s1'), a('s3'), a('s4', '.claude-trabalho')], new Set(['s3']));
    expect(r.reopen.map((e) => e.sessionId)).toEqual(['s1', 's2']);
    expect(r.skipped.map((e) => e.sessionId)).toEqual(['s4']);
    expect(toReopen([], new Set()).reopen).toEqual([]);
  });

  it('openListSaver: grava o que cresce; o que encolhe só na segunda vez igual', () => {
    const f = join(tmp(), 'abertos.json');
    const save = openListSaver(f, [a('s1'), a('s2')]);
    save([a('s1')]); // desligando: ainda não grava
    expect(readOpen(f)).toEqual([]);
    save([a('s1'), a('s2'), a('s3')]);
    expect(readOpen(f).map((e) => e.sessionId)).toEqual(['s1', 's2', 's3']);
    save([]);
    expect(readOpen(f)).toHaveLength(3);
    save([]); // fechou todos de propósito
    expect(readOpen(f)).toEqual([]);
    expect(readdirSync(join(f, '..'))).toEqual(['abertos.json']);
  });

  it('cleanDeadSessions: remove registro (e .key) de pid morto, mantém o vivo', () => {
    const dir = tmp();
    const s = join(dir, 'sessions');
    mkdirSync(s);
    writeFileSync(join(s, '10.json'), JSON.stringify({ pid: 10 }));
    writeFileSync(join(s, '10.abc.key'), 'k');
    writeFileSync(join(s, '20.json'), JSON.stringify({ pid: 20 }));
    writeFileSync(join(s, 'ruim.json'), '{');
    expect(cleanDeadSessions([dir, join(dir, 'nao-existe')], (pid) => pid === 20)).toBe(2);
    expect(readdirSync(s)).toEqual(['20.json']);
    expect(JSON.parse(readFileSync(join(s, '20.json'), 'utf8')).pid).toBe(20);
  });

  it('startReopen: pending conta os retomáveis até terminar (e zera se ninguém precisa voltar)', async () => {
    vi.useFakeTimers();
    try {
      const d = tmp();
      const f = join(d, 'abertos.json');
      writeFileSync(f, JSON.stringify([a('s1'), a('s2', '.codex'), a('s3', '.claude-trabalho')]));
      const empty = { rooms: [], agents: [] } as unknown as OfficeSnapshot;
      const posts: unknown[] = [];
      let done = 0;
      const st = startReopen({ file: f, snapshot: () => empty, post: async (b) => (posts.push(b), { ok: true }), claudeDirs: [], cleanSessions: false, settleMs: 10, graceMs: 100, saveEveryMs: 60_000, onDone: () => done++ });
      expect(st.pending()).toBe(2);
      await vi.advanceTimersByTimeAsync(10 + 2 * 2_000);
      expect(posts).toHaveLength(2);
      expect(st.pending()).toBe(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(st.pending()).toBe(0);
      expect(done).toBe(1);

      writeFileSync(f, '[]');
      const none = startReopen({ file: f, snapshot: () => empty, post: async () => ({ ok: true }), claudeDirs: [], cleanSessions: false, settleMs: 10, onDone: () => done++ });
      expect(none.pending()).toBe(0);
      await vi.advanceTimersByTimeAsync(10);
      expect(done).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
