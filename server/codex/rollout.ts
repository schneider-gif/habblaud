// Leitura das sessões do Codex CLI (OpenAI): o "rollout" JSONL que o Codex grava em
// <CODEX_HOME>/sessions/AAAA/MM/DD/rollout-<data>-<threadId>.jsonl. Código puro (sem I/O): recebe linhas e devolve
// atividades no mesmo modelo dos agentes do Claude, mais o estado do turno (trabalhando / esperando / ocioso).
//
// Formato conferido no Codex CLI 0.162.1 (ver docs/codex.md): cada linha é {timestamp, ordinal?, type, payload}:
// - session_meta: {id, cwd, cli_version, originator, model_provider, ...} — a primeira linha (só aparece na primeira
//   mensagem: antes disso o arquivo nem existe);
// - turn_context: {cwd, approval_policy, sandbox_policy, model?, ...} a cada turno;
// - event_msg: task_started | task_complete {last_agent_message, duration_ms} | turn_aborted {reason} |
//   item_completed {item: UserMessage | AgentMessage | CommandExecution | FileChange | ...} | token_count | ...;
// - response_item: message {role: user|assistant|developer, content[]} | function_call {name, arguments, call_id} |
//   function_call_output {call_id, output} | custom_tool_call {name: apply_patch, input} | custom_tool_call_output |
//   reasoning {summary[]} | web_search_call;
// - world_state, token_usage_record: ignorados aqui (tokens vêm do token_count).
// O pedido de aprovação NÃO vira linha no rollout: só a chamada sem resultado (com sandbox_permissions
// "require_escalated" quando o modelo pede para sair do sandbox). A confirmação vem da tela do tmux (screen.ts).
import { describeCommand, describePrompt, maskSecrets, SPECIAL, truncate, basename, type ActivityDescription } from '../../shared/activity';
import type { Activity, AgentStats, TaskItem } from '../../shared/types';

type Rec = Record<string, unknown>;

const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Uma chamada de ferramenta ainda sem resultado. */
export interface CodexPendingCall {
  callId: string;
  name: string;
  at: number;
  /** O modelo pediu para rodar fora do sandbox (sandbox_permissions: require_escalated): o Codex vai pedir aprovação. */
  escalated: boolean;
  /** Comando (exec_command/shell) ou arquivos do apply_patch, já mascarado. */
  detail?: string;
  /** Justificativa que o modelo deu (aparece no pedido de aprovação). */
  justification?: string;
  kind: 'command' | 'patch' | 'other';
}

export interface CodexState {
  threadId?: string;
  cwd?: string;
  cliVersion?: string;
  model?: string;
  provider?: string;
  approvalPolicy?: string;
  sandbox?: string;
  firstPrompt?: string;
  lastPrompt?: string;
  /** Nome dado pelo usuário (/rename → thread_name_updated), quando houver. */
  name?: string;
  /** Turno em andamento (task_started sem task_complete/turn_aborted). */
  turnOpen: boolean;
  turnStartedAt?: number;
  pending: Map<string, CodexPendingCall>;
  tasks: TaskItem[];
  stats: AgentStats;
  firstAt?: number;
  lastAt?: number;
  /** Última linha do rollout foi um fim de turno (ou interrupção). */
  ended: boolean;
  /** Mensagens do usuário vistas (o boneco "sem conversa" vira agente de verdade). */
  prompts: number;
}

export function createCodexState(): CodexState {
  return { turnOpen: false, pending: new Map(), tasks: [], stats: { toolCalls: 0, tokensIn: 0, tokensOut: 0, subagents: 0 }, ended: false, prompts: 0 };
}

export interface CodexLineResult {
  at: number;
  activities: { activity: Activity; current: boolean }[];
}

/** Texto das partes de uma mensagem (input_text/output_text/text). */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const r = rec(c);
      return r ? str(r.text) : '';
    })
    .filter(Boolean)
    .join('\n');
}

/** Mensagens "de usuário" que são do próprio Codex (contexto do ambiente, AGENTS.md, avisos): não são prompts. */
export function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return /^<(environment_context|user_instructions|turn_aborted|user_shell_command|subagent_notification|permissions instructions|collaboration_mode|skill)\b/i.test(t) || t.startsWith('# AGENTS.md');
}

