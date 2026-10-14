// Quadro de missões: GET /api/missions e POST /api/missions/:id/{start,complete,seen}. A trava (recurso só com
// bind local e Host local) é conferida em app.ts; o guard já exige Origin local e JSON nos POST, e aqui o corpo
// é lido com readJson (415 sem JSON).
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MissionStartResult } from '../../shared/missions';
import type { AgentInput } from '../input/tmux';
import { errMsg, log } from '../log';
import type { MissionsEngine } from '../missions/engine';
import { HttpError, readJson, sendJson } from './app';

/** Conta do Claude aberto pelo escritório (igual a SPAWN_ACCOUNT em app.ts). */
const SPAWN_ACCOUNT = '.claude';
const ACTION = /^\/api\/missions\/([^/]+)\/(start|complete|seen)$/;

async function startMission(engine: MissionsEngine, input: AgentInput | undefined, id: string): Promise<{ status: number; body: unknown }> {
  const r = await engine.start(id);
  if (!('ok' in r)) return { status: r.status, body: { error: r.error } };
  const out: MissionStartResult = { view: engine.view(), project: r.project, spawn: 'unavailable' };
  // Um agente já trabalhando na pasta (ou aberto num clique anterior) é reaproveitado.
  const present = engine.agentIn(r.project);
  if (present) return { status: 201, body: { ...out, agentId: present, spawn: 'reused' } };
  if (!input) return { status: 201, body: out };
  try {
    // Sem pedido pronto: o agente abre vazio e o quadro só leva o foco até a caixa de mensagem.
    const s = await input.spawn(r.project);
    return { status: 201, body: { ...out, spawn: 'ok', ...(s.pid ? { agentId: `${SPAWN_ACCOUNT}:${s.pid}` } : {}) } };
  } catch (err) {
    log.warnOnce(`missions-spawn:${errMsg(err)}`, `Missão começada, mas o agente não abriu: ${errMsg(err)}`);
    return { status: 201, body: { ...out, spawn: 'failed' } };
  }
}

export function handleMissionsRoute(req: IncomingMessage, res: ServerResponse, url: URL, engine: MissionsEngine, input: AgentInput | undefined): void {
  const method = req.method ?? 'GET';
  const notAllowed = (allow: string) => {
    req.resume();
    res.setHeader('Allow', allow);
    sendJson(res, 405, { error: 'método não permitido' });
  };
  if (url.pathname === '/api/missions') {
    if (method !== 'GET' && method !== 'HEAD') return notAllowed('GET');
    return sendJson(res, 200, engine.view());
  }
  const m = ACTION.exec(url.pathname);
  if (!m) {
    req.resume();
    return sendJson(res, 404, { error: 'rota desconhecida' });
  }
  if (method !== 'POST') return notAllowed('POST');
  let id: string;
  try {
    id = decodeURIComponent(m[1]);
  } catch {
    req.resume();
    return sendJson(res, 400, { error: 'id inválido' });
  }
  const action = m[2];
  readJson(req)
    .then(async (body) => {
      if (action === 'start') return startMission(engine, input, id);
      if (action === 'seen') {
        if (!engine.seen(id)) return { status: 404, body: { error: 'missão desconhecida' } };
        return { status: 200, body: { ok: true, view: engine.view() } };
      }
      // "Concluí": a interface pede confirmação antes; o corpo precisa dizer que foi confirmado.
      if ((body as { confirm?: unknown } | null)?.confirm !== true) throw new HttpError(400, 'confirme com {confirm: true}');
      const r = await engine.complete(id);
      if (!('ok' in r)) return { status: r.status, body: { error: r.error } };
      return { status: 200, body: { ok: true, coins: r.coins, view: engine.view() } };
    })
    .then(
      (r) => sendJson(res, r.status, r.body),
      (err) => {
        if (res.headersSent) return void res.destroy();
        if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
        else sendJson(res, 500, { error: 'erro interno' });
      },
    );
}
