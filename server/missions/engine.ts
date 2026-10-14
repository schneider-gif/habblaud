// Motor das missões: acompanha os snapshots do escritório (fins de turno), as mensagens mandadas pelo escritório e,
// só enquanto há missão ativa, confere a cada 30 s os arquivos/git do projeto. Concluir paga a recompensa uma vez.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { MissionId, MissionsView, MissionView } from '../../shared/missions';
import type { AgentStatus, OfficeSnapshot } from '../../shared/types';
import { errMsg, log } from '../log';
import { listeningPortsByDir } from '../projects/ports';
import { levelFor, MISSIONS, missionById, type Mission } from './catalog';
import { detect, emptyFacts, inside, turnEnds, type Detection } from './detect';
import { fileFacts, githubFacts, type FileFacts } from './probe';
import { activeMission, completeMission, dayKey, markSeen, missionState, recordMessage, recordTurns, startMission, streak, type MissionsState, type MissionsStore } from './store';

export interface MissionsProbe {
  files(dir: string): Promise<FileFacts>;
  github(projectsDir: string): Promise<{ remote: boolean; pushed: boolean; project?: string }>;
  ports(dirs: readonly string[]): Promise<Map<string, number[]>>;
}

export const defaultProbe: MissionsProbe = { files: fileFacts, github: (d) => githubFacts(d), ports: listeningPortsByDir };

export interface MissionsEngineDeps {
  store: MissionsStore;
  /** ~/projetos */
  projectsDir: string;
  probe?: MissionsProbe;
  now?: () => number;
  intervalMs?: number;
  /** Algo mudou no quadro (conclusão, passos). */
  onChange?: () => void;
}

type Refusal = { status: 404 | 409; error: string };

export class MissionsEngine {
  private prev = new Map<string, AgentStatus>();
  /** Pasta (sala) de cada agente principal presente, do último snapshot. */
  private where = new Map<string, { dir: string; status: AgentStatus }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private running: Promise<MissionId | undefined> = Promise.resolve(undefined);
  /** Última detecção da missão ativa (passos mostrados no quadro). */
  private last: { id: MissionId; d: Detection } | null = null;
  private readonly now: () => number;
  private readonly probe: MissionsProbe;

  constructor(private readonly d: MissionsEngineDeps) {
    this.now = d.now ?? Date.now;
    this.probe = d.probe ?? defaultProbe;
  }

  projectDir(slug: string): string {
    return join(this.d.projectsDir, slug);
  }

  ingest(snap: OfficeSnapshot): void {
    const { ends, next } = turnEnds(this.prev, snap, this.now());
    this.prev = next;
    const rooms = new Map(snap.rooms.map((r) => [r.id, r.path]));
    this.where.clear();
    for (const a of snap.agents) if (a.kind === 'main' && !a.id.startsWith('demo:')) this.where.set(a.id, { dir: rooms.get(a.roomId) ?? a.roomId, status: a.status });
    if (!ends.length || !activeMission(this.d.store.get())) return;
    this.d.store.update((s) => recordTurns(s, ends));
    void this.evaluate();
  }

  /** Mensagem mandada pelo escritório a um agente (POST /api/agents/:id/input deu certo). */
  noteInput(agentId: string): void {
    const w = this.where.get(agentId);
    if (!w || !activeMission(this.d.store.get())) return;
    this.d.store.update((s) => recordMessage(s, { agentId, dir: w.dir, at: this.now() }));
    void this.evaluate();
  }

  /** Agente principal presente (não encerrado) com a sala dentro de `dir`. */
  agentIn(dir: string): string | undefined {
    for (const [id, w] of this.where) if (w.status !== 'offline' && w.status !== 'done' && inside(w.dir, dir)) return id;
    return undefined;
  }

  /** Espera a avaliação em curso (testes e rotas que querem o quadro já atualizado). */
  async settled(): Promise<void> {
    await this.running;
  }

  /** Confere a missão ativa; uma avaliação por vez. Devolve a missão concluída agora, se houver. */
  evaluate(): Promise<MissionId | undefined> {
    this.running = this.running.then(() => this.evaluateNow()).catch((err) => {
      log.warnOnce('missions-eval', `Falha ao conferir as missões: ${errMsg(err)}`);
      return undefined;
    });
    return this.running;
  }