/** Arquivos tocados por um patch do apply_patch ("*** Update File: x", "*** Add File: y", "*** Delete File: z"). */
export function patchFiles(input: string): { op: 'add' | 'update' | 'delete'; path: string }[] {
  const out: { op: 'add' | 'update' | 'delete'; path: string }[] = [];
  for (const m of input.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)) {
    out.push({ op: m[1].toLowerCase() as 'add' | 'update' | 'delete', path: m[2].trim() });
  }
  return out;
}

function parseArgs(raw: unknown): Rec {
  if (rec(raw)) return raw as Rec;
  try {
    return rec(JSON.parse(str(raw))) ?? {};
  } catch {
    return {};
  }
}

/** Comando de uma chamada exec_command/shell/shell_command (string ou lista argv). */
export function commandOf(args: Rec): string {
  const c = args.cmd ?? args.command;
  if (Array.isArray(c)) {
    const parts = c.map(String);
    // ["bash", "-lc", "<script>"]: o que interessa é o script.
    if (parts.length >= 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && /^-l?c$/.test(parts[1])) return parts.slice(2).join(' ');
    return parts.join(' ');
  }
  return str(c);
}

const SHELL_TOOLS = new Set(['exec_command', 'shell', 'shell_command', 'local_shell', 'container.exec']);

/** Chamada de ferramenta do Codex -> atividade em PT-BR. */
export function describeCodexCall(name: string, args: Rec, input?: string): ActivityDescription & { tool: string } {
  if (SHELL_TOOLS.has(name)) {
    const cmd = commandOf(args);
    return { ...describeCommand(cmd, str(args.justification) || undefined), tool: 'Bash' };
  }
  if (name === 'write_stdin') return { kind: 'run', icon: '📟', text: 'Conferindo saída do terminal', tool: 'BashOutput' };
  if (name === 'apply_patch') {
    const files = patchFiles(input ?? str(args.input) ?? '');
    const first = files[0];
    const detail = truncate(files.map((f) => f.path).join(', '), 300) || undefined;
    if (!first) return { kind: 'edit', icon: '✏️', text: 'Editando arquivos', tool: 'Edit', detail };
    const more = files.length > 1 ? ` (+${files.length - 1})` : '';
    if (first.op === 'add') return { kind: 'write', icon: '📝', text: truncate(`Escrevendo ${basename(first.path)}${more}`, 46), tool: 'Write', detail };
    if (first.op === 'delete') return { kind: 'edit', icon: '🗑️', text: truncate(`Apagando ${basename(first.path)}${more}`, 46), tool: 'Edit', detail };
    return { kind: 'edit', icon: '✏️', text: truncate(`Editando ${basename(first.path)}${more}`, 46), tool: 'Edit', detail };
  }
  if (name === 'update_plan') return { kind: 'plan', icon: '📋', text: 'Atualizando o plano', tool: 'TodoWrite' };
  if (name === 'view_image') {
    const p = str(args.path);
    return { kind: 'read', icon: '🖼️', text: p ? `Olhando ${basename(p)}` : 'Olhando uma imagem', tool: 'Read', detail: p || undefined };
  }
  if (name === 'web_search' || name === 'web_search_call') {
    const q = str(args.query);
    return { kind: 'web', icon: '🌐', text: q ? `Pesquisando “${truncate(q, 28)}”` : 'Pesquisando na web', tool: 'WebSearch', detail: q || undefined };
  }
  if (name === 'request_user_input') return { kind: 'ask', icon: '❓', text: 'Fazendo uma pergunta', tool: 'AskUserQuestion' };
  if (/goal/.test(name)) return { kind: 'plan', icon: '🎯', text: 'Acompanhando o objetivo', tool: name };
  if (name.startsWith('mcp__') || name.includes('mcp')) return { kind: 'mcp', icon: '🔌', text: truncate(`Usando ${name.replace(/^mcp__/, '')}`, 46), tool: name };
  if (/agent/.test(name)) return { kind: 'delegate', icon: '👥', text: 'Coordenando subagentes', tool: name };
  return { kind: 'other', icon: '🛠️', text: truncate(`Usando ${name}`, 46), tool: name };
}

