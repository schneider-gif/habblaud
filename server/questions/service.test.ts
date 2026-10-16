// QuestionService: pergunta pendente lida do transcript (só de agentes esperando), resposta pelo "tmux" (TUI falso),
// confirmação pelo tool_result, erros (já respondida, fora do tmux, diálogo fechado, tela que não reage) e
// applyQuestion no snapshot. Tudo com dados sintéticos.
import { describe, expect, it } from 'vitest';
import type { AgentInfo, AskQuestion } from '../../shared/types';
import { setQuiet } from '../log';
import { AnswerError } from './ask';
import { FakeAskTui } from './fake-tui';
import { applyQuestion, QuestionService, WAITING_FOR_QUESTION } from './service';

setQuiet(true);

const QS: AskQuestion[] = [
  { question: 'Qual banco?', header: 'Banco', multiSelect: false, options: [{ label: 'Postgres' }, { label: 'SQLite' }] },
  { question: 'Quais recursos?', header: 'Recursos', multiSelect: true, options: [{ label: 'Cache' }, { label: 'Fila' }] },
];
const useLine = (id: string) => JSON.stringify({ message: { content: [{ type: 'tool_use', id, name: 'AskUserQuestion', input: { questions: QS } }] } });
const resultLine = (id: string) => JSON.stringify({ message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });

function setup(opts: { status?: AgentInfo['status']; tmux?: boolean; tui?: FakeAskTui | null } = {}) {
  const agent = { id: 'a1', kind: 'main', engine: 'claude', status: opts.status ?? 'waiting' } as unknown as AgentInfo;
  const lines: string[] = [];
  let mtime = 1;
  let dirty = 0;
  const tui = opts.tui === undefined ? new FakeAskTui(QS) : opts.tui;
  const sent: string[] = [];
  const svc = new QuestionService({
    office: { list: () => [agent], markDirty: () => void dirty++ },
    transcriptPathOf: () => '/t.jsonl',
    readLines: () => lines,
    stat: () => ({ mtimeMs: mtime, size: lines.length }),
    sleep: async () => {},
    stepPauseMs: 0,
    confirmMs: 0,
    input:
      opts.tmux === false
        ? { screen: async () => undefined, driveKeys: async () => {}, typeText: async () => {} }
        : {
            screen: async () => (tui ? tui.screen() : 'prompt normal'),
            driveKeys: async (_id, keys) => {
              sent.push(...keys);
              for (const k of keys) tui?.key(k);
              if (tui?.closed && tui.result) lines.push(resultLine('t1'));
            },
            typeText: async (_id, t) => {
              sent.push(`text:${t}`);
              tui?.type(t);
            },
          },
  });
  const write = (l: string) => {
    lines.push(l);
    mtime++;
  };
  return { agent, svc, write, tui, sent, dirty: () => dirty };
}

describe('QuestionService', () => {
  it('acha a pergunta de agente esperando e a solta quando respondida', () => {
    const s = setup();
    s.write(useLine('t1'));
    s.svc.poll();
    expect(s.svc.pendingOf('a1')?.toolUseId).toBe('t1');
    expect(s.dirty()).toBe(1);
    s.write(resultLine('t1'));
    s.svc.poll();
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });

  it('não lê transcript de agente trabalhando sem pergunta', () => {
    const s = setup({ status: 'working' });
    s.write(useLine('t1'));
    s.svc.poll();
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });

  it('agente que saiu perde a pergunta', () => {
    const s = setup();
    s.write(useLine('t1'));
    s.svc.poll();
    s.agent.status = 'offline';
    s.svc.poll();
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });

  it('responde dirigindo o diálogo e confirma pelo tool_result', async () => {
    const s = setup();
    s.write(useLine('t1'));
    s.svc.poll();
    const r = await s.svc.answer('a1', { toolUseId: 't1', answers: [{ selected: [1] }, { selected: [0], other: 'Busca' }] });
    expect(r).toEqual({ answered: true });
    expect(s.tui?.result).toEqual({ 'Qual banco?': 'SQLite', 'Quais recursos?': 'Cache, Busca' });
    expect(s.sent).not.toContain('Escape');
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });

  it('pergunta já respondida ou id diferente: 404', async () => {
    const s = setup();
    await expect(s.svc.answer('a1', { answers: [] })).rejects.toMatchObject({ status: 404 });
    s.write(useLine('t1'));
    await expect(s.svc.answer('a1', { toolUseId: 'outro', answers: [{ selected: [0] }, { selected: [0] }] })).rejects.toMatchObject({ status: 404 });
  });

  it('resposta inválida: 400 sem apertar nada', async () => {
    const s = setup();
    s.write(useLine('t1'));
    await expect(s.svc.answer('a1', { toolUseId: 't1', answers: [{ selected: [0] }] })).rejects.toBeInstanceOf(AnswerError);
    expect(s.sent).toEqual([]);
  });

  it('fora do tmux: 409', async () => {
    const s = setup({ tmux: false });
    s.write(useLine('t1'));
    await expect(s.svc.answer('a1', { toolUseId: 't1', answers: [{ selected: [0] }, { selected: [0] }] })).rejects.toMatchObject({ status: 409 });
  });

  it('diálogo não está aberto na tela: 409 sem apertar nada', async () => {
    const s = setup({ tui: null });
    s.write(useLine('t1'));
    await expect(s.svc.answer('a1', { toolUseId: 't1', answers: [{ selected: [0] }, { selected: [0] }] })).rejects.toMatchObject({ status: 409 });
    expect(s.sent).toEqual([]);
  });

  it('tela que não reage às teclas: desiste', async () => {
    const tui = new FakeAskTui(QS);
    tui.key = () => {}; // TUI travado
    const s = setup({ tui });
    s.write(useLine('t1'));
    await expect(s.svc.answer('a1', { toolUseId: 't1', answers: [{ selected: [1] }, { selected: [0] }] })).rejects.toMatchObject({ status: 409 });
  });
});

describe('applyQuestion', () => {
  const info = { toolUseId: 't1', questions: QS, createdAt: 0 };
  it('põe a pergunta e o motivo da espera', () => {
    const a = applyQuestion({ status: 'waiting' } as AgentInfo, info);
    expect(a.question).toBe(info);
    expect(a.waitingFor).toBe(WAITING_FOR_QUESTION);
  });
  it('não mexe em agente que saiu', () => {
    expect(applyQuestion({ status: 'offline' } as AgentInfo, info).question).toBeUndefined();
  });
});
