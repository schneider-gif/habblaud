// Núcleo do hb-msg (mod/habblaud/mensagens/caixa.mjs): caixas, trava, anti-loop, identidade, destinatário, aviso.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acharMensagem,
  agentesDoSnapshot,
  ancestrais,
  comTrava,
  enviarMensagem,
  ErroMsg,
  LIMITES,
  lerCaixa,
  listarPasta,
  mover,
  naoLidas,
  paneDoEnviron,
  pendentes,
  ppidDoStat,
  quemSouEu,
  registrarNoPar,
  resolverDestino,
  textoDoAviso,
  validarTexto,
  type Agente,
} from '../../mod/habblaud/mensagens/caixa.mjs';

const CLI = resolve(__dirname, '../../mod/habblaud/mensagens/hb-msg.mjs');
const A = { sid: 'aaaaaaaa-1111-4111-8111-111111111111', nome: 'Flávia', engine: 'claude' as const };
const B = { sid: 'bbbbbbbb-2222-4222-8222-222222222222', nome: 'Bruno', engine: 'codex' as const };
const C = { sid: 'cccccccc-3333-4333-8333-333333333333', nome: 'Caio', engine: 'claude' as const };

let raiz: string;
beforeEach(() => {
  raiz = mkdtempSync(join(tmpdir(), 'hbmsg-'));
});
afterEach(() => rmSync(raiz, { recursive: true, force: true }));

function erro(fn: () => unknown): ErroMsg {
  try {
    fn();
  } catch (err) {
    if (err instanceof ErroMsg) return err;
    throw err;
  }
  throw new Error('esperava ErroMsg');
}

describe('validarTexto', () => {
  it('apara, normaliza CRLF e aceita \\n e \\t', () => {
    expect(validarTexto('  oi\r\ntudo\tbem  ')).toBe('oi\ntudo\tbem');
  });
  it('recusa vazio, controle e acima de 8 KB (em bytes: acento conta 2)', () => {
    expect(erro(() => validarTexto('   ')).message).toMatch(/vazia/);
    expect(erro(() => validarTexto('a\u0007b')).message).toMatch(/controle/);
    expect(validarTexto('x'.repeat(LIMITES.maxBytes))).toHaveLength(LIMITES.maxBytes);
    expect(erro(() => validarTexto('é'.repeat(LIMITES.maxBytes / 2 + 1))).message).toMatch(/longa demais/);
  });
});

