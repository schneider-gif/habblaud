// Responder pelo escritório os pedidos de aprovação do Codex. Não há API para isso no Codex CLI 0.162.1 (o pedido
// não passa por hook nem fica no rollout): o Habblaude lê a tela do pane no tmux e, com a decisão da página, manda a
// tecla que o próprio Codex mostra — "y" (aprovar), "p"/"a" (aprovar e não perguntar de novo, quando oferecido) ou
// Esc (recusar). Antes de digitar, a tela é conferida de novo: se o pedido já foi respondido no terminal, nada é
// enviado (404). Mesmas rotas e formato dos pedidos do Claude (/api/permissions/:id, ids "codex-...").
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { PermissionDecision } from '../../shared/types';
import { HttpError, readJson, sendJson } from '../http/app';
import { parseDecision } from '../permissions/registry';
import { approvalKey } from './screen';
import type { CodexWatcher } from './watcher';

export const CODEX_PERMISSION_PREFIX = 'codex-';
const ITEM = /^\/api\/permissions\/(codex-[0-9A-Za-z_.-]{1,160})(?:\/(decision|wait))?$/;

export interface CodexApprovalDeps {
  watcher: Pick<CodexWatcher, 'approvals' | 'screenOf' | 'refresh'>;
  sendKeys: (agentId: string, keys: string[]) => Promise<void>;
  /** Recusa com motivo: o texto vai como mensagem depois do Esc ("No, and tell Codex what to do differently"). */
  sendText?: (agentId: string, text: string) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
}

export type DecideResult = 'ok' | 'not-found' | 'invalid';

/** Aplica uma decisão a um pedido do Codex. */
export async function decideCodex(deps: CodexApprovalDeps, id: string, d: PermissionDecision): Promise<DecideResult> {
  const ap = deps.watcher.approvals().find((a) => a.info.id === id);
  if (!ap) return 'not-found';
  if (d.behavior === 'terminal') return 'ok'; // fica para responder no terminal; o pedido continua na tela
  if (d.suggestion !== undefined && (d.suggestion !== 0 || !ap.screen.alwaysKey)) return 'invalid';
  // A tela ainda pede aprovação? (pode ter sido respondida no terminal ou expirado entre a leitura e o clique)
  const now = await deps.watcher.screenOf(ap.agentId);
  if (now?.kind !== 'approval') return 'not-found';
  const decision = d.behavior === 'deny' ? 'deny' : d.suggestion === 0 ? 'always' : 'allow';
  await deps.sendKeys(ap.agentId, [approvalKey(decision, now)]);
  if (decision === 'deny' && d.message?.trim() && deps.sendText) {
    await (deps.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms))))(400);
    await deps.sendText(ap.agentId, d.message.trim());
  }
  deps.watcher.refresh(ap.agentId);
  return 'ok';
}

/**
 * Embrulha as rotas de /api/permissions: ids "codex-..." são respondidos aqui; o resto segue para o registro do
 * Claude (`next`, que pode faltar quando o hook de permissões está desligado).
 */
export function withCodexPermissions(
  deps: CodexApprovalDeps,
  next: ((req: IncomingMessage, res: ServerResponse, path: string) => void) | undefined,
): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  return (req, res, path) => {
    const m = ITEM.exec(path);
    if (!m) {
      if (next) return next(req, res, path);
      return sendJson(res, 404, { error: 'rota desconhecida' });
    }
    const id = m[1];
    const method = req.method ?? 'GET';
    if (m[2] === 'wait') return sendJson(res, 404, { error: 'pedido do Codex: não há espera por hook' });
    if (m[2] === 'decision') {
      if (method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return sendJson(res, 405, { error: 'método não permitido' });
      }
      readJson(req)
        .then(async (body) => {
          const d = parseDecision(body);
          if (!d) throw new HttpError(400, 'esperado {behavior: "allow" | "deny" | "terminal", message?, suggestion?}');
          const r = await decideCodex(deps, id, d);
          if (r === 'ok') sendJson(res, 200, { ok: true });
          else if (r === 'invalid') sendJson(res, 400, { error: 'este pedido não tem a opção "não perguntar de novo"' });
          else sendJson(res, 404, { error: 'pedido desconhecido: já foi respondido no terminal' });
        })
        .catch((err) => {
          if (res.headersSent) return void res.destroy();
          if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
          else sendJson(res, 409, { error: err instanceof Error ? err.message : 'não foi possível responder' });
        });
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      res.setHeader('Allow', 'GET');
      return sendJson(res, 405, { error: 'método não permitido' });
    }
    const ap = deps.watcher.approvals().find((a) => a.info.id === id);
    if (ap) sendJson(res, 200, ap.info);
    else sendJson(res, 404, { error: 'pedido desconhecido' });
  };
}
