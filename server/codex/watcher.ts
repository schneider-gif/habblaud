// Fonte "codex": observa as conversas ABERTAS do Codex CLI (OpenAI) e as põe no escritório no mesmo modelo dos agentes
// do Claude. A cada ~1 s: travas abertas (proc.ts) -> agente "<conta>:<pid>"; rollout (rollout.ts) -> atividades,
// título, tarefas e números; tela do tmux (screen.ts, a cada ~1,5 s) -> "precisa de você" (aprovação, login,
// confiança na pasta). Só leitura: nada aqui escreve nos arquivos do Codex.
import { basename } from 'node:path';
import { describeCommand } from '../../shared/activity';
import type { AgentStatus, PermissionRequestInfo, ShellJob, SourceInfo } from '../../shared/types';
import { errMsg, log } from '../log';
import type { Office, TranscriptSummary } from '../model/office';
import { FileTail } from '../sources/tail';
import { codexTitle, createCodexState, likelyApproval, parseCodexLine, type CodexPendingCall, type CodexState } from './rollout';
import { agentPidOf, findRollout, isDaemonCmdline, openThreads, realProc, type ProcReader } from './proc';
import { classifyCodexScreen, type CodexScreen } from './screen';

/** Lê a tela do pane do tmux de um processo (undefined = fora do tmux ou sem tmux). */
export type ScreenReader = (pid: number) => Promise<string | undefined>;

export interface CodexWatcherOptions {
  dirs: () => readonly string[];
  office: Office;
  proc?: ProcReader;
  screen?: ScreenReader;
  now?: () => number;
  pollMs?: number;
  screenMs?: number;
  tailBytes?: number;
}

interface Tracker {
  id: string;
  account: string;
  dir: string;
  threadId: string;
  pid?: number;
  daemon: boolean;
  rollout?: string;
  nextFindAt: number;
  finds: number;
  tail?: FileTail;
  state: CodexState;
  inOffice: boolean;
  missingSince?: number;
  screen?: CodexScreen;
  screenAt?: number;
  /** A tela mostrou um pedido de aprovação: quando começou (para o "desde" do pedido). */
  approvalSince?: number;
  /** Linhas lidas do rollout antes de o agente entrar no escritório. */
  backlog?: string[];
  /** Pasta do session_meta do rollout (antes de aplicar as linhas). */
  metaCwd?: string;
}

/** Pedido de aprovação do Codex que dá para responder pelo escritório (ver approvals.ts). */
export interface CodexApproval {
  agentId: string;
  pid: number;
  info: PermissionRequestInfo;
  screen: Extract<CodexScreen, { kind: 'approval' }>;
}

const CLOSE_AFTER_MISSING_MS = 1_500;
/** Pedido de aprovação sem resposta pelo escritório "expira" para o cliente só depois disso (fica no terminal). */
const APPROVAL_TTL_MS = 6 * 3600_000;

export const WAIT_APPROVE_COMMAND = 'aprovar um comando do Codex';
export const WAIT_APPROVE_EDIT = 'aprovar uma edição do Codex';
export const WAIT_LOGIN = 'conectar sua conta OpenAI (clique para abrir o terminal)';
export const WAIT_TRUST = 'confiar nesta pasta (responda no terminal)';

/** Texto da opção "não perguntar de novo" do Codex, em português (o prefixo do comando vem da própria tela). */
export function alwaysRuleText(key: 'p' | 'a', label: string): string {
  if (key === 'a') return 'Não perguntar de novo para estes arquivos';
  const prefix = /start with `([^`]+)`/.exec(label)?.[1];
  return prefix ? `Não perguntar de novo para comandos que começam com \`${prefix}\`` : 'Não perguntar de novo para este comando';
}

export class CodexWatcher {
  private trackers = new Map<string, Tracker>();
  private sourceInfo = new Map<string, SourceInfo>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private screenTimer: ReturnType<typeof setInterval> | null = null;
  private screening = false;
  private readonly now: () => number;
  private readonly proc: ProcReader;
  private readonly tailBytes: number;

  constructor(private readonly opts: CodexWatcherOptions) {
    this.now = opts.now ?? Date.now;
    this.proc = opts.proc ?? realProc;
    this.tailBytes = opts.tailBytes ?? 1024 * 1024;
  }

  start(): void {
    this.boot();
    this.timer = setInterval(() => this.safePoll(), this.opts.pollMs ?? 1_000);
    this.timer.unref?.();
    if (this.opts.screen) {
      this.screenTimer = setInterval(() => void this.scanScreens(), this.opts.screenMs ?? 1_500);
      this.screenTimer.unref?.();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.screenTimer) clearInterval(this.screenTimer);
    this.timer = null;
    this.screenTimer = null;
  }