describe('caixas', () => {
  it('enviar grava em novas/ do destinatário (um arquivo por mensagem, sem sobra em tmp/)', () => {
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'pode revisar o PR 12?' }, { now: 1_000_000 });
    expect(m).toMatchObject({ de: A, para: B, texto: 'pode revisar o PR 12?', ts: 1_000_000 });
    expect(m.id).toMatch(/^m-[a-z0-9]+-[a-z0-9]+$/);
    expect(readdirSync(join(raiz, B.sid, 'novas'))).toEqual([`${m.id}.json`]);
    expect(readdirSync(join(raiz, B.sid, 'tmp'))).toEqual([]);
    expect(naoLidas(raiz, B.sid)).toBe(1);
    expect(naoLidas(raiz, A.sid)).toBe(0);
  });

  it('ninguém manda para si mesmo; sessionId estranho não vira caminho', () => {
    expect(erro(() => enviarMensagem(raiz, { de: A, para: A, texto: 'oi' })).codigo).toBe(2);
    expect(() => enviarMensagem(raiz, { de: A, para: { sid: '../x', nome: 'x', engine: 'claude' }, texto: 'oi' })).toThrow(/inválido/);
  });

  it('ler devolve só a própria caixa, marca como lidas e a segunda leitura vem vazia', () => {
    enviarMensagem(raiz, { de: A, para: B, texto: 'um' }, { now: 1000 });
    enviarMensagem(raiz, { de: C, para: B, texto: 'dois' }, { now: 2000 });
    enviarMensagem(raiz, { de: B, para: A, texto: 'para a A' }, { now: 3000 });
    const lidas = lerCaixa(raiz, B.sid, { now: 4000 });
    expect(lidas.map((m) => m.texto)).toEqual(['um', 'dois']);
    expect(lerCaixa(raiz, B.sid)).toEqual([]);
    expect(listarPasta(raiz, B.sid, 'lidas')).toHaveLength(2);
    expect(naoLidas(raiz, A.sid)).toBe(1);
  });

  it('ler também pega as avisadas (aviso com texto longo) e apaga lidas com mais de 7 dias', () => {
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'longa' });
    expect(mover(raiz, B.sid, m.id, 'novas', 'avisadas')).toBe(true);
    expect(mover(raiz, B.sid, m.id, 'novas', 'avisadas')).toBe(false); // o rename é a posse: só um consegue
    expect(lerCaixa(raiz, B.sid).map((x) => x.id)).toEqual([m.id]);
    const velho = join(raiz, B.sid, 'lidas', `${m.id}.json`);
    const t = (Date.now() - 8 * 24 * 3_600_000) / 1000;
    utimesSync(velho, t, t);
    lerCaixa(raiz, B.sid);
    expect(existsSync(velho)).toBe(false);
  });

  it('acharMensagem: id exato ou começo único, só na própria caixa', () => {
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'oi' });
    expect(acharMensagem(raiz, B.sid, m.id).texto).toBe('oi');
    expect(acharMensagem(raiz, B.sid, m.id.slice(0, -2)).id).toBe(m.id);
    expect(erro(() => acharMensagem(raiz, A.sid, m.id)).message).toMatch(/não achei/);
    expect(erro(() => acharMensagem(raiz, B.sid, 'rm -rf')).message).toMatch(/inválido/);
  });

  it('pendentes: caixas com novas, ignora pastas internas', () => {
    enviarMensagem(raiz, { de: A, para: B, texto: '1' });
    enviarMensagem(raiz, { de: A, para: C, texto: '2' });
    lerCaixa(raiz, C.sid);
    const p = pendentes(raiz);
    expect([...p.keys()]).toEqual([B.sid]);
    expect(p.get(B.sid)![0].texto).toBe('1');
  });
});

describe('anti-loop', () => {
  it(`no máximo ${LIMITES.porMinuto}/min entre o par, contando os dois sentidos; libera depois do minuto`, () => {
    const t0 = 10_000_000;
    for (let i = 0; i < LIMITES.porMinuto; i++) {
      const [de, para] = i % 2 ? [B, A] : [A, B];
      enviarMensagem(raiz, { de, para, texto: `msg ${i}` }, { now: t0 + i * 1000 });
    }
    const e = erro(() => enviarMensagem(raiz, { de: B, para: A, texto: 'de novo' }, { now: t0 + 10_000 }));
    expect(e.codigo).toBe(3);
    expect(e.message).toMatch(/anti-loop.*Espere ~50 s/);
    // outro par não é afetado
    expect(() => enviarMensagem(raiz, { de: A, para: C, texto: 'oi' }, { now: t0 + 10_000 })).not.toThrow();
    // passado o minuto, volta
    expect(() => enviarMensagem(raiz, { de: B, para: A, texto: 'depois' }, { now: t0 + 61_000 })).not.toThrow();
  });

  it(`e no máximo ${LIMITES.porHora}/h`, () => {
    const lim = { ...LIMITES, porMinuto: 1000 };
    for (let i = 0; i < lim.porHora; i++) expect(registrarNoPar(raiz, A.sid, B.sid, { now: 1e9 + i * 100_000, limites: lim }).ok).toBe(true);
    const r = registrarNoPar(raiz, B.sid, A.sid, { now: 1e9 + lim.porHora * 100_000, limites: lim });
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.motivo).toMatch(/por hora/);
  });

  it('a trava (mkdir) exclui: fn não roda com a trava de outro e trava esquecida vence', () => {
    const trava = join(raiz, 't.trava');
    mkdirSync(trava);
    expect(() => comTrava(trava, () => 1, { timeoutMs: 100 })).toThrow(/ocupada/);
    const t = (Date.now() - 60_000) / 1000;
    utimesSync(trava, t, t);
    expect(comTrava(trava, () => 42)).toBe(42);
    expect(existsSync(trava)).toBe(false);
  });

  it('envios simultâneos de processos diferentes não passam do limite (trava de verdade)', async () => {
    const mod = resolve(__dirname, '../../mod/habblaud/mensagens/caixa.mjs').replace(/\\/g, '/');
    const script = `import { registrarNoPar } from 'file://${mod.startsWith('/') ? '' : '/'}${mod}';
      const r = registrarNoPar(process.argv[1], '${A.sid}', '${B.sid}'); process.stdout.write(r.ok ? 'ok' : 'no');`;
    const runs = Array.from({ length: 12 }, () =>
      new Promise<string>((ok) => {
        const p = spawn(process.execPath, ['--input-type=module', '-e', script, raiz]);
        let out = '';
        p.stdout.on('data', (d) => (out += d));
        p.on('close', () => ok(out));
      }),
    );
    const outs = await Promise.all(runs);
    expect(outs.filter((o) => o === 'ok')).toHaveLength(LIMITES.porMinuto);
    expect(outs.filter((o) => o === 'no')).toHaveLength(12 - LIMITES.porMinuto);
    expect(JSON.parse(readFileSync(join(raiz, '.pares', `${[A.sid, B.sid].sort().join('__')}.json`), 'utf8'))).toHaveLength(LIMITES.porMinuto);
  });
});

