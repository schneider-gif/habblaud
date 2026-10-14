// Quadro de missões: o quadro de cortiça da recepção (no canvas) abre este painel no canto do escritório.
// Uma missão por vez, com objetivo (nunca um pedido pronto) e o exemplo escondido; as próximas aparecem só como
// silhueta com "?". Concluir (detecção automática no servidor ou "Concluí" com confirmação) solta confete em
// pixel, sem som, e paga as moedas na Caixa do escritório. Minimizável; nunca é modal nem bloqueia o escritório.
import type { MissionsView, MissionStartResult, MissionView } from '../../../shared/missions';
import type { UiComponent, UiContext } from './context';
import { h, prefersReducedMotion, setHidden, setText } from './dom';
import { boardHint, confetti, currentMission, kicker, levelProgress, parseMissionsView, stepsText } from './missions-model';

const URL_BASE = '/api/missions';
const POLL_MS = 10_000;
/** Quanto esperar o agente aberto pela missão aparecer no escritório. */
const AGENT_WAIT_MS = 60_000;
const CELEBRATE_MS = 2_600;

type Terminal = { open(agentId: string, opener?: HTMLElement | null): void; focusInput(): void };

export class MissionBoard implements UiComponent {
  readonly el: HTMLElement;
  /** Balão sobre o quadro de cortiça do canvas. */
  readonly balloon: HTMLButtonElement;
  /** Camada do confete (cobre a tela, sem receber cliques). */
  readonly fx: HTMLElement;
  private view: MissionsView | null = null;
  /** Motivo de o recurso estar desligado (403), para explicar no clique do quadro. */
  private off: string | null = null;
  private busy = false;
  private confirming = false;
  /** Missão com o exemplo aberto (fecha sozinho quando a missão da vez muda). */
  private exampleOf: string | null = null;
  private pending: { id: string; until: number } | null = null;
  private celebrated = new Set<string>();
  private drawn = '';
  private raf = 0;
  private headTitle: HTMLElement;
  private headLevel: HTMLElement;
  private coinsEl: HTMLElement;
  private minBtn: HTMLButtonElement;
  private body: HTMLElement;

  constructor(
    private ctx: UiContext,
    private terminal: Terminal,
  ) {
    this.headTitle = h('span', { class: 'ui-missions__title-text', text: 'Missões' });
    this.headLevel = h('span', { class: 'ui-missions__level' });
    this.coinsEl = h('span', { class: 'ui-missions__coins' });
    this.minBtn = h('button', { class: 'ui-missions__min', type: 'button', on: { click: () => this.toggleMinimized() } });
    const head = h(
      'header',
      { class: 'ui-missions__head' },
      h('button', { class: 'ui-missions__title', type: 'button', on: { click: () => this.toggleMinimized() } }, h('span', { class: 'ui-missions__icon', text: '📋', attrs: { 'aria-hidden': 'true' } }), this.headTitle, this.headLevel),
      this.coinsEl,
      this.minBtn,
    );
    this.body = h('div', { class: 'ui-missions__body' });
    this.el = h('section', { class: 'ui-missions', hidden: true, attrs: { 'aria-label': 'Quadro de missões' } }, head, this.body);
    this.balloon = h('button', { class: 'ui-missions-balloon', type: 'button', hidden: true, on: { click: () => this.openFromWorld() } });
    this.fx = h('div', { class: 'ui-missions-fx', attrs: { 'aria-hidden': 'true' } });
    ctx.world.onObjectClick?.((id) => id === 'mission-board' && this.openFromWorld());
    void this.load();
    setInterval(() => {
      if (!document.hidden && !this.busy) void this.load();
    }, POLL_MS);
  }

  // ---------------------------------------------------------------- dados