  boot(): void {
    this.opts.office.beginBoot();
    try {
      this.poll(true);
    } finally {
      this.opts.office.endBoot();
    }
  }

  sources(): SourceInfo[] {
    return this.opts.dirs().map((d) => this.sourceInfo.get(d) ?? { label: basename(d), path: d, sessions: 0, ok: true });
  }

  /** Rollout de um agente do Codex presente (terminal da conversa). */
  transcriptPathOf(agentId: string): string | undefined {
    return this.trackers.get(agentId)?.rollout;
  }

  /** Sessões abertas por conta (para o "sessions" das contas). */
  sessionsByAccount(): Map<string, number> {
    const m = new Map<string, number>();
    for (const t of this.trackers.values()) if (t.inOffice) m.set(t.account, (m.get(t.account) ?? 0) + 1);
    return m;
  }

  /** Pid do agente (para mandar mensagens/teclas pelo tmux): só TUIs, nunca o daemon. */
  pidOf(agentId: string): number | undefined {
    const t = this.trackers.get(agentId);
    return t && !t.daemon ? t.pid : undefined;
  }

  has(agentId: string): boolean {
    return this.trackers.get(agentId)?.inOffice === true;
  }

  /** Pedidos de aprovação vistos na tela agora. */
  approvals(): CodexApproval[] {
    const out: CodexApproval[] = [];
    for (const t of this.trackers.values()) {
      if (!t.inOffice || t.daemon || !t.pid || t.screen?.kind !== 'approval') continue;
      const sc = t.screen;
      const createdAt = t.approvalSince ?? this.now();
      const pend = this.pendingFor(t, sc);
      const command = sc.command ?? pend?.detail;
      const edit = sc.what === 'edit';
      const info: PermissionRequestInfo = {
        id: `codex-${t.threadId}-${pend?.callId ?? createdAt}`,
        tool: edit ? 'Edit' : 'Bash',
        title: edit ? `Edit(${command ?? 'arquivos'})` : `Bash(${command ?? 'comando'})`,
        text: edit ? 'Editar arquivos' : command ? describeCommand(command).text : 'Rodar um comando',
        icon: edit ? '✏️' : '💻',
        createdAt,
        expiresAt: createdAt + APPROVAL_TTL_MS,
      };
      const reason = sc.reason ?? pend?.justification;
      if (command || reason) {
        info.input = [command ? (edit ? command : `$ ${command}`) : undefined, reason ? `Motivo: ${reason}` : undefined].filter(Boolean).join('\n');
        info.inputKind = edit ? 'text' : 'command';
      }
      if (sc.alwaysKey && sc.alwaysLabel) info.suggestions = [{ index: 0, rules: [alwaysRuleText(sc.alwaysKey, sc.alwaysLabel)], destination: 'session' }];
      out.push({ agentId: t.id, pid: t.pid, info, screen: sc });
    }
    return out;
  }

  private pendingFor(t: Tracker, sc: Extract<CodexScreen, { kind: 'approval' }>): CodexPendingCall | undefined {
    const want = sc.what === 'edit' ? 'patch' : 'command';
    let best: CodexPendingCall | undefined;
    for (const c of t.state.pending.values()) if (c.kind === want && (!best || c.at > best.at)) best = c;
    return best;
  }

  // ---------------------------------------------------------------- polling

  private safePoll(): void {
    try {
      this.poll(false);
    } catch (err) {
      log.warnOnce(`codex-poll:${errMsg(err)}`, `Codex: falha no ciclo de leitura: ${errMsg(err)}`);
    }
  }

