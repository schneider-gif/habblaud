// Carteiro: entrega o aviso no tmux de quem está livre, adia para quem está ocupado, avisa o feed uma vez.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { enviarMensagem, lerCaixa, listarPasta, LIMITES } from '../../mod/habblaud/mensagens/caixa.mjs';
import { Carteiro } from './carteiro';

const A = { sid: 'aaaaaaaa-1111-4111-8111-111111111111', nome: 'Flávia', engine: 'claude' as const };
const B = { sid: 'bbbbbbbb-2222-4222-8222-222222222222', nome: 'Bruno', engine: 'codex' as const };

function agente(id: string, sid: string, name: string, status: AgentInfo['status'], statusSince = 0): AgentInfo {
  return { id, kind: 'main', sessionId: sid, name, status, statusSince, roomId: 'r', look: 'f', role: '', account: '.claude', recent: [], tasks: [], startedAt: 0, lastEventAt: 0, stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, seed: 1 };
}

let raiz: string;
beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'hbcart-'));
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

function montar(agentes: AgentInfo[], opts: { falhar?: boolean; semTmux?: string[] } = {}) {
  const digitado: Array<{ id: string; texto: string }> = [];
  const feed: string[] = [];
  let now = 100_000;
  const c = new Carteiro({
    raiz,
    agentes: () => agentes,
    disponivel: async (id) => !opts.semTmux?.includes(id),
    digitar: async (id, texto) => {
      if (opts.falhar) throw new Error('tmux caiu');
      digitado.push({ id, texto });
    },
    aoChegar: (m, de, para) => feed.push(`${de?.name ?? m.de.nome} → ${para?.name ?? m.para.nome}`),
    now: () => now,
  });
  return { c, digitado, feed, avancar: (ms: number) => (now += ms) };
}

describe('Carteiro', () => {
  it('destinatário livre: digita o aviso com a mensagem, marca como lida e não repete', async () => {
    const ags = [agente('.claude:1', A.sid, 'Flávia', 'working'), agente('.codex:2', B.sid, 'Bruno', 'idle')];
    const { c, digitado, feed } = montar(ags);
    await c.tick(); // primeira volta: nada (e o que já estava na caixa no boot não vai para o feed)
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'pode rodar os testes?' });
    expect(await c.tick()).toEqual([m.id]);
    expect(digitado).toHaveLength(1);
    expect(digitado[0].id).toBe('.codex:2');
    expect(digitado[0].texto).toContain('pode rodar os testes?');
    expect(digitado[0].texto).toContain(`hb-msg responder ${m.id}`);
    expect(feed).toEqual(['Flávia → Bruno']);
    expect(listarPasta(raiz, B.sid, 'lidas').map((x) => x.id)).toEqual([m.id]);
    expect(await c.tick()).toEqual([]);
    expect(digitado).toHaveLength(1);
  });

  it('ocupado (ou recém-livre, ou esperando a pessoa): adia; entrega quando fica livre', async () => {
    const bruno = agente('.codex:2', B.sid, 'Bruno', 'working');
    const ags = [agente('.claude:1', A.sid, 'Flávia', 'idle'), bruno];
    const { c, digitado, avancar } = montar(ags);
    await c.tick();
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'quando puder' });
    await c.tick();
    bruno.status = 'waiting';
    await c.tick();
    expect(digitado).toHaveLength(0);
    expect(listarPasta(raiz, B.sid, 'novas')).toHaveLength(1);
    bruno.status = 'idle';
    bruno.statusSince = 100_000; // acabou de ficar livre: espera a folga
    await c.tick();
    expect(digitado).toHaveLength(0);
    avancar(2000);
    expect(await c.tick()).toEqual([m.id]);
    expect(digitado).toHaveLength(1);
  });

  it('fora do escritório ou sem tmux: fica na caixa; o agente lê com hb-msg ler', async () => {
    const { c, digitado } = montar([agente('.claude:9', B.sid, 'Bruno', 'idle')], { semTmux: ['.claude:9'] });
    enviarMensagem(raiz, { de: A, para: B, texto: 'oi' });
    await c.tick();
    expect(digitado).toHaveLength(0);
    expect(lerCaixa(raiz, B.sid).map((x) => x.texto)).toEqual(['oi']);
  });

  it('falha ao digitar: devolve para novas e tenta de novo', async () => {
    const ags = [agente('.codex:2', B.sid, 'Bruno', 'idle')];
    const r = montar(ags, { falhar: true });
    enviarMensagem(raiz, { de: A, para: B, texto: 'oi' });
    expect(await r.c.tick()).toEqual([]);
    expect(listarPasta(raiz, B.sid, 'novas')).toHaveLength(1);
    const ok = montar(ags);
    expect(await ok.c.tick()).toHaveLength(1);
  });

  it('texto longo: aviso curto e a mensagem fica em avisadas até o hb-msg ler', async () => {
    const { c, digitado } = montar([agente('.codex:2', B.sid, 'Bruno', 'idle')]);
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'y'.repeat(LIMITES.inline + 1) });
    await c.tick();
    expect(digitado[0].texto).toMatch(/texto longo/);
    expect(digitado[0].texto).not.toContain('yyyy');
    expect(listarPasta(raiz, B.sid, 'avisadas').map((x) => x.id)).toEqual([m.id]);
    expect(lerCaixa(raiz, B.sid).map((x) => x.id)).toEqual([m.id]);
  });
});
