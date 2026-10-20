#!/usr/bin/env node
// Bot Habblaude: atende o WhatsApp do cliente (add-on ChatBot) com o Claude da conta dele, sem ferramentas.
// Sobe com o escritório (hb-supervise whatsapp-bot); sem ChatBot ativo fica ocioso, conferindo a cada 5 min.
// Estado: ~/.habblaud/whatsapp-bot.json (token + cursor, 600); logs, histórico e status em ~/.habblaud/whatsapp-bot/.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aparar, backoff, claudeArgs, filtrar, lerResposta, lerSaidaClaude, mascarar, mensagemClaude, montarPrompt, PEDIR_TEXTO, prontos, soAudioSemTexto, soDigitos, textoDaMensagem } from './bot-core.mjs';

const PORTAL = (process.env.HABBLAUDE_PORTAL_URL || 'https://app.habblaude.com').replace(/\/$/, '');
const HOME = homedir();
const ESTADO = join(HOME, '.habblaud', 'whatsapp-bot.json');
const DIR = join(HOME, '.habblaud', 'whatsapp-bot');
const CWD = join(DIR, 'cwd');
const LOG = join(DIR, 'bot.log');
const POLL_MS = 3_000, CONFIG_MS = 60_000, OCIOSO_MS = 30_000, SEM_CHATBOT_MS = 300_000, CLAUDE_MS = 90_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(CWD, { recursive: true });

function log(texto) {
  try {
    if (existsSync(LOG) && statSync(LOG).size > 2_000_000) renameSync(LOG, `${LOG}.1`);
    appendFileSync(LOG, `${new Date().toISOString()} ${texto}\n`);
  } catch { /* log nunca derruba o bot */ }
}
const status = (estado) => { try { writeFileSync(join(DIR, 'status.json'), JSON.stringify({ estado, em: new Date().toISOString() })); } catch { /* idem */ } };

function lerEstado() {
  try { return JSON.parse(readFileSync(ESTADO, 'utf8')); } catch { return {}; }
}
function gravarEstado(e) {
  writeFileSync(ESTADO, JSON.stringify(e));
  chmodSync(ESTADO, 0o600);
}