function planTasks(args: Rec): TaskItem[] | undefined {
  const plan = args.plan;
  if (!Array.isArray(plan)) return undefined;
  return plan
    .map((p, i) => {
      const r = rec(p);
      if (!r) return undefined;
      const status = str(r.status);
      return {
        id: String(i + 1),
        title: truncate(str(r.step) || str(r.title) || `Passo ${i + 1}`, 120),
        status: status === 'completed' ? 'completed' : status === 'in_progress' ? 'in_progress' : 'pending',
      } as TaskItem;
    })
    .filter((t): t is TaskItem => !!t);
}

function timeOf(j: Rec, now: number): number {
  const t = Date.parse(str(j.timestamp));
  return Number.isFinite(t) ? t : now;
}

/** Interpreta uma linha do rollout, atualizando o estado. Linhas inválidas devolvem nenhuma atividade. */
export function parseCodexLine(state: CodexState, line: string, o: { idPrefix: string; now: number }): CodexLineResult {
  let j: Rec;
  try {
    j = JSON.parse(line) as Rec;
  } catch {
    return { at: o.now, activities: [] };
  }
  const at = timeOf(j, o.now);
  const p = rec(j.payload) ?? {};
  const type = str(j.type);
  const out: CodexLineResult = { at, activities: [] };
  const ordinal = typeof j.ordinal === 'number' ? j.ordinal : undefined;
  const idOf = (suffix: string) => `${o.idPrefix}#${ordinal ?? at}:${suffix}`;
  const push = (d: ActivityDescription & { tool?: string; error?: boolean }, suffix: string, extra: Partial<Activity> = {}) => {
    const a: Activity = { id: idOf(suffix), kind: d.kind, icon: d.icon, text: d.text, at, ...extra };
    if (d.detail) a.detail = maskSecrets(d.detail);
    if (d.tool) a.tool = d.tool;
    if (d.error) a.error = true;
    out.activities.push({ activity: a, current: true });
  };
  if (type !== 'session_meta') {
    state.firstAt ??= at;
    state.lastAt = at;
  }

  switch (type) {
    case 'session_meta': {
      state.threadId = str(p.id) || str(p.session_id) || state.threadId;
      state.cwd = str(p.cwd) || state.cwd;
      state.cliVersion = str(p.cli_version) || state.cliVersion;
      state.provider = str(p.model_provider) || state.provider;
      const ts = Date.parse(str(p.timestamp));
      if (Number.isFinite(ts)) state.firstAt ??= ts;
      return out;
    }
    case 'turn_context': {
      state.cwd = str(p.cwd) || state.cwd;
      state.model = str(p.model) || state.model;
      state.approvalPolicy = str(p.approval_policy) || state.approvalPolicy;
      const sb = rec(p.sandbox_policy);
      if (sb) state.sandbox = str(sb.type) || state.sandbox;
      return out;
    }
    case 'event_msg':
      return eventMsg(state, p, out, at, push);
    case 'response_item':
      return responseItem(state, p, out, at, push);
    default:
      return out;
  }
}

type Push = (d: ActivityDescription & { tool?: string; error?: boolean }, suffix: string, extra?: Partial<Activity>) => void;

function eventMsg(state: CodexState, p: Rec, out: CodexLineResult, at: number, push: Push): CodexLineResult {
  switch (str(p.type)) {
    case 'task_started':
      state.turnOpen = true;
      state.ended = false;
      state.turnStartedAt = at;
      return out;
    case 'task_complete': {
      const ms = typeof p.duration_ms === 'number' ? p.duration_ms : state.turnStartedAt !== undefined ? at - state.turnStartedAt : undefined;
      state.turnOpen = false;
      state.ended = true;
      state.pending.clear();
      push(SPECIAL.turnDone(ms && ms > 0 ? ms : undefined), 'done');
      return out;
    }
    case 'turn_aborted':
      state.turnOpen = false;
      state.ended = true;
      state.pending.clear();
      push(SPECIAL.interrupted(), 'aborted');
      return out;
    case 'thread_name_updated': {
      const n = str(p.thread_name) || str(p.name);
      if (n.trim()) state.name = n.trim();
      return out;
    }
    case 'token_count': {
      const info = rec(p.info);
      const total = rec(info?.total_token_usage);
      if (total) {
        const inT = Number(total.input_tokens) || 0;
        const outT = (Number(total.output_tokens) || 0) + 0;
        state.stats = { ...state.stats, tokensIn: inT, tokensOut: outT };
      }
      return out;
    }
    case 'context_compacted':
      push(SPECIAL.compact(), 'compact');
      return out;
    case 'error':
    case 'stream_error':
      push(SPECIAL.error(undefined, truncate(str(p.message), 300) || undefined), 'error');
      return out;
    case 'item_completed': {
      const item = rec(p.item);
      if (!item) return out;
      // Resultado de comando/patch: tira da lista de pendentes (o function_call_output também tira).
      const id = str(item.id);
      if (id && (item.type === 'CommandExecution' || item.type === 'FileChange')) {
        state.pending.delete(id);
        if (item.type === 'CommandExecution' && str(item.status) === 'failed') {
          const cmd = Array.isArray(item.command) ? commandOf({ command: item.command }) : '';
          push({ kind: 'error', icon: '⚠️', text: truncate(`Comando falhou: ${describeCommand(cmd).text}`, 46), detail: cmd || undefined, tool: 'Bash', error: true }, `fail-${id}`);
        }
      }
      return out;
    }
    default:
      return out;
  }
}

