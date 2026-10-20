// Perguntas pendentes (AskUserQuestion) dos agentes e a resposta pelo chat do Habblaude.
// - A cada ~1,5 s confere o transcript dos agentes principais do Claude que estão esperando (status 'waiting' do
//   registro de sessões) e guarda a pergunta sem tool_result; o snapshot a leva em AgentInfo.question. Quando o
//   tool_result aparece (respondida aqui ou no próprio terminal), a pergunta some sozinha.
// - answer() dirige o diálogo do TUI pelo tmux, um passo por vez (askStep em ask.ts), relendo a tela depois de cada
//   tecla, e confere no transcript que a resposta chegou.
import { statSync } from 'node:fs';
import type { AgentInfo, AskQuestionInfo } from '../../shared/types';
import { hash32 } from '../../shared/hash';
import { errMsg, log } from '../log';
import { readTail, SCAN_TAIL_BYTES } from '../permissions/transcript';
import { AnswerError, answeredInLines, askStep, classifyAskScreen, cleanAnswers, matchQuestion, pendingAskFromLines, questionFromScreen } from './ask';

export const QUESTION_POLL_MS = 1_500;
/** Pausa depois de cada passo, para o TUI redesenhar antes de a tela ser lida de novo. */
export const STEP_PAUSE_MS = 220;
/** Passos no máximo (setas contam um passo por lote). */
export const MAX_STEPS = 80;
/** Tempo para o tool_result aparecer no transcript depois do envio. */
export const CONFIRM_MS = 10_000;
export const WAITING_FOR_QUESTION = 'responder uma pergunta';

export interface QuestionInput {
  /** Tela atual do pane do agente (texto puro); undefined = fora do tmux. */
  screen(id: string): Promise<string | undefined>;
  /** Teclas de navegação (Up, Down, Space, Enter, BSpace). */
  driveKeys(id: string, keys: readonly string[]): Promise<void>;
  /** Texto literal digitado no pane (campo "Outro"). */
  typeText(id: string, text: string): Promise<void>;
}

export interface QuestionServiceOptions {
  office: { list(): AgentInfo[]; markDirty(): void };
  transcriptPathOf: (agentId: string) => string | undefined;
  input?: QuestionInput;
  readLines?: (path: string) => string[];
  stat?: (path: string) => { mtimeMs: number; size: number } | undefined;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  stepPauseMs?: number;
  confirmMs?: number;
}

/** Põe a pergunta pendente no agente do snapshot (cópia já clonada pelo Office). */
export function applyQuestion(a: AgentInfo, q: AskQuestionInfo | undefined): AgentInfo {
  if (!q || a.status === 'offline' || a.status === 'done') return a;
  a.question = q;
  if (a.status === 'waiting' && !a.permission) a.waitingFor = WAITING_FOR_QUESTION;
  return a;
}

