// Terminal embutido: shell de verdade dentro do escritório (xterm.js + WebSocket /api/shell/ws). Cada aba é uma sessão
// tmux terminal-N no servidor (server/shell/service.ts): fechar o painel ou recarregar a página não mata nada, e ao
// abrir de novo a aba volta como estava. Também anexa às sessões dos agentes em configuração (agente-*: primeira
// execução do Claude, tema e login), sem matar a sessão ao fechar.
// Diferente do terminal da conversa (ui/terminal.ts, atalho T), que mostra o transcript de um agente.
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import type { XtermBundle } from './shell-xterm';

export interface ShellTabInfo {
  id: string;
  n: number;
  command: string;
  cwd: string;
  createdAt: number;
  attached: number;
}

/** Aba no navegador: uma sessão terminal-N ou a sessão tmux de um agente em configuração. */
export interface ShellTabView {
  id: string;
  label: string;
  kind: 'shell' | 'agent';
}

export const SHELL_ACTIVE_KEY = 'habblaud:shell-active';
/** Posição/tamanho da janela do terminal (arrastada/redimensionada) e se estava maximizada. */
export const SHELL_GEOM_KEY = 'habblaud:shell-geom';

export interface ShellGeom {
  x: number;
  y: number;
  w: number;
  h: number;
  max?: boolean;
}

/** Encaixa a janela na tela atual (a janela pode ter sido salva num monitor maior): sempre alcançável pelo cabeçalho. */
export function clampGeom(g: ShellGeom, view: { w: number; h: number; top: number }): ShellGeom {
  const w = Math.max(320, Math.min(g.w, view.w - 8));
  const h = Math.max(200, Math.min(g.h, view.h - view.top - 8));
  const x = Math.max(4, Math.min(g.x, view.w - w - 4));
  const y = Math.max(view.top, Math.min(g.y, view.h - h - 4));
  return { x, y, w, h, max: g.max };
}

export function parseGeom(raw: string | null): ShellGeom | null {
  if (!raw) return null;
  try {
    const g = JSON.parse(raw) as Partial<ShellGeom>;
    if ([g.x, g.y, g.w, g.h].every((v) => typeof v === 'number' && Number.isFinite(v))) return { x: g.x!, y: g.y!, w: g.w!, h: g.h!, max: g.max === true };
  } catch {
    // corrompido: volta ao padrão
  }
  return null;
}

/** Linhas a rolar por um evento de roda (pixels, linhas ou páginas), com sinal: negativo = para cima. */
export function wheelLines(deltaY: number, deltaMode: number): number {
  if (!deltaY) return 0;
  const lines = deltaMode === 1 ? deltaY : deltaMode === 2 ? deltaY * 20 : deltaY / 20;
  return Math.sign(lines) * Math.max(1, Math.round(Math.abs(lines)));
}

/** O que fazer com uma tecla de copiar/colar no terminal: copiar, deixar o navegador colar, ou mandar ao shell. */
export function clipboardKey(e: { key: string; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }, hasSelection: boolean): 'copy' | 'paste' | 'swallow' | 'pass' {
  if (e.altKey || !(e.ctrlKey || e.metaKey)) return 'pass';
  const k = e.key.toLowerCase();
  if (k === 'c') {
    // Ctrl+C sem seleção continua sendo o Ctrl+C do shell (interromper); com seleção, copia.
    if (hasSelection) return 'copy';
    return e.ctrlKey && !e.shiftKey && !e.metaKey ? 'pass' : 'swallow';
  }
  if (k === 'v') return 'paste';
  return 'pass';
}
export const SHELL_UNAVAILABLE_HINT =
  'O terminal embutido só funciona com o Habblaud acessível apenas pelo próprio computador (ou pelo seu escritório na nuvem), no Linux e fora da demonstração';

/** Teclas da barra do celular (o teclado virtual não tem Esc, Tab, Ctrl nem setas). */
export const MOBILE_KEYS: [string, string, string][] = [
  ['Esc', '\x1b', 'Esc'],
  ['Tab', '\t', 'Tab'],
  ['Ctrl+C', '\x03', 'Interromper (Ctrl+C)'],
  ['Ctrl+D', '\x04', 'Fim de entrada (Ctrl+D)'],
  ['↑', '\x1b[A', 'Seta para cima'],
  ['↓', '\x1b[B', 'Seta para baixo'],
  ['←', '\x1b[D', 'Seta para a esquerda'],
  ['→', '\x1b[C', 'Seta para a direita'],
];