  poll(boot = false): void {
    const now = this.now();
    const seen = new Set<string>();
    for (const dir of this.opts.dirs()) {
      const account = basename(dir);
      let threads;
      try {
        threads = openThreads(dir, this.proc);
      } catch (err) {
        this.sourceInfo.set(dir, { label: account, path: dir, sessions: 0, ok: false, error: errMsg(err) });
        continue;
      }
      this.sourceInfo.set(dir, { label: account, path: dir, sessions: threads.length, ok: true });
      for (const th of threads) {
        const holder = th.holder;
        const daemon = holder !== undefined && isDaemonCmdline(this.proc.cmdline(holder));
        const pid = holder !== undefined && !daemon ? agentPidOf(holder, this.proc) : undefined;
        const id = pid !== undefined ? `${account}:${pid}` : `${account}:t-${th.threadId.slice(0, 13)}`;
        seen.add(id);
        let t = this.trackers.get(id);
        if (t && t.threadId !== th.threadId) {
          // Mesmo processo, conversa nova (/new no Codex): mesmo boneco, rollout novo.
          t = { ...this.newTracker(id, account, dir, th.threadId, pid, daemon), inOffice: t.inOffice };
          this.trackers.set(id, t);
          if (t.inOffice) this.opts.office.switchSession(id, th.threadId);
        }
        if (!t) {
          t = this.newTracker(id, account, dir, th.threadId, pid, daemon);
          this.trackers.set(id, t);
        }
        delete t.missingSince;
        try {
          this.sync(t, boot);
        } catch (err) {
          log.warnOnce(`codex:${id}:${errMsg(err)}`, `Codex ${id}: ${errMsg(err)}`);
        }
      }
    }
    for (const [id, t] of [...this.trackers]) {
      if (seen.has(id)) continue;
      t.missingSince ??= now;
      if (!boot && now - t.missingSince < CLOSE_AFTER_MISSING_MS) continue;
      this.trackers.delete(id);
      if (t.inOffice) this.opts.office.closeMain(id);
    }
  }

  private newTracker(id: string, account: string, dir: string, threadId: string, pid: number | undefined, daemon: boolean): Tracker {
    return { id, account, dir, threadId, pid, daemon, nextFindAt: 0, finds: 0, state: createCodexState(), inOffice: false };
  }

  private sync(t: Tracker, boot: boolean): void {
    const office = this.opts.office;
    const now = this.now();
    if (!t.rollout && now >= t.nextFindAt) {
      // Antes da primeira mensagem o rollout não existe: procura no dia da conversa (UUIDv7) e, de vez em quando, em tudo.
      t.finds++;
      t.rollout = findRollout(t.dir, t.threadId, now, t.finds % 10 === 1);
      t.nextFindAt = now + 1_000;
      if (t.rollout) this.load(t);
    }
    if (!t.inOffice) {
      const cwd = t.state.cwd ?? t.metaCwd ?? (t.pid ? this.proc.cwd(t.pid) : undefined);
      // Conversa do daemon ainda sem rollout: sem pasta não dá para pôr numa sala; espera a primeira mensagem.
      if (!cwd) return;
      office.addMain({
        id: t.id,
        account: t.account,
        sessionId: t.threadId,
        cwd,
        role: 'Agente principal',
        startedAt: t.state.firstAt ?? now,
        status: t.state.turnOpen ? 'working' : 'idle',
        engine: 'codex',
      });
      t.inOffice = true;
      if (t.tail) this.replay(t);
      this.applySummary(t);
    } else if (t.tail) {
      this.pump(t, !boot);
    }
    this.applyStatus(t);
  }

  /** Abre o rollout: lê o fim (≈1 MB) agora; as atividades vão para o escritório quando o agente entrar. */
  private load(t: Tracker): void {
    if (!t.rollout) return;
    t.tail = new FileTail(t.rollout);
    t.tail.seekTail(this.tailBytes);
    t.state = createCodexState();
    t.backlog = [];
    for (let i = 0; i < 64; i++) {
      const r = t.tail.read();
      for (const line of r.lines) t.backlog.push(line);
      if (!r.more) break;
    }
    for (const line of t.backlog.slice(0, 40)) {
      try {
        const j = JSON.parse(line) as { type?: string; payload?: { cwd?: unknown } };
        if ((j.type === 'session_meta' || j.type === 'turn_context') && typeof j.payload?.cwd === 'string' && j.payload.cwd) {
          t.metaCwd = j.payload.cwd;
          break;
        }
      } catch {
        // linha cortada
      }
    }
  }

  /** Aplica as linhas já lidas (carga inicial: sem feed nem avisos). */
  private replay(t: Tracker): void {
    const lines = t.backlog ?? [];
    t.backlog = [];
    this.apply(t, lines, false);
  }

  private pump(t: Tracker, live: boolean): void {
    if (!t.tail) return;
    if (t.backlog?.length) this.replay(t);
    for (let i = 0; i < 4; i++) {
      const r = t.tail.read();
      if (r.reset) {
        this.load(t);
        this.replay(t);
        return;
      }
      if (r.lines.length) this.apply(t, r.lines, live);
      if (!r.more) break;
    }
  }

