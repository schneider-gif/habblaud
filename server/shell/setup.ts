// Agentes "em configuração": o escritório abriu um Claude no tmux ("+ Novo agente", sessão agente-*), mas ele ainda
// não criou a sessão em ~/.claude/sessions — na primeira execução o Claude Code para na escolha de tema e no login,
// e sem login nunca chega a existir sessão. Sem isto o escritório ficava vazio e o cliente não sabia que precisava
// entrar com a conta. Aqui cada sessão agente-* viva sem agente correspondente vira um boneco provisório na mesa,
// "precisa de você", e clicar nele abre o terminal embutido já anexado àquela sessão.
import type { AgentTmuxSession } from './service';

export interface SetupAgent {
  /** Id que o agente de verdade terá ("<conta>:<pid>", pid do pane = pid do Claude por causa do `exec claude`). */
  id: string;
  session: string;
  cwd: string;
  createdAt: number;
  status: 'idle' | 'waiting';
  waitingFor?: string;
}

/** Até quanto tempo depois de aberto o Claude ainda "está abrindo" (com login feito ele cria a sessão em ~2 s). */
export const SETUP_GRACE_MS = 15_000;
export const SETUP_POLL_MS = 3_000;
export const WAIT_LOGIN = 'conectar sua conta do Claude (clique para abrir o terminal)';
export const WAIT_SETUP = 'terminar a configuração do Claude no terminal (clique para abrir)';

/** Puro: quem vira boneco provisório. `hasAgentPid` diz se já existe agente principal com aquele pid. */
export function setupAgents(
  sessions: readonly AgentTmuxSession[],
  o: { account: string; hasAgentPid: (pid: number) => boolean; connected: boolean; now: number },
): SetupAgent[] {
  const out: SetupAgent[] = [];
  for (const s of sessions) {
    if (o.hasAgentPid(s.pid)) continue;
    const id = `${o.account}:${s.pid}`;
    const base = { id, session: s.session, cwd: s.cwd || '~', createdAt: s.createdAt || o.now };
    if (!o.connected) out.push({ ...base, status: 'waiting', waitingFor: WAIT_LOGIN });
    else if (o.now - base.createdAt < SETUP_GRACE_MS) out.push({ ...base, status: 'idle' });
    else out.push({ ...base, status: 'waiting', waitingFor: WAIT_SETUP });
  }
  return out;
}

/** Espera depois de a conta ganhar credencial antes de reiniciar (o agente que fez o login registra a sessão dele). */
export const RESTART_DELAY_MS = 6_000;

export interface SetupWatcherDeps {
  list: () => Promise<AgentTmuxSession[]>;
  /**
   * Reabre um agente que ficou parado no onboarding/login: os processos `claude` já abertos não releem a credencial
   * nova, então depois do login num deles os outros continuariam pedindo login. Só recebe sessões sem agente de
   * verdade (sem conversa), conferidas de novo na hora.
   */
  restart?: (s: AgentTmuxSession) => Promise<void>;
  connected: () => Promise<boolean>;
  /**
   * Conta pronta para os agentes reabertos não pararem em nada: credencial E onboarding do Claude concluído (tema
   * escolhido etc., hasCompletedOnboarding no ~/.claude.json). O reinício espera isto passar de falso a verdadeiro;
   * sem esta função, vale `connected`.
   */
  ready?: () => Promise<boolean>;
  hasAgentPid: (pid: number) => boolean;
  apply: (agents: SetupAgent[]) => void;
  account: string;
  now?: () => number;
}

export class SetupWatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** Conta pronta na última conferência (undefined = ainda não conferiu). */
  private lastReady: boolean | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: SetupWatcherDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.scan(), SETUP_POLL_MS);
    this.timer.unref?.();
    void this.scan();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.timer = null;
    this.restartTimer = null;
  }

  /** A conta passou a ter credencial: reabre os agentes que ainda estão no onboarding (depois de RESTART_DELAY_MS). */
  private scheduleRestart(): void {
    if (!this.deps.restart || this.restartTimer) return;
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.restartPending();
    }, RESTART_DELAY_MS);
    this.restartTimer.unref?.();
  }

  async restartPending(): Promise<number> {
    if (!this.deps.restart) return 0;
    let n = 0;
    for (const s of await this.deps.list().catch(() => [])) {
      if (this.deps.hasAgentPid(s.pid)) continue; // já tem conversa: nunca reinicia
      // Alguém está nela agora (normalmente onde o login acabou de ser feito, terminando o onboarding): não mexe.
      if ((s.attached ?? 0) > 0) continue;
      try {
        await this.deps.restart(s);
        n++;
      } catch {
        // pasta sumiu, tmux recusou: fica como está (o boneco continua pedindo a configuração)
      }
    }
    if (n) void this.scan();
    return n;
  }

  /** Confere já (agente acabou de ser aberto pelo escritório). */
  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const sessions = await this.deps.list();
      const connected = await this.deps.connected();
      const ready = connected && (this.deps.ready ? await this.deps.ready() : true);
      if (this.lastReady === false && ready && sessions.length) this.scheduleRestart();
      this.lastReady = ready;
      this.deps.apply(setupAgents(sessions, { account: this.deps.account, hasAgentPid: this.deps.hasAgentPid, connected, now: (this.deps.now ?? Date.now)() }));
    } catch {
      // tmux sumiu no meio: tenta de novo no próximo ciclo
    } finally {
      this.running = false;
    }
  }
}
