// Barra superior: marca, conexão, contadores, uso por conta e botões de controle.
import type { UiComponent, UiContext } from './context';
import { h, iconButton, setAttr, setHidden, setText, setTitle, setVariant } from './dom';
import { formatDuration, formatInt } from './format';
import { FALLBACK_MARK, ICONS } from './icons';
import { computeCounters, shellLine, shellWaitIn, shellWaitingAgents, waitingAgents, type Counters } from './model';
import { TIMELAPSE_ICONS } from './timelapse';
import { focusPermission, nextPermissionAgent, permissionAgents } from './permission';
import { UsageCards } from './usage';
import { VersionChip } from './version';
import { wordmark } from './widgets';

interface CounterRefs {
  el: HTMLElement;
  value: HTMLElement;
  label: HTMLElement;
}

/** Contadores fixos (o de shells é à parte: só aparece quando há shells rodando). */
const COUNTERS: { key: Exclude<keyof Counters, 'shells'>; singular: string; plural: string; hint: string }[] = [
  { key: 'rooms', singular: 'sala', plural: 'salas', hint: 'Salas abertas (uma por projeto)' },
  { key: 'agents', singular: 'agente', plural: 'agentes', hint: 'Agentes no escritório (principais e subagentes)' },
  { key: 'working', singular: 'trabalhando', plural: 'trabalhando', hint: 'Agentes processando um pedido agora' },
  { key: 'subagents', singular: 'subagente', plural: 'subagentes', hint: 'Subagentes em atividade' },
  { key: 'waiting', singular: 'precisa de você', plural: 'precisam de você', hint: 'Agentes esperando sua resposta no terminal' },
];
const WAITING_HINT = COUNTERS.find((c) => c.key === 'waiting')!.hint;

export class TopBar implements UiComponent {
  readonly el: HTMLElement;
  private pill: HTMLElement;
  private pillText: HTMLElement;
  private demoBadge: HTMLElement;
  private counters = new Map<keyof Counters, CounterRefs>();
  private shellsBtn: HTMLButtonElement;
  /** Próximo agente do botão de shells (cliques seguidos passam por todos, do que espera há mais tempo). */
  private shellCursor = 0;
  private usage: UsageCards;
  private version: VersionChip;
  private hadOpen = false;
  private sidebarBtn: HTMLButtonElement;
  private feedBtn: HTMLButtonElement;
  private timelapseBtn: HTMLButtonElement;
  readonly settingsBtn: HTMLButtonElement;
  /** Grupo dos botões de painéis (feed, configurações, ajuda); o histórico entra aqui (ui/index.ts). */
  readonly panelGroup: HTMLElement;

  private newAgentBtn: HTMLButtonElement;
  /** Terminal embutido (shell): só com meta.shell. */
  private shellBtn: HTMLButtonElement;
  /** Link rápido (meta.links.vscode): o VS Code do escritório na nuvem. */
  private vscodeLink: HTMLAnchorElement;
  /** Selo no botão do painel lateral recolhido: quantos precisam de você. */
  private sidebarBadge: HTMLElement;
  /** "⋯": guarda os botões que não cabem na barra (do menos ao mais importante; ver fit()). */
  private moreBtn: HTMLButtonElement;
  private moreMenu: HTMLElement;
  private rightEl!: HTMLElement;
  private viewGroupEl!: HTMLElement;
  /** Botões guardados no "⋯" e o marcador do lugar original de cada um. */
  private parked: { el: HTMLElement; home: Comment }[] = [];
  private fitSig = '';
  private fitRaf = 0;

  /** Abre o editor de agente novo (nome, pasta e boneco). */
  private newAgent(): void {
    this.ctx.customize();
  }

