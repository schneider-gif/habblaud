// Núcleo das mensagens entre agentes do mesmo escritório (hb-msg). Node puro (só node:*), sem build: usado pela CLI
// (hb-msg.mjs, roda dentro do agente) e pelo servidor do Habblaud (server/mensagens/carteiro.ts, que avisa o
// destinatário quando ele fica livre).
//
// Caixas: <raiz>/<sessionId>/{novas,avisadas,lidas}/<id>.json, um arquivo por mensagem (estilo maildir). Gravar é
// tmp + rename e mudar de estado é rename: atômico, sem trava e sem arquivo corrompido com vários agentes gravando
// juntos. novas = ainda sem aviso; avisadas = aviso digitado, mas o texto não coube nele; lidas = lida por
// `hb-msg ler` ou entregue inteira no aviso. A única trava (mkdir atômico, o flock sem dependência) protege o
// contador anti-loop de cada par.
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const LIMITES = Object.freeze({
  /** Maior mensagem aceita (bytes UTF-8). */
  maxBytes: 8192,
  /** Mensagens trocadas por um par (nos dois sentidos) por minuto e por hora: anti-loop. */
  porMinuto: 5,
  porHora: 30,
  /** Texto até este tamanho vai inteiro no aviso digitado no agente; maior fica para `hb-msg ler`. */
  inline: 1500,
  /** Mensagens por aviso (o resto: "e mais N"). */
  porAviso: 3,
  /** Mensagens lidas ficam guardadas por 7 dias (para `responder`). */
  guardarLidasMs: 7 * 24 * 3_600_000,
});

export const PASTAS = Object.freeze(['novas', 'avisadas', 'lidas']);

export class ErroMsg extends Error {
  /** @param {string} message @param {number} codigo código de saída da CLI */
  constructor(message, codigo = 1) {
    super(message);
    this.codigo = codigo;
  }
}

/** Raiz das caixas: HB_MSG_DIR ou ~/.habblaud/mensagens. */
export function raizPadrao(home, env = process.env) {
  const d = env.HB_MSG_DIR?.trim();
  return d || join(home, '.habblaud', 'mensagens');
}

const ID_SEGURO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** sessionId vira nome de pasta: só caracteres seguros (UUIDs do Claude e do Codex passam). */
export function idSeguro(id) {
  if (typeof id !== 'string' || !ID_SEGURO.test(id) || id.includes('..')) throw new ErroMsg(`id de sessão inválido: ${String(id)}`);
  return id;
}

export function novoIdMensagem(now = Date.now(), rnd = Math.random) {
  const r = Math.floor(rnd() * 0xffffff).toString(36).padStart(5, '0');
  return `m-${now.toString(36)}-${r}`;
}

/** Texto aceito: não vazio, até maxBytes, sem caracteres de controle além de \n e \t. */
export function validarTexto(texto, maxBytes = LIMITES.maxBytes) {
  if (typeof texto !== 'string') throw new ErroMsg('faltou o texto da mensagem');
  const t = texto.replace(/\r\n?/g, '\n').trim();
  if (!t) throw new ErroMsg('mensagem vazia');
  const bytes = Buffer.byteLength(t, 'utf8');
  if (bytes > maxBytes) throw new ErroMsg(`mensagem longa demais (${bytes} bytes; máx. ${maxBytes}): resuma ou aponte um arquivo`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(t)) throw new ErroMsg('a mensagem tem caracteres de controle');
  return t;
}

