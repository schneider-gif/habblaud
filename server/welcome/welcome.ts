// Agente de boas-vindas (docs/BOAS-VINDAS.md): na primeira abertura do escritório, um cartão com 3 sugestões de
// primeira tarefa. Clicar abre um agente de verdade (o mesmo spawn do "+ Novo agente") e manda a sugestão como
// primeira mensagem assim que o Claude estiver pronto. Pular (ou usar) grava a decisão no state.json do servidor:
// o cartão nunca mais aparece, em nenhum navegador.
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WELCOME_SUGGESTIONS, type WelcomeChoice, type WelcomeDelivery, type WelcomeView } from '../../shared/welcome';
import { InputError } from '../input/tmux';
import { errMsg, log } from '../log';
import type { ServerStateKey } from '../model/state';

/** Chave do registro no state.json (só o servidor grava). */
export const WELCOME_KEY: ServerStateKey = 'habblaud.boasvindas.v1';

/** Espera entre conferências da entrega. */
export const DELIVERY_POLL_MS = 1_000;
/** Agente presente há tanto tempo sem a tela parar de mudar: manda assim mesmo. */
export const DELIVERY_SETTLE_MAX_MS = 8_000;
/** Desiste da entrega depois disso (cobre tema/configuração terminados no terminal). */
export const DELIVERY_TIMEOUT_MS = 10 * 60_000;
/** Tentativas de envio (tmux recusou, pid trocou no meio). */
const SEND_ATTEMPTS = 3;

export type WelcomeRecord =
  | { state: 'pending'; since: number }
  | { state: 'done'; how: 'skipped' | 'used' | 'auto'; choice?: WelcomeChoice; at: number };

/** HABBLAUD_BOAS_VINDAS=0 (ou false/off/não) desliga o cartão de vez. */
export function welcomeOff(env: NodeJS.ProcessEnv): boolean {
  const v = env.HABBLAUD_BOAS_VINDAS?.trim().toLowerCase();
  return v === '0' || v === 'false' || v === 'off' || v === 'nao' || v === 'não';
}

/** Leitura defensiva do registro salvo (texto JSON); qualquer coisa torta = sem registro. */
export function parseWelcomeRecord(raw: string | undefined): WelcomeRecord | undefined {
  if (!raw) return undefined;
  try {
    const o = JSON.parse(raw) as Partial<Record<string, unknown>>;
    if (o?.state === 'pending' && typeof o.since === 'number') return { state: 'pending', since: o.since };
    if (o?.state === 'done' && (o.how === 'skipped' || o.how === 'used' || o.how === 'auto') && typeof o.at === 'number') {
      const choice = WELCOME_SUGGESTIONS.find((s) => s.id === o.choice)?.id;
      return { state: 'done', how: o.how, at: o.at, ...(choice ? { choice } : {}) };
    }
  } catch {
    // ilegível: trata como primeira vez
  }
  return undefined;
}

export function cleanChoice(v: unknown): WelcomeChoice {
  const s = WELCOME_SUGGESTIONS.find((x) => x.id === v);
  if (!s) throw new InputError(400, 'sugestão desconhecida');
  return s.id;
}