  private async detectActive(m: Mission, s: MissionsState): Promise<Detection> {
    const dir = this.projectDir(m.project);
    const f = { ...emptyFacts(dir, s.started[m.id] ?? 0), turns: s.turns, messages: s.messages };
    if (m.id === 'leve-github') f.github = await this.probe.github(this.d.projectsDir);
    else Object.assign(f, await this.probe.files(dir));
    if (m.id === 'api-banco') f.ports = (await this.probe.ports([dir])).get(dir) ?? [];
    return detect(m.id, f);
  }

  private async evaluateNow(): Promise<MissionId | undefined> {
    const m = activeMission(this.d.store.get());
    if (!m) {
      this.stopTimer();
      return undefined;
    }
    const d = await this.detectActive(m, this.d.store.get());
    const changed = JSON.stringify(this.last) !== JSON.stringify({ id: m.id, d });
    this.last = { id: m.id, d };
    if (!d.done) {
      if (changed) this.d.onChange?.();
      return undefined;
    }
    const at = this.now();
    this.d.store.update((s) => completeMission(s, m.id, at, 'auto'));
    log.info(`   Missão concluída: ${m.text.pt.title} (+${m.coins} moedas).`);
    this.afterComplete();
    return m.id;
  }

  private afterComplete(): void {
    this.last = null;
    if (!activeMission(this.d.store.get())) this.stopTimer();
    this.d.onChange?.();
  }

  /** "Começar": cria ~/projetos/<slug> (sem sobrescrever nada) e ativa a missão. */
  async start(id: unknown): Promise<{ ok: true; project: string } | Refusal> {
    const r = this.d.store.update((s) => startMission(s, id, this.now()));
    if (!('ok' in r)) return r;
    const m = missionById(id)!;
    const project = this.projectDir(m.project);
    await mkdir(project, { recursive: true });
    this.startTimer();
    await this.evaluate();
    return { ok: true, project };
  }

  /** "Concluí": confere antes (se a detecção achar, vale como automática); senão conclui como manual. */
  async complete(id: unknown): Promise<{ ok: true; coins: number } | Refusal> {
    const m = missionById(id);
    if (!m) return { status: 404, error: 'missão desconhecida' };
    if (missionState(this.d.store.get(), m.id) !== 'active') return { status: 409, error: 'só a missão em andamento pode ser concluída' };
    const auto = await this.evaluate();
    if (auto === m.id) return { ok: true, coins: m.coins };
    if (missionState(this.d.store.get(), m.id) !== 'active') return { status: 409, error: 'só a missão em andamento pode ser concluída' };
    const coins = this.d.store.update((s) => completeMission(s, m.id, this.now(), 'manual'));
    log.info(`   Missão concluída (manual): ${m.text.pt.title}.`);
    this.afterComplete();
    return { ok: true, coins };
  }

  seen(id: unknown): boolean {
    const m = missionById(id);
    if (!m) return false;
    this.d.store.update((s) => markSeen(s, m.id));
    return true;
  }

  view(): MissionsView {
    const s = this.d.store.get();
    const missions = MISSIONS.map((m): MissionView => {
      const state = missionState(s, m.id);
      const base: MissionView = { id: m.id, number: m.number, state, coins: m.coins, xp: m.xp };
      if (state === 'locked') return base;
      const t = m.text.pt;
      const v: MissionView = { ...base, title: t.title, why: t.why, goal: t.goal, example: t.example, project: `~/projetos/${m.project}` };
      if (s.started[m.id] !== undefined) v.startedAt = s.started[m.id];
      const c = s.completed[m.id];
      if (c) Object.assign(v, { doneAt: c.at, doneBy: c.by });
      if (state === 'active' && this.last?.id === m.id) {
        v.steps = this.last.d.steps;
        if (this.last.d.info) v.info = this.last.d.info;
      }
      return v;
    });
    return {
      missions,
      wallet: { coins: s.wallet.coins, ledger: s.wallet.ledger.slice(-20).reverse() },
      xp: s.xp,
      level: levelFor(s.xp),
      streak: streak(s.days, dayKey(this.now())),
      celebrate: [...s.celebrate],
    };
  }

  /** Liga a conferência a cada 30 s se houver missão ativa (chamado no boot e ao começar uma missão). */
  startTimer(): void {
    if (this.timer || !activeMission(this.d.store.get())) return;
    this.timer = setInterval(() => void this.evaluate(), this.d.intervalMs ?? 30_000);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