/** URL do WebSocket na mesma origem da página (ws: em http, wss: em https). */
export function shellWsUrl(loc: { protocol: string; host: string }, session: string, cols: number, rows: number): string {
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  const q = new URLSearchParams({ session, cols: String(cols), rows: String(rows) });
  return `${proto}//${loc.host}/api/shell/ws?${q}`;
}

/** Rótulo da aba: número e o programa em primeiro plano ("1 · bash", "2 · vim"). */
export function shellTabLabel(t: Pick<ShellTabInfo, 'n' | 'command'>): string {
  const cmd = t.command && !/^-?(ba|z|fi|da)?sh$/.test(t.command) ? t.command : 'shell';
  return `${t.n} · ${cmd}`;
}

/** Junta as abas do servidor com as de agentes abertas aqui; agentes primeiro (eles precisam de você). */
export function mergeTabs(server: readonly ShellTabInfo[], agents: readonly ShellTabView[]): ShellTabView[] {
  return [...agents, ...server.map((t) => ({ id: t.id, label: shellTabLabel(t), kind: 'shell' as const }))];
}

/** Aba ativa depois de fechar `closed`: a vizinha da direita, senão a da esquerda, senão nenhuma. */
export function nextActiveTab(tabs: readonly ShellTabView[], closed: string): string | null {
  const i = tabs.findIndex((t) => t.id === closed);
  const rest = tabs.filter((t) => t.id !== closed);
  if (!rest.length) return null;
  return rest[Math.min(Math.max(i, 0), rest.length - 1)].id;
}

type Phase = 'idle' | 'loading' | 'connecting' | 'open' | 'closed' | 'error';