/** Há algum arquivo com o sufixo até `depth` níveis abaixo de `dir`? (Para cedo no primeiro.) */
async function hasFile(dir: string, suffix: string, depth: number): Promise<boolean> {
  let ents;
  try {
    ents = await readdir(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of ents) if (e.isFile() && e.name.endsWith(suffix)) return true;
  if (depth <= 0) return false;
  for (const e of ents) if (e.isDirectory() && (await hasFile(join(dir, e.name), suffix, depth - 1))) return true;
  return false;
}

/**
 * Já houve uso do Claude Code ou do Codex nesta máquina? Alguma conversa em `<conta>/projects/<pasta>/*.jsonl` ou
 * em `<CODEX_HOME>/sessions/AAAA/MM/DD/*.jsonl`. Quem já usava não vê o cartão (atualização de quem já é cliente).
 */
export async function hasConversations(claudeDirs: readonly string[], codexDirs: readonly string[]): Promise<boolean> {
  for (const d of claudeDirs) if (await hasFile(join(d, 'projects'), '.jsonl', 1)) return true;
  for (const d of codexDirs) if (await hasFile(join(d, 'sessions'), '.jsonl', 3)) return true;
  return false;
}

/** 409 de conta sem login: o cartão volta ao passo "conecte sua conta". */
export class WelcomeLoginError extends InputError {
  readonly login = true;
  constructor() {
    super(409, 'conecte sua conta do Claude primeiro');
  }
}

export interface WelcomeDeps {
  store: { getServer(key: ServerStateKey): string | undefined; setServer(key: ServerStateKey, value: string): void };
  /** Cartão ligado (sem HABBLAUD_BOAS_VINDAS=0 e com o recurso de abrir agentes). */
  enabled: () => boolean;
  /** Conta do Claude conectada (missions/auth.ts). */
  loggedIn: () => Promise<boolean>;
  /** Já usava o Claude/Codex antes (só na primeira consulta; ver hasConversations). */
  usedBefore: () => Promise<boolean>;
  /** Abre o agente (o mesmo input.spawn do POST /api/agents/new, motor Claude). */
  spawn: (cwd: string) => Promise<{ cwd: string; pid?: number }>;
  /** O agente já chegou ao escritório (principal, não offline): o Claude criou a sessão. Mesmo critério do SetupWatcher. */
  agentReady: (id: string) => boolean;
  /** Recebe mensagens pelo tmux (input.available). */
  available: (id: string) => Promise<boolean>;
  /** Tela do pane (input.screen): esperar ela parar de mudar antes de colar o texto. */
  screen: (id: string) => Promise<string | undefined>;
  /** Envio normal (input.send): buffer + bracketed paste + Enter. */
  send: (id: string, text: string) => Promise<void>;
  /** Conta do agente aberto (padrão: .claude). */
  account?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export class WelcomeService {
  private delivery: (WelcomeDelivery & { text: string }) | undefined;
  private starting = false;
  /** Entrega em andamento (os testes esperam por ela). */
  pending: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: WelcomeDeps) {
    this.now = d.now ?? Date.now;
    this.sleep = d.sleep ?? ((ms) => new Promise((ok) => setTimeout(ok, ms).unref?.()));
  }

  private record(): WelcomeRecord | undefined {
    return parseWelcomeRecord(this.d.store.getServer(WELCOME_KEY));
  }

  private save(r: WelcomeRecord): void {
    this.d.store.setServer(WELCOME_KEY, JSON.stringify(r));
  }

  private deliveryView(): WelcomeDelivery | undefined {
    return this.delivery ? { agentId: this.delivery.agentId, state: this.delivery.state } : undefined;
  }

  /** Registro atual; na primeira consulta decide entre pendente e "já era cliente". */
  private async ensureRecord(): Promise<WelcomeRecord> {
    const r = this.record();
    if (r) return r;
    let used = false;
    try {
      used = await this.d.usedBefore();
    } catch {
      // sem como conferir: mostra (pular é um clique)
    }
    const next: WelcomeRecord = used ? { state: 'done', how: 'auto', at: this.now() } : { state: 'pending', since: this.now() };
    // outra consulta pode ter gravado no meio: vale a primeira
    const again = this.record();
    if (again) return again;
    this.save(next);
    return next;
  }

  async view(): Promise<WelcomeView> {
    const suggestions = WELCOME_SUGGESTIONS.map((s) => ({ ...s }));
    const delivery = this.deliveryView();
    if (!this.d.enabled()) return { state: 'off', suggestions, ...(delivery ? { delivery } : {}) };
    const r = await this.ensureRecord();
    if (r.state === 'done') return { state: 'done', suggestions, ...(delivery ? { delivery } : {}) };
    const logged = await this.d.loggedIn().catch(() => false);
    return { state: logged ? 'ready' : 'login', suggestions };
  }

  /** "✕ Pular": nunca mais aparece. Vale também sem login. */
  skip(): void {
    if (!this.d.enabled()) throw new InputError(403, 'boas-vindas desligadas neste escritório');
    if (this.record()?.state === 'done') return;
    this.save({ state: 'done', how: 'skipped', at: this.now() });
  }

  /** Clique numa sugestão: abre o agente e começa a entrega da primeira mensagem. */
  async start(choiceRaw: unknown): Promise<{ agentId?: string; cwd: string; choice: WelcomeChoice }> {
    const choice = cleanChoice(choiceRaw);
    if (!this.d.enabled()) throw new InputError(403, 'boas-vindas desligadas neste escritório');
    if ((await this.ensureRecord()).state === 'done') throw new InputError(409, 'as boas-vindas já foram usadas');
    if (this.starting) throw new InputError(409, 'já estou abrindo o agente');
    this.starting = true;
    try {
      if (!(await this.d.loggedIn().catch(() => false))) throw new WelcomeLoginError();
      const s = WELCOME_SUGGESTIONS.find((x) => x.id === choice)!;
      // spawn que falha (pasta, tmux) não grava nada: dá para tentar de novo
      const r = await this.d.spawn(s.folder);
      this.save({ state: 'done', how: 'used', choice, at: this.now() });
      const agentId = r.pid ? `${this.d.account ?? '.claude'}:${r.pid}` : undefined;
      if (agentId) {
        this.delivery = { agentId, state: 'waiting', text: s.text };
        this.pending = this.deliver().catch((err) => {
          if (this.delivery) this.delivery.state = 'failed';
          log.warnOnce(`welcome-deliver:${errMsg(err)}`, `Boas-vindas: a primeira mensagem não foi entregue (${errMsg(err)}).`);
        });
      } else this.delivery = { agentId: '', state: 'failed', text: s.text };
      return { ...(agentId ? { agentId } : {}), cwd: r.cwd, choice };
    } finally {
      this.starting = false;
    }
  }

  /** O SetupWatcher reabriu o agente depois do login (pid novo): a entrega segue o novo. */
  moveAgent(from: string, to: string): void {
    if (this.delivery?.state === 'waiting' && this.delivery.agentId === from) this.delivery.agentId = to;
  }

  /**
   * Espera o Claude subir e cola a mensagem. Pronto = agente no escritório (sessão criada) e recebendo pelo tmux;
   * depois, a tela do pane igual em duas leituras seguidas (o campo de mensagem já foi desenhado), ou
   * DELIVERY_SETTLE_MAX_MS de agente presente.
   */
  private async deliver(): Promise<void> {
    const dl = this.delivery;
    if (!dl) return;
    const deadline = this.now() + DELIVERY_TIMEOUT_MS;
    let readySince: number | undefined;
    let lastScreen: string | undefined;
    let failures = 0;
    while (this.now() < deadline) {
      await this.sleep(DELIVERY_POLL_MS);
      const id = dl.agentId;
      if (!this.d.agentReady(id) || !(await this.d.available(id))) {
        readySince = undefined;
        lastScreen = undefined;
        continue;
      }
      readySince ??= this.now();
      const screen = (await this.d.screen(id))?.trimEnd();
      const settled = !!screen && screen === lastScreen;
      lastScreen = screen;
      if (!settled && this.now() - readySince < DELIVERY_SETTLE_MAX_MS) continue;
      try {
        await this.d.send(id, dl.text);
        dl.state = 'sent';
        log.info(`Boas-vindas: primeira mensagem entregue a ${id}.`);
        return;
      } catch (err) {
        if (++failures >= SEND_ATTEMPTS) throw err;
        readySince = undefined;
        lastScreen = undefined;
      }
    }
    dl.state = 'failed';
    log.warnOnce('welcome-timeout', 'Boas-vindas: o agente não ficou pronto a tempo; a primeira mensagem não foi enviada.');
  }
}