function dorme(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Trava por mkdir atômico (o equivalente ao flock sem dependência): roda fn com a trava e solta no fim. Trava
 * esquecida (processo morto no meio) vence em staleMs.
 */
export function comTrava(caminho, fn, { staleMs = 10_000, timeoutMs = 5_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    try {
      mkdirSync(caminho, { mode: 0o700 });
      break;
    } catch (err) {
      if (err?.code !== 'EEXIST') throw err;
      try {
        if (Date.now() - statSync(caminho).mtimeMs > staleMs) {
          rmSync(caminho, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue; // sumiu entre o mkdir e o stat
      }
      if (Date.now() - t0 > timeoutMs) throw new ErroMsg('caixa ocupada demais: tente de novo em instantes');
      dorme(20);
    }
  }
  try {
    return fn();
  } finally {
    rmSync(caminho, { recursive: true, force: true });
  }
}

function garantePasta(p) {
  mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

export function pastaDaCaixa(raiz, sid, pasta) {
  return join(raiz, idSeguro(sid), pasta);
}

/** Chave do par (ordem não importa). */
export function chaveDoPar(a, b) {
  return [idSeguro(a), idSeguro(b)].sort().join('__');
}

/**
 * Anti-loop: registra uma mensagem entre a e b se o par ainda está dentro dos limites (porMinuto e porHora,
 * contando os dois sentidos). Devolve {ok:true} ou {ok:false, motivo, esperarS}. Sob trava: dois envios ao mesmo
 * tempo não passam juntos do limite.
 */
export function registrarNoPar(raiz, a, b, { now = Date.now(), limites = LIMITES } = {}) {
  const dir = garantePasta(join(raiz, '.pares'));
  const chave = chaveDoPar(a, b);
  const arq = join(dir, `${chave}.json`);
  return comTrava(join(dir, `${chave}.trava`), () => {
    let hist = [];
    try {
      const j = JSON.parse(readFileSync(arq, 'utf8'));
      if (Array.isArray(j)) hist = j.filter((t) => typeof t === 'number');
    } catch {
      // primeiro contato do par
    }
    hist = hist.filter((t) => now - t < 3_600_000 && t <= now + 60_000).sort((x, y) => x - y);
    const ultimoMinuto = hist.filter((t) => now - t < 60_000);
    if (ultimoMinuto.length >= limites.porMinuto) {
      const esperarS = Math.max(1, Math.ceil((ultimoMinuto[0] + 60_000 - now) / 1000));
      return { ok: false, motivo: `limite anti-loop: ${limites.porMinuto} mensagens por minuto entre vocês dois`, esperarS };
    }
    if (hist.length >= limites.porHora) {
      const esperarS = Math.max(1, Math.ceil((hist[0] + 3_600_000 - now) / 1000));
      return { ok: false, motivo: `limite anti-loop: ${limites.porHora} mensagens por hora entre vocês dois`, esperarS };
    }
    hist.push(now);
    const tmp = `${arq}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(hist), { mode: 0o600 });
    renameSync(tmp, arq);
    return { ok: true };
  });
}

/**
 * Grava uma mensagem na caixa do destinatário (novas/). `de` e `para`: {sid, nome, engine}. Confere tamanho e
 * anti-loop; devolve a mensagem gravada.
 */
export function enviarMensagem(raiz, { de, para, texto, respondeA }, { now = Date.now(), limites = LIMITES, rnd } = {}) {
  idSeguro(de?.sid);
  idSeguro(para?.sid);
  if (de.sid === para.sid) throw new ErroMsg('você não pode mandar mensagem para si mesmo', 2);
  const t = validarTexto(texto, limites.maxBytes);
  const par = registrarNoPar(raiz, de.sid, para.sid, { now, limites });
  if (!par.ok) throw new ErroMsg(`${par.motivo}. Espere ~${par.esperarS} s, junte tudo numa mensagem só ou peça ajuda ao humano.`, 3);
  const msg = {
    v: 1,
    id: novoIdMensagem(now, rnd),
    ts: now,
    hora: new Date(now).toISOString(),
    de: { sid: de.sid, nome: String(de.nome ?? ''), engine: de.engine === 'codex' ? 'codex' : 'claude' },
    para: { sid: para.sid, nome: String(para.nome ?? ''), engine: para.engine === 'codex' ? 'codex' : 'claude' },
    texto: t,
  };
  if (respondeA) msg.respondeA = String(respondeA);
  const tmpDir = garantePasta(pastaDaCaixa(raiz, para.sid, 'tmp'));
  const novas = garantePasta(pastaDaCaixa(raiz, para.sid, 'novas'));
  for (const p of ['avisadas', 'lidas']) garantePasta(pastaDaCaixa(raiz, para.sid, p));
  const tmp = join(tmpDir, `${msg.id}.json`);
  writeFileSync(tmp, JSON.stringify(msg), { mode: 0o600 });
  renameSync(tmp, join(novas, `${msg.id}.json`));
  return msg;
}

function lerArquivo(p) {
  try {
    const m = JSON.parse(readFileSync(p, 'utf8'));
    return m && typeof m === 'object' && typeof m.id === 'string' && typeof m.texto === 'string' ? m : undefined;
  } catch {
    return undefined;
  }
}

function arquivos(dir) {
  try {
    return readdirSync(dir).filter((n) => n.endsWith('.json') && n.startsWith('m-'));
  } catch {
    return [];
  }
}

/** Mensagens de uma pasta da caixa (sem mexer), da mais antiga para a mais nova. */
export function listarPasta(raiz, sid, pasta) {
  const dir = pastaDaCaixa(raiz, sid, pasta);
  return arquivos(dir)
    .map((n) => lerArquivo(join(dir, n)))
    .filter(Boolean)
    .sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

/** Quantas mensagens ainda não lidas (novas + avisadas). */
export function naoLidas(raiz, sid) {
  return arquivos(pastaDaCaixa(raiz, sid, 'novas')).length + arquivos(pastaDaCaixa(raiz, sid, 'avisadas')).length;
}

/**
 * Move uma mensagem de uma pasta para outra da mesma caixa. true = foi este processo que moveu (o rename é a
 * "posse": se dois tentam ao mesmo tempo, só um consegue).
 */
export function mover(raiz, sid, id, de, para) {
  const nome = `${id}.json`;
  try {
    garantePasta(pastaDaCaixa(raiz, sid, para));
    renameSync(join(pastaDaCaixa(raiz, sid, de), nome), join(pastaDaCaixa(raiz, sid, para), nome));
    return true;
  } catch {
    return false;
  }
}

/**
 * Lê (e marca como lidas) as mensagens não lidas da caixa: novas e avisadas -> lidas. Também apaga lidas antigas.
 */
export function lerCaixa(raiz, sid, { now = Date.now(), limites = LIMITES } = {}) {
  const out = [];
  for (const pasta of ['novas', 'avisadas']) {
    for (const n of arquivos(pastaDaCaixa(raiz, sid, pasta))) {
      const id = n.slice(0, -5);
      // o carteiro pode ter movido novas -> avisadas no meio: tenta de lá também
      if (!mover(raiz, sid, id, pasta, 'lidas') && !(pasta === 'novas' && mover(raiz, sid, id, 'avisadas', 'lidas'))) continue;
      const m = lerArquivo(join(pastaDaCaixa(raiz, sid, 'lidas'), n));
      if (m) out.push(m);
    }
  }
  limparLidas(raiz, sid, now, limites.guardarLidasMs);
  return out.sort((a, b) => a.ts - b.ts || a.id.localeCompare(b.id));
}

export function limparLidas(raiz, sid, now = Date.now(), maxIdadeMs = LIMITES.guardarLidasMs) {
  const dir = pastaDaCaixa(raiz, sid, 'lidas');
  for (const n of arquivos(dir)) {
    try {
      if (now - statSync(join(dir, n)).mtimeMs > maxIdadeMs) rmSync(join(dir, n), { force: true });
    } catch {
      // sumiu
    }
  }
}

/** Acha uma mensagem da própria caixa pelo id (ou começo único do id). */
export function acharMensagem(raiz, sid, id) {
  const alvo = String(id ?? '').trim();
  if (!/^m-[a-z0-9-]{2,40}$/.test(alvo)) throw new ErroMsg(`id de mensagem inválido: ${alvo || '(vazio)'} (é o "m-..." do aviso)`);
  const achadas = [];
  for (const pasta of PASTAS) for (const m of listarPasta(raiz, sid, pasta)) if (m.id === alvo || m.id.startsWith(alvo)) achadas.push(m);
  const exata = achadas.find((m) => m.id === alvo);
  if (exata) return exata;
  if (achadas.length === 1) return achadas[0];
  if (achadas.length > 1) throw new ErroMsg(`id ambíguo: ${alvo} (${achadas.map((m) => m.id).join(', ')})`, 2);
  throw new ErroMsg(`não achei a mensagem ${alvo} na sua caixa (só dá para responder mensagens recebidas por você)`, 2);
}

/** Caixas com mensagens novas (ainda sem aviso): sessionId -> mensagens (da mais antiga para a mais nova). */
export function pendentes(raiz) {
  const out = new Map();
  let nomes = [];
  try {
    nomes = readdirSync(raiz);
  } catch {
    return out;
  }
  for (const sid of nomes) {
    if (!ID_SEGURO.test(sid) || sid.includes('..')) continue;
    const msgs = listarPasta(raiz, sid, 'novas');
    if (msgs.length) out.set(sid, msgs);
  }
  return out;
}

// ------------------------------------------------------------------ agentes e identidade

/** Normaliza nome para comparar: sem acento, minúsculo. */
export function normalizarNome(s) {
  return String(s ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim();
}

/** pid de um id de agente principal "<conta>:<pid>". */
export function pidDoAgente(id) {
  const m = /^[^:]+:(\d+)$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : undefined;
}

/**
 * Agentes de pé a partir do /api/snapshot: só principais reais (sem demo, sem subagentes), presentes.
 * Cada um: {id, sid, curto, nome, engine, status, pasta, pid}.
 */
export function agentesDoSnapshot(snap) {
  const salas = new Map((snap?.rooms ?? []).map((r) => [r.id, r.path]));
  return (snap?.agents ?? [])
    .filter((a) => a && a.kind === 'main' && typeof a.id === 'string' && !a.id.startsWith('demo:') && a.status !== 'offline' && a.status !== 'done' && !a.setup)
    .filter((a) => typeof a.sessionId === 'string' && ID_SEGURO.test(a.sessionId))
    .map((a) => ({
      id: a.id,
      sid: a.sessionId,
      curto: a.sessionId.slice(0, 8),
      nome: a.name,
      engine: a.engine === 'codex' ? 'codex' : 'claude',
      status: a.status,
      statusSince: a.statusSince,
      pasta: salas.get(a.roomId) ?? a.roomId,
      pid: pidDoAgente(a.id),
    }));
}

/** ppid a partir do conteúdo de /proc/<pid>/stat (o comm pode ter espaços e parênteses). */
export function ppidDoStat(stat) {
  const fim = String(stat).lastIndexOf(')');
  if (fim < 0) return undefined;
  const campos = String(stat)
    .slice(fim + 2)
    .split(' ');
  const ppid = Number(campos[1]);
  return Number.isSafeInteger(ppid) && ppid > 0 ? ppid : undefined;
}

/** Cadeia de processos pais (o próprio pid primeiro), até o init ou 64 níveis. */
export function ancestrais(pid, lerStat = (p) => readFileSync(`/proc/${p}/stat`, 'utf8')) {
  const out = [];
  let cur = pid;
  for (let i = 0; i < 64 && cur && cur > 1 && !out.includes(cur); i++) {
    out.push(cur);
    try {
      cur = ppidDoStat(lerStat(cur));
    } catch {
      break;
    }
  }
  return out;
}

/** TMUX_PANE de um environ (NUL-separado). */
export function paneDoEnviron(environ) {
  for (const kv of String(environ).split('\0')) if (kv.startsWith('TMUX_PANE=')) return kv.slice(10);
  return undefined;
}

/**
 * Quem sou eu entre os agentes: (1) HB_MSG_EU (sessionId ou id do agente; para testes e diagnóstico), (2) o
 * primeiro processo pai que é um agente (o comando roda dentro do Bash do Claude ou do shell do Codex), (3) o
 * mesmo pane do tmux (TMUX_PANE) de um agente.
 */
export function quemSouEu(agentes, { env = process.env, pids = [], paneDe } = {}) {
  const forcado = env.HB_MSG_EU?.trim();
  if (forcado) {
    const a = agentes.find((x) => x.sid === forcado || x.id === forcado || x.curto === forcado);
    if (a) return a;
    if (ID_SEGURO.test(forcado)) return { id: forcado, sid: forcado, curto: forcado.slice(0, 8), nome: forcado.slice(0, 8), engine: 'claude', status: 'idle', pasta: '' };
  }
  for (const p of pids) {
    const a = agentes.find((x) => x.pid === p);
    if (a) return a;
  }
  const pane = env.TMUX_PANE?.trim();
  if (pane && paneDe) {
    for (const a of agentes) {
      if (!a.pid) continue;
      try {
        if (paneDe(a.pid) === pane) return a;
      } catch {
        // processo sumiu
      }
    }
  }
  return undefined;
}

/**
 * Destinatário por nome (sem acento/maiúsculas; exato, depois começo único), id curto/sessionId (começo, 4+
 * caracteres) ou id do agente. Nunca a própria sessão.
 */
export function resolverDestino(agentes, alvo, eu) {
  const q = String(alvo ?? '').trim();
  if (!q) throw new ErroMsg('faltou o destinatário (nome ou id curto; veja hb-msg quem)');
  const outros = agentes.filter((a) => !eu || a.sid !== eu.sid);
  const n = normalizarNome(q);
  const unico = (lista, como) => {
    if (lista.length === 1) return lista[0];
    if (lista.length > 1) throw new ErroMsg(`"${q}" é ambíguo (${como}): ${lista.map((a) => `${a.nome} ${a.curto}`).join(', ')}. Use o id curto.`, 2);
    return undefined;
  };
  const r =
    unico(outros.filter((a) => a.id === q || a.sid === q), 'id') ??
    unico(outros.filter((a) => normalizarNome(a.nome) === n), 'nome') ??
    (q.length >= 4 ? unico(outros.filter((a) => a.sid.toLowerCase().startsWith(q.toLowerCase())), 'id curto') : undefined) ??
    unico(outros.filter((a) => normalizarNome(a.nome).startsWith(n)), 'começo do nome');
  if (r) return r;
  if (eu && (normalizarNome(eu.nome) === n || eu.sid.startsWith(q))) throw new ErroMsg('esse é você mesmo', 2);
  throw new ErroMsg(`não achei "${q}" entre os agentes de pé (veja hb-msg quem)`, 2);
}

// ------------------------------------------------------------------ aviso digitado no agente

function rotulo(de) {
  return `${de.nome || de.sid.slice(0, 8)} (${de.engine} · ${de.sid.slice(0, 8)})`;
}

/**
 * Texto do aviso digitado no pane do destinatário (vira um prompt dele). Até porAviso mensagens; cada texto até
 * `inline` caracteres vai inteiro (essas o carteiro marca como lidas), o resto fica para `hb-msg ler`.
 * Devolve {texto, inteiras: ids entregues por inteiro, incluidas: ids citadas}.
 */
export function textoDoAviso(msgs, limites = LIMITES) {
  const lote = msgs.slice(0, limites.porAviso);
  const resto = msgs.length - lote.length;
  const inteiras = [];
  const blocos = lote.map((m) => {
    const tipo = m.respondeA ? `Resposta de ${rotulo(m.de)} à sua mensagem ${m.respondeA}` : `Mensagem de ${rotulo(m.de)}`;
    if (m.texto.length <= limites.inline) {
      inteiras.push(m.id);
      return `📨 ${tipo} [${m.id}]:\n${m.texto}`;
    }
    return `📨 ${tipo} [${m.id}]: (texto longo, ${m.texto.length} caracteres: leia com hb-msg ler)`;
  });
  const linhas = [blocos.join('\n\n')];
  if (resto > 0) linhas.push(`(e mais ${resto} mensagem(ns) na sua caixa: hb-msg ler)`);
  const ex = lote[0];
  linhas.push(
    `↩ Para responder: hb-msg responder ${ex.id} "sua resposta" (o que você só escrever aqui não chega a quem mandou). Responda só se precisar: não responda só para agradecer ou confirmar.`,
  );
  return { texto: linhas.join('\n'), inteiras, incluidas: lote.map((m) => m.id) };
}
