// Telas de seleção/diálogo no terminal do agente que o Habblaud não conhece (ex.: "Teach auto mode about your
// environment?", confiança na pasta, imports do CLAUDE.md, telas novas de versões futuras do Claude Code ou do Codex).
// Sem isto o agente ficava preso esperando uma tecla que ninguém via no escritório. O DialogWatcher lê a tela (tmux)
// dos agentes a cada poucos segundos e, se achar um diálogo, põe o trecho dele no snapshot (AgentInfo.dialog); o
// escritório mostra o trecho com os botões ↑ ↓ Enter Esc, que viram teclas no pane (pressKey).
// Pergunta com opções (AskUserQuestion) e pedido de permissão têm cartão próprio: aí o watcher fica de fora.
import type { AgentInfo, TerminalDialogInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import { AnswerError, classifyAskScreen } from './ask';
import { WAITING_FOR_QUESTION } from './service';

export const DIALOG_POLL_MS = 2_500;
/** Pausa depois de uma tecla, para o TUI redesenhar antes de a tela ser lida de novo. */
export const DIALOG_KEY_PAUSE_MS = 250;
export const WAITING_FOR_DIALOG = 'responder uma tela no terminal';
/** Teclas dos botões do escritório (nomes do tmux). */
export const DIALOG_KEYS = ['Up', 'Down', 'Enter', 'Escape'] as const;
export type DialogKey = (typeof DIALOG_KEYS)[number];
/** Linhas do trecho no máximo. */
const EXCERPT_MAX_LINES = 24;
const EXCERPT_MAX_CHARS = 4_000;

/**
 * Rodapé de diálogo de seleção. "esc to interrupt" (minúsculo, agente trabalhando) e o rodapé normal da caixa de
 * prompt ("? for shortcuts", "auto mode on") não entram.
 */
const FOOTER = /Enter to (confirm|select|continue|submit|choose)|Esc to (cancel|exit|go back|skip|close)|↑\/↓ to (navigate|select)|Arrow keys to navigate|[Pp]ress [Ee]nter to (confirm|continue)/;
const SEP = /^\s*[─━▔▁]{8,}/;
/** Linha com o cursor de seleção (❯ ou ›) apontando uma opção. */
const CURSOR = /^\s*[❯›>]\s*\S/;
/**
 * Telas sem cursor de seleção que esperam a pessoa (sem isto sumiam do escritório e o agente ficava com a mão
 * levantada sem nada para responder): o /login do Claude Code (link + "Paste code here", "OAuth error … Press Enter
 * to retry", "Login successful. Press Enter to continue…") e qualquer "Press Enter to retry/continue".
 */
const NO_CURSOR = /Paste code here|Login successful|OAuth error|Press Enter to (retry|continue)/;
/** Login com o campo de colar o código: a caixa de mensagem do chat manda o texto para ele. */
const LOGIN_INPUT = /Paste code here/;
export const isLoginDialog = (excerpt: string) => LOGIN_INPUT.test(excerpt);

/**
 * Trecho do diálogo de seleção na tela (texto puro do capture-pane), ou undefined se a tela não mostra um.
 * O trecho vai do separador que abre a caixa do diálogo (ou de até EXCERPT_MAX_LINES acima) até o rodapé.
 */
export function findDialog(text: string): string | undefined {
  const lines = text.replace(/\r/g, '').split('\n');
  let footer = -1;
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 12); i--) {
    if (FOOTER.test(lines[i])) {
      footer = i;
      break;
    }
  }
  if (footer < 0) return undefined;
  // fim: o rodapé pode quebrar em duas linhas num terminal estreito
  let end = footer;
  while (end + 1 < lines.length && lines[end + 1].trim() && !SEP.test(lines[end + 1])) end++;
  let start = Math.max(0, footer - EXCERPT_MAX_LINES);
  for (let i = footer - 1; i >= start; i--) {
    if (SEP.test(lines[i]) && lines.slice(i + 1, footer).some((l) => l.trim())) {
      start = i + 1;
      break;
    }
  }
  const block = lines.slice(start, end + 1);
  if (!block.some((l) => CURSOR.test(l) || NO_CURSOR.test(l))) return undefined;
  while (block.length && !block[0].trim()) block.shift();
  return block
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .slice(0, EXCERPT_MAX_CHARS);
}

