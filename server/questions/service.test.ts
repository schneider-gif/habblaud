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
    const none = setup({ tui: null }); // nem no transcript nem na tela
    await expect(none.svc.answer('a1', { answers: [] })).rejects.toMatchObject({ status: 404 });
    const s = setup();
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

describe('QuestionService: apagar texto longo do "Outro"', () => {
  it('manda os Backspace em lotes de até 40', async () => {
    const tui = new FakeAskTui(QS);
    const s = setup({ tui });
    // Texto antigo de 90 letras já no campo do "Outro" da pergunta 1.
    tui.other[0] = 'x'.repeat(90);
    s.write(useLine('t1'));
    const batches: number[] = [];
    const svc = s.svc as unknown as { opts: { input: { driveKeys: (id: string, k: readonly string[]) => Promise<void> } } };
    const orig = svc.opts.input.driveKeys;
    svc.opts.input.driveKeys = async (id, k) => {
      if (k[0] === 'BSpace') batches.push(k.length);
      return orig(id, k);
    };
    await s.svc.answer('a1', { toolUseId: 't1', answers: [{ selected: [], other: 'novo' }, { selected: [0] }] });
    expect(batches).toEqual([40, 40, 10]);
    expect(tui.result).toEqual({ 'Qual banco?': 'novo', 'Quais recursos?': 'Cache' });
  });
});

describe('QuestionService: pergunta lida da tela (Claude Code real não grava o tool_use antes da resposta)', () => {
  function screenOnly(tui: FakeAskTui) {
    const agent = { id: 'a1', kind: 'main', engine: 'claude', status: 'waiting' } as unknown as AgentInfo;
    const keys: string[] = [];
    const svc = new QuestionService({
      office: { list: () => [agent], markDirty: () => {} },
      transcriptPathOf: () => '/t.jsonl',
      readLines: () => [], // transcript sem o tool_use
      stat: () => ({ mtimeMs: 1, size: 0 }),
      sleep: async () => {},
      stepPauseMs: 0,
      confirmMs: 0,
      input: {
        screen: async () => tui.screen(),
        driveKeys: async (_id, k) => {
          keys.push(...k);
          for (const x of k) tui.key(x);
        },
        typeText: async (_id, t) => tui.type(t),
      },
    });
    return { svc, keys, agent };
  }

  it('pergunta única: aparece pela tela e a resposta chega', async () => {
    const tui = new FakeAskTui([{ question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: 'calma' }, { label: 'Verde' }] }]);
    const s = screenOnly(tui);
    s.svc.poll();
    expect(s.svc.pendingOf('a1')).toBeUndefined();
    await s.svc.pollScreens();
    const q = s.svc.pendingOf('a1')!;
    expect(q.toolUseId).toMatch(/^screen:/);
    expect(q.fromScreen).toEqual({ tabs: 1 });
    expect(q.questions).toEqual([{ question: 'Qual cor você prefere?', header: 'Cor', multiSelect: false, options: [{ label: 'Azul', description: 'calma' }, { label: 'Verde' }] }]);
    expect(await s.svc.answer('a1', { toolUseId: q.toolUseId, answers: [{ selected: [1] }] })).toEqual({ answered: true });
    expect(tui.result).toEqual({ 'Qual cor você prefere?': 'Verde' });
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });

  it('várias abas: uma pergunta por vez até a revisão e o envio', async () => {
    const tui = new FakeAskTui(QS);
    const s = screenOnly(tui);
    await s.svc.pollScreens();
    const q1 = s.svc.pendingOf('a1')!;
    expect(q1.fromScreen).toEqual({ tabs: 2 });
    expect(q1.questions[0].question).toBe('Qual banco?');
    await s.svc.answer('a1', { toolUseId: q1.toolUseId, answers: [{ selected: [1] }] });
    const q2 = s.svc.pendingOf('a1')!;
    expect(q2.questions[0]).toMatchObject({ question: 'Quais recursos?', multiSelect: true });
    expect(q2.toolUseId).not.toBe(q1.toolUseId);
    await s.svc.answer('a1', { toolUseId: q2.toolUseId, answers: [{ selected: [0, 1] }] });
    expect(tui.result).toEqual({ 'Qual banco?': 'SQLite', 'Quais recursos?': 'Cache, Fila' });
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });

  it('tela sem diálogo: nada (e some quando o diálogo fecha no terminal)', async () => {
    const tui = new FakeAskTui([{ question: 'Qual?', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }]);
    const s = screenOnly(tui);
    await s.svc.pollScreens();
    expect(s.svc.pendingOf('a1')).toBeDefined();
    tui.key('Enter'); // respondida no próprio terminal
    await s.svc.pollScreens();
    expect(s.svc.pendingOf('a1')).toBeUndefined();
  });
});