function defaultStat(path: string): { mtimeMs: number; size: number } | undefined {
  try {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

export class QuestionService {
  private pending = new Map<string, AskQuestionInfo>();
  private seen = new Map<string, { mtimeMs: number; size: number }>();
  private busy = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly readLines: (path: string) => string[];
  private readonly stat: (path: string) => { mtimeMs: number; size: number } | undefined;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly opts: QuestionServiceOptions) {
    this.readLines = opts.readLines ?? ((p) => readTail(p, SCAN_TAIL_BYTES));
    this.stat = opts.stat ?? defaultStat;
    this.sleep = opts.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms)));
    this.now = opts.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.poll();
      void this.pollScreens();
    }, this.opts.pollMs ?? QUESTION_POLL_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Perguntas pendentes por agente (para o snapshot). */
  get(): ReadonlyMap<string, AskQuestionInfo> {
    return this.pending;
  }

  pendingOf(agentId: string): AskQuestionInfo | undefined {
    return this.pending.get(agentId);
  }

  /** Confere os transcripts dos agentes que esperam (ou que tinham pergunta) e atualiza o mapa. */
  poll(): void {
    let changed = false;
    const alive = new Set<string>();
    for (const a of this.opts.office.list()) {
      if (a.kind !== 'main' || a.engine === 'codex' || a.status === 'offline' || a.status === 'done') continue;
      if (a.status !== 'waiting' && !this.pending.has(a.id)) continue;
      alive.add(a.id);
      if (this.check(a.id)) changed = true;
    }
    for (const id of [...this.pending.keys()]) {
      if (alive.has(id)) continue;
      this.pending.delete(id);
      this.seen.delete(id);
      changed = true;
    }
    if (changed) this.opts.office.markDirty();
  }

  /** Relê o fim do transcript (só se o arquivo mudou, a menos de `force`). Devolve true se a pergunta mudou. */
  private check(id: string, force = false): boolean {
    const path = this.opts.transcriptPathOf(id);
    if (!path) return false;
    const st = this.stat(path);
    if (!st) return false;
    const prev = this.seen.get(id);
    if (!force && prev && prev.mtimeMs === st.mtimeMs && prev.size === st.size) return false;
    this.seen.set(id, st);
    let q: AskQuestionInfo | undefined;
    try {
      q = pendingAskFromLines(this.readLines(path));
    } catch (err) {
      log.warnOnce(`question:${path}`, `Não foi possível ler o transcript para perguntas (${errMsg(err)}).`);
      return false;
    }
    const before = this.pending.get(id);
    if (q) this.pending.set(id, q);
    else if (before?.fromScreen) return false; // lida da tela: quem cuida é pollScreens
    else this.pending.delete(id);
    return before?.toolUseId !== q?.toolUseId;
  }

  private screening = false;

  /**
   * Fonte reserva: a tela do diálogo. O Claude Code 2.1.295 real só grava o tool_use do AskUserQuestion no transcript
   * depois da resposta, então para agentes esperando sem pergunta do transcript a pergunta sai do capture-pane.
   */
  async pollScreens(): Promise<void> {
    if (this.screening || !this.opts.input) return;
    this.screening = true;
    try {
      let changed = false;
      for (const a of this.opts.office.list()) {
        if (a.kind !== 'main' || a.engine === 'codex' || a.status === 'offline' || a.status === 'done') continue;
        const cur = this.pending.get(a.id);
        if (cur && !cur.fromScreen) continue;
        if (a.status !== 'waiting' && !cur) continue;
        if (await this.checkScreen(a.id)) changed = true;
      }
      if (changed) this.opts.office.markDirty();
    } finally {
      this.screening = false;
    }
  }

  /** Relê a tela do agente e atualiza a pergunta lida dela. Devolve true se mudou. */
  private async checkScreen(id: string): Promise<boolean> {
    let text: string | undefined;
    try {
      text = await this.opts.input?.screen(id);
    } catch {
      text = undefined;
    }
    const before = this.pending.get(id);
    if (before && !before.fromScreen) return false;
    const screen = text === undefined ? undefined : classifyAskScreen(text);
    const question = screen?.kind === 'question' ? questionFromScreen(screen) : undefined;
    if (!question || screen?.kind !== 'question') {
      if (!before) return false;
      this.pending.delete(id);
      return true;
    }
    const toolUseId = `screen:${hash32(JSON.stringify(question)).toString(36)}`;
    if (before?.toolUseId === toolUseId) return false;
    this.pending.set(id, { toolUseId, questions: [question], createdAt: this.now(), fromScreen: { tabs: screen.tabs } });
    return true;
  }

  /**
   * Responde a pergunta pendente pelo tmux. Lança AnswerError (status HTTP) se a pergunta já foi respondida, se o
   * agente não roda no tmux ou se a tela não mostra o diálogo esperado. `answered` = o tool_result chegou a tempo.
   */
  async answer(agentId: string, body: unknown): Promise<{ answered: boolean }> {
    const input = this.opts.input;
    if (!input) throw new AnswerError(403, 'responder perguntas pelo escritório está desligado aqui');
    const b = body && typeof body === 'object' ? (body as { toolUseId?: unknown; answers?: unknown }) : {};
    if (this.check(agentId, true)) this.opts.office.markDirty();
    if (!this.pending.has(agentId) || this.pending.get(agentId)?.fromScreen) await this.checkScreen(agentId);
    const q = this.pending.get(agentId);
    if (!q || (typeof b.toolUseId === 'string' && b.toolUseId !== q.toolUseId)) throw new AnswerError(404, 'esta pergunta já foi respondida');
    const answers = cleanAnswers(b.answers, q.questions);
    if (this.busy.has(agentId)) throw new AnswerError(409, 'já estou enviando a resposta desta pergunta');
    this.busy.add(agentId);
    try {
      let steps = 0;
      let last = '';
      let repeats = 0;
      for (;;) {
        const text = await input.screen(agentId);
        if (text === undefined) throw new AnswerError(409, 'este agente não roda no tmux: responda no terminal dele');
        const screen = classifyAskScreen(text);
        if (!screen) {
          if (steps > 0) break; // o diálogo fechou: enviado
          throw new AnswerError(409, 'o diálogo da pergunta não está aberto no terminal do agente');
        }
        // Lida da tela (uma aba por vez): a aba respondida deu lugar à próxima pergunta. Ela aparece no próximo cartão.
        if (q.fromScreen && steps > 0 && screen.kind === 'question' && matchQuestion(screen.head, q.questions) < 0) break;
        if (++steps > MAX_STEPS) throw new AnswerError(409, 'não consegui completar o diálogo da pergunta: responda no terminal');
        const step = askStep(screen, q.questions, answers);
        if ('error' in step) throw new AnswerError(409, `${step.error}: responda no terminal`);
        const key = JSON.stringify(step) + text;
        repeats = key === last ? repeats + 1 : 0;
        last = key;
        if (repeats >= 3) throw new AnswerError(409, 'o terminal não reagiu às teclas: responda no terminal');
        if ('text' in step) {
          // driveKeys aceita até 40 teclas por vez: apaga em lotes.
          for (let left = step.erase; left > 0; left -= 40) await input.driveKeys(agentId, Array.from({ length: Math.min(40, left) }, () => 'BSpace'));
          await input.typeText(agentId, step.text);
        } else await input.driveKeys(agentId, step.keys);
        await this.sleep(this.opts.stepPauseMs ?? STEP_PAUSE_MS);
      }
      if (q.fromScreen) {
        // Sem id do tool_use para conferir no transcript: vale a tela (o diálogo fechou ou foi para a próxima aba).
        this.pending.delete(agentId);
        await this.checkScreen(agentId);
        this.opts.office.markDirty();
        return { answered: true };
      }
      // Confere no transcript (o tool_result chega logo depois do envio).
      const path = this.opts.transcriptPathOf(agentId);
      const until = this.now() + (this.opts.confirmMs ?? CONFIRM_MS);
      let answered = false;
      while (path && !answered) {
        try {
          answered = answeredInLines(this.readLines(path), q.toolUseId);
        } catch {
          // transcript sumiu: fica sem confirmação
          break;
        }
        if (answered || this.now() >= until) break;
        await this.sleep(250);
      }
      if (this.check(agentId, true)) this.opts.office.markDirty();
      return { answered };
    } finally {
      this.busy.delete(agentId);
    }
  }
}