const snap = {
  rooms: [
    { id: 'r1', name: 'loja', path: '/home/ubuntu/projetos/loja' },
    { id: 'r2', name: 'api', path: '/home/ubuntu/projetos/api' },
  ],
  agents: [
    { id: '.claude:101', kind: 'main', name: 'Flávia', sessionId: A.sid, status: 'idle', roomId: 'r1', statusSince: 1 },
    { id: '.codex:202', kind: 'main', name: 'Bruno', sessionId: B.sid, status: 'working', roomId: 'r2', engine: 'codex', statusSince: 1 },
    { id: `${A.sid}:sub1`, kind: 'sub', name: 'Ajudante', sessionId: A.sid, status: 'working', roomId: 'r1' },
    { id: '.claude:303', kind: 'main', name: 'Caio', sessionId: C.sid, status: 'offline', roomId: 'r1' },
    { id: 'demo:1', kind: 'main', name: 'Demo', sessionId: 'dddddddd-0000', status: 'idle', roomId: 'r1' },
    { id: '.claude:404', kind: 'main', name: 'Bruna', sessionId: 'eeeeeeee-4444-4444-8444-444444444444', status: 'waiting', roomId: 'r2' },
  ],
};

describe('agentes e identidade', () => {
  const ags = agentesDoSnapshot(snap);

  it('snapshot -> só principais reais e presentes, com engine, pasta, pid e id curto', () => {
    expect(ags.map((a) => a.nome)).toEqual(['Flávia', 'Bruno', 'Bruna']);
    expect(ags[1]).toMatchObject({ id: '.codex:202', engine: 'codex', pid: 202, curto: 'bbbbbbbb', pasta: '/home/ubuntu/projetos/api', status: 'working' });
  });

  it('ppid do /proc/<pid>/stat mesmo com espaços e parênteses no comm; cadeia de pais', () => {
    expect(ppidDoStat('123 (node (x) y) S 77 123 123 0')).toBe(77);
    const stats: Record<number, string> = { 900: '900 (node) S 800 0', 800: '800 (bash) S 202 0', 202: '202 (codex) S 1 0' };
    expect(ancestrais(900, (p) => stats[p])).toEqual([900, 800, 202]);
  });

  it('quem sou eu: pelo processo pai, depois TMUX_PANE, e HB_MSG_EU tem precedência', () => {
    expect(quemSouEu(ags, { env: {}, pids: [900, 800, 202] })?.nome).toBe('Bruno');
    expect(quemSouEu(ags, { env: {}, pids: [900] })).toBeUndefined();
    const panes: Record<number, string> = { 101: '%3', 202: '%5' };
    expect(quemSouEu(ags, { env: { TMUX_PANE: '%5' }, pids: [900], paneDe: (p) => panes[p] })?.nome).toBe('Bruno');
    expect(quemSouEu(ags, { env: { HB_MSG_EU: A.sid }, pids: [202] })?.nome).toBe('Flávia');
    expect(paneDoEnviron('A=1\0TMUX=/tmp/s,1,0\0TMUX_PANE=%7\0')).toBe('%7');
  });

  it('destinatário: nome sem acento/maiúsculas, id curto, começo único; ambíguo e eu mesmo dão erro', () => {
    const eu = ags[0] as Agente;
    expect(resolverDestino(ags, 'bruno', eu).id).toBe('.codex:202');
    expect(resolverDestino(ags, 'BRUNA', eu).id).toBe('.claude:404');
    expect(resolverDestino(ags, 'eeee', eu).nome).toBe('Bruna');
    expect(erro(() => resolverDestino(ags, 'Br', eu)).message).toMatch(/ambíguo/);
    expect(erro(() => resolverDestino(ags, 'flavia', eu)).message).toMatch(/você mesmo/);
    expect(erro(() => resolverDestino(ags, 'Zé', eu)).message).toMatch(/não achei/);
    expect(resolverDestino(ags, 'flavia', ags[1]).nome).toBe('Flávia');
  });
});