  constructor(private ctx: UiContext) {
    // Marca: usa o logo do projeto se existir; senão, o prédio em pixels.
    const mark = h('span', { class: 'ui-brand__mark' });
    const logo = h('img', { attrs: { src: '/assets/brand/logo-mark.png', srcset: '/assets/brand/logo-mark@4x.png 4x', alt: '', width: 32, height: 32, draggable: 'false' } });
    logo.addEventListener('error', () => {
      mark.innerHTML = FALLBACK_MARK;
    });
    mark.append(logo);

    this.pillText = h('span', { class: 'ui-pill__text' });
    this.pill = h('span', { class: 'ui-pill', role: 'status', attrs: { 'aria-live': 'polite' } }, h('span', { class: 'ui-pill__dot' }), this.pillText);
    this.demoBadge = h('span', { class: 'ui-demo-badge', text: 'Demonstração', title: 'Agentes de demonstração ligados (desligue em Configurações)', hidden: true });

    const counterWrap = h('div', { class: 'ui-counters', role: 'group', attrs: { 'aria-label': 'Resumo do escritório' } });
    for (const c of COUNTERS) {
      const value = h('span', { class: 'ui-counter__value', text: '0' });
      const label = h('span', { class: 'ui-counter__label', text: c.plural });
      let el: HTMLElement;
      if (c.key === 'waiting') {
        // Em telas pequenas o rótulo some e fica a mão levantada.
        const icon = h('span', { class: 'ui-counter__icon', attrs: { 'aria-hidden': 'true' } });
        icon.innerHTML = ICONS.hand;
        el = h('button', { class: 'ui-counter ui-counter--waiting', type: 'button', title: `${c.hint}. Clique para ir até o primeiro.`, on: { click: () => this.focusFirstWaiting() } }, icon, value, label);
      } else {
        el = h('div', { class: `ui-counter ui-counter--${c.key}`, title: c.hint }, value, label);
      }
      this.counters.set(c.key, { el, value, label });
      counterWrap.append(el);
    }

    // "⏳ N shells": entre os subagentes e o "precisa de você"; some quando não há shells rodando.
    {
      const icon = h('span', { class: 'ui-counter__icon ui-hourglass', attrs: { 'aria-hidden': 'true' } });
      icon.innerHTML = ICONS.hourglass;
      const value = h('span', { class: 'ui-counter__value', text: '0' });
      const label = h('span', { class: 'ui-counter__label', text: 'shells' });
      this.shellsBtn = h(
        'button',
        { class: 'ui-counter ui-counter--shells', type: 'button', hidden: true, on: { click: () => this.focusNextShell() } },
        icon,
        h('span', { class: 'ui-counter__stack' }, value, label),
      );
      this.counters.set('shells', { el: this.shellsBtn, value, label });
      counterWrap.insertBefore(this.shellsBtn, this.counters.get('waiting')!.el);
    }

    this.usage = new UsageCards(ctx);

    this.sidebarBtn = iconButton(ICONS.sidebar, 'Recolher ou expandir o painel lateral ( [ )', () => ctx.togglePanel('sidebar'), 'ui-btn-sidebar');
    this.sidebarBadge = h('span', { class: 'ui-badge ui-btn-sidebar__badge', hidden: true, attrs: { 'aria-hidden': 'true' } });
    this.sidebarBtn.append(this.sidebarBadge);
    this.shellBtn = h(
      'button',
      { class: 'ui-btn ui-btn-shell', type: 'button', hidden: true, title: 'Terminal: shell de verdade no seu escritório ( ` )', attrs: { 'aria-label': 'Terminal', 'aria-keyshortcuts': '`' }, on: { click: () => ctx.toggleShell() } },
      h('span', { class: 'ui-btn-shell__icon', html: ICONS.shell }),
      h('span', { class: 'ui-btn-shell__label', text: 'Terminal' }),
    );
    const link = (cls: string, icon: string, label: string, title: string) =>
      h(
        'a',
        { class: `ui-btn ui-btn-link ${cls}`, hidden: true, title, attrs: { target: '_blank', rel: 'noopener noreferrer' } },
        h('span', { class: 'ui-btn-link__icon', html: icon }),
        h('span', { class: 'ui-btn-link__label', text: label }),
      );
    this.vscodeLink = link('ui-btn-vscode', ICONS.code, 'VS Code', 'Abrir o VS Code do escritório em outra aba');
    this.feedBtn = iconButton(ICONS.feed, 'Feed de atividade ( ] )', () => ctx.togglePanel('feed'));
    this.timelapseBtn = iconButton(TIMELAPSE_ICONS.timelapse, 'Timelapse: reproduzir o dia (L)', () => ctx.toggleTimelapse(), 'ui-btn-timelapse');
    this.settingsBtn = iconButton(ICONS.settings, 'Configurações', () => ctx.toggleSettings());
    this.settingsBtn.setAttribute('aria-haspopup', 'dialog');
    this.version = new VersionChip(ctx, this.settingsBtn);
    const viewGroup = h(
      'div',
      { class: 'ui-btn-group', role: 'group', attrs: { 'aria-label': 'Câmera' } },
      iconButton(ICONS.overview, 'Visão geral (O)', () => ctx.camera('overview')),
      iconButton(ICONS.zoomOut, 'Afastar (−)', () => ctx.camera('zoomOut')),
      iconButton(ICONS.zoomIn, 'Aproximar (+)', () => ctx.camera('zoomIn')),
    );
    const panelGroup = h(
      'div',
      { class: 'ui-btn-group', role: 'group', attrs: { 'aria-label': 'Painéis' } },
      this.timelapseBtn,
      this.feedBtn,
      this.settingsBtn,
      iconButton(ICONS.help, 'Ajuda (?)', () => ctx.openHelp()),
    );
    this.panelGroup = panelGroup;

    // "Novo agente": só aparece quando o servidor abre agentes no tmux (GET /api/agents/new -> {available}).
    this.newAgentBtn = h(
      'button',
      { class: 'ui-btn ui-btn--primary ui-btn-new-agent', type: 'button', hidden: true, title: 'Novo agente', attrs: { 'aria-label': 'Novo agente' }, on: { click: () => this.newAgent() } },
      h('span', { text: '+' }),
      h('span', { class: 'ui-btn-new-agent__label', text: ' Novo agente' }),
    );
    this.moreMenu = h('div', { class: 'ui-more-menu', role: 'menu', hidden: true, attrs: { 'aria-label': 'Mais opções' } });
    this.moreBtn = h('button', {
      class: 'ui-icon-btn ui-more-btn',
      type: 'button',
      hidden: true,
      title: 'Mais opções',
      text: '⋯',
      attrs: { 'aria-label': 'Mais opções', 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
      on: { click: () => this.toggleMore() },
    });
    // Clicar numa opção do "⋯" fecha o menu depois que o botão fez o dele (popovers medem a posição do botão).
    this.moreMenu.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).closest('button, a')) setTimeout(() => this.toggleMore(false), 0);
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.moreMenu.hidden && !this.moreMenu.contains(e.target as Node) && e.target !== this.moreBtn) this.toggleMore(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.moreMenu.hidden) {
        this.toggleMore(false);
        this.moreBtn.focus();
      }
    });
    if (!ctx.store.mock)
      fetch('/api/agents/new')
        .then((r) => (r.ok ? r.json() : null))
        .then((j: { available?: boolean } | null) => setHidden(this.newAgentBtn, j?.available !== true))
        .catch(() => undefined);

    this.el = h(
      'header',
      { class: 'ui-topbar', role: 'banner' },
      h(
        'div',
        { class: 'ui-topbar__left' },
        this.sidebarBtn,
        h(
          'div',
          { class: 'ui-brand' },
          mark,
          h('div', { class: 'ui-brand__text' }, wordmark(), h('div', { class: 'ui-topbar__status' }, this.pill, this.version.el, this.demoBadge)),
        ),
      ),
      counterWrap,
      this.usage.el,
      (this.rightEl = h('div', { class: 'ui-topbar__right' }, this.newAgentBtn, h('div', { class: 'ui-topbar__tools' }, this.shellBtn, this.vscodeLink), viewGroup, panelGroup, this.moreBtn)),
      this.moreMenu,
    );
    this.viewGroupEl = viewGroup;
    new ResizeObserver(() => this.scheduleFit()).observe(this.el);
    addEventListener('resize', () => this.scheduleFit());
  }

  // ---------------------------------------------------------------- caber na largura da tela

  /** Do menos ao mais importante: o que vai primeiro para o "⋯" quando a barra não cabe. */
  private overflowCandidates(): HTMLElement[] {
    const panel = [...this.panelGroup.children].filter((c): c is HTMLElement => c instanceof HTMLElement && c !== this.settingsBtn);
    return [this.viewGroupEl, ...panel, this.vscodeLink];
  }

  private scheduleFit(): void {
    if (this.fitRaf) return;
    this.fitRaf = requestAnimationFrame(() => {
      this.fitRaf = 0;
      this.fit();
    });
  }

  /** A barra está apertada? (algo passa da borda, transborda ou invade o vizinho) */
  private crowded(): boolean {
    const bar = this.el;
    if (bar.scrollWidth > bar.clientWidth + 1) return true;
    const right = this.rightEl.getBoundingClientRect();
    if (right.right > innerWidth - 2) return true;
    const usage = this.usage.el;
    if (usage.offsetParent && usage.scrollWidth > usage.clientWidth + 1) return true;
    // na mesma linha, o que vem antes do grupo da direita não pode passar por baixo dele
    for (const el of [usage, ...this.el.querySelectorAll<HTMLElement>('.ui-counters, .ui-topbar__left')]) {
      if (!el.offsetParent) continue;
      const r = el.getBoundingClientRect();
      if (r.width && Math.abs(r.top - right.top) < right.height && r.right > right.left + 1) return true;
    }
    return false;
  }

  /** Devolve tudo ao lugar e guarda no "⋯", em ordem, o que não couber. */
  fit(): void {
    for (const p of this.parked) p.home.replaceWith(p.el);
    this.parked = [];
    setHidden(this.moreBtn, true);
    if (!this.crowded()) return this.toggleMore(false);
    setHidden(this.moreBtn, false);
    for (const el of this.overflowCandidates()) {
      if (el.hidden) continue;
      const home = document.createComment('topbar');
      el.replaceWith(home);
      this.moreMenu.append(el);
      this.parked.push({ el, home });
      if (!this.crowded()) break;
    }
    if (!this.parked.length) setHidden(this.moreBtn, true);
  }

  private toggleMore(open?: boolean): void {
    const next = open ?? this.moreMenu.hidden;
    setHidden(this.moreMenu, !next);
    this.moreBtn.setAttribute('aria-expanded', String(next));
    if (!next) return;
    const r = this.moreBtn.getBoundingClientRect();
    this.moreMenu.style.top = `${Math.round(r.bottom + 6)}px`;
    this.moreMenu.style.right = `${Math.max(6, Math.round(innerWidth - r.right))}px`;
    (this.moreMenu.querySelector('button:not([hidden]), a:not([hidden])') as HTMLElement | null)?.focus();
  }

  /** Acrescenta um botão de janela própria (ex.: Meu dia) ao começo do grupo de painéis. */
  addPanelButton(btn: HTMLElement): void {
    this.panelGroup.prepend(btn);
  }

  render(): void {
    const { store } = this.ctx;
    const snap = store.snapshot;

    // Conexão.
    const conn = store.connection;
    if (conn === 'open') this.hadOpen = true;
    const label =
      conn === 'open' ? 'Conectado' : conn === 'mock' ? 'Simulação' : conn === 'closed' ? 'Desconectado' : this.hadOpen ? 'Reconectando…' : 'Conectando…';
    setText(this.pillText, label);
    setVariant(this.pill, 'is-', conn);
    setTitle(
      this.pill,
      conn === 'mock'
        ? 'Dados simulados no navegador (?mock=1)'
        : conn === 'open'
          ? 'Recebendo eventos do servidor em tempo real'
          : 'Sem conexão com o servidor do Habblaud',
    );
    setHidden(this.demoBadge, !(conn === 'open' && snap?.meta.demo));

    // Contadores.
    const now = this.ctx.now();
    const c = computeCounters(snap, now);
    for (const def of COUNTERS) {
      const refs = this.counters.get(def.key)!;
      const n = c[def.key];
      setText(refs.value, formatInt(n));
      setText(refs.label, n === 1 ? def.singular : def.plural);
      setAttr(refs.el, 'aria-label', `${formatInt(n)} ${n === 1 ? def.singular : def.plural}`);
    }
    const waiting = this.counters.get('waiting')!.el as HTMLButtonElement;
    waiting.classList.toggle('is-active', c.waiting > 0);
    waiting.disabled = c.waiting === 0;
    // Pedidos que dá para responder por aqui (hook de permissão): a dica diz quantos.
    const answerable = permissionAgents(snap?.agents ?? []).length;
    waiting.classList.toggle('has-answer', answerable > 0);
    setTitle(
      waiting,
      answerable
        ? `${WAITING_HINT}. ${answerable === 1 ? '1 pedido de permissão dá' : `${answerable} pedidos de permissão dão`} para responder por aqui: clique para ir até ${answerable === 1 ? 'ele' : 'cada um'} (P).`
        : `${WAITING_HINT}. Clique para ir até o primeiro.`,
    );
    this.renderShells(c.shells, now);

    this.usage.render();
    this.version.render();

    const sideOpen = this.ctx.isPanelOpen('sidebar');
    this.sidebarBtn.setAttribute('aria-pressed', String(sideOpen));
    // Recolhido, o botão avisa quem precisa de você (o contador da barra some em telas estreitas).
    const badge = sideOpen ? 0 : c.waiting;
    setHidden(this.sidebarBadge, badge === 0);
    setText(this.sidebarBadge, badge > 99 ? '99+' : String(badge));
    this.sidebarBtn.classList.toggle('has-badge', badge > 0);
    setAttr(this.sidebarBtn, 'aria-label', badge ? `Expandir o painel lateral (${badge} ${badge === 1 ? 'precisa' : 'precisam'} de você)` : sideOpen ? 'Recolher o painel lateral' : 'Expandir o painel lateral');
    setHidden(this.shellBtn, !this.ctx.isShellAvailable());
    // Botões que aparecem/somem mudam o que cabe: reencaixa.
    const sig = [this.newAgentBtn.hidden, this.ctx.isShellAvailable(), !!snap?.meta.links?.vscode, store.mock, (snap?.accounts.length ?? 0), c.waiting > 0, c.shells > 0].join();
    if (sig !== this.fitSig) {
      this.fitSig = sig;
      this.scheduleFit();
    }
    this.shellBtn.setAttribute('aria-pressed', String(this.ctx.isShellOpen()));
    const links = store.mock ? undefined : snap?.meta.links;
    setAttr(this.vscodeLink, 'href', links?.vscode);
    setHidden(this.vscodeLink, !links?.vscode);
    this.feedBtn.setAttribute('aria-pressed', String(this.ctx.isPanelOpen('feed')));
    this.timelapseBtn.setAttribute('aria-pressed', String(this.ctx.isTimelapseOpen()));
    setHidden(this.timelapseBtn, store.mock);
  }

  private renderShells(n: number, now: number): void {
    const refs = this.counters.get('shells')!;
    setHidden(this.shellsBtn, n === 0);
    if (n === 0) {
      this.shellCursor = 0;
      return;
    }
    const all = this.ctx.store.snapshot?.agents ?? [];
    const agents = shellWaitingAgents(all, now);
    setText(refs.value, formatInt(n));
    setText(refs.label, n === 1 ? 'shell' : 'shells');
    const who = agents.length === 1 ? agents[0].name : `${formatInt(agents.length)} agentes`;
    setAttr(refs.el, 'aria-label', `${formatInt(n)} ${n === 1 ? 'shell rodando' : 'shells rodando'}; ${who} esperando. Ir até o próximo.`);
    // Dica: quem espera o quê, do que espera há mais tempo.
    const lines = agents.slice(0, 6).map((a) => {
      const w = shellWaitIn(a, all, now)!;
      return `${a.name}: ${shellLine(w, now).label} (${formatDuration(now - w.since)})`;
    });
    if (agents.length > 6) lines.push(`… e mais ${agents.length - 6}`);
    setTitle(refs.el, `Shells rodando: ${agents.length === 1 ? 'o agente espera' : 'os agentes esperam'} terminar.\n${lines.join('\n')}\nClique para ir até ${agents.length > 1 ? 'cada um' : 'ele'}.`);
  }

  private focusNextShell(): void {
    const agents = shellWaitingAgents(this.ctx.store.snapshot?.agents ?? [], this.ctx.now());
    if (!agents.length) return;
    // Se o atual já está selecionado, passa para o próximo da fila.
    const sel = this.ctx.selection();
    let i = this.shellCursor % agents.length;
    if (sel?.type === 'agent' && agents[i].id === sel.id) i = (i + 1) % agents.length;
    this.shellCursor = i + 1;
    this.ctx.select({ type: 'agent', id: agents[i].id }, { focus: true });
  }

  private focusFirstWaiting(): void {
    // Quem tem pedido para responder pelo escritório vem antes (cliques seguidos passam por todos).
    const agents = this.ctx.store.snapshot?.agents ?? [];
    const sel = this.ctx.selection();
    const next = nextPermissionAgent(agents, sel?.type === 'agent' ? sel.id : undefined);
    if (next) return focusPermission(this.ctx, next.id);
    const first = waitingAgents(agents)[0];
    if (first) this.ctx.select({ type: 'agent', id: first.id }, { focus: true });
  }
}