  private async load(): Promise<void> {
    try {
      const r = await fetch(URL_BASE, { cache: 'no-store', headers: { Accept: 'application/json' } });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        this.off = (j as { error?: string }).error ?? 'missões indisponíveis neste escritório';
        this.setView(null);
        return;
      }
      this.off = null;
      this.setView(parseMissionsView(j));
    } catch {
      // servidor fora do ar: mantém o que estava na tela
    }
  }

  private setView(v: MissionsView | null): void {
    this.view = v;
    this.ctx.invalidate();
    if (v?.celebrate.length) this.celebrate(v);
  }

  private async post(path: string, body: unknown = {}): Promise<{ ok: boolean; status: number; json: Record<string, unknown> }> {
    const r = await fetch(`${URL_BASE}/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const json = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, json };
  }

  // ---------------------------------------------------------------- ações

  private openFromWorld(): void {
    if (this.off || !this.view) {
      this.ctx.notify(`Quadro de missões: ${this.off ?? 'carregando…'}`, 'warn');
      return;
    }
    this.narrowOpen = true;
    if (this.ctx.prefs.missionsMinimized) this.ctx.updatePrefs({ missionsMinimized: false });
    else this.ctx.invalidate();
    requestAnimationFrame(() => this.el.querySelector<HTMLButtonElement>('.ui-missions__go')?.focus({ preventScroll: true }));
  }

  /** Celular/tela estreita: o quadro cobriria o escritório inteiro, então começa recolhido (só a etiqueta) a cada visita. */
  private narrowOpen = false;

  private minimized(): boolean {
    return this.ctx.prefs.missionsMinimized || (this.ctx.isNarrow() && !this.narrowOpen);
  }

  private toggleMinimized(): void {
    if (this.ctx.isNarrow()) {
      const open = this.minimized();
      this.narrowOpen = open;
      if (open && this.ctx.prefs.missionsMinimized) this.ctx.updatePrefs({ missionsMinimized: false });
      else this.ctx.invalidate();
      return;
    }
    this.ctx.updatePrefs({ missionsMinimized: !this.ctx.prefs.missionsMinimized });
  }

  private async start(m: MissionView): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.ctx.invalidate();
    try {
      const r = await this.post(`${encodeURIComponent(m.id)}/start`);
      if (!r.ok) {
        this.ctx.notify(`Não deu para começar a missão: ${(r.json.error as string) ?? 'o escritório recusou'}.`, 'warn');
        return;
      }
      const res = r.json as unknown as MissionStartResult;
      this.setView(parseMissionsView(res.view));
      const where = m.project ?? 'a pasta da missão';
      if (res.agentId && (res.spawn === 'ok' || res.spawn === 'reused')) {
        this.pending = { id: res.agentId, until: Date.now() + AGENT_WAIT_MS };
        this.ctx.notify(res.spawn === 'ok' ? `Abrindo um agente em ${where}: escreva o seu pedido na caixa de mensagem.` : `O agente de ${where} já está no escritório: escreva para ele.`);
        this.focusPending();
      } else if (res.spawn === 'unavailable') {
        this.ctx.notify(`Pasta ${where} pronta. Abra o Claude nela pelo terminal: este escritório não abre agentes sozinho (precisa do tmux).`);
      } else {
        this.ctx.notify(`Pasta ${where} pronta, mas o agente não abriu. Abra o Claude nela pelo terminal.`, 'warn');
      }
    } catch {
      this.ctx.notify('Não deu para começar a missão: o escritório não respondeu.', 'warn');
    } finally {
      this.busy = false;
      this.ctx.invalidate();
    }
  }

  private async recheck(): Promise<void> {
    this.busy = true;
    this.ctx.invalidate();
    await this.load();
    this.busy = false;
    this.ctx.invalidate();
    if (this.view && currentMission(this.view)?.number === 0) this.ctx.notify('Ainda não achei o login do Claude nesta máquina. Rode claude no terminal e entre com a sua conta.', 'warn');
  }

  /** O agente da missão chegou: seleciona, abre o terminal e põe o cursor na caixa de mensagem (vazia). */
  private focusPending(): void {
    const p = this.pending;
    if (!p) return;
    if (!this.ctx.agent(p.id)) {
      if (Date.now() > p.until) this.pending = null;
      return;
    }
    this.pending = null;
    this.ctx.select({ type: 'agent', id: p.id }, { focus: true });
    this.terminal.open(p.id, null);
    setTimeout(() => this.terminal.focusInput(), 350);
  }

  private async complete(m: MissionView): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.confirming = false;
    this.ctx.invalidate();
    try {
      const r = await this.post(`${encodeURIComponent(m.id)}/complete`, { confirm: true });
      if (!r.ok) this.ctx.notify(`Não deu para concluir: ${(r.json.error as string) ?? 'o escritório recusou'}.`, 'warn');
      else this.setView(parseMissionsView(r.json.view));
    } catch {
      this.ctx.notify('Não deu para concluir: o escritório não respondeu.', 'warn');
    } finally {
      this.busy = false;
      this.ctx.invalidate();
    }
  }

  // ---------------------------------------------------------------- comemoração

  private celebrate(v: MissionsView): void {
    for (const id of v.celebrate) {
      if (this.celebrated.has(id)) continue;
      this.celebrated.add(id);
      const m = v.missions.find((x) => x.id === id);
      if (!m) continue;
      this.burst(m);
      this.ctx.notify(`🏆 Missão ${m.number} concluída: ${m.title ?? ''} (+${m.coins} moedas na Caixa do escritório)`);
      void this.post(`${encodeURIComponent(id)}/seen`).then((r) => r.ok && this.setView(parseMissionsView(r.json.view)));
    }
  }

  /** Confete em pixel caindo + faixa de recompensa; sem som. Com movimento reduzido, só a faixa. */
  private burst(m: MissionView): void {
    const banner = h(
      'div',
      { class: 'ui-missions-fx__banner' },
      h('span', { class: 'ui-missions-fx__trophy', text: '🏆' }),
      h('strong', { text: `Missão ${m.number} concluída!` }),
      h('span', { text: `+${m.coins} 🪙  ·  +${m.xp} XP` }),
    );
    const layer = h('div', { class: 'ui-missions-fx__burst' }, banner);
    if (!prefersReducedMotion()) {
      for (const p of confetti(m.number * 7919 + Date.now(), 70)) {
        layer.append(h('i', { class: 'ui-missions-fx__bit', style: `left:${p.x}%;--dx:${p.dx}px;--delay:${p.delay}ms;--size:${p.size}px;background:${p.color}` }));
      }
    }
    this.fx.append(layer);
    setTimeout(() => layer.remove(), CELEBRATE_MS + 700);
  }

  // ---------------------------------------------------------------- desenho

  render(): void {
    this.focusPending();
    const v = this.view;
    setHidden(this.el, !v);
    this.syncBalloon();
    if (!v) return;
    const min = this.minimized();
    this.el.classList.toggle('is-min', min);
    setText(this.headLevel, `Nv ${v.level.level} · ${v.level.name}`);
    setText(this.coinsEl, `🪙 ${v.wallet.coins}`);
    this.coinsEl.title = v.wallet.ledger.length ? `Caixa do escritório\n${v.wallet.ledger.map((e) => `+${e.delta}  ${e.text}`).join('\n')}` : 'Caixa do escritório: conclua missões para ganhar moedas';
    setText(this.minBtn, min ? '+' : '–');
    this.minBtn.setAttribute('aria-label', min ? 'Abrir o quadro de missões' : 'Recolher o quadro de missões');
    this.minBtn.title = this.minBtn.getAttribute('aria-label')!;
    setHidden(this.body, min);
    const key = JSON.stringify([v, this.busy, this.confirming, this.exampleOf, min, this.ctx.isShellAvailable()]);
    if (key === this.drawn || min) return;
    this.drawn = key;
    const lost = v.authLost
      ? h(
          'div',
          { class: 'ui-missions__lost', role: 'status' },
          h('b', { text: '⚠ Sua conta do Claude saiu — conecte de novo.' }),
          ' Rode claude no terminal e faça o login; suas missões continuam aqui. ',
          this.ctx.isShellAvailable() ? h('button', { class: 'ui-link-btn', type: 'button', text: 'Fazer login agora', on: { click: () => this.ctx.openShell({ login: true }) } }) : null,
        )
      : null;
    this.body.replaceChildren(...[lost, this.progressRow(v), this.track(v), this.card(v)].filter((x): x is HTMLElement => !!x));
  }

  private progressRow(v: MissionsView): HTMLElement {
    const pct = Math.round(levelProgress(v) * 100);
    const xpText = v.level.next !== undefined ? `${v.xp} / ${v.level.next} XP` : `${v.xp} XP · nível máximo`;
    return h(
      'div',
      { class: 'ui-missions__xp' },
      h('div', { class: 'ui-missions__bar', attrs: { role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, 'aria-label': 'Progresso até o próximo nível' } }, h('i', { style: `width:${pct}%` })),
      h('span', { class: 'ui-missions__xptext', text: xpText }),
      v.streak > 0 ? h('span', { class: 'ui-missions__streak', title: 'Dias seguidos com missões', text: `🔥 ${v.streak} ${v.streak === 1 ? 'dia' : 'dias'}` }) : null,
    );
  }

  private track(v: MissionsView): HTMLElement {
    return h(
      'ol',
      { class: 'ui-missions__track', attrs: { 'aria-label': 'Missões' } },
      ...v.missions.map((m) =>
        h(
          'li',
          { class: `ui-missions__slot is-${m.state}`, title: m.state === 'locked' ? `Missão ${m.number}: trancada até você concluir a anterior` : `Missão ${m.number}: ${m.title}${m.state === 'done' ? ' (concluída)' : ''}` },
          h('span', { class: 'ui-missions__slot-num', text: String(m.number) }),
          h('span', { class: 'ui-missions__slot-mark', text: m.state === 'done' ? '✓' : m.state === 'locked' ? '?' : '★' }),
        ),
      ),
    );
  }

  private card(v: MissionsView): HTMLElement {
    const m = currentMission(v);
    if (!m) {
      return h(
        'article',
        { class: 'ui-missions__card is-all-done' },
        h('h3', { text: '🏆 Todas as missões concluídas!' }),
        h('p', { text: `Você juntou ${v.wallet.coins} moedas na Caixa do escritório. Continue criando: o escritório é seu.` }),
      );
    }
    const next = v.missions.find((x) => x.number === m.number + 1);
    const showExample = this.exampleOf === m.id;
    const steps = m.steps?.length
      ? h('ul', { class: 'ui-missions__steps' }, ...m.steps.map((s) => h('li', { class: s.ok ? 'is-ok' : '', text: `${s.ok ? '☑' : '☐'} ${s.label}` })))
      : null;
    const actions: HTMLElement[] = [];
    // Missão 0 (login): com o terminal embutido, "Fazer login agora" abre uma aba rodando o claude (tema e login ali
    // mesmo); o outro botão só confere de novo (o GET confere a credencial na hora).
    const login = m.project === '~';
    if (login && this.ctx.isShellAvailable()) {
      actions.push(
        h('button', {
          class: 'ui-missions__go ui-missions__go--login',
          type: 'button',
          text: '⌨ Fazer login agora',
          title: 'Abre o terminal do escritório já rodando o claude: escolha o tema e entre com a sua conta',
          on: { click: () => this.ctx.openShell({ login: true }) },
        }),
      );
    }
    const go = h('button', {
      class: 'ui-missions__go',
      type: 'button',
      text: this.busy ? 'Um instante…' : login ? '↻ Já fiz login: conferir' : m.state === 'available' ? '▶ Começar missão' : '▶ Ir para o agente da missão',
      on: { click: () => void (login ? this.recheck() : this.start(m)) },
    });
    go.disabled = this.busy;
    actions.push(go);
    if (m.state === 'active') {
      if (this.confirming) {
        actions.push(
          h(
            'div',
            { class: 'ui-missions__confirm', role: 'group', attrs: { 'aria-label': 'Confirmar conclusão' } },
            h('span', { text: 'Concluiu mesmo? A conferência automática ainda não viu tudo.' }),
            h('button', { class: 'ui-missions__yes', type: 'button', text: 'Sim, concluí', on: { click: () => void this.complete(m) } }),
            h('button', { class: 'ui-missions__no', type: 'button', text: 'Ainda não', on: { click: () => ((this.confirming = false), this.ctx.invalidate()) } }),
          ),
        );
      } else {
        actions.push(h('button', { class: 'ui-missions__done', type: 'button', text: 'Concluí', title: 'Marcar como concluída (pede confirmação)', on: { click: () => ((this.confirming = true), this.ctx.invalidate()) } }));
      }
    }
    return h(
      'article',
      { class: `ui-missions__card is-${m.state}` },
      h('div', { class: 'ui-missions__kicker', text: kicker(m, v.missions.length) }),
      h('h3', { class: 'ui-missions__name', text: m.title ?? '' }),
      h('p', { class: 'ui-missions__why', text: m.why ?? '' }),
      h('div', { class: 'ui-missions__goal' }, h('b', { text: 'Objetivo: ' }), m.goal ?? ''),
      steps,
      m.state === 'active' && stepsText(m) ? h('div', { class: 'ui-missions__stepstext', text: stepsText(m) }) : null,
      m.info ? h('div', { class: 'ui-missions__info', text: m.info }) : null,
      h(
        'div',
        { class: 'ui-missions__example' },
        h('button', {
          class: 'ui-missions__extoggle',
          type: 'button',
          text: showExample ? '▾ esconder exemplo' : '▸ exemplo',
          attrs: { 'aria-expanded': showExample ? 'true' : 'false' },
          on: { click: () => ((this.exampleOf = showExample ? null : m.id), this.ctx.invalidate()) },
        }),
        showExample ? h('q', { class: 'ui-missions__extext', text: m.example ?? '' }) : null,
      ),
      h('div', { class: 'ui-missions__reward', text: `Recompensa: ${m.coins} 🪙 · ${m.xp} XP` }),
      h('div', { class: 'ui-missions__actions' }, ...actions),
      next ? h('div', { class: 'ui-missions__next' }, h('span', { class: 'ui-missions__silhouette', text: '?' }), `Próxima: missão ${next.number} — trancada`) : null,
    );
  }

  /** Balão preso ao quadro de cortiça do canvas: segue a câmera enquanto estiver visível. */
  private syncBalloon(): void {
    const v = this.view;
    const hint = v ? boardHint(v) : undefined;
    const want = !!hint && (this.minimized() || !!v?.celebrate.length || !!v?.authLost || currentMission(v!)?.state === 'available' || currentMission(v!)?.number === 0);
    if (!want) {
      setHidden(this.balloon, true);
      if (this.raf) cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    setText(this.balloon, hint!);
    this.balloon.setAttribute('aria-label', `${hint} (abrir o quadro de missões)`);
    if (this.raf) return;
    const tick = () => {
      this.raf = requestAnimationFrame(tick);
      const r = this.ctx.world.objectScreenRect?.('mission-board');
      if (!r || r.w < 18) return setHidden(this.balloon, true);
      setHidden(this.balloon, false);
      this.balloon.style.transform = `translate(${Math.round(r.x + r.w / 2)}px, ${Math.round(r.y - 6)}px) translate(-50%, -100%)`;
    };
    tick();
  }
}
