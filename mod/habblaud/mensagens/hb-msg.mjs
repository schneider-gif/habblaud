#!/usr/bin/env node
// hb-msg: agentes do Claude Code e do Codex no mesmo escritório Habblaude conversando entre si.
//   hb-msg quem                         quem está de pé e quem sou eu
//   hb-msg enviar <nome|id> "texto"     grava na caixa do colega (o Habblaude avisa quando ele ficar livre)
//   hb-msg ler [--esperar N]            lê (e marca como lidas) as mensagens da sua caixa
//   hb-msg responder <id-msg> "texto"   responde uma mensagem recebida
// Node puro, sem dependências. A lista de agentes vem do Habblaude local (GET /api/snapshot); fora do ar, só os
// agentes do Claude Code (registro ~/.claude*/sessions).
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  acharMensagem,
  agentesDoSnapshot,
  ancestrais,
  enviarMensagem,
  ErroMsg,
  lerCaixa,
  LIMITES,
  naoLidas,
  paneDoEnviron,
  quemSouEu,
  raizPadrao,
  resolverDestino,
} from './caixa.mjs';

const env = process.env;
const home = env.HOME || homedir();
const raiz = raizPadrao(home, env);
const porta = Number(env.HABBLAUD_PORT) || 4747;
const base = `http://127.0.0.1:${porta}`;

const AJUDA = `hb-msg: conversar com outros agentes do escritório (Claude Code e Codex)

  hb-msg quem                         lista os agentes de pé e diz quem é você
  hb-msg enviar <nome|id> "texto"     manda uma mensagem (até ${LIMITES.maxBytes} bytes)
  hb-msg ler [--esperar N]            lê as mensagens novas (--esperar: espera até N s chegar alguma)
  hb-msg responder <id-msg> "texto"   responde uma mensagem recebida (id "m-..." do aviso)

Opções: --json (quem/ler). Anti-loop: no máx. ${LIMITES.porMinuto} mensagens/min e ${LIMITES.porHora}/h entre o mesmo par.`;

const STATUS = { working: 'trabalhando', idle: 'livre', waiting: 'esperando a pessoa', shell: 'esperando um shell' };

