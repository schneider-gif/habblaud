// Seletor de IA da barra: só o logo da IA em uso (bolinha = funcionando); clicou, a lista no estilo do chat Prisma1.
// "Sua conta" (conta Claude conectada, ou conectar com o token de 1 ano do `claude setup-token`) e "Motores de IA
// Habblaude" (adicional do portal). A troca é gravada pelo servidor (/api/ia) e aplicada pelo daemon hb-ia.
import { IA_MODELOS, iaModelo, type IaEstado } from '../../../shared/ia';
import type { UiContext } from './context';
import { h, setHidden } from './dom';

const LOGO = (arquivo: string) => `/assets/ia/${arquivo}`;
const PORTAL_IA = 'https://app.habblaude.com/escritorio';
const POLL_MS = 60_000;

async function api(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<IaEstado> {
  const r = await fetch(path, {
    method,
    cache: 'no-store',
    ...(method === 'GET' ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) }),
  });
  const j = (await r.json().catch(() => ({}))) as IaEstado & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `erro ${r.status}`);
  return j;
}

const dolar = (v: number) => `US$ ${v.toFixed(2).replace('.', ',')}`;

export class IaPicker {
  readonly el: HTMLButtonElement;
  private img: HTMLImageElement;
  private menu: HTMLElement;
  private estado: IaEstado | null = null;
  private conectando = false;
  private erro = '';
  private ocupado = false;

