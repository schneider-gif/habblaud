import { describe, expect, it } from 'vitest';
import type { OfficeSnapshot } from '../../shared/types';
import { detect, emptyFacts, inside, turnEnds, type Facts } from './detect';

const DIR = '/h/projetos/meu-site';
const snap = (agents: { id: string; status: string; room: string; kind?: string }[]) =>
  ({
    rooms: [...new Set(agents.map((a) => a.room))].map((r) => ({ id: `room:${r}`, path: r, name: r })),
    agents: agents.map((a) => ({ id: a.id, kind: a.kind ?? 'main', status: a.status, roomId: `room:${a.room}` })),
  }) as unknown as OfficeSnapshot;

const facts = (over: Partial<Facts>): Facts => ({ ...emptyFacts(DIR, 100), ...over });

describe('inside', () => {
  it('a própria pasta e as de dentro; nunca uma irmã com o mesmo prefixo', () => {
    expect(inside(DIR, DIR)).toBe(true);
    expect(inside(`${DIR}/src`, DIR)).toBe(true);
    expect(inside(`${DIR}-2`, DIR)).toBe(false);
    expect(inside('/h/projetos', DIR)).toBe(false);
    expect(inside('C:\\h\\projetos\\meu-site\\src', 'C:\\h\\projetos\\meu-site')).toBe(true);
  });
});

describe('turnEnds', () => {
  it('working → idle/shell/done de um principal é fim de turno, com a pasta da sala', () => {
    const prev = new Map([['a', 'working'], ['b', 'working'], ['c', 'working'], ['s', 'working']] as const);
    const r = turnEnds(prev, snap([
      { id: 'a', status: 'idle', room: DIR },
      { id: 'b', status: 'shell', room: '/x' },
      { id: 'c', status: 'waiting', room: DIR },
      { id: 's', status: 'idle', room: DIR, kind: 'sub' },
    ]), 7);
    expect(r.ends).toEqual([{ agentId: 'a', dir: DIR, at: 7 }, { agentId: 'b', dir: '/x', at: 7 }]);
    expect(r.next.get('c')).toBe('waiting');
    expect(r.next.has('s')).toBe(false);
  });
  it('primeiro snapshot não inventa fim de turno; agentes do demo nunca contam', () => {
    expect(turnEnds(new Map(), snap([{ id: 'a', status: 'idle', room: DIR }]), 1).ends).toEqual([]);
    const prev = new Map([['demo:1', 'working']] as const);
    expect(turnEnds(prev, snap([{ id: 'demo:1', status: 'idle', room: DIR }]), 1).ends).toEqual([]);
  });
});

describe('Missão 1: Seu primeiro site', () => {
  it('pasta + turno na pasta depois do começo + index.html', () => {
    const d = detect('primeiro-site', facts({ exists: true, index: true, turns: [{ agentId: 'a', dir: `${DIR}/src`, at: 150 }] }));
    expect(d.done).toBe(true);
    expect(d.steps.every((s) => s.ok)).toBe(true);
  });
  it('sem index.html, turno antes do começo ou em outra pasta: não conclui', () => {
    expect(detect('primeiro-site', facts({ exists: true, index: false, turns: [{ agentId: 'a', dir: DIR, at: 150 }] })).done).toBe(false);
    expect(detect('primeiro-site', facts({ exists: true, index: true, turns: [{ agentId: 'a', dir: DIR, at: 50 }] })).done).toBe(false);
    expect(detect('primeiro-site', facts({ exists: true, index: true, turns: [{ agentId: 'a', dir: `${DIR}-2`, at: 150 }] })).done).toBe(false);
  });
  it('passos dizem o que falta', () => {
    const d = detect('primeiro-site', facts({ exists: true }));
    expect(d.steps.map((s) => s.ok)).toEqual([true, false, false]);
  });
});

describe('Missão 2: Peça uma melhoria', () => {
  it('mensagem pelo escritório a um agente da pasta e o MESMO agente termina o turno depois', () => {
    const msg = { agentId: 'a', dir: DIR, at: 200 };
    expect(detect('peca-melhoria', facts({ messages: [msg], turns: [{ agentId: 'a', dir: DIR, at: 300 }] })).done).toBe(true);
    expect(detect('peca-melhoria', facts({ messages: [msg], turns: [{ agentId: 'b', dir: DIR, at: 300 }] })).done).toBe(false);
    expect(detect('peca-melhoria', facts({ messages: [msg], turns: [{ agentId: 'a', dir: DIR, at: 150 }] })).done).toBe(false);
  });
  it('mensagem antes do começo ou para outra pasta não conta', () => {
    expect(detect('peca-melhoria', facts({ messages: [{ agentId: 'a', dir: DIR, at: 50 }], turns: [{ agentId: 'a', dir: DIR, at: 300 }] })).done).toBe(false);
    expect(detect('peca-melhoria', facts({ messages: [{ agentId: 'a', dir: '/x', at: 200 }], turns: [{ agentId: 'a', dir: '/x', at: 300 }] })).done).toBe(false);
  });
});

describe('Missão 3: Um jogo em pixel art', () => {
  it('precisa de canvas e de um turno na pasta', () => {
    const turns = [{ agentId: 'a', dir: DIR, at: 150 }];
    expect(detect('jogo-pixel', facts({ exists: true, index: true, canvas: true, turns })).done).toBe(true);
    expect(detect('jogo-pixel', facts({ exists: true, index: true, canvas: false, turns })).done).toBe(false);
  });
});

describe('Missão 4: Leve para o GitHub', () => {
  it('remoto do GitHub e push feito', () => {
    expect(detect('leve-github', facts({ github: { remote: true, pushed: true, project: 'meu-site' } })).done).toBe(true);
    expect(detect('leve-github', facts({ github: { remote: true, pushed: false } })).done).toBe(false);
    expect(detect('leve-github', facts({})).done).toBe(false);
  });
});

describe('Missão 5: Uma API com banco', () => {
  it('servidor com rotas + banco + turno; porta escutando é só informação', () => {
    const turns = [{ agentId: 'a', dir: DIR, at: 150 }];
    expect(detect('api-banco', facts({ exists: true, api: true, db: true, turns })).done).toBe(true);
    expect(detect('api-banco', facts({ exists: true, api: true, db: false, turns })).done).toBe(false);
    const d = detect('api-banco', facts({ exists: true, api: true, db: true, turns, ports: [41873] }));
    expect(d.info).toBe('Servidor no ar na porta 41873.');
  });
});
