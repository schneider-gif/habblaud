// API falsa da Anthropic para testar o diálogo AskUserQuestion do Claude Code sem login.
// Uso: node mock-api.mjs <porta> <arquivo-perguntas.json> <log.jsonl> (usado por scripts/e2e-perguntas/run.ts)
// - 1ª chamada com ferramentas cujo último bloco do usuário é texto: responde tool_use AskUserQuestion com o JSON do arquivo;
// - chamada que traz o tool_result: grava o resultado no log e responde texto "ok";
// - qualquer outra: texto curto.
import { createServer } from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';

const [port, qfile, logfile] = process.argv.slice(2);
let n = 0;

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [ev, data] of events) res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function msgStart(id) {
  return ['message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
}

function textReply(res, stream, text) {
  const id = `msg_${++n}`;
  if (!stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: 'claude-haiku-5-5', content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } }));
  }
  sse(res, [
    msgStart(id),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

function askReply(res, input) {
  const id = `msg_${++n}`;
  const toolId = `toolu_mock${n}${Date.now() % 100000}`;
  sse(res, [
    msgStart(id),
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: 'AskUserQuestion', input: {} } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } }],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (!req.url.startsWith('/v1/messages') || req.method !== 'POST') {
      res.writeHead(req.url.includes('count_tokens') ? 200 : 404, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: 10 }));
    }
    let j = {};
    try {
      j = JSON.parse(body);
    } catch {}
    const msgs = j.messages ?? [];
    const users = msgs.filter((m) => m.role === 'user');
    const last = users[users.length - 1];
    const blocks = Array.isArray(last?.content) ? last.content : [{ type: 'text', text: String(last?.content ?? '') }];
    const result = blocks.find((b) => b.type === 'tool_result');
    const hasAsk = (j.tools ?? []).some((t) => t.name === 'AskUserQuestion');
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join(' ');
    if (result) {
      appendFileSync(logfile, JSON.stringify({ at: Date.now(), tool_result: result }) + '\n');
      return textReply(res, j.stream, 'ok, recebi.');
    }
    if (hasAsk && /PERGUNTE/.test(text)) {
      const input = JSON.parse(readFileSync(qfile, 'utf8'));
      appendFileSync(logfile, JSON.stringify({ at: Date.now(), asked: input }) + '\n');
      return askReply(res, input);
    }
    return textReply(res, j.stream, 'ok');
  });
}).listen(Number(port), '127.0.0.1', () => console.log(`mock em ${port}`));