function responseItem(state: CodexState, p: Rec, out: CodexLineResult, at: number, push: Push): CodexLineResult {
  switch (str(p.type)) {
    case 'message': {
      const role = str(p.role);
      const text = messageText(p.content).trim();
      if (!text) return out;
      if (role === 'user') {
        if (isInjectedUserText(text)) return out;
        state.prompts += 1;
        state.firstPrompt ??= text;
        state.lastPrompt = text;
        state.turnOpen = true;
        state.ended = false;
        push(describePrompt(text), 'prompt');
      } else if (role === 'assistant') {
        push(SPECIAL.respond(truncate(text, 300)), 'respond');
      }
      return out;
    }
    case 'reasoning':
      push(SPECIAL.think(), 'think');
      return out;
    case 'function_call':
    case 'custom_tool_call':
    case 'local_shell_call': {
      const name = str(p.name) || (p.type === 'local_shell_call' ? 'local_shell' : '');
      const callId = str(p.call_id) || str(p.id);
      const args = p.type === 'custom_tool_call' ? {} : parseArgs(p.arguments ?? p.action);
      const input = p.type === 'custom_tool_call' ? str(p.input) : undefined;
      const d = describeCodexCall(name, args, input);
      state.stats = { ...state.stats, toolCalls: state.stats.toolCalls + 1 };
      if (name === 'update_plan') {
        const tasks = planTasks(args);
        if (tasks) state.tasks = tasks;
      }
      if (callId) {
        const kind: CodexPendingCall['kind'] = SHELL_TOOLS.has(name) ? 'command' : name === 'apply_patch' ? 'patch' : 'other';
        const pend: CodexPendingCall = { callId, name, at, escalated: str(args.sandbox_permissions) === 'require_escalated', kind };
        const detail = kind === 'command' ? commandOf(args) : d.detail;
        if (detail) pend.detail = truncate(maskSecrets(detail), 300);
        const why = str(args.justification);
        if (why) pend.justification = truncate(why, 200);
        state.pending.set(callId, pend);
      }
      push(d, `call-${callId || 'x'}`);
      return out;
    }
    case 'function_call_output':
    case 'custom_tool_call_output': {
      const callId = str(p.call_id);
      if (callId) state.pending.delete(callId);
      return out;
    }
    case 'web_search_call': {
      const action = rec(p.action);
      push(describeCodexCall('web_search', { query: str(action?.query) }), `web-${str(p.id)}`);
      return out;
    }
    default:
      return out;
  }
}

/** Título do agente: nome dado (/rename) > primeiro pedido. */
export function codexTitle(s: CodexState): string | undefined {
  const t = s.name ?? s.firstPrompt;
  return t ? truncate(t, 80) : undefined;
}

/** Chamada pendente que provavelmente espera aprovação (sem olhar a tela): saída do sandbox pedida pelo modelo. */
export function likelyApproval(s: CodexState, now: number, minMs = 1_000): CodexPendingCall | undefined {
  for (const c of s.pending.values()) if (c.escalated && now - c.at >= minMs) return c;
  return undefined;
}

/** Status do agente pelo rollout: turno aberto = trabalhando; senão ocioso. A espera (aprovação) vem da tela. */
export function codexStatus(s: CodexState): 'working' | 'idle' {
  return s.turnOpen ? 'working' : 'idle';
}
