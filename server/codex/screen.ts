// O que a tela do Codex (TUI no tmux) está pedindo. O rollout não registra pedidos de aprovação nem a tela de login,
// então o Habblaud lê a tela do pane (tmux capture-pane) e reconhece os textos fixos do Codex CLI 0.162.1:
//
//   aprovação de comando:  "Would you like to run the following command?"  1. Yes, proceed (y)
//                          2. Yes, and don't ask again for commands that start with `…` (p)   3. No, … (esc)
//   aprovação de edição:   "Would you like to make the following edits?"   1. Yes, proceed (y)
//                          2. Yes, and don't ask again for these files (a)  3. No, … (esc)
//   login:                 "Sign in with ChatGPT" / "Sign in with Device Code" / "Provide your own API key"
//   confiança na pasta:    "Trust this folder?"  1. Trust and continue
//
// As teclas de resposta (y / p / a / Esc) são as que o próprio Codex mostra entre parênteses. Código puro.

export type CodexScreen =
  | { kind: 'approval'; what: 'command' | 'edit' | 'other'; command?: string; reason?: string; alwaysKey?: 'p' | 'a'; alwaysLabel?: string }
  | { kind: 'login' }
  | { kind: 'trust' }
  | { kind: 'normal' };

/** Linhas não vazias da tela, sem espaços à direita. */
function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.replace(/\s+$/, ''));
}

/** Classifica a tela capturada do pane do Codex. */
export function classifyCodexScreen(text: string): CodexScreen {
  const t = text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
  if (/Would you like to (run the following command|make the following edits|allow|grant)/i.test(t) && /Yes, proceed/i.test(t)) {
    const ls = lines(t);
    const what: 'command' | 'edit' | 'other' = /make the following edits/i.test(t) ? 'edit' : /run the following command/i.test(t) ? 'command' : 'other';
    const out: CodexScreen = { kind: 'approval', what };
    const cmd = ls.map((l) => /^\s*\$ (.+)$/.exec(l)?.[1]).filter(Boolean).pop();
    if (cmd) out.command = cmd.trim().slice(0, 300);
    const reason = ls.map((l) => /^\s*(?:Reason|Description): (.+)$/.exec(l)?.[1]).filter(Boolean).pop();
    if (reason) out.reason = reason.trim().slice(0, 200);
    const always = ls.map((l) => /2\.\s*(Yes, and don't ask again[^(]*)\((p|a)\)/.exec(l)).find(Boolean);
    if (always) {
      out.alwaysKey = always[2] as 'p' | 'a';
      out.alwaysLabel = always[1].trim().replace(/\s+/g, ' ').slice(0, 160);
    }
    return out;
  }
  if (/Sign in with ChatGPT/i.test(t) && /(Device Code|API key)/i.test(t)) return { kind: 'login' };
  if (/Trust this folder\?/i.test(t) && /Trust and continue/i.test(t)) return { kind: 'trust' };
  return { kind: 'normal' };
}

/** Tecla do tmux para cada decisão num pedido de aprovação do Codex. */
export function approvalKey(decision: 'allow' | 'always' | 'deny', screen: Extract<CodexScreen, { kind: 'approval' }>): string {
  if (decision === 'deny') return 'Escape';
  if (decision === 'always' && screen.alwaysKey) return screen.alwaysKey;
  return 'y';
}