  constructor(private ctx: UiContext) {
    this.img = h('img', { class: 'ui-ia-btn__logo', attrs: { src: LOGO('prisma.svg'), alt: '', width: 20, height: 20, draggable: 'false' } });
    this.el = h(
      'button',
      {
        class: 'ui-icon-btn ui-ia-btn',
        type: 'button',
        hidden: true,
        attrs: { 'aria-haspopup': 'menu', 'aria-expanded': 'false' },
        on: { click: () => this.toggle() },
      },
      this.img,
      h('span', { class: 'ui-ia-btn__dot', attrs: { 'aria-hidden': 'true' } }),
    );
    this.menu = h('div', { class: 'ui-ia-menu', role: 'menu', hidden: true, attrs: { 'aria-label': 'IA dos agentes' } });
    document.body.append(this.menu);
    document.addEventListener('pointerdown', (e) => {
      if (!this.menu.hidden && !this.menu.contains(e.target as Node) && !this.el.contains(e.target as Node)) this.toggle(false);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !this.menu.hidden) {
        this.toggle(false);
        this.el.focus();
      }
    });
    void this.carregar();
    setInterval(() => void this.carregar(), POLL_MS);
  }

  private async carregar(): Promise<void> {
    try {
      this.mostrar(await api('GET', '/api/ia'));
    } catch {
      /* servidor antigo ou fora: o botão fica como estava */
    }
  }

  private mostrar(e: IaEstado): void {
    this.estado = e;
    setHidden(this.el, !e.disponivel);
    const m = e.modo === 'motores' ? iaModelo(e.modelo) : undefined;
    const nome = e.modo === 'conta' ? 'Minha conta Claude' : m ? m.nome : 'nenhuma IA ligada';
    this.img.src = LOGO(e.modo === 'conta' ? 'claude.svg' : (m?.logo ?? 'prisma.svg'));
    this.el.classList.toggle('ui-ia-btn--off', e.modo === 'nenhum');
    const titulo = `IA dos agentes: ${nome} (clique para trocar)`;
    this.el.title = titulo;
    this.el.setAttribute('aria-label', titulo);
    // com o campo do token aberto não redesenha (apagaria o que o cliente está colando)
    if (!this.menu.hidden && !this.conectando) this.render();
  }

  private toggle(abrir = this.menu.hidden): void {
    if (abrir) {
      this.erro = '';
      this.render();
      const r = this.el.getBoundingClientRect();
      this.menu.style.top = `${Math.round(r.bottom + 6)}px`;
      this.menu.style.right = `${Math.max(8, Math.round(window.innerWidth - r.right))}px`;
      void this.carregar();
    } else this.conectando = false;
    setHidden(this.menu, !abrir);
    this.el.setAttribute('aria-expanded', String(abrir));
  }

  private async agir(fn: () => Promise<IaEstado>): Promise<void> {
    if (this.ocupado) return;
    this.ocupado = true;
    this.erro = '';
    this.render();
    try {
      this.conectando = false;
      this.mostrar(await fn());
      // o daemon aplica em instantes: confere de novo para a bolinha e o uso refletirem
      setTimeout(() => void this.carregar(), 2_500);
    } catch (err) {
      this.erro = err instanceof Error ? err.message : 'não deu certo';
    } finally {
      this.ocupado = false;
      this.render();
    }
  }

  private item(o: { logo: string; nome: string; desc: string; ativo: boolean; pill?: string; desabilitado?: boolean; onClick: () => void }): HTMLElement {
    return h(
      'button',
      {
        class: `ui-ia-item${o.ativo ? ' is-on' : ''}`,
        type: 'button',
        role: 'menuitemradio',
        attrs: { 'aria-checked': String(o.ativo), disabled: o.desabilitado || this.ocupado || undefined },
        on: { click: () => !o.ativo && o.onClick() },
      },
      h('img', { class: 'ui-ia-item__logo', attrs: { src: LOGO(o.logo), alt: '', width: 26, height: 26, draggable: 'false' } }),
      h('span', { class: 'ui-ia-item__txt' }, h('b', { text: o.nome }), h('small', { text: o.desc })),
      o.ativo ? h('span', { class: 'ui-ia-item__ck', text: '✓', attrs: { 'aria-hidden': 'true' } }) : o.pill ? h('span', { class: 'ui-ia-item__pill', text: o.pill }) : null,
    );
  }

  private render(): void {
    const e = this.estado;
    this.menu.replaceChildren();
    if (!e) return;
    const sec = (t: string) => h('div', { class: 'ui-ia-sec', text: t });

    this.menu.append(sec('Sua conta'));
    if (e.conta) {
      this.menu.append(
        this.item({
          logo: 'claude.svg',
          nome: 'Minha conta Claude',
          desc: e.token ? 'Conectada com o token de 1 ano · usa o seu plano' : 'Usa o seu plano Pro/Max',
          ativo: e.modo === 'conta',
          onClick: () => void this.agir(() => api('POST', '/api/ia', { modo: 'conta' })),
        }),
      );
      if (e.token) {
        this.menu.append(
          h('button', { class: 'ui-ia-link', type: 'button', text: 'Desconectar o token da conta Claude', on: { click: () => void this.agir(() => api('DELETE', '/api/ia/token')) } }),
        );
      }
    } else if (!this.conectando) {
      this.menu.append(
        this.item({ logo: 'claude.svg', nome: 'Conectar minha conta Claude', desc: 'Pro ou Max. Fica conectada por 1 ano.', ativo: false, onClick: () => ((this.conectando = true), this.render()) }),
      );
    } else this.menu.append(this.formToken());

    this.menu.append(h('div', { class: 'ui-ia-hr' }), sec('Motores de IA Habblaude'));
    if (e.motores) {
      if (e.bloqueio) this.menu.append(h('p', { class: 'ui-ia-nota ui-ia-nota--warn', text: 'Seu ~/.claude/settings.json tem uma chave própria (ANTHROPIC_API_KEY ou apiKeyHelper) que passa na frente dos Motores. Tire-a para usar os Motores.' }));
      for (const m of IA_MODELOS) {
        this.menu.append(
          this.item({
            logo: m.logo,
            nome: m.nome,
            desc: m.desc,
            ativo: e.modo === 'motores' && e.modelo === m.id,
            pill: m.premium ? 'gasta rápido' : undefined,
            onClick: () => void this.agir(() => api('POST', '/api/ia', { modo: 'motores', modelo: m.id })),
          }),
        );
      }
      if (e.uso) {
        const lim = e.uso.limite !== null ? ` de ${dolar(e.uso.limite)}` : '';
        this.menu.append(h('div', { class: 'ui-ia-uso', text: `📊 Hoje: ${dolar(e.uso.hoje)}${lim}` }));
      }
    } else {
      this.menu.append(
        h('a', { class: 'ui-ia-item', attrs: { href: PORTAL_IA, target: '_blank', rel: 'noopener noreferrer' } },
          h('img', { class: 'ui-ia-item__logo', attrs: { src: LOGO('prisma.svg'), alt: '', width: 26, height: 26 } }),
          h('span', { class: 'ui-ia-item__txt' }, h('b', { text: 'Contratar Motores de IA' }), h('small', { text: 'Agentes com IA da Habblaude, sem conta Claude.' })),
        ),
      );
    }
    this.menu.append(h('p', { class: 'ui-ia-nota', text: 'Vale para agentes novos; os que já estão abertos trocam quando você reabrir.' }));
    if (this.erro) this.menu.append(h('p', { class: 'ui-ia-nota ui-ia-nota--warn', role: 'alert', text: `⚠ ${this.erro}` }));
  }

  private formToken(): HTMLElement {
    const input = h('input', {
      class: 'ui-ia-token__input',
      attrs: { type: 'password', placeholder: 'sk-ant-oat01-…', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Token da conta Claude' },
    });
    const salvar = () => void this.agir(() => api('POST', '/api/ia/token', { token: input.value }));
    input.addEventListener('keydown', (ev) => ev.key === 'Enter' && salvar());
    const terminal = this.ctx.isShellAvailable()
      ? h('button', { class: 'ui-btn', type: 'button', text: 'Abrir o terminal', on: { click: () => this.ctx.openShell({ program: 'claude-token', label: 'Conta Claude' }) } })
      : h('code', { text: 'claude setup-token' });
    return h(
      'div',
      { class: 'ui-ia-token' },
      h('p', { text: '1. No terminal, rode o comando e autorize no navegador com a sua conta Claude:' }),
      terminal,
      h('p', { text: '2. Cole aqui a linha que começa com sk-ant- :' }),
      h('div', { class: 'ui-ia-token__row' }, input, h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Conectar', attrs: { disabled: this.ocupado || undefined }, on: { click: salvar } })),
      h('button', { class: 'ui-ia-link', type: 'button', text: 'Cancelar', on: { click: () => ((this.conectando = false), this.render()) } }),
    );
  }
}
