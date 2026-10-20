#!/usr/bin/env node
// Bot Habblaude: atende o WhatsApp do cliente (add-on ChatBot) com o Claude da conta dele, sem ferramentas.
// Sobe com o escritório (hb-supervise whatsapp-bot); sem ChatBot ativo fica ocioso, conferindo a cada 5 min.
// Estado: ~/.habblaud/whatsapp-bot.json (token + cursor, 600); logs, histórico e status em ~/.habblaud/whatsapp-bot/.
import { execFile } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { aparar, backoff, claudeArgs, filtrar, lerResposta, lerSaidaClaude, mascarar, montarPrompt, soDigitos } from './bot-core.mjs';

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

function perguntarClaude(prompt) {
  // ambiente mínimo: nada de token do Coder nem segredos para o processo que lê texto de estranhos
  const env = { HOME, PATH: process.env.PATH, USER: process.env.USER ?? 'ubuntu', LANG: process.env.LANG ?? 'C.UTF-8' };
  return new Promise((ok) => {
    execFile('claude', claudeArgs(prompt), { cwd: CWD, env, timeout: CLAUDE_MS, maxBuffer: 4_000_000 }, (err, stdout) => {
      ok(err && !stdout ? null : lerSaidaClaude(stdout));
    });
  });
}

async function atender(estado, cfg, m) {
  const quem = mascarar(m.de);
  log(`<- ${quem}`);
  const h = historico(m.de);
  guardar(m.de, { quem: 'cliente', texto: m.texto });
  const saida = await perguntarClaude(montarPrompt(cfg.instrucoes, h, m));
  if (saida === null) {
    log(`!! Claude não respondeu para ${quem} (sem login ou erro): chamando o dono`);
    await api(estado, 'POST', '/api/whatsapp/bot/pendente', { de: m.de, nome: m.nome, texto: m.texto }).catch(() => {});
    return;
  }
  const r = lerResposta(saida);
  if (r.chamarDono) await api(estado, 'POST', '/api/whatsapp/bot/pendente', { de: m.de, nome: m.nome, texto: m.texto }).catch((e) => log(`pendente falhou: ${e.message}`));
  try {
    await api(estado, 'POST', '/api/whatsapp/enviar', { para: m.de, texto: r.resposta });
    guardar(m.de, { quem: 'bot', texto: r.resposta });
    log(`-> ${quem}${r.chamarDono ? ' (chamou o dono)' : ''}`);
  } catch (e) {
    if (e.status === 429) { log('limite de envio: esperando'); await sleep(30_000); }
    else log(`envio para ${quem} recusado: ${e.message}`); // 403/409: segue, não repete
    if (e.status === 401) throw e;
  }
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
      // cursor anda mensagem a mensagem: uma falha no meio não faz responder de novo quem já foi atendido
      for (const m of j.mensagens ?? []) {
        if (filtrar([m], cfg, Date.now()).length) await atender(estado, cfg, m);
        estado.cursor = m.id;
        gravarEstado(estado);
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