async function snapshot() {
  try {
    const r = await fetch(`${base}/api/snapshot`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return undefined;
    return await r.json();
  } catch {
    return undefined;
  }
}

/** Habblaude fora do ar: agentes do Claude Code pelo registro de sessões abertas (status e nome do names.json). */
function agentesLocais() {
  let nomes = {};
  try {
    nomes = JSON.parse(readFileSync(join(env.HABBLAUD_DATA_DIR?.trim() || join(home, '.habblaud'), 'names.json'), 'utf8')).names ?? {};
  } catch {
    // sem nomes
  }
  const out = [];
  let dirs = [];
  try {
    dirs = readdirSync(home).filter((d) => d === '.claude' || d.startsWith('.claude-'));
  } catch {
    return out;
  }
  for (const d of dirs) {
    let arqs = [];
    try {
      arqs = readdirSync(join(home, d, 'sessions')).filter((n) => n.endsWith('.json'));
    } catch {
      continue;
    }
    for (const n of arqs) {
      try {
        const j = JSON.parse(readFileSync(join(home, d, 'sessions', n), 'utf8'));
        if (typeof j.pid !== 'number' || typeof j.sessionId !== 'string') continue;
        try {
          process.kill(j.pid, 0);
        } catch (err) {
          if (err.code === 'ESRCH') continue;
        }
        const st = { busy: 'working', idle: 'idle', waiting: 'waiting', shell: 'shell' }[j.status] ?? 'idle';
        out.push({ id: `${d}:${j.pid}`, sid: j.sessionId, curto: j.sessionId.slice(0, 8), nome: nomes[j.sessionId]?.name || j.sessionId.slice(0, 8), engine: 'claude', status: st, pasta: j.cwd ?? '', pid: j.pid });
      } catch {
        // registro sendo gravado
      }
    }
  }
  return out;
}

async function contexto() {
  const snap = await snapshot();
  const agentes = snap ? agentesDoSnapshot(snap) : agentesLocais();
  let pids = [];
  try {
    pids = ancestrais(process.pid);
  } catch {
    // sem /proc
  }
  const eu = quemSouEu(agentes, {
    env,
    pids,
    paneDe: (pid) => paneDoEnviron(readFileSync(`/proc/${pid}/environ`, 'latin1')),
  });
  return { agentes, eu, online: !!snap };
}

function exigirEu(ctx) {
  if (ctx.eu) return ctx.eu;
  throw new ErroMsg(
    ctx.online
      ? 'não descobri qual agente você é: rode o hb-msg de dentro de um agente do Claude Code ou do Codex aberto no escritório'
      : `o Habblaude não respondeu em ${base} e não achei você entre as sessões do Claude Code abertas`,
    2,
  );
}

function curtaPasta(p) {
  return p && p.startsWith(home) ? `~${p.slice(home.length)}` : p || '?';
}

function eAgente(a) {
  return `${a.nome} (${a.engine} · ${a.curto})`;
}

function tirarOpcao(args, nome, comValor) {
  const i = args.indexOf(nome);
  if (i < 0) return undefined;
  const v = comValor ? args[i + 1] : true;
  args.splice(i, comValor ? 2 : 1);
  return v;
}

/** Texto da mensagem: o resto dos argumentos, ou o stdin com "-". */
function textoDe(partes) {
  if (partes.length === 1 && partes[0] === '-') return readFileSync(0, 'utf8');
  return partes.join(' ');
}

function avisoEntrega(dest, online) {
  if (!online) return `⚠ o Habblaude não respondeu em ${base}: ${dest.nome} só vai ver quando rodar hb-msg ler.`;
  if (dest.status === 'idle' || dest.status === 'shell') return `${dest.nome} está livre: o aviso chega no terminal em instantes.`;
  return `${dest.nome} está ${STATUS[dest.status] ?? dest.status}: o aviso vai quando ficar livre.`;
}

async function cmdQuem(args) {
  const json = tirarOpcao(args, '--json', false);
  const ctx = await contexto();
  if (json) {
    process.stdout.write(`${JSON.stringify({ eu: ctx.eu ?? null, agentes: ctx.agentes, online: ctx.online, naoLidas: ctx.eu ? naoLidas(raiz, ctx.eu.sid) : 0 }, null, 2)}\n`);
    return;
  }
  const linhas = [];
  if (!ctx.online) linhas.push(`⚠ Habblaude fora do ar (${base}): lista só com as sessões do Claude Code.`);
  linhas.push(ctx.eu ? `Você: ${eAgente(ctx.eu)} em ${curtaPasta(ctx.eu.pasta)}` : 'Você: (não identificado: rode de dentro de um agente do escritório)');
  const outros = ctx.agentes.filter((a) => !ctx.eu || a.sid !== ctx.eu.sid);
  if (!outros.length) linhas.push('Nenhum outro agente de pé no escritório.');
  else {
    linhas.push('Colegas de pé:');
    const w = Math.max(...outros.map((a) => a.nome.length));
    for (const a of outros) linhas.push(`  ${a.nome.padEnd(w)}  ${a.engine.padEnd(6)}  ${a.curto}  ${(STATUS[a.status] ?? a.status).padEnd(18)}  ${curtaPasta(a.pasta)}`);
  }
  if (ctx.eu) {
    const n = naoLidas(raiz, ctx.eu.sid);
    if (n) linhas.push(`Você tem ${n} mensagem(ns) não lida(s): hb-msg ler`);
  }
  process.stdout.write(`${linhas.join('\n')}\n`);
}

async function cmdEnviar(args) {
  const [alvo, ...resto] = args;
  const ctx = await contexto();
  const eu = exigirEu(ctx);
  const dest = resolverDestino(ctx.agentes, alvo, eu);
  const msg = enviarMensagem(raiz, { de: eu, para: dest, texto: textoDe(resto) });
  process.stdout.write(`✉ Mensagem ${msg.id} gravada na caixa de ${eAgente(dest)}.\n${avisoEntrega(dest, ctx.online)}\n`);
}

async function cmdResponder(args) {
  const [id, ...resto] = args;
  const ctx = await contexto();
  const eu = exigirEu(ctx);
  const orig = acharMensagem(raiz, eu.sid, id);
  const presente = ctx.agentes.find((a) => a.sid === orig.de.sid);
  const dest = presente ?? { ...orig.de, status: 'offline', curto: orig.de.sid.slice(0, 8) };
  const msg = enviarMensagem(raiz, { de: eu, para: dest, texto: textoDe(resto), respondeA: orig.id });
  const quando = presente ? avisoEntrega(presente, ctx.online) : `${dest.nome} não está de pé agora: a resposta fica na caixa dele.`;
  process.stdout.write(`✉ Resposta ${msg.id} (a ${orig.id}) gravada na caixa de ${eAgente(dest)}.\n${quando}\n`);
}

async function cmdLer(args) {
  const json = tirarOpcao(args, '--json', false);
  const esp = tirarOpcao(args, '--esperar', true);
  const esperarS = esp === undefined ? 0 : Math.min(Math.max(Number(esp) || 0, 0), 3600);
  const ctx = await contexto();
  const eu = exigirEu(ctx);
  const fim = Date.now() + esperarS * 1000;
  let msgs = lerCaixa(raiz, eu.sid);
  while (!msgs.length && Date.now() < fim) {
    await new Promise((ok) => setTimeout(ok, 400));
    msgs = lerCaixa(raiz, eu.sid);
  }
  if (json) {
    process.stdout.write(`${JSON.stringify(msgs, null, 2)}\n`);
    return;
  }
  if (!msgs.length) {
    process.stdout.write(esperarS ? `Nenhuma mensagem em ${esperarS} s.\n` : 'Nenhuma mensagem nova.\n');
    return;
  }
  const blocos = msgs.map((m) => {
    const hora = new Date(m.ts).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const tipo = m.respondeA ? `resposta a ${m.respondeA}` : 'mensagem';
    return `📨 [${m.id}] ${hora} · ${tipo} de ${m.de.nome || m.de.sid.slice(0, 8)} (${m.de.engine} · ${m.de.sid.slice(0, 8)}):\n${m.texto}`;
  });
  blocos.push(`↩ Responder: hb-msg responder <id> "texto" (só se precisar).`);
  process.stdout.write(`${blocos.join('\n\n')}\n`);
}

async function main(argv) {
  const [cmd, ...args] = argv;
  switch (cmd) {
    case 'quem':
    case 'who':
      return cmdQuem(args);
    case 'enviar':
    case 'send':
      return cmdEnviar(args);
    case 'ler':
    case 'read':
      return cmdLer(args);
    case 'responder':
    case 'reply':
      return cmdResponder(args);
    case undefined:
    case 'ajuda':
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(`${AJUDA}\n`);
      return;
    default:
      throw new ErroMsg(`comando desconhecido: ${cmd}\n\n${AJUDA}`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  process.stderr.write(`hb-msg: ${err instanceof ErroMsg ? err.message : err?.stack || err}\n`);
  process.exit(err instanceof ErroMsg ? err.codigo : 1);
});
