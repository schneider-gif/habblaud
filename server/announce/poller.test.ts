import { describe, expect, it } from 'vitest';
import { AnnouncementPoller, parseAnnouncement } from './poller';

const SRC = 'https://habblaude.com/avisos.json';
const NOW = Date.parse('2026-10-15T12:00:00Z');
const OK = { id: 'codex-2026-10', title: 'Codex chegou!', body: 'Conecte sua conta.', logo: '/avisos/codex.svg' };

describe('parseAnnouncement', () => {
  it('aceita o aviso e resolve o logo na mesma origem', () => {
    expect(parseAnnouncement(OK, SRC, NOW)).toEqual({ ...OK, logo: 'https://habblaude.com/avisos/codex.svg', confetti: true });
  });

  it('descarta logo de outra origem ou sem https', () => {
    expect(parseAnnouncement({ ...OK, logo: 'https://evil.example/x.svg' }, SRC, NOW)?.logo).toBeUndefined();
    expect(parseAnnouncement({ ...OK, logo: 'javascript:alert(1)' }, SRC, NOW)?.logo).toBeUndefined();
  });

  it('nenhum aviso: vazio, campos faltando, id inválido ou vencido', () => {
    expect(parseAnnouncement({}, SRC, NOW)).toBeUndefined();
    expect(parseAnnouncement(null, SRC, NOW)).toBeUndefined();
    expect(parseAnnouncement({ ...OK, id: 'a b' }, SRC, NOW)).toBeUndefined();
    expect(parseAnnouncement({ ...OK, until: '2026-10-01T00:00:00Z' }, SRC, NOW)).toBeUndefined();
    expect(parseAnnouncement({ ...OK, until: '2026-11-01T00:00:00Z' }, SRC, NOW)?.id).toBe(OK.id);
  });

  it('confetti: false desliga o confete', () => {
    expect(parseAnnouncement({ ...OK, confetti: false }, SRC, NOW)?.confetti).toBe(false);
  });
});

describe('AnnouncementPoller', () => {
  it('avisa mudança e mantém o último aviso quando a leitura falha', async () => {
    let changes = 0;
    let fail = false;
    const fetchFn = (async () => {
      if (fail) throw new TypeError('fetch failed');
      return new Response(JSON.stringify(OK), { status: 200 });
    }) as typeof fetch;
    const p = new AnnouncementPoller(SRC, () => changes++, fetchFn);
    await p.poll();
    expect(p.get()?.id).toBe(OK.id);
    expect(changes).toBe(1);
    fail = true;
    await p.poll();
    expect(p.get()?.id).toBe(OK.id);
    expect(changes).toBe(1);
  });

  it('sem URL fica desligado', () => {
    expect(new AnnouncementPoller(undefined, () => {}).get()).toBeUndefined();
  });
});
