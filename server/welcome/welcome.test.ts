import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { setQuiet } from '../log';
import { StateStore } from '../model/state';
import { DELIVERY_SETTLE_MAX_MS, DELIVERY_TIMEOUT_MS, hasConversations, PROMPT_RE, parseWelcomeRecord, WELCOME_KEY, WelcomeService, welcomeOff, type WelcomeDeps } from './welcome';

setQuiet(true);

/** Serviço com relógio falso: cada sleep avança o relógio; o "Claude" fica pronto em `readyAt`. */
function make(over: Partial<WelcomeDeps> & { readyAt?: number; screens?: (t: number) => string } = {}) {
  let t = 1_000_000;
  const store = new StateStore(null);
  const spawned: string[] = [];
  const sent: { id: string; text: string; at: number }[] = [];
  const start = t;
  const readyAt = over.readyAt ?? 3_000;
  const deps: WelcomeDeps = {
    store,
    enabled: () => true,
    loggedIn: async () => true,
    usedBefore: async () => false,
    spawn: async (cwd) => {
      spawned.push(cwd);
      return { cwd: `/home/u/${cwd}`, pid: 4242 };
    },
    agentReady: (id) => id === '.claude:4242' && t - start >= readyAt,
    available: async () => true,
    screen: async () => over.screens?.(t - start) ?? '╭──╮\n│ > │\n╰──╯',
    send: async (id, text) => void sent.push({ id, text, at: t - start }),
    now: () => t,
    sleep: async (ms) => void (t += ms),
    ...over,
  };
  const svc = new WelcomeService(deps);
  return { svc, store, spawned, sent, clock: () => t - start };
}