export interface DialogInput {
  screen(id: string): Promise<string | undefined>;
  navKeys(id: string, keys: readonly DialogKey[]): Promise<void>;
}

export interface DialogWatcherOptions {
  office: { list(): AgentInfo[]; markDirty(): void };
  input: DialogInput;
  /** O agente já tem cartão próprio (pergunta com opções ou pedido de permissão): fica de fora. */
  covered: (agentId: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
  keyPauseMs?: number;
}

/** Põe o diálogo no agente do snapshot (cópia já clonada pelo Office): ele espera a pessoa. */
export function applyDialog(a: AgentInfo, d: TerminalDialogInfo | undefined): AgentInfo {
  if (!d || a.status === 'offline' || a.status === 'done' || a.question || a.permission) return a;
  a.dialog = d;
  a.status = 'waiting';
  if (!a.waitingFor || a.waitingFor === WAITING_FOR_QUESTION) a.waitingFor = WAITING_FOR_DIALOG;
  return a;
}

export class DialogWatcher {
  private dialogs = new Map<string, TerminalDialogInfo>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: DialogWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs ?? DIALOG_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get(): ReadonlyMap<string, TerminalDialogInfo> {
    return this.dialogs;
  }

  dialogOf(agentId: string): TerminalDialogInfo | undefined {
    return this.dialogs.get(agentId);
  }

  /** Lê a tela dos agentes principais abertos e atualiza o mapa (um por vez; uma rodada de cada vez). */
  async poll(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let changed = false;
      const alive = new Set<string>();
      for (const a of this.opts.office.list()) {
        if (a.kind !== 'main' || a.status === 'offline' || a.status === 'done' || a.setup) continue;
        alive.add(a.id);
        if (await this.check(a.id)) changed = true;
      }
      for (const id of [...this.dialogs.keys()]) {
        if (alive.has(id)) continue;
        this.dialogs.delete(id);
        changed = true;
      }
      if (changed) this.opts.office.markDirty();
    } finally {
      this.running = false;
    }
  }

  /** Relê a tela de um agente. Devolve true se o diálogo mudou (apareceu, sumiu ou trocou de texto). */
  private async check(id: string): Promise<boolean> {
    let text: string | undefined;
    try {
      text = await this.opts.input.screen(id);
    } catch (err) {
      log.warnOnce(`dialog:${id}`, `Não foi possível ler a tela do agente (${errMsg(err)}).`);
      text = undefined;
    }
    const before = this.dialogs.get(id);
    const excerpt = text !== undefined && !this.opts.covered(id) && !classifyAskScreen(text) ? findDialog(text) : undefined;
    if (!excerpt) {
      this.dialogs.delete(id);
      return !!before;
    }
    if (before?.text === excerpt) return false;
    this.dialogs.set(id, isLoginDialog(excerpt) ? { text: excerpt, at: this.now(), login: true } : { text: excerpt, at: this.now() });
    return true;
  }

  /** Aperta uma tecla no diálogo (botões do escritório) e relê a tela. Só com diálogo à mostra. */
  async pressKey(agentId: string, body: unknown): Promise<{ dialog: boolean }> {
    const key = (body as { key?: unknown } | undefined)?.key;
    if (typeof key !== 'string' || !(DIALOG_KEYS as readonly string[]).includes(key)) throw new AnswerError(400, 'tecla inválida (use Up, Down, Enter ou Escape)');
    if (!this.dialogs.has(agentId)) {
      if (await this.check(agentId)) this.opts.office.markDirty();
      if (!this.dialogs.has(agentId)) throw new AnswerError(404, 'a tela do terminal já mudou: confira de novo');
    }
    await this.opts.input.navKeys(agentId, [key as DialogKey]);
    await this.sleep(this.opts.keyPauseMs ?? DIALOG_KEY_PAUSE_MS);
    if (await this.check(agentId)) this.opts.office.markDirty();
    return { dialog: this.dialogs.has(agentId) };
  }
}
