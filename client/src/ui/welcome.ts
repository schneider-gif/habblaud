// Cartão de boas-vindas (primeira abertura do escritório, docs/BOAS-VINDAS.md): um agente sentado na mesa com um
// balão e 3 primeiras tarefas. Clicar abre o agente de verdade (POST /api/welcome/start) e o servidor manda a
// sugestão como primeira mensagem. "✕ Pular" sempre visível: grava no servidor e nunca mais aparece.
import type { WelcomeChoice, WelcomeView } from '../../../shared/welcome';
import { appearanceFromSeed, characterSprite, furnitureSprites, poseFrameCount, type Sprite } from '../art';
import type { UiComponent, UiContext } from './context';
import { h, prefersReducedMotion, setHidden, setText } from './dom';
import { officeIsEmpty } from './overlays';
import { safeLocalStorage } from './prefs';
import { SHELL_UNAVAILABLE_HINT } from './shell';
import { deliveryNotice, parseWelcomeView, shouldShowWelcome, WELCOME_LOCAL_KEY } from './welcome-model';

/** Consulta da entrega da primeira mensagem enquanto ela espera o Claude subir. */
const DELIVERY_POLL_MS = 2_500;
/** Depois disso a página para de perguntar (o servidor espera até 10 min; o aviso perde o sentido). */
const DELIVERY_POLL_MAX_MS = 4 * 60_000;
/** Quanto tempo o agente aberto pelo cartão é esperado para ganhar o foco. */
const FOCUS_MS = 120_000;

const ICON: Record<WelcomeChoice, string> = { site: '🌐', explicar: '💬', organizar: '🗂' };

/** Cena da mesa em pixels de mundo (ampliada pelo CSS, sem suavizar). */
const SCENE_W = 48;
const SCENE_H = 56;
const WAVE_MS = 450;
/** Boneco fixo do cartão (sempre o mesmo rosto). */
const WELCOME_SEED = 0x5eedb0a5;

/** Cadeira, agente sentado acenando (de frente) e a mesa vista por trás, como nas ilhas de mesas do escritório. */
function drawDeskScene(canvas: HTMLCanvasElement, frame: number): void {
  const g = canvas.getContext('2d');
  if (!g) return;
  g.imageSmoothingEnabled = false;
  g.clearRect(0, 0, canvas.width, canvas.height);
  // origem: canto superior esquerdo da cadeira (1x1) com a mesa (2x1) logo abaixo dela
  const ox = 8;
  const oy = 22;
  const put = (sp: Sprite, x: number, y: number) => g.drawImage(sp.canvas, Math.round(ox + x - sp.ax), Math.round(oy + y - sp.ay));
  try {
    const chair = furnitureSprites('office_chair_front', 'blue');
    put(chair.base, 16, 16);
    const appearance = appearanceFromSeed(WELCOME_SEED, { look: 'f' });
    const n = Math.max(1, poseFrameCount('raise_hand'));
    put(characterSprite({ appearance, dir: 'down', pose: 'raise_hand', seated: true, frame: frame % n }), 16, 12);
    if (chair.front) put(chair.front, 16, 16);
    const desk = furnitureSprites('desk_back', 'white');
    put(desk.base, 16, 32);
    if (desk.front) put(desk.front, 16, 32);
  } catch {
    // arte indisponível: o balão e as sugestões bastam
  }
}

export class WelcomeCard implements UiComponent {
  readonly el: HTMLElement;
  private view: WelcomeView | null = null;
  private shown = false;
  private dismissed = false;
  private busy: WelcomeChoice | 'skip' | 'check' | null = null;
  private pendingFocus: { id: string; until: number } | null = null;
  private readonly storage = safeLocalStorage();
  private readonly scene: HTMLCanvasElement;
  private wave: ReturnType<typeof setInterval> | null = null;
  private waveFrame = 0;
  private readonly loginBox: HTMLElement;
  private readonly loginBtn: HTMLButtonElement;
  private readonly checkBtn: HTMLButtonElement;
  private readonly choices: HTMLElement;
  private readonly choiceBtns = new Map<WelcomeChoice, HTMLButtonElement>();
  private readonly lead: HTMLElement;
  private readonly errEl: HTMLElement;
  private readonly skipBtn: HTMLButtonElement;