describe('boas-vindas', () => {
  it('HABBLAUD_BOAS_VINDAS=0 (ou false/off) desliga', () => {
    expect(welcomeOff({ HABBLAUD_BOAS_VINDAS: '0' })).toBe(true);
    expect(welcomeOff({ HABBLAUD_BOAS_VINDAS: 'off' })).toBe(true);
    expect(welcomeOff({ HABBLAUD_BOAS_VINDAS: '1' })).toBe(false);
    expect(welcomeOff({})).toBe(false);
  });

  it('desligado: estado off, sem gravar nada; pular e começar dão 403', async () => {
    const { svc, store } = make({ enabled: () => false });
    expect((await svc.view()).state).toBe('off');
    expect(store.getServer(WELCOME_KEY)).toBeUndefined();
    expect(() => svc.skip()).toThrow(expect.objectContaining({ status: 403 }));
    await expect(svc.start('site')).rejects.toMatchObject({ status: 403 });
  });

  it('primeira abertura: pendente, com as 3 sugestões; sem login o cartão guia para o login', async () => {
    let logged = false;
    const { svc, store } = make({ loggedIn: async () => logged });
    const v = await svc.view();
    expect(v.state).toBe('login');
    expect(v.suggestions.map((s) => s.text)).toEqual(['Crie um site simples para mim', 'Explique o que você sabe fazer', 'Organize meus arquivos']);
    expect(parseWelcomeRecord(store.getServer(WELCOME_KEY))).toMatchObject({ state: 'pending' });
    await expect(svc.start('site')).rejects.toMatchObject({ status: 409, login: true });
    logged = true;
    expect((await svc.view()).state).toBe('ready');
  });

  it('quem já usava o Claude/Codex (conversas no disco) nunca vê: done/auto na primeira consulta, e só nela', async () => {
    let used = true;
    const a = make({ usedBefore: async () => used });
    expect((await a.svc.view()).state).toBe('done');
    expect(parseWelcomeRecord(a.store.getServer(WELCOME_KEY))).toMatchObject({ state: 'done', how: 'auto' });
    // pendente gravado não é reavaliado: o login feito no terminal não some com o cartão
    used = false;
    const b = make({ usedBefore: async () => used });
    expect((await b.svc.view()).state).toBe('ready');
    used = true;
    expect((await b.svc.view()).state).toBe('ready');
  });

  it('✕ Pular grava no servidor (state.json) e o cartão não volta, nem depois de reiniciar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hb-welcome-'));
    const file = join(dir, 'state.json');
    const store = new StateStore(file);
    const { svc } = make({ store, loggedIn: async () => false });
    expect((await svc.view()).state).toBe('login');
    svc.skip();
    expect((await svc.view()).state).toBe('done');
    store.flush();
    const again = new StateStore(file);
    again.load();
    expect(parseWelcomeRecord(again.getServer(WELCOME_KEY))).toMatchObject({ state: 'done', how: 'skipped' });
    const { svc: svc2 } = make({ store: again });
    expect((await svc2.view()).state).toBe('done');
    await expect(svc2.start('site')).rejects.toMatchObject({ status: 409 });
  });

  it('sugestão do site: abre o Claude em projetos/primeiro-projeto, grava "usada" e manda a sugestão quando ele fica pronto', async () => {
    const { svc, store, spawned, sent } = make({ readyAt: 3_000 });
    const r = await svc.start('site');
    expect(r).toEqual({ agentId: '.claude:4242', cwd: '/home/u/projetos/primeiro-projeto', choice: 'site' });
    expect(spawned).toEqual(['projetos/primeiro-projeto']);
    expect(parseWelcomeRecord(store.getServer(WELCOME_KEY))).toMatchObject({ state: 'done', how: 'used', choice: 'site' });
    expect((await svc.view()).delivery).toEqual({ agentId: '.claude:4242', state: 'waiting' });
    await svc.pending;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ id: '.claude:4242', text: 'Crie um site simples para mim' });
    // só depois de o agente chegar e a tela ficar igual em duas leituras
    expect(sent[0].at).toBeGreaterThan(3_000);
    expect((await svc.view()).delivery?.state).toBe('sent');
  });

  it('as outras sugestões abrem no HOME', async () => {
    const a = make();
    await a.svc.start('explicar');
    await a.svc.pending;
    expect(a.spawned).toEqual(['']);
    expect(a.sent[0].text).toBe('Explique o que você sabe fazer');
    const b = make();
    await b.svc.start('organizar');
    expect(b.spawned).toEqual(['']);
  });

  it('espera o campo de mensagem aparecer na tela antes de colar (abertura do Claude não conta)', async () => {
    // sessão criada em 1 s, mas a caixa "│ > │" só é desenhada em 5 s
    const { svc, sent } = make({ readyAt: 1_000, screens: (t) => (t < 5_000 ? 'Iniciando o Claude...' : '╭──╮\n│ > │\n╰──╯') });
    await svc.start('explicar');
    await svc.pending;
    expect(sent).toHaveLength(1);
    expect(sent[0].at).toBeGreaterThanOrEqual(6_000);
    expect(sent[0].at).toBeLessThan(1_000 + DELIVERY_SETTLE_MAX_MS);
    expect(PROMPT_RE.test('──────\n❯ \n──────')).toBe(true);
    expect(PROMPT_RE.test('Welcome to Claude Code\n>_ tips')).toBe(false);
  });

  it('tela que não para de mudar: manda depois de DELIVERY_SETTLE_MAX_MS com o agente presente', async () => {
    const { svc, sent } = make({ readyAt: 2_000, screens: (t) => `relógio ${t}` });
    await svc.start('explicar');
    await svc.pending;
    expect(sent).toHaveLength(1);
    expect(sent[0].at).toBeGreaterThanOrEqual(2_000 + DELIVERY_SETTLE_MAX_MS);
  });

  it('agente que nunca fica pronto: desiste em DELIVERY_TIMEOUT_MS e marca falha, sem mandar nada', async () => {
    const { svc, sent, clock } = make({ readyAt: Infinity });
    await svc.start('site');
    await svc.pending;
    expect(sent).toEqual([]);
    expect(clock()).toBeGreaterThanOrEqual(DELIVERY_TIMEOUT_MS);
    expect((await svc.view()).delivery?.state).toBe('failed');
  });

  it('agente reaberto depois do login (pid novo): a entrega segue o pid novo', async () => {
    let t0 = 0;
    const box: { svc?: WelcomeService } = {};
    const m = make({
      agentReady: (id) => id === '.claude:9999' && t0 >= 4_000,
      sleep: async () => {
        t0 += 1_000;
        if (t0 === 2_000) box.svc?.moveAgent('.claude:4242', '.claude:9999');
      },
      now: () => 1_000_000 + t0,
    });
    box.svc = m.svc;
    await m.svc.start('site');
    await m.svc.pending;
    expect(m.sent.map((s) => s.id)).toEqual(['.claude:9999']);
  });

  it('spawn que falha não grava nada (dá para tentar de novo); clique duplo não abre dois', async () => {
    let fail = true;
    let calls = 0;
    const { svc, store } = make({
      spawn: async (cwd) => {
        calls++;
        if (fail) throw Object.assign(new Error('tmux'), { status: 400 });
        await new Promise((ok) => setTimeout(ok, 5));
        return { cwd, pid: 4242 };
      },
    });
    await expect(svc.start('site')).rejects.toThrow('tmux');
    expect(parseWelcomeRecord(store.getServer(WELCOME_KEY))).toMatchObject({ state: 'pending' });
    fail = false;
    const [a, b] = await Promise.allSettled([svc.start('site'), svc.start('site')]);
    expect(a.status).toBe('fulfilled');
    expect(b).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(calls).toBe(2);
    await expect(svc.start('explicar')).rejects.toMatchObject({ status: 409 });
  });

  it('sugestão desconhecida: 400', async () => {
    const { svc } = make();
    await expect(svc.start('rm -rf')).rejects.toMatchObject({ status: 400 });
  });

  it('hasConversations: só conta conversas .jsonl (pasta vazia de projects não conta)', async () => {
    const root = mkdtempSync(join(tmpdir(), 'hb-conv-'));
    const claude = join(root, '.claude');
    const codex = join(root, '.codex');
    mkdirSync(join(claude, 'projects', '-home-u'), { recursive: true });
    expect(await hasConversations([claude], [codex])).toBe(false);
    mkdirSync(join(codex, 'sessions', '2026', '10', '17'), { recursive: true });
    writeFileSync(join(codex, 'sessions', '2026', '10', '17', 'rollout-x.jsonl'), '{}\n');
    expect(await hasConversations([claude], [codex])).toBe(true);
    writeFileSync(join(claude, 'projects', '-home-u', 'abc.jsonl'), '{}\n');
    expect(await hasConversations([claude], [])).toBe(true);
  });
});