  private apply(t: Tracker, lines: readonly string[], live: boolean): void {
    if (!lines.length) return;
    const office = this.opts.office;
    for (const line of lines) {
      const r = parseCodexLine(t.state, line, { idPrefix: t.id, now: this.now() });
      for (const a of r.activities) office.addActivity(t.id, a.activity, a.current, { feed: live });
    }
    this.applySummary(t);
  }

  private applySummary(t: Tracker): void {
    const s = t.state;
    const summary: TranscriptSummary = { tasks: s.tasks, stats: { ...s.stats } };
    const title = codexTitle(s);
    if (title) summary.title = title;
    else if (!s.prompts) summary.title = 'Codex pronto: mande a primeira mensagem';
    if (s.model) summary.model = s.model;
    if (s.approvalPolicy) summary.permissionMode = s.approvalPolicy;
    if (s.lastAt !== undefined) summary.lastAt = s.lastAt;
    this.opts.office.applyTranscript(t.id, summary);
  }

  private applyStatus(t: Tracker): void {
    const office = this.opts.office;
    const now = this.now();
    let status: AgentStatus = t.state.turnOpen ? 'working' : 'idle';
    let waitingFor: string | undefined;
    const sc = t.screen;
    if (sc?.kind === 'approval') {
      status = 'waiting';
      waitingFor = sc.what === 'edit' ? WAIT_APPROVE_EDIT : WAIT_APPROVE_COMMAND;
    } else if (sc?.kind === 'login') {
      status = 'waiting';
      waitingFor = WAIT_LOGIN;
    } else if (sc?.kind === 'trust') {
      status = 'waiting';
      waitingFor = WAIT_TRUST;
    } else if (!sc && t.state.turnOpen) {
      // Sem tela para conferir (fora do tmux): saída do sandbox pedida pelo modelo e sem resultado = aprovação.
      const c = likelyApproval(t.state, now);
      if (c) {
        status = 'waiting';
        waitingFor = c.kind === 'patch' ? WAIT_APPROVE_EDIT : WAIT_APPROVE_COMMAND;
      }
    }
    // Comando em primeiro plano ainda sem resultado: o boneco espera o comando (não "pensa").
    const jobs: ShellJob[] = [];
    if (status === 'working') {
      for (const c of t.state.pending.values()) {
        if (c.kind !== 'command') continue;
        const job: ShellJob = { id: c.callId, label: c.detail ? describeCommand(c.detail).text : 'Comando no terminal', startedAt: c.at, background: false, kind: 'shell' };
        if (c.detail) job.command = c.detail;
        jobs.push(job);
      }
    }
    office.setShells(t.id, jobs);
    office.setStatus(t.id, status, waitingFor);
    office.fillWorkingActivity(t.id);
  }

  /** Lê a tela dos agentes no tmux (aprovação, login, confiança). */
  async scanScreens(): Promise<void> {
    const read = this.opts.screen;
    if (!read || this.screening) return;
    this.screening = true;
    try {
      for (const t of [...this.trackers.values()]) {
        if (t.daemon || !t.pid || !t.inOffice) continue;
        let text: string | undefined;
        try {
          text = await read(t.pid);
        } catch {
          text = undefined;
        }
        const sc = text === undefined ? undefined : classifyCodexScreen(text);
        const before = JSON.stringify(t.screen ?? null);
        t.screen = sc;
        t.screenAt = this.now();
        if (sc?.kind === 'approval') t.approvalSince ??= this.now();
        else delete t.approvalSince;
        if (JSON.stringify(sc ?? null) !== before && this.trackers.get(t.id) === t) {
          this.applyStatus(t);
          // O pedido (approvals) entra no snapshot pelo mapa de permissões: o status pode não ter mudado (já era
          // "esperando" pela chamada pendente), então avisa a mudança mesmo assim.
          this.opts.office.markDirty();
        }
      }
    } finally {
      this.screening = false;
    }
  }

  /** Confere a tela de um agente agora (antes de mandar uma tecla de aprovação). */
  async screenOf(agentId: string): Promise<CodexScreen | undefined> {
    const t = this.trackers.get(agentId);
    if (!t?.pid || t.daemon || !this.opts.screen) return undefined;
    const text = await this.opts.screen(t.pid).catch(() => undefined);
    return text === undefined ? undefined : classifyCodexScreen(text);
  }

  /** Força uma releitura da tela (depois de responder). */
  refresh(agentId: string): void {
    const t = this.trackers.get(agentId);
    if (t) {
      delete t.screen;
      delete t.approvalSince;
      this.applyStatus(t);
      this.opts.office.markDirty();
    }
    void this.scanScreens();
  }
}