class Http extends Error {
  constructor(status) { super(`HTTP ${status}`); this.status = status; }
}
async function api(estado, metodo, caminho, corpo) {
  const r = await fetch(`${PORTAL}${caminho}`, {
    method: metodo,
    headers: { 'Content-Type': 'application/json', ...(estado.token ? { Authorization: `Bearer ${estado.token}` } : {}) },
    ...(corpo ? { body: JSON.stringify(corpo) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Http(r.status);
  return r.json().catch(() => ({}));
}

async function registrar(estado) {
  const token = process.env.CODER_AGENT_TOKEN;
  if (!token) throw new Error('sem CODER_AGENT_TOKEN');
  const j = await api({}, 'POST', '/api/whatsapp/bot/registrar', { agentToken: token });
  estado.token = j.token;
  gravarEstado(estado);
  log('registrado no portal');
}

/** Primeira vez: anda até o fim da fila sem responder (histórico antigo não ganha resposta). */
async function cursorAtual(estado) {
  let cursor = 0;
  for (;;) {
    const j = await api(estado, 'GET', `/api/whatsapp/mensagens?depois=${cursor}&limite=100`);
    if (!j.mensagens?.length) return j.cursor ?? cursor;
    cursor = j.cursor;
  }
}

const arqHistorico = (de) => join(DIR, `${soDigitos(de)}.jsonl`);
function historico(de) {
  try { return readFileSync(arqHistorico(de), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
function guardar(de, item) {
  const h = aparar([...historico(de), { ...item, em: new Date().toISOString() }]);
  writeFileSync(arqHistorico(de), h.map((x) => JSON.stringify(x)).join('\n') + '\n');
}

function perguntarClaude(prompt, imagens) {
  // ambiente mínimo: nada de token do Coder nem segredos para o processo que lê texto de estranhos
  const env = { HOME, PATH: process.env.PATH, USER: process.env.USER ?? 'ubuntu', LANG: process.env.LANG ?? 'C.UTF-8' };
  return new Promise((ok) => {
    const p = spawn('claude', claudeArgs(), { cwd: CWD, env, stdio: ['pipe', 'pipe', 'ignore'] });
    let out = '';
    const fim = setTimeout(() => p.kill('SIGKILL'), CLAUDE_MS);
    p.stdout.on('data', (d) => { if (out.length < 4_000_000) out += d; });
    p.on('error', () => { clearTimeout(fim); ok(null); });
    p.on('close', () => { clearTimeout(fim); ok(lerSaidaClaude(out)); });
    p.stdin.end(mensagemClaude(prompt, imagens));
  });
}

/** Baixa as imagens da rajada pelo portal; a que falhar vira "[imagem que não foi possível abrir]" no prompt. */
async function imagensDe(estado, msgs) {
  const imagens = [];
  for (const m of msgs) {
    if (m.midia?.tipo !== 'imagem' || !m.midia.id) continue;
    try {
      const j = await api(estado, 'GET', `/api/whatsapp/midia/${encodeURIComponent(m.midia.id)}`);
      if (!/^image\/(png|jpeg|gif|webp)$/.test(j.mime) || typeof j.base64 !== 'string' || j.base64.length > 7_000_000) throw new Error('imagem inválida');
      imagens.push({ mime: j.mime, base64: j.base64 });
    } catch (e) {
      if (e.status === 401) throw e;
      m.imagemFalhou = true;
    }
  }
  return imagens;
}

async function enviar(estado, de, quem, texto) {
  try {
    await api(estado, 'POST', '/api/whatsapp/enviar', { para: de, texto });
    guardar(de, { quem: 'bot', texto });
    return true;
  } catch (e) {
    if (e.status === 401) throw e;
    if (e.status === 429) { log('limite de envio: esperando'); await sleep(30_000); }
    else log(`envio para ${quem} recusado: ${e.message}`); // 403/409: segue, não repete
    return false;
  }
}

/** Responde de uma vez todas as mensagens da rajada de um contato. */
async function atender(estado, cfg, msgs) {
  const de = msgs[0].de, quem = mascarar(de), nome = msgs[0].nome;
  log(`<- ${quem} (${msgs.length} mensage${msgs.length > 1 ? 'ns' : 'm'})`);
  if (soAudioSemTexto(msgs)) {
    guardar(de, { quem: 'cliente', texto: '[áudio]' });
    if (await enviar(estado, de, quem, PEDIR_TEXTO)) log(`-> ${quem} (pediu texto no lugar do áudio)`);
    return;
  }
  const h = historico(de);
  const imagens = await imagensDe(estado, msgs);
  for (const m of msgs) guardar(de, { quem: 'cliente', texto: textoDaMensagem(m) });
  const texto = msgs.map(textoDaMensagem).join('\n');
  const saida = await perguntarClaude(montarPrompt(cfg, h, msgs), imagens);
  if (saida === null) {
    log(`!! Claude não respondeu para ${quem} (sem login ou erro): chamando o dono`);
    await api(estado, 'POST', '/api/whatsapp/bot/pendente', { de, nome, texto }).catch(() => {});
    return;
  }
  const r = lerResposta(saida);
  if (r.chamarDono) await api(estado, 'POST', '/api/whatsapp/bot/pendente', { de, nome, texto }).catch((e) => log(`pendente falhou: ${e.message}`));
  for (const reg of r.registros) {
    // 404 = portal ainda sem registros: ignora
    await api(estado, 'POST', '/api/whatsapp/bot/registro', { de, nome, ...reg }).then(() => log(`registro ${reg.tipo} de ${quem}`), (e) => { if (e.status !== 404) log(`registro falhou: ${e.message}`); });
  }
  let enviadas = 0;
  for (const t of r.mensagens) if (await enviar(estado, de, quem, t)) enviadas++;
  log(`-> ${quem}${enviadas > 1 ? ` (${enviadas} mensagens)` : ''}${r.chamarDono ? ' (chamou o dono)' : ''}`);
}

async function main() {
  const estado = lerEstado();
  let cfg = null, cfgEm = 0, falhas = 0;
  log('Bot Habblaude iniciado');
  for (;;) {
    try {
      if (!estado.token) await registrar(estado);
      if (!cfg || Date.now() - cfgEm > CONFIG_MS) { cfg = await api(estado, 'GET', '/api/whatsapp/bot/config'); cfgEm = Date.now(); }
      if (!cfg.ativo || cfg.pausado) { status(cfg.ativo ? 'pausado' : 'desligado'); cfg = null; await sleep(OCIOSO_MS); continue; }
      if (estado.cursor === undefined) { estado.cursor = await cursorAtual(estado); gravarEstado(estado); log('começando das mensagens novas'); }
      status('ativo');
      const j = await api(estado, 'GET', `/api/whatsapp/mensagens?depois=${estado.cursor}&limite=50`);
      // a fila de rajada fica no estado em disco: o cursor anda ao enfileirar e nada se perde se o bot reiniciar
      estado.fila ??= {};
      for (const m of j.mensagens ?? []) {
        if (filtrar([m], cfg, Date.now()).length) {
          const f = (estado.fila[soDigitos(m.de)] ??= { msgs: [] });
          f.msgs.push(m);
          f.ultimaEm = Date.now();
        }
        estado.cursor = m.id;
        gravarEstado(estado);
      }
      for (const de of prontos(estado.fila, Date.now())) {
        const msgs = estado.fila[de].msgs;
        delete estado.fila[de];
        gravarEstado(estado);
        // o dono pode ter assumido a conversa enquanto a rajada esperava
        const ok = filtrar(msgs.map((m) => ({ ...m, recebidaEm: new Date().toISOString() })), cfg, Date.now());
        if (ok.length) await atender(estado, cfg, ok);
      }
      falhas = 0;
      await sleep(POLL_MS);
    } catch (e) {
      if (e.status === 401) { delete estado.token; gravarEstado(estado); log('token recusado: registrando de novo'); await sleep(5_000); continue; }
      if (e.status === 409) { status('sem-chatbot'); cfg = null; await sleep(SEM_CHATBOT_MS); continue; }
      falhas++;
      status('erro');
      log(`erro: ${e.message}`);
      await sleep(backoff(falhas));
    }
  }
}

main();