  constructor(private ctx: UiContext) {
    try {
      this.dismissed = this.storage?.getItem(WELCOME_LOCAL_KEY) === '1';
    } catch {
      // navegador sem storage: o servidor decide
    }
    this.skipBtn = h('button', {
      class: 'ui-welcome__skip',
      type: 'button',
      text: '✕ Pular',
      title: 'Pular as boas-vindas (não aparece de novo)',
      on: { click: () => void this.skip() },
    });
    // Agente "sentado na mesa" (arte do próprio escritório: cadeira, boneco acenando e mesa) com o balão.
    this.scene = h('canvas', { class: 'ui-welcome__scene', attrs: { width: SCENE_W, height: SCENE_H } });
    const balloon = h('div', { class: 'ui-welcome__balloon', text: 'Oi! Sou seu primeiro agente. Por onde começamos?' });
    const art = h('div', { class: 'ui-welcome__art', attrs: { 'aria-hidden': 'true' } }, this.scene, balloon);
    drawDeskScene(this.scene, 0);

    this.lead = h('p', { class: 'ui-welcome__lead' });
    this.loginBtn = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: '⌨ Fazer login agora', on: { click: () => this.login() } });
    this.checkBtn = h('button', { class: 'ui-btn', type: 'button', text: '↻ Já fiz login: conferir', on: { click: () => void this.recheck() } });
    this.loginBox = h(
      'div',
      { class: 'ui-welcome__login', hidden: true },
      h('p', { class: 'ui-welcome__step', text: '1º passo: conecte a sua conta do Claude (Pro/Max ou chave de API da Anthropic). O terminal abre com o Claude; escolha a conta, abra o link e volte aqui.' }),
      h('div', { class: 'ui-welcome__login-actions' }, this.loginBtn, this.checkBtn),
    );
    this.choices = h('div', { class: 'ui-welcome__choices', role: 'group', attrs: { 'aria-label': 'Primeira tarefa' } });
    this.errEl = h('p', { class: 'ui-welcome__err', role: 'alert', hidden: true });
    this.el = h(
      'section',
      { class: 'ui-welcome', hidden: true, role: 'dialog', attrs: { 'aria-labelledby': 'ui-welcome-title', 'aria-describedby': 'ui-welcome-lead' }, on: { keydown: (e) => this.onKey(e) } },
      this.skipBtn,
      art,
      h('h2', { class: 'ui-welcome__title', text: 'Seu escritório está pronto', attrs: { id: 'ui-welcome-title' } }),
      this.lead,
      this.loginBox,
      this.choices,
      this.errEl,
      h('p', { class: 'ui-welcome__foot', text: 'Depois dá para abrir quantos agentes quiser em + Novo agente.' }),
    );
    this.lead.id = 'ui-welcome-lead';
    if (!ctx.store.mock) void this.load();
  }

  /** O cartão está na tela (o "escritório vazio" some enquanto isso). */
  visible(): boolean {
    return shouldShowWelcome({
      view: this.view,
      officeEmpty: officeIsEmpty(this.ctx),
      shown: this.shown,
      shellOpen: this.ctx.isShellOpen(),
      dismissed: this.dismissed,
      mock: this.ctx.store.mock,
    });
  }

  private async load(): Promise<WelcomeView | null> {
    try {
      const r = await fetch('/api/welcome', { cache: 'no-store' });
      const v = r.ok ? parseWelcomeView(await r.json()) : null;
      if (v) this.view = v;
    } catch {
      // sem servidor: o cartão simplesmente não aparece
    }
    this.ctx.invalidate();
    return this.view;
  }

  render(): void {
    this.focusArrived();
    const show = this.visible();
    const was = !this.el.hidden;
    setHidden(this.el, !show);
    this.animate(show);
    if (!show || !this.view) return;
    if (!this.shown) this.shown = true;
    const login = this.view.state === 'login';
    setText(this.lead, login ? 'Conecte a sua conta e escolha a primeira tarefa: o agente abre e já começa a trabalhar.' : 'Escolha a primeira tarefa: o agente abre e já começa a trabalhar nela.');
    setHidden(this.loginBox, !login);
    this.loginBtn.disabled = this.busy !== null;
    this.checkBtn.disabled = this.busy !== null;
    setText(this.checkBtn, this.busy === 'check' ? 'Conferindo…' : '↻ Já fiz login: conferir');
    this.renderChoices(login);
    this.skipBtn.disabled = this.busy === 'skip';
    if (!was) requestAnimationFrame(() => (login ? this.loginBtn : this.choiceBtns.values().next().value)?.focus({ preventScroll: true }));
  }

  private renderChoices(login: boolean): void {
    const list = this.view?.suggestions ?? [];
    if (this.choiceBtns.size !== list.length)
      this.choices.replaceChildren(
        ...list.map((s) => {
          const b = h(
            'button',
            { class: 'ui-welcome__choice', type: 'button', attrs: { 'data-choice': s.id }, on: { click: () => void this.start(s.id) } },
            h('span', { class: 'ui-welcome__choice-icon', text: ICON[s.id], attrs: { 'aria-hidden': 'true' } }),
            h('span', { class: 'ui-welcome__choice-text', text: s.text }),
          );
          this.choiceBtns.set(s.id, b);
          return b;
        }),
      );
    for (const [id, b] of this.choiceBtns) {
      b.disabled = login || this.busy !== null;
      b.title = login ? 'Conecte a sua conta do Claude primeiro' : '';
      b.classList.toggle('is-busy', this.busy === id);
      const text = b.querySelector('.ui-welcome__choice-text');
      const label = this.view?.suggestions.find((s) => s.id === id)?.text ?? '';
      if (text) setText(text, this.busy === id ? 'Abrindo o agente…' : label);
    }
  }

  /** O agente acena enquanto o cartão está na tela (parado com movimento reduzido). */
  private animate(on: boolean): void {
    if (on && !this.wave && !prefersReducedMotion()) {
      this.wave = setInterval(() => drawDeskScene(this.scene, ++this.waveFrame), WAVE_MS);
    } else if (!on && this.wave) {
      clearInterval(this.wave);
      this.wave = null;
    }
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || this.busy) return;
    e.preventDefault();
    e.stopPropagation();
    void this.skip();
  }

  private error(text: string | null): void {
    setHidden(this.errEl, !text);
    if (text) setText(this.errEl, text);
  }

  /** Guarda a decisão no navegador também (o cartão não pisca na próxima abertura antes do servidor responder). */
  private dismissLocally(): void {
    this.dismissed = true;
    try {
      this.storage?.setItem(WELCOME_LOCAL_KEY, '1');
    } catch {
      // sem storage: o servidor basta
    }
  }

  private async post(path: string, body: unknown): Promise<{ ok: boolean; status: number; j: Record<string, unknown> }> {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: r.ok, status: r.status, j };
  }

  private async skip(): Promise<void> {
    if (this.busy) return;
    this.busy = 'skip';
    // some na hora: quem pula não quer esperar a rede
    this.dismissLocally();
    this.ctx.invalidate();
    try {
      const r = await this.post('/api/welcome/skip', {});
      if (!r.ok) console.warn('[ui] boas-vindas: pular não foi gravado no servidor', r.status, r.j.error);
    } catch {
      // offline: fica pulado neste navegador e o servidor pergunta de novo noutro
    } finally {
      this.busy = null;
      this.ctx.invalidate();
    }
  }

  private login(): void {
    if (this.ctx.isShellAvailable()) this.ctx.openShell({ login: true });
    else this.ctx.notify(`Rode claude no terminal e entre com a sua conta; depois clique em "Já fiz login: conferir". (${SHELL_UNAVAILABLE_HINT}.)`, 'warn');
  }

  private async recheck(): Promise<void> {
    this.busy = 'check';
    this.ctx.invalidate();
    const v = await this.load();
    this.busy = null;
    if (v?.state === 'login') this.ctx.notify('Ainda não achei o login do Claude nesta máquina. Termine o login no terminal e confira de novo.', 'warn');
    this.ctx.invalidate();
  }

  private async start(choice: WelcomeChoice): Promise<void> {
    if (this.busy) return;
    this.busy = choice;
    this.error(null);
    this.ctx.invalidate();
    try {
      const r = await this.post('/api/welcome/start', { choice });
      if (r.ok) {
        this.dismissLocally();
        const id = typeof r.j.agentId === 'string' ? r.j.agentId : undefined;
        if (id) {
          this.pendingFocus = { id, until: Date.now() + FOCUS_MS };
          void this.watchDelivery(id);
        }
        this.ctx.notify('Seu primeiro agente está chegando: aparece no escritório em alguns segundos e já recebe o pedido.');
      } else if (r.j.login === true) {
        await this.load(); // volta ao passo do login
        this.error('Conecte a sua conta do Claude primeiro.');
      } else if (r.status === 409 && this.view) {
        // já usado/pulado em outro navegador
        this.dismissLocally();
      } else this.error(typeof r.j.error === 'string' ? `Não deu para abrir o agente: ${r.j.error}` : 'Não deu para abrir o agente. Tente de novo.');
    } catch {
      this.error('Não foi possível falar com o escritório. Tente de novo.');
    } finally {
      this.busy = null;
      this.ctx.invalidate();
    }
  }

  /**
   * O agente aberto pelo cartão chegou: seleciona e leva a câmera até ele (uma vez). O boneco provisório ("Abrindo o
   * Claude…") não conta, senão a seleção abriria o terminal dele à toa; só se ele parar pedindo configuração.
   */
  private focusArrived(): void {
    const p = this.pendingFocus;
    if (!p) return;
    const a = this.ctx.agent(p.id);
    if (a && (!a.setup || a.status === 'waiting')) {
      this.pendingFocus = null;
      this.ctx.select({ type: 'agent', id: p.id }, { focus: true });
    } else if (Date.now() > p.until) this.pendingFocus = null;
  }

  /** Pergunta ao servidor pela entrega da primeira mensagem e avisa quando ela termina. */
  private async watchDelivery(id: string): Promise<void> {
    const until = Date.now() + DELIVERY_POLL_MAX_MS;
    while (Date.now() < until) {
      await new Promise((ok) => setTimeout(ok, DELIVERY_POLL_MS));
      const d = (await this.load())?.delivery;
      if (!d || d.agentId === '') return;
      const n = deliveryNotice(d, this.ctx.agent(d.agentId)?.name ?? this.ctx.agent(id)?.name);
      if (n) return this.ctx.notify(n.text, n.level);
    }
  }
}