export class ShellPanel implements UiComponent {
  readonly el: HTMLElement;
  private tabsEl: HTMLElement;
  private body: HTMLElement;
  private screen: HTMLElement;
  private overlay: HTMLElement;
  private overlayText: HTMLElement;
  private overlayBtn: HTMLButtonElement;
  private maxBtn: HTMLButtonElement;
  private server: ShellTabInfo[] = [];
  private agentTabs: ShellTabView[] = [];
  private active: string | null = null;
  private xterm: XtermBundle | null = null;
  private loadingXterm: Promise<XtermBundle> | null = null;
  private ws: WebSocket | null = null;
  private phase: Phase = 'idle';
  private openFlag = false;
  private resizeObs: ResizeObserver | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private lastSize = '';
  private returnFocus: HTMLElement | null = null;
  /** Atualiza os rótulos das abas (programa em primeiro plano) enquanto o painel está aberto. */
  private labelTimer: ReturnType<typeof setInterval> | null = null;
  /** Link sob o mouse (menu do botão direito: copiar/abrir o link inteiro). */
  private hoverLink: string | null = null;
  private menu: HTMLElement;
  private head!: HTMLElement;
  private geom: ShellGeom | null = parseGeom(safeGet(SHELL_GEOM_KEY));
  private wheelAcc = 0;
  private wheelTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private ctx: UiContext) {
    this.tabsEl = h('div', { class: 'ui-shell__tabs', role: 'tablist', attrs: { 'aria-label': 'Abas do terminal' } });
    const addBtn = iconButton(ICONS.plus, 'Nova aba', () => void this.newTab(), 'ui-icon-btn--sm ui-shell__add');
    const copyBtn = iconButton(ICONS.copy, 'Copiar seleção (Ctrl+Shift+C)', () => void this.copy(), 'ui-icon-btn--sm');
    const pasteBtn = iconButton(ICONS.paste, 'Colar (Ctrl+Shift+V)', () => void this.paste(), 'ui-icon-btn--sm');
    this.maxBtn = iconButton(ICONS.maximize, 'Maximizar', () => this.toggleMax(), 'ui-icon-btn--sm');
    const closeBtn = iconButton(ICONS.close, 'Fechar o painel (as abas continuam abertas no servidor)', () => this.close(), 'ui-icon-btn--sm');
    this.screen = h('div', { class: 'ui-shell__screen' });
    this.overlayText = h('p', { class: 'ui-shell__msg' });
    this.overlayBtn = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Reconectar', on: { click: () => this.overlayAction() } });
    this.overlay = h('div', { class: 'ui-shell__overlay', hidden: true }, this.overlayText, this.overlayBtn);
    this.body = h('div', { class: 'ui-shell__body' }, this.screen, this.overlay);
    const keys = h(
      'div',
      { class: 'ui-shell__keys', role: 'toolbar', attrs: { 'aria-label': 'Teclas especiais' } },
      ...MOBILE_KEYS.map(([label, seq, title]) =>
        h('button', {
          class: 'ui-shell__key',
          type: 'button',
          text: label,
          title,
          on: {
            pointerdown: (e: Event) => e.preventDefault(), // não tira o foco (e o teclado virtual) do terminal
            click: () => this.send(seq),
          },
        }),
      ),
      h('button', { class: 'ui-shell__key', type: 'button', text: 'Copiar', on: { pointerdown: (e: Event) => e.preventDefault(), click: () => void this.copy() } }),
      h('button', { class: 'ui-shell__key', type: 'button', text: 'Colar', on: { pointerdown: (e: Event) => e.preventDefault(), click: () => void this.paste() } }),
    );
    this.menu = h('div', { class: 'ui-shell__menu', role: 'menu', hidden: true });
    this.el = h(
      'section',
      { class: 'ui-panel ui-shell', hidden: true, role: 'dialog', attrs: { 'aria-label': 'Terminal', tabindex: '-1' } },
      (this.head = h(
        'header',
        { class: 'ui-shell__head', title: 'Arraste para mover a janela · duplo clique maximiza' },
        h('span', { class: 'ui-shell__title', attrs: { 'aria-hidden': 'true' } }, h('span', { class: 'ui-shell__icon', html: ICONS.terminal }), h('span', { text: 'Terminal' })),
        this.tabsEl,
        addBtn,
        h('div', { class: 'ui-shell__actions' }, copyBtn, pasteBtn, this.maxBtn, closeBtn),
      )),
      this.body,
      keys,
      this.menu,
    );
    this.setupDrag();
    this.screen.addEventListener('contextmenu', (e) => this.openMenu(e));
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node)) this.hideMenu();
    });
    // Redimensionar pelo canto: guarda o tamanho novo.
    new ResizeObserver(() => {
      if (!this.openFlag || this.el.classList.contains('is-max') || this.ctx.isNarrow() || !this.el.style.width) return;
      this.saveGeom();
    }).observe(this.el);
  }

  // ---------------------------------------------------------------- janela: arrastar, redimensionar, maximizar

  private setupDrag(): void {
    let start: { px: number; py: number; x: number; y: number } | null = null;
    this.head.addEventListener('dblclick', (e) => {
      if ((e.target as HTMLElement).closest('button, [role="tab"], [role="button"]')) return;
      this.toggleMax();
    });
    this.head.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || this.ctx.isNarrow() || this.el.classList.contains('is-max')) return;
      if ((e.target as HTMLElement).closest('button, [role="tab"], [role="button"], a')) return;
      const r = this.el.getBoundingClientRect();
      this.pin(r);
      start = { px: e.clientX, py: e.clientY, x: r.left, y: r.top };
      this.head.setPointerCapture(e.pointerId);
      this.el.classList.add('is-dragging');
      e.preventDefault();
    });
    this.head.addEventListener('pointermove', (e) => {
      if (!start) return;
      const g = clampGeom(
        { x: start.x + e.clientX - start.px, y: start.y + e.clientY - start.py, w: this.el.offsetWidth, h: this.el.offsetHeight },
        this.viewport(),
      );
      this.el.style.left = `${g.x}px`;
      this.el.style.top = `${g.y}px`;
    });
    const end = () => {
      if (!start) return;
      start = null;
      this.el.classList.remove('is-dragging');
      this.saveGeom();
    };
    this.head.addEventListener('pointerup', end);
    this.head.addEventListener('pointercancel', end);
  }

  private viewport(): { w: number; h: number; top: number } {
    const top = (this.ctx.root.querySelector('.ui-topbar') as HTMLElement | null)?.getBoundingClientRect().bottom ?? 64;
    return { w: innerWidth, h: innerHeight, top: Math.round(top) + 4 };
  }

  /** Fixa a janela por left/top/width/height (o padrão é ancorado no canto inferior direito). */
  private pin(r: { left: number; top: number; width: number; height: number }): void {
    Object.assign(this.el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, right: 'auto', bottom: 'auto' });
  }

  private saveGeom(): void {
    const r = this.el.getBoundingClientRect();
    const max = this.el.classList.contains('is-max');
    const g: ShellGeom = max && this.geom ? { ...this.geom, max } : { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), max };
    this.geom = g;
    safeSet(SHELL_GEOM_KEY, JSON.stringify(g));
  }

  /** Aplica a posição/tamanho guardados (desktop); no celular a janela ocupa a tela (CSS). */
  private applyGeom(): void {
    if (this.ctx.isNarrow() || !this.geom) return;
    const g = clampGeom(this.geom, this.viewport());
    this.pin({ left: g.x, top: g.y, width: g.w, height: g.h });
    this.el.classList.toggle('is-max', g.max === true);
    this.syncMaxBtn();
  }

  // ---------------------------------------------------------------- menu do botão direito

  private openMenu(e: MouseEvent): void {
    e.preventDefault();
    const term = this.xterm?.term;
    const link = this.hoverLink;
    const item = (label: string, fn: () => void, disabled = false) =>
      h('button', {
        class: 'ui-shell__menu-item',
        type: 'button',
        role: 'menuitem',
        text: label,
        attrs: disabled ? { disabled: true } : {},
        on: {
          click: () => {
            this.hideMenu();
            fn();
          },
        },
      });
    const items = [
      item('Copiar', () => void this.copy(), !term?.hasSelection()),
      item('Colar', () => void this.paste()),
      item('Selecionar tudo', () => term?.selectAll()),
    ];
    if (link) items.unshift(item('Abrir link em outra aba', () => this.openLink(link)), item('Copiar link', () => void this.copyLink(link)));
    this.menu.replaceChildren(...items);
    setHidden(this.menu, false);
    const box = this.el.getBoundingClientRect();
    const mw = this.menu.offsetWidth;
    const mh = this.menu.offsetHeight;
    this.menu.style.left = `${Math.min(e.clientX - box.left, box.width - mw - 4)}px`;
    this.menu.style.top = `${Math.min(e.clientY - box.top, box.height - mh - 4)}px`;
    (this.menu.querySelector('button:not([disabled])') as HTMLButtonElement | null)?.focus();
  }

  private hideMenu(): void {
    setHidden(this.menu, true);
  }

  private openLink(url: string): void {
    window.open(url, '_blank', 'noopener,noreferrer');
  }

  private async copyLink(url: string): Promise<void> {
    const ok = await copyText(url);
    if (ok) this.ctx.notify('Link copiado (inteiro).');
    else this.ctx.notify('O navegador não deixou copiar o link.', 'warn');
    this.xterm?.term.focus();
  }

  get isOpen(): boolean {
    return this.openFlag;
  }

  /** O servidor oferece o terminal embutido agora? */
  available(): boolean {
    return !this.ctx.store.mock && this.ctx.store.snapshot?.meta.shell === true;
  }

  render(): void {
    if (this.openFlag && !this.available() && this.phase !== 'error') {
      this.showOverlay(`${SHELL_UNAVAILABLE_HINT}.`, null);
      this.phase = 'error';
      this.disconnect();
    }
  }

  toggle(): void {
    if (this.openFlag) this.close();
    else void this.open();
  }

  /** Abre o painel; sem aba nenhuma no servidor, cria a primeira. `login`: aba nova rodando o claude (Missão 0). */
  async open(opts: { login?: boolean; session?: string; label?: string } = {}): Promise<void> {
    if (!this.available()) {
      this.ctx.notify(`${SHELL_UNAVAILABLE_HINT}.`, 'warn');
      return;
    }
    if (!this.openFlag) {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      this.openFlag = true;
      setHidden(this.el, false);
      this.applyGeom();
      this.ctx.root.classList.add('has-shell');
      this.ctx.invalidate();
      this.labelTimer = setInterval(() => {
        if (this.openFlag && !document.hidden && this.phase === 'open') void this.refresh();
      }, 5000);
    }
    this.phase = 'loading';
    this.showOverlay('Abrindo o terminal…', null);
    let bundle: XtermBundle;
    try {
      bundle = await this.ensureXterm();
    } catch {
      this.showOverlay('Não foi possível carregar o terminal (recarregue a página).', null);
      this.phase = 'error';
      return;
    }
    if (!this.openFlag) return;
    if (opts.session) {
      if (!this.agentTabs.some((t) => t.id === opts.session)) this.agentTabs.unshift({ id: opts.session, label: opts.label ?? opts.session, kind: 'agent' });
      await this.refresh();
      return this.activate(opts.session);
    }
    await this.refresh();
    if (opts.login) return void this.newTab({ login: true });
    if (this.active && this.allTabs().some((t) => t.id === this.active)) return this.activate(this.active, { force: !this.ws });
    const saved = safeGet(SHELL_ACTIVE_KEY);
    const tabs = this.allTabs();
    const pick = tabs.find((t) => t.id === saved) ?? tabs.find((t) => t.kind === 'shell') ?? tabs[0];
    if (pick) this.activate(pick.id);
    else await this.newTab();
    void bundle;
  }

  close(): void {
    if (!this.openFlag) return;
    this.openFlag = false;
    if (this.labelTimer) clearInterval(this.labelTimer);
    this.labelTimer = null;
    this.disconnect();
    setHidden(this.el, true);
    this.ctx.root.classList.remove('has-shell');
    this.hideMenu();
    this.ctx.invalidate();
    if (this.returnFocus?.isConnected) this.returnFocus.focus();
    this.returnFocus = null;
  }

  private allTabs(): ShellTabView[] {
    return mergeTabs(this.server, this.agentTabs);
  }

  private async refresh(): Promise<void> {
    try {
      const r = await fetch('/api/shell', { cache: 'no-store' });
      const j = (await r.json()) as { available?: boolean; reason?: string; tabs?: ShellTabInfo[] };
      if (!j.available) {
        this.showOverlay(j.reason ? `Terminal indisponível: ${j.reason}.` : `${SHELL_UNAVAILABLE_HINT}.`, null);
        this.phase = 'error';
        this.server = [];
      } else this.server = Array.isArray(j.tabs) ? j.tabs : [];
    } catch {
      this.server = [];
    }
    this.renderTabs();
  }

  private renderedTabs = '';

  private renderTabs(): void {
    const tabs = this.allTabs();
    const key = JSON.stringify([tabs, this.active]);
    if (key === this.renderedTabs) return;
    this.renderedTabs = key;
    this.tabsEl.replaceChildren(
      ...tabs.map((t) => {
        const selected = t.id === this.active;
        const tab = h(
          'button',
          {
            class: `ui-shell__tab${selected ? ' is-active' : ''}${t.kind === 'agent' ? ' is-agent' : ''}`,
            type: 'button',
            role: 'tab',
            title: t.kind === 'agent' ? `Sessão do agente (${t.id}): termine a configuração do Claude aqui` : `Sessão tmux ${t.id} (também abre no VS Code: tmux attach -t ${t.id})`,
            attrs: { 'aria-selected': String(selected) },
            on: { click: () => this.activate(t.id) },
          },
          h('span', { class: 'ui-shell__tab-label', text: t.label }),
        );
        const x = h('span', {
          class: 'ui-shell__tab-x',
          role: 'button',
          title: t.kind === 'agent' ? 'Fechar a aba (o agente continua aberto)' : 'Fechar a aba (encerra o shell)',
          attrs: { 'aria-label': `Fechar ${t.label}`, tabindex: '0' },
          html: ICONS.close,
          on: {
            click: (e: Event) => {
              e.stopPropagation();
              void this.closeTab(t);
            },
          },
        });
        tab.append(x);
        return tab;
      }),
    );
  }

  private async newTab(opts: { login?: boolean } = {}): Promise<void> {
    const size = this.size();
    try {
      const r = await fetch('/api/shell/tabs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ login: opts.login === true, cols: size.cols, rows: size.rows }),
      });
      const j = (await r.json()) as { tab?: ShellTabInfo; error?: string };
      if (!r.ok || !j.tab) throw new Error(j.error ?? `HTTP ${r.status}`);
      await this.refresh();
      this.activate(j.tab.id);
    } catch (err) {
      this.ctx.notify(`Não foi possível abrir uma aba nova: ${(err as Error).message}`, 'warn');
    }
  }

  private async closeTab(t: ShellTabView): Promise<void> {
    if (t.kind === 'shell') {
      if (!confirm(`Fechar a aba ${t.label}? O que estiver rodando nela será encerrado.`)) return;
      try {
        await fetch(`/api/shell/tabs/${encodeURIComponent(t.id)}/close`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      } catch {
        // a lista de abas abaixo mostra o estado real
      }
    }
    const next = nextActiveTab(this.allTabs(), t.id);
    this.agentTabs = this.agentTabs.filter((a) => a.id !== t.id);
    if (this.active === t.id) {
      this.disconnect();
      this.active = null;
    }
    await this.refresh();
    const still = next && this.allTabs().some((x) => x.id === next) ? next : this.allTabs()[0]?.id;
    if (still) this.activate(still);
    else if (this.openFlag) this.showOverlay('Nenhuma aba aberta.', 'Abrir um terminal');
  }

  private activate(id: string, opts: { force?: boolean } = {}): void {
    if (this.active === id && this.ws && !opts.force) {
      this.xterm?.term.focus();
      return;
    }
    this.active = id;
    if (this.allTabs().find((t) => t.id === id)?.kind === 'shell') safeSet(SHELL_ACTIVE_KEY, id);
    this.renderTabs();
    this.connect();
  }

  private connect(): void {
    this.disconnect();
    const id = this.active;
    const x = this.xterm;
    if (!id || !x || !this.openFlag) return;
    x.term.reset();
    this.fit();
    const { cols, rows } = x.term;
    this.phase = 'connecting';
    this.showOverlay('Conectando…', null);
    const ws = new WebSocket(shellWsUrl(location, id, cols, rows));
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.phase = 'open';
      setHidden(this.overlay, true);
      this.lastSize = '';
      this.sendResize();
      x.term.focus();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      if (ev.data instanceof ArrayBuffer) x.term.write(new Uint8Array(ev.data));
      else {
        try {
          const msg = JSON.parse(String(ev.data)) as { t?: string };
          if (msg.t === 'exit') this.onExit(id);
        } catch {
          // aviso desconhecido
        }
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.phase === 'open' || this.phase === 'connecting') {
        const wasOpen = this.phase === 'open';
        this.phase = 'closed';
        // Queda de rede ou servidor reiniciando: tenta de novo uma vez, sozinho.
        void this.refresh().then(() => {
          if (!this.openFlag || this.active !== id) return;
          if (!this.allTabs().some((t) => t.id === id) || (this.agentTabs.some((t) => t.id === id) && !wasOpen)) return this.onExit(id);
          this.showOverlay('Conexão perdida com o terminal.', 'Reconectar');
          if (wasOpen) this.retryTimer = setTimeout(() => this.openFlag && this.active === id && !this.ws && this.connect(), 1500);
        });
      }
    };
  }

  /** A sessão acabou (exit no shell, Claude fechado): tira a aba e vai para a vizinha. */
  private onExit(id: string): void {
    const next = nextActiveTab(this.allTabs(), id);
    this.agentTabs = this.agentTabs.filter((a) => a.id !== id);
    this.disconnect();
    if (this.active === id) this.active = null;
    void this.refresh().then(() => {
      if (!this.openFlag) return;
      const target = next && this.allTabs().some((t) => t.id === next) ? next : this.allTabs()[0]?.id;
      if (target) this.activate(target);
      else this.showOverlay('A sessão terminou.', 'Abrir um terminal');
    });
  }

  private disconnect(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState <= WebSocket.OPEN) ws.close(1000);
    if (this.phase === 'open' || this.phase === 'connecting') this.phase = 'closed';
  }

  private overlayAction(): void {
    if (!this.allTabs().length || !this.active) void this.newTab();
    else this.connect();
  }

  private showOverlay(text: string, action: string | null): void {
    setText(this.overlayText, text);
    setHidden(this.overlayBtn, action === null);
    if (action) setText(this.overlayBtn, action);
    setHidden(this.overlay, false);
  }

  private send(data: string): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'i', d: data }));
    this.xterm?.term.focus();
  }

  private sendResize(): void {
    const t = this.xterm?.term;
    if (!t || this.ws?.readyState !== WebSocket.OPEN) return;
    const key = `${t.cols}x${t.rows}`;
    if (key === this.lastSize) return;
    this.lastSize = key;
    this.ws.send(JSON.stringify({ t: 'r', c: t.cols, r: t.rows }));
  }

  private fit(): void {
    if (!this.xterm || !this.openFlag || this.screen.clientWidth < 40 || this.screen.clientHeight < 20) return;
    try {
      this.xterm.fit.fit();
    } catch {
      // ainda sem layout
    }
  }

  private size(): { cols: number; rows: number } {
    const t = this.xterm?.term;
    return { cols: t?.cols ?? 100, rows: t?.rows ?? 30 };
  }

  private toggleMax(): void {
    if (!this.el.classList.contains('is-max') && !this.geom && !this.ctx.isNarrow()) this.saveGeom();
    this.el.classList.toggle('is-max');
    this.syncMaxBtn();
    if (!this.ctx.isNarrow()) {
      const on = this.el.classList.contains('is-max');
      this.geom = { ...(this.geom ?? { x: 0, y: 0, w: 900, h: 520 }), max: on };
      safeSet(SHELL_GEOM_KEY, JSON.stringify(this.geom));
    }
    requestAnimationFrame(() => this.fit());
  }

  private syncMaxBtn(): void {
    const on = this.el.classList.contains('is-max');
    this.maxBtn.title = on ? 'Restaurar o tamanho' : 'Maximizar';
    this.maxBtn.setAttribute('aria-label', this.maxBtn.title);
    this.maxBtn.innerHTML = on ? ICONS.restore : ICONS.maximize;
  }

  private async copy(): Promise<void> {
    const sel = this.xterm?.term.getSelection() ?? '';
    if (!sel) {
      this.ctx.notify('Selecione um texto no terminal (arraste com o mouse ou toque e segure).');
      return;
    }
    if (await copyText(sel)) {
      this.ctx.announce('Copiado.');
      this.xterm?.term.clearSelection();
    } else this.ctx.notify('O navegador não deixou copiar.', 'warn');
    this.xterm?.term.focus();
  }

  private async paste(): Promise<void> {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.xterm?.term.paste(text);
    } catch {
      this.ctx.notify('O navegador não deixou ler a área de transferência: use Ctrl+Shift+V (ou Ctrl+V).', 'warn');
    }
    this.xterm?.term.focus();
  }

  private ensureXterm(): Promise<XtermBundle> {
    if (this.xterm) return Promise.resolve(this.xterm);
    this.loadingXterm ??= import('./shell-xterm').then(({ createXterm }) => {
      const narrow = this.ctx.isNarrow();
      const bundle = createXterm({
        fontSize: narrow ? 12 : 13,
        onLink: (url) => this.openLink(url),
        onLinkHover: (url) => (this.hoverLink = url),
      });
      bundle.term.open(this.screen);
      bundle.term.onData((d) => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'i', d }));
      });
      bundle.term.onBinary((d) => {
        if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 'i', d }));
      });
      bundle.term.onResize(() => this.sendResize());
      bundle.term.attachCustomKeyEventHandler((e) => {
        if (e.type !== 'keydown') return true;
        // Ctrl+C / Cmd+C copiam quando há seleção (sem seleção, Ctrl+C interrompe como sempre); Ctrl+V, Cmd+V e
        // Ctrl+Shift+V deixam o navegador colar (o xterm recebe o evento de colar, com bracketed paste).
        const what = clipboardKey(e, bundle.term.hasSelection());
        if (what === 'copy') {
          e.preventDefault();
          void this.copy();
          return false;
        }
        if (what === 'paste' || what === 'swallow') return false;
        return true;
      });
      // Roda do mouse: rola o histórico do tmux (modo cópia), agrupando os eventos de um mesmo giro.
      bundle.term.attachCustomWheelEventHandler((ev) => {
        if (ev.ctrlKey) return true;
        const n = wheelLines(ev.deltaY, ev.deltaMode);
        if (!n) return false;
        ev.preventDefault();
        this.wheelAcc += n;
        this.wheelTimer ??= setTimeout(() => {
          this.wheelTimer = null;
          const total = this.wheelAcc;
          this.wheelAcc = 0;
          if (total && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ t: 's', n: total }));
        }, 40);
        return false;
      });
      this.resizeObs = new ResizeObserver(() => requestAnimationFrame(() => this.fit()));
      this.resizeObs.observe(this.screen);
      this.xterm = bundle;
      return bundle;
    });
    return this.loadingXterm;
  }
}

function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // aba anônima / armazenamento cheio
  }
}