describe('aviso digitado no agente', () => {
  it('mensagem curta vai inteira, com o comando para responder', () => {
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'Rodei os testes: 3 falham em auth.' });
    const av = textoDoAviso([m]);
    expect(av.texto).toContain(`📨 Mensagem de Flávia (claude · aaaaaaaa) [${m.id}]:\nRodei os testes: 3 falham em auth.`);
    expect(av.texto).toContain(`hb-msg responder ${m.id} "sua resposta"`);
    expect(av.inteiras).toEqual([m.id]);
  });

  it('resposta, texto longo (fica para o ler) e mais de 3 mensagens; nunca passa do limite do tmux (8000)', () => {
    const r = enviarMensagem(raiz, { de: B, para: A, texto: 'feito', respondeA: 'm-abc-1' });
    expect(textoDoAviso([r]).texto).toMatch(/Resposta de Bruno \(codex · bbbbbbbb\) à sua mensagem m-abc-1/);
    const longas = [A, C, A, C, A].map((de, i) => enviarMensagem(raiz, { de, para: B, texto: 'z'.repeat(i === 0 ? 3000 : LIMITES.inline) }, { now: 1e12 + i * 1e6 }));
    const av = textoDoAviso(longas);
    expect(av.incluidas).toHaveLength(3);
    expect(av.inteiras).toEqual([longas[1].id, longas[2].id]);
    expect(av.texto).toMatch(/texto longo, 3000 caracteres: leia com hb-msg ler/);
    expect(av.texto).toMatch(/e mais 2 mensagem/);
    expect(av.texto.length).toBeLessThan(8000);
  });
});

describe('CLI hb-msg (processo de verdade)', () => {
  const run = (args: string[], env: Record<string, string> = {}) =>
    spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: raiz, HB_MSG_DIR: raiz, HABBLAUD_PORT: '1', ...env }, timeout: 15_000 });

  it('ajuda e comando desconhecido', () => {
    expect(run([]).stdout).toMatch(/hb-msg quem/);
    const r = run(['xyz']);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/comando desconhecido/);
  });

  it('sem Habblaude e fora de um agente: quem avisa; enviar sai com código 2', () => {
    expect(run(['quem']).stdout).toMatch(/Habblaude fora do ar/);
    const r = run(['enviar', 'Bruno', 'oi']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/não achei você|não descobri/);
  });

  it('ler e responder com HB_MSG_EU (identidade forçada para teste)', () => {
    const m = enviarMensagem(raiz, { de: A, para: B, texto: 'pergunta' });
    const r1 = run(['ler'], { HB_MSG_EU: B.sid });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain(`[${m.id}]`);
    expect(r1.stdout).toContain('pergunta');
    expect(run(['ler', '--esperar', '1'], { HB_MSG_EU: B.sid }).stdout).toMatch(/Nenhuma mensagem em 1 s/);
    const r2 = run(['responder', m.id, 'resposta', 'aqui'], { HB_MSG_EU: B.sid });
    expect(r2.status, r2.stderr).toBe(0);
    expect(r2.stdout).toMatch(/Resposta m-.* \(a m-/);
    const volta = listarPasta(raiz, A.sid, 'novas');
    expect(volta).toHaveLength(1);
    expect(volta[0]).toMatchObject({ texto: 'resposta aqui', respondeA: m.id, para: { sid: A.sid } });
  });
});
