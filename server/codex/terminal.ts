// Terminal da conversa (somente leitura) para os agentes do Codex: o rollout JSONL vira as mesmas entradas
// (TerminalEntry) que o terminal mostra para o Claude. Também há um parser "automático" que reconhece o formato pela
// linha (rollout do Codex tem {type, payload}; transcript do Claude, não) — usado por padrão em http/terminal.ts.
import { formatDuration, maskSecrets, truncate } from '../../shared/activity';
import type { TerminalEntry } from '../../shared/types';
import { createTerminalParser, INPUT_MAX, RESULT_MAX, RESULT_MAX_LINES, TEXT_MAX, type TerminalParser } from '../sources/terminal';
import { commandOf, isInjectedUserText, messageText, patchFiles } from './rollout';

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function clip(text: string, max: number, maxLines = Infinity): { text: string; truncated: boolean } {
  let t = maskSecrets(text);
  let truncated = false;
  const lines = t.split('\n');
  if (lines.length > maxLines) {
    t = lines.slice(0, maxLines).join('\n');
    truncated = true;
  }
  if (t.length > max) {
    t = t.slice(0, max);
    truncated = true;
  }
  return { text: t, truncated };
}

/** Saída de uma ferramenta do Codex: tira o cabeçalho "Chunk ID/Wall time/..." e fica com o "Output:". */
export function cleanToolOutput(raw: string): { text: string; exit?: number } {
  const m = /Process exited with code (-?\d+)/.exec(raw);
  const out = raw.includes('\nOutput:\n') ? raw.slice(raw.indexOf('\nOutput:\n') + 9) : raw;
  const r: { text: string; exit?: number } = { text: out.replace(/\s+$/, '') };
  if (m) r.exit = Number(m[1]);
  return r;
}

class CodexTerminalParser implements TerminalParser {
  private seq = 0;
  private names = new Map<string, string>();

  push(line: string): TerminalEntry[] {
    let j: Rec;
    try {
      j = JSON.parse(line) as Rec;
    } catch {
      return [];
    }
    const p = rec(j.payload);
    if (!p) return [];
    const t = Date.parse(str(j.timestamp));
    const at = Number.isFinite(t) ? t : 0;
    const id = (s: string) => `cx${typeof j.ordinal === 'number' ? j.ordinal : ++this.seq}-${s}`;
    const type = str(j.type);
    if (type === 'response_item') return this.item(p, at, id);
    if (type === 'event_msg') {
      switch (str(p.type)) {
        case 'turn_aborted':
          return [{ kind: 'system', id: id('abort'), at, text: 'Interrompido por você', level: 'warn' }];
        case 'task_complete': {
          const ms = typeof p.duration_ms === 'number' ? p.duration_ms : undefined;
          return ms && ms >= 1000 ? [{ kind: 'system', id: id('done'), at, text: `Trabalhou por ${formatDuration(ms)}` }] : [];
        }
        case 'context_compacted':
          return [{ kind: 'system', id: id('compact'), at, text: 'Conversa compactada' }];
        case 'error':
        case 'stream_error':
          return [{ kind: 'system', id: id('err'), at, text: 'Erro', detail: truncate(str(p.message), 400), level: 'error' }];
        default:
          return [];
      }
    }
    return [];
  }

  private item(p: Rec, at: number, id: (s: string) => string): TerminalEntry[] {
    switch (str(p.type)) {
      case 'message': {
        const role = str(p.role);
        const text = messageText(p.content).trim();
        if (!text) return [];
        if (role === 'user' && !isInjectedUserText(text)) return [{ kind: 'user', id: id('u'), at, text: clip(text, TEXT_MAX).text }];
        if (role === 'assistant') return [{ kind: 'assistant', id: id('a'), at, text: clip(text, TEXT_MAX).text }];
        return [];
      }
      case 'reasoning': {
        const summary = Array.isArray(p.summary) ? p.summary.map((s) => str(rec(s)?.text)).filter(Boolean).join('\n') : '';
        return [summary ? { kind: 'thinking', id: id('r'), at, text: clip(summary, 8000).text } : { kind: 'thinking', id: id('r'), at }];
      }
      case 'function_call':
      case 'custom_tool_call': {
        const name = str(p.name);
        const callId = str(p.call_id) || id('call');
        this.names.set(callId, name);
        if (p.type === 'custom_tool_call' && name === 'apply_patch') {
          const input = str(p.input);
          const files = patchFiles(input).map((f) => f.path);
          return [{ kind: 'tool', id: callId, at, tool: 'apply_patch', title: `Edit(${truncate(files.join(', ') || 'arquivos', 100)})`, input: clip(input, INPUT_MAX).text, inputKind: 'diff' }];
        }
        let args: Rec = {};
        try {
          args = rec(JSON.parse(str(p.arguments))) ?? {};
        } catch {
          // argumentos não-JSON
        }
        if (/^(exec_command|shell|shell_command|local_shell)$/.test(name)) {
          const cmd = commandOf(args);
          return [{ kind: 'tool', id: callId, at, tool: 'Bash', title: `Bash(${truncate(cmd, 100)})`, input: clip(cmd, INPUT_MAX).text, inputKind: 'command' }];
        }
        const raw = str(p.arguments) || str(p.input);
        return [{ kind: 'tool', id: callId, at, tool: name, title: `${name}()`, input: clip(raw, INPUT_MAX).text, inputKind: 'json' }];
      }
      case 'function_call_output':
      case 'custom_tool_call_output': {
        const callId = str(p.call_id);
        const outRaw = typeof p.output === 'string' ? p.output : str(rec(p.output)?.content) || JSON.stringify(p.output ?? '');
        const { text, exit } = cleanToolOutput(outRaw);
        const c = clip(text, RESULT_MAX, RESULT_MAX_LINES);
        const e: TerminalEntry = { kind: 'result', id: `${callId}-r`, at, toolUseId: callId, text: c.text || '(sem saída)' };
        if (exit !== undefined && exit !== 0) e.error = true;
        if (/aborted by user/.test(outRaw)) e.error = true;
        if (c.truncated) e.truncated = true;
        return [e];
      }
      default:
        return [];
    }
  }
}

export function createCodexTerminalParser(): TerminalParser {
  return new CodexTerminalParser();
}

/** A linha é de um rollout do Codex? ({timestamp, type: session_meta|response_item|event_msg|turn_context..., payload}) */
export function isCodexLine(line: string): boolean {
  return /^\{"timestamp":"[^"]+",(?:"ordinal":\d+,)?"type":"(session_meta|response_item|event_msg|turn_context|world_state|token_usage_record|compacted)"/.test(line);
}

/** Parser que decide pela primeira linha reconhecível: rollout do Codex ou transcript do Claude. */
export function createAutoTerminalParser(): TerminalParser {
  let inner: TerminalParser | undefined;
  return {
    push(line: string) {
      if (!inner) {
        if (!line.trim()) return [];
        inner = isCodexLine(line) ? createCodexTerminalParser() : createTerminalParser();
      }
      return inner.push(line);
    },
  };
}
