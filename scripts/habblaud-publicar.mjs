#!/usr/bin/env node
// habblaud-publicar: pede ao escritório (Habblaud local) para publicar um projeto de ~/projetos na Hospedagem
// Habblaude. O escritório mostra um pedido de confirmação; só depois do "Publicar" do usuário o projeto é empacotado e
// enviado. Este comando espera e imprime o resultado (link do site).
//
//   node scripts/habblaud-publicar.mjs [pasta] [--site <id>] [--porta 4747] [--origem Claude] [--json]
//   npm run publicar -- [pasta] ...
//
// pasta: caminho dentro de ~/projetos (padrão: a pasta atual). Variáveis: HABBLAUD_URL (padrão
// http://127.0.0.1:<HABBLAUD_PORT ou 4747>). Saída: 0 = publicado; 1 = falhou/recusado/expirado; 2 = erro de uso.
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  console.log(`Uso: habblaud-publicar [pasta] [--site <id>] [--porta <n>] [--origem <nome>] [--json]

Pede ao escritório para publicar a pasta (dentro de ~/projetos). O usuário confirma no escritório
(aviso "Publicar?") e o comando espera o fim do deploy, imprimindo o link.
  --site <id>     publica de novo num site existente (sem isso, usa o site com o nome da pasta, se houver)
  --porta <n>     porta do Habblaud local (padrão: HABBLAUD_PORT ou 4747)
  --origem <nome> quem está pedindo (aparece no aviso; ex.: Claude, Codex)
  --json          imprime só o resultado final em JSON`);
  process.exit(0);
}

function opt(name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
}
const site = opt('--site');
const porta = opt('--porta') ?? process.env.HABBLAUD_PORT ?? '4747';
const origem = opt('--origem') ?? process.env.HABBLAUD_AGENT ?? 'agente';
const asJson = args.includes('--json');
const positional = args.filter((a) => !a.startsWith('--'));
const path = resolve(positional[0] ?? process.cwd());
const base = (process.env.HABBLAUD_URL ?? `http://127.0.0.1:${porta}`).replace(/\/+$/, '');

const say = (msg) => {
  if (!asJson) console.log(msg);
};

async function call(method, route, body) {
  let res;
  try {
    res = await fetch(`${base}${route}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json', Accept: 'application/json' } : { Accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    throw new Error(`não consegui falar com o Habblaud em ${base} (${err.message}). Ele está rodando?`);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `o Habblaud respondeu ${res.status}`);
  return data;
}

const LABEL = {
  pending: 'Esperando o usuário confirmar no escritório…',
  publishing: 'Confirmado! Empacotando e publicando…',
};

try {
  const { request } = await call('POST', '/api/publish/requests', { path, siteId: site, origem });
  say(`Pedido de publicação enviado para o escritório (${request.projeto}).`);
  say('Peça ao usuário para confirmar no Habblaud (aviso "Publicar?").');
  let last = '';
  const started = Date.now();
  for (;;) {
    const { request: r } = await call('GET', `/api/publish/requests/${encodeURIComponent(request.id)}`);
    if (r.status !== last) {
      last = r.status;
      if (LABEL[r.status]) say(LABEL[r.status]);
    }
    if (r.status === 'ok') {
      if (asJson) console.log(JSON.stringify({ ok: true, url: r.url, siteId: r.siteId, deployId: r.deployId }));
      else say(`Publicado! ${r.url ?? ''}`.trim());
      process.exit(0);
    }
    if (['failed', 'rejected', 'expired'].includes(r.status)) {
      const why = r.status === 'rejected' ? 'O usuário recusou a publicação.' : r.status === 'expired' ? 'Ninguém confirmou a tempo.' : `A publicação falhou: ${r.erro ?? 'erro desconhecido'}`;
      if (asJson) console.log(JSON.stringify({ ok: false, status: r.status, erro: r.erro }));
      else console.error(why);
      process.exit(1);
    }
    if (Date.now() - started > 40 * 60_000) {
      console.error('Tempo esgotado esperando a publicação.');
      process.exit(1);
    }
    await new Promise((ok) => setTimeout(ok, 2000));
  }
} catch (err) {
  if (asJson) console.log(JSON.stringify({ ok: false, erro: err.message }));
  else console.error(`habblaud-publicar: ${err.message}`);
  process.exit(2);
}
