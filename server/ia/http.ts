// Rotas de /api/ia (seletor de IA da barra). O servidor só grava pedidos em ~/.habblaude e lê o estado que o daemon
// hb-ia publica (mod/habblaud/ia/hb-ia.mjs, o único que mexe no ~/.claude/settings.json). Mesma trava de Host do
// painel do GitHub; o guard (http/guard.ts) já exige JSON e Origin local nos POST/DELETE.
//
//   GET    /api/ia          IaEstado
//   POST   /api/ia          {modo: "motores"|"conta", modelo?: id do catálogo} -> 201 IaEstado
//   POST   /api/ia/token    {token} (saída do `claude setup-token`)            -> 201 IaEstado
//   DELETE /api/ia/token                                                        -> 200 IaEstado
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { hostAllowed, isLoopbackHost } from '../http/guard';
import { IA_MODELOS, iaModelo, IA_PADRAO, RE_CLAUDE_TOKEN, type IaEstado, type IaModo } from '../../shared/ia';

export interface IaRoutesDeps {
  home: string;
  allowedHosts: ReadonlySet<string>;
  localHosts?: ReadonlySet<string>;
  sendJson: (res: ServerResponse, status: number, body: unknown) => void;
  readJson: (req: IncomingMessage) => Promise<unknown>;
}

const lerJson = (p: string): Record<string, unknown> | null => {
  try {
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, unknown>) : null;
  } catch {
    return null;
  }
};

/** tmp + rename: o hb-ia observa a pasta e lê o arquivo inteiro */
function gravar(p: string, texto: string): void {
  const tmp = `${p}.tmp-${process.pid}`;
  writeFileSync(tmp, texto, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, p);
}

export function lerEstado(home: string): IaEstado {
  const dir = join(home, '.habblaude');
  const e = lerJson(join(dir, 'ia-estado.json'));
  if (!e) return { disponivel: false, motores: false, conta: false, modo: 'nenhum', modelo: null, uso: null, token: false };
  const esc = lerJson(join(dir, 'ia-escolha.json'));
  const modo: IaModo = e.modo === 'motores' || e.modo === 'conta' ? e.modo : 'nenhum';
  // modelo fora do catálogo (o padrão do portal, ex. minimax-m2.5) aparece como o Prisma, o padrão da lista
  const bruto = typeof e.modelo === 'string' ? e.modelo : null;
  const uso = e.uso as { hoje?: unknown; limite?: unknown } | null;
  return {
    disponivel: true,
    motores: e.motores === true,
    conta: e.conta === true,
    modo,
    modelo: modo === 'motores' ? (iaModelo(bruto)?.id ?? IA_PADRAO) : null,
    uso: uso && typeof uso.hoje === 'number' ? { hoje: uso.hoje, limite: typeof uso.limite === 'number' ? uso.limite : null } : null,
    token: e.token === true,
    ...(e.resultado === 'config-do-cliente' && esc?.modo === 'motores' ? { bloqueio: 'config-do-cliente' } : {}),
  };
}

export class IaError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export function escolher(home: string, body: Record<string, unknown>): void {
  const modo = body.modo;
  if (modo !== 'motores' && modo !== 'conta') throw new IaError('modo deve ser "motores" ou "conta"');
  const modelo = body.modelo;
  if (modelo !== undefined && !iaModelo(typeof modelo === 'string' ? modelo : null)) {
    throw new IaError(`modelo fora da lista (${IA_MODELOS.map((m) => m.id).join(', ')})`);
  }
  const dir = join(home, '.habblaude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const antes = lerJson(join(dir, 'ia-escolha.json')) ?? {};
  // trocar para a conta guarda o último modelo, para voltar nele
  const novo = { modo, modelo: (modelo as string | undefined) ?? (typeof antes.modelo === 'string' ? antes.modelo : undefined) };
  gravar(join(dir, 'ia-escolha.json'), JSON.stringify(novo) + '\n');
}

export function salvarToken(home: string, token: unknown): void {
  const t = typeof token === 'string' ? token.trim() : '';
  if (!RE_CLAUDE_TOKEN.test(t)) throw new IaError('token inválido: cole a linha inteira que começa com sk-ant- (saída do claude setup-token)');
  const dir = join(home, '.habblaude');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  gravar(join(dir, 'claude-token'), t + '\n');
  // conectou a conta agora: passa a usar ela (o cliente troca de volta pela lista)
  const esc = lerJson(join(dir, 'ia-escolha.json')) ?? {};
  gravar(join(dir, 'ia-escolha.json'), JSON.stringify({ ...esc, modo: 'conta' }) + '\n');
}

export function createIaRoutes(deps: IaRoutesDeps) {
  const { sendJson } = deps;
  return (req: IncomingMessage, res: ServerResponse, url: URL): boolean => {
    const path = url.pathname;
    if (path !== '/api/ia' && path !== '/api/ia/token') return false;
    const host = req.headers.host;
    const negado = !hostAllowed(host, deps.allowedHosts) ? 'Host não permitido' : !isLoopbackHost(host, deps.localHosts) ? 'o seletor de IA só abre pelo próprio escritório' : undefined;
    const method = req.method ?? 'GET';
    if (negado) {
      req.resume();
      sendJson(res, 403, { error: negado });
      return true;
    }
    const responder = (status: number, fn: (b: Record<string, unknown>) => void, comCorpo: boolean) => {
      (comCorpo ? deps.readJson(req) : (req.resume(), Promise.resolve({})))
        .then((b) => {
          fn((b ?? {}) as Record<string, unknown>);
          sendJson(res, status, lerEstado(deps.home));
        })
        .catch((err) => sendJson(res, err instanceof IaError ? err.status : 500, { error: err instanceof Error ? err.message : 'erro interno' }));
    };
    if (path === '/api/ia' && method === 'GET') {
      sendJson(res, 200, lerEstado(deps.home));
    } else if (path === '/api/ia' && method === 'POST') {
      responder(201, (b) => escolher(deps.home, b), true);
    } else if (path === '/api/ia/token' && method === 'POST') {
      responder(201, (b) => salvarToken(deps.home, b.token), true);
    } else if (path === '/api/ia/token' && method === 'DELETE') {
      responder(200, () => rmSync(join(deps.home, '.habblaude', 'claude-token'), { force: true }), false);
    } else {
      req.resume();
      res.setHeader('Allow', path === '/api/ia' ? 'GET, POST' : 'POST, DELETE');
      sendJson(res, 405, { error: 'método não permitido' });
    }
    return true;
  };
}
