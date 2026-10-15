// Assistente "Publicar" (Hospedagem Habblaude): leva um projeto de ~/projetos para a internet.
// Passos: 0 conectar a conta · 1 projeto · 2 tipo e comandos · 3 variáveis · 4 endereço (e domínio próprio) ·
// 5 publicar com log ao vivo · "Publicar de novo" · "Meus sites". Fala só com as rotas locais /api/publish/*.
// Abre pelo botão da barra, pela sala ("Publicar este projeto") ou por
//   window.dispatchEvent(new CustomEvent('hb:publish', { detail: { path } }))
// Também atende os pedidos dos agentes (CLI habblaud-publicar): mostra "Publicar?" e só publica com o sim do usuário.
import type {
  Conta,
  Deteccao,
  DeployView,
  DominioView,
  EnvImport,
  PacoteInfo,
  ProjetoLocal,
  PublishRequest,
  PublishStatus,
  SegredoEncontrado,
  SiteConfig,
  SiteView,
  Tipo,
} from '../../../shared/publish';
import { slugSite, TIPOS } from '../../../shared/publish';
import type { UiContext } from './context';
import { copyText, h, iconButton } from './dom';
import { ICONS, pixelIcon } from './icons';
import * as M from './publish-model';
import './publish.css';

export const PUBLISH_EVENT = 'hb:publish';

/** Abre o assistente (de qualquer lugar da interface, sem depender do contexto). */
export function requestPublish(path?: string): void {
  window.dispatchEvent(new CustomEvent(PUBLISH_EVENT, { detail: { path } }));
}

const PUBLISH_ICON = pixelIcon(['...##...', '..#..#..', '..#..#..', '.#.##.#.', '.#....#.', '.#.##.#.', '##....##', '#.#..#.#', '...##...', '..#..#..']);
const DOMAIN_CHECK_MS = 15_000;
const STEPS = ['project', 'detect', 'env', 'address', 'publish'] as const;
const STEP_LABEL = ['Projeto', 'Tipo', 'Variáveis', 'Endereço', 'Publicar'];

type View = 'loading' | 'off' | 'connect' | 'project' | 'detect' | 'env' | 'address' | 'publish' | 'sites';

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly motivo?: string,
  ) {
    super(message);
  }
}

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      cache: 'no-store',
      headers: { Accept: 'application/json', ...(method !== 'GET' ? { 'Content-Type': 'application/json' } : {}) },
      body: method !== 'GET' ? JSON.stringify(body ?? {}) : undefined,
    });
  } catch {
    throw new ApiError(0, 'Sem conexão com o servidor do Habblaud.');
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new ApiError(r.status, typeof j.error === 'string' ? j.error : `Erro ${r.status}.`, typeof j.code === 'string' ? j.code : undefined, typeof j.motivo === 'string' ? j.motivo : undefined);
  return j as T;
}

interface Flow {
  projeto?: ProjetoLocal;
  deteccao?: Deteccao;
  segredos: SegredoEncontrado[];
  envDisponivel?: EnvImport;
  tipo: Tipo;
  config: SiteConfig;
  env: M.EnvRow[];
  envChanged: boolean;
  /** Site deste projeto (existente ou recém-criado). */
  site?: SiteView;
  /** O site já existia antes deste fluxo (publicar de novo: atualiza a configuração). */
  siteExisted: boolean;
  nome: string;
  handle: string;
  dominio: string;
  querDominio: boolean;
  requestId?: string;
}

function newFlow(): Flow {
  return { segredos: [], tipo: 'static', config: { porta: 8080 }, env: [], envChanged: false, siteExisted: false, nome: '', handle: '', dominio: '', querDominio: false };
}

let uid = 0;
const nextId = (p: string) => `ui-pub-${p}-${++uid}`;

function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const id = control.id || nextId('f');
  control.id = id;
  const hintEl = hint ? h('span', { class: 'ui-pub__hint', text: hint, attrs: { id: `${id}-hint` } }) : null;
  if (hintEl) control.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'ui-pub__field' }, h('label', { text: label, attrs: { for: id } }), control, hintEl);
}

function input(value: string, opts: { placeholder?: string; mono?: boolean; type?: string; max?: number; onInput?: (v: string) => void; label?: string } = {}): HTMLInputElement {
  const el = h('input', {
    class: `ui-pub__input${opts.mono ? ' is-mono' : ''}`,
    type: opts.type ?? 'text',
    attrs: { placeholder: opts.placeholder, autocomplete: 'off', spellcheck: 'false', maxlength: opts.max, 'aria-label': opts.label },
  });
  el.value = value;
  if (opts.onInput) el.addEventListener('input', () => opts.onInput!(el.value));
  return el;
}

function btn(text: string, onClick: () => void, cls = ''): HTMLButtonElement {
  return h('button', { class: `ui-btn ${cls}`.trim(), type: 'button', text, on: { click: () => onClick() } });
}

function relTime(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'agora há pouco';
  if (s < 3600) return `há ${Math.round(s / 60)} min`;
  if (s < 86400) return `há ${Math.round(s / 3600)} h`;
  return `há ${Math.round(s / 86400)} dia(s)`;
}

export class PublishWizard {
  readonly el: HTMLDialogElement;
  readonly button: HTMLButtonElement;
  /** Pedido de um agente ("Publicar?"). */
  readonly askEl: HTMLDialogElement;
  private body: HTMLElement;
  private tabs: HTMLElement;
  private tabNew: HTMLButtonElement;
  private tabSites: HTMLButtonElement;
  private view: View = 'loading';
  private status?: PublishStatus;
  private flow: Flow = newFlow();
  /** Para onde ir depois de conectar. */
  private target: { view: 'project' | 'sites'; path?: string } = { view: 'project' };
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private es?: EventSource;
  private domainChecks = new Map<string, { siteId: string; nome: string; el: HTMLElement; update: (d: DominioView) => void }>();
  private currentAsk?: PublishRequest;
  private asked = new Set<string>();
  private askQueue: PublishRequest[] = [];
  private available = true;

  constructor(private ctx: UiContext) {
    this.button = iconButton(PUBLISH_ICON, 'Publicar um projeto na internet', () => this.open());
    this.button.classList.add('ui-btn-publish');
    this.button.setAttribute('aria-haspopup', 'dialog');

    const title = h('h2', { text: 'Publicar', attrs: { id: 'ui-pub-title' } });
    this.tabNew = h('button', { class: 'ui-pub__tab', type: 'button', text: 'Publicar projeto', on: { click: () => this.startNew() } });
    this.tabSites = h('button', { class: 'ui-pub__tab', type: 'button', text: 'Meus sites', on: { click: () => void this.showSites() } });
    this.tabs = h('div', { class: 'ui-pub__tabs', role: 'group', attrs: { 'aria-label': 'Seções' } }, this.tabNew, this.tabSites);
    this.body = h('div', { class: 'ui-pub__body' });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-pub', attrs: { 'aria-labelledby': 'ui-pub-title' } },
      h('div', { class: 'ui-dialog__head ui-pub__head' }, h('div', { class: 'ui-pub__title' }, title, this.tabs), iconButton(ICONS.close, 'Fechar', () => this.close(), 'ui-icon-btn--sm')),
      this.body,
    );
    this.el.addEventListener('close', () => {
      this.clearTimers();
      this.domainChecks.clear();
    });
    // Teclas dentro da janela não acionam os atalhos do escritório (o Esc fecha a janela pelo próprio <dialog>).
    this.el.addEventListener('keydown', (e) => e.stopPropagation());

    this.askEl = h('dialog', { class: 'ui-dialog ui-pub ui-pub-ask', role: 'alertdialog', attrs: { 'aria-labelledby': 'ui-pub-ask-title', 'aria-describedby': 'ui-pub-ask-text' } });
    this.askEl.addEventListener('keydown', (e) => e.stopPropagation());
    // Esc no pedido = "Agora não".
    this.askEl.addEventListener('cancel', () => this.rejectAsk());
    this.askEl.addEventListener('close', () => setTimeout(() => this.nextAsk(), 50));

    window.addEventListener(PUBLISH_EVENT, (e) => {
      const d = (e as CustomEvent<{ path?: string }>).detail;
      this.open({ path: typeof d?.path === 'string' ? d.path : undefined });
    });
    if (ctx.store.mock) this.button.hidden = true;
    else void this.watchRequests();
  }

  // ------------------------------------------------------------ abrir/fechar

  open(opts: { path?: string; requestId?: string; view?: 'sites' } = {}): void {
    if (!this.available) {
      this.ctx.notify('Publicar só funciona com o Habblaud aberto pelo próprio computador (http://localhost).', 'warn');
      return;
    }
    this.flow = newFlow();
    this.flow.requestId = opts.requestId;
    this.target = { view: opts.view ?? 'project', path: opts.path };
    if (!this.el.open) this.el.showModal();
    void this.boot();
  }

  close(): void {
    if (this.el.open) this.el.close();
  }

  private clearTimers(): void {
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.es?.close();
    this.es = undefined;
    this.domainTimer = false;
  }

  private later(fn: () => void, ms: number): void {
    const t = setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
  }

  /** Troca o conteúdo da janela e leva o foco ao título da etapa. */
  private show(view: View, ...children: (Node | null | false | undefined)[]): void {
    this.clearTimers();
    this.view = view;
    const inFlow = (STEPS as readonly string[]).includes(view);
    this.tabs.hidden = view === 'connect' || view === 'off' || view === 'loading';
    this.tabNew.setAttribute('aria-pressed', String(inFlow));
    this.tabSites.setAttribute('aria-pressed', String(view === 'sites'));
    const nodes = children.filter((c): c is Node => !!c);
    if (inFlow) nodes.unshift(this.stepper(STEPS.indexOf(view as (typeof STEPS)[number])));
    this.body.replaceChildren(...nodes);
    this.body.scrollTop = 0;
    for (const [k, c] of this.domainChecks) if (!c.el.isConnected) this.domainChecks.delete(k);
    this.scheduleDomainChecks();
    const head = this.body.querySelector<HTMLElement>('h3');
    if (head) {
      head.tabIndex = -1;
      head.focus({ preventScroll: true });
    }
  }

  private stepper(i: number): HTMLElement {
    const ol = h('ol', { class: 'ui-pub__steps', attrs: { 'aria-label': `Passo ${i + 1} de ${STEPS.length}` } });
    STEP_LABEL.forEach((label, n) => ol.append(h('li', { class: n < i ? 'is-done' : n === i ? 'is-current' : '', attrs: n === i ? { 'aria-current': 'step' } : {} }, h('span', { class: 'ui-pub__step-n', text: String(n + 1) }), h('span', { class: 'ui-pub__step-l', text: label }))));
    return ol;
  }

  private loading(text: string): void {
    this.show('loading', h('div', { class: 'ui-pub__loading', role: 'status' }, h('span', { class: 'ui-pub__spinner', attrs: { 'aria-hidden': 'true' } }), h('span', { text })));
  }

  private errorBox(err: unknown): HTMLElement {
    const msg = err instanceof Error ? err.message : String(err);
    return h('p', { class: 'ui-pub__alert is-error', role: 'alert', text: msg });
  }

  // ------------------------------------------------------------ conexão

  private async boot(): Promise<void> {
    this.loading('Conferindo sua conta…');
    try {
      this.status = await api<PublishStatus>('GET', '/api/publish/status');
    } catch (err) {
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        this.show('off', h('h3', { text: 'Publicar indisponível aqui' }), h('p', { text: err.status === 404 ? 'Esta versão do servidor do Habblaud não tem o Publicar.' : err.message }));
        return;
      }
      this.show('off', h('h3', { text: 'Algo deu errado' }), this.errorBox(err), btn('Tentar de novo', () => void this.boot()));
      return;
    }
    if (!this.ready()) return this.renderConnect();
    await this.goTarget();
  }

  private ready(): boolean {
    const s = this.status;
    return !!s?.connected && !!s.conta && s.conta.ativo;
  }

  private get conta(): Conta | undefined {
    return this.status?.conta;
  }

  private async goTarget(): Promise<void> {
    if (this.target.view === 'sites') return this.showSites();
    if (this.target.path) return this.loadDetect(this.target.path);
    return this.renderProjects();
  }

  private renderConnect(): void {
    const s = this.status!;
    if (s.connected && s.conta && !s.conta.ativo) {
      const why = s.conta.motivo ? M.MOTIVO_LABEL[s.conta.motivo] : 'A hospedagem não está ativa na sua conta.';
      this.show(
        'connect',
        h('h3', { text: 'Falta ativar a hospedagem' }),
        h('p', { text: why }),
        h('p', { class: 'ui-pub__muted', text: 'Com a Hospedagem Habblaude seus projetos ganham um endereço na internet, com HTTPS, sem você mexer em servidor.' }),
        h(
          'div',
          { class: 'ui-pub__actions' },
          h('a', { class: 'ui-btn ui-btn--primary', text: s.conta.motivo === 'sem_complemento' ? 'Contratar a hospedagem' : 'Abrir o portal', attrs: { href: s.conta.contratarUrl, target: '_blank', rel: 'noopener noreferrer' } }),
          btn('Já resolvi, conferir de novo', () => void this.boot()),
        ),
      );
      return;
    }
    if (s.connected && s.erroCode && s.erroCode !== 'unauthenticated') {
      this.show('connect', h('h3', { text: 'Não conseguimos falar com o portal' }), this.errorBox(s.erro), h('div', { class: 'ui-pub__actions' }, btn('Tentar de novo', () => void this.boot())));
      return;
    }
    const refused = s.connected && s.erroCode === 'unauthenticated';
    const p = s.pairing;
    const parts: (Node | null)[] = [
      h('h3', { text: refused ? 'Conecte sua conta de novo' : 'Conecte sua conta Habblaude' }),
      h('p', {
        text: refused
          ? s.tokenSource === 'env'
            ? 'A chave configurada neste escritório (HB_PUBLISH_TOKEN) foi recusada. Peça uma nova no portal ou conecte por aqui.'
            : 'A conexão deste escritório com a sua conta foi desfeita ou expirou.'
          : 'Para publicar, este escritório precisa da sua permissão. Vamos abrir o portal numa nova aba: lá você só confirma.',
      }),
    ];
    if (p?.status === 'pending') {
      parts.push(
        h(
          'div',
          { class: 'ui-pub__pair', role: 'status' },
          h('span', { class: 'ui-pub__spinner', attrs: { 'aria-hidden': 'true' } }),
          h('div', {}, h('strong', { text: 'Esperando você confirmar no portal…' }), h('p', { class: 'ui-pub__muted' }, 'Código: ', h('code', { class: 'ui-pub__code', text: p.code }))),
        ),
        h('div', { class: 'ui-pub__actions' }, h('a', { class: 'ui-btn ui-btn--primary', text: 'Abrir a página de confirmação', attrs: { href: p.url, target: '_blank', rel: 'noopener noreferrer' } }), btn('Gerar outro código', () => void this.connect())),
      );
      this.show('connect', ...parts);
      this.later(() => void this.pollPairing(), 2000);
      return;
    }
    if (p?.status === 'expired') parts.push(h('p', { class: 'ui-pub__alert is-warn', text: 'O código expirou. Gere outro.' }));
    if (p?.status === 'error' && p.erro) parts.push(this.errorBox(p.erro));
    parts.push(h('div', { class: 'ui-pub__actions' }, btn('Conectar minha conta', () => void this.connect(), 'ui-btn--primary')));
    this.show('connect', ...parts);
  }

  private async connect(): Promise<void> {
    try {
      const p = await api<{ url: string }>('POST', '/api/publish/connect');
      window.open(p.url, '_blank', 'noopener');
      this.status = await api<PublishStatus>('GET', '/api/publish/status');
      this.renderConnect();
    } catch (err) {
      this.show('connect', h('h3', { text: 'Não deu para começar a conexão' }), this.errorBox(err), h('div', { class: 'ui-pub__actions' }, btn('Tentar de novo', () => void this.connect())));
    }
  }

  private async pollPairing(): Promise<void> {
    if (this.view !== 'connect' || !this.el.open) return;
    try {
      this.status = await api<PublishStatus>('GET', '/api/publish/status');
    } catch {
      this.later(() => void this.pollPairing(), 4000);
      return;
    }
    if (this.status.pairing?.status === 'ok' || (this.status.connected && !this.status.erroCode)) {
      this.ctx.notify('Escritório conectado à sua conta Habblaude.', 'info');
      if (this.ready()) return void this.goTarget();
      return this.renderConnect();
    }
    if (this.status.pairing?.status === 'pending') this.later(() => void this.pollPairing(), 2000);
    else this.renderConnect();
  }

  // ------------------------------------------------------------ passo 1: projeto

  private startNew(): void {
    this.flow = newFlow();
    void this.renderProjects();
  }

  private async renderProjects(): Promise<void> {
    this.loading('Procurando seus projetos…');
    let list: { dir: string; projects: ProjetoLocal[] };
    try {
      list = await api('GET', '/api/publish/projects');
    } catch (err) {
      return this.show('project', h('h3', { text: 'Qual projeto você quer publicar?' }), this.errorBox(err));
    }
    const sites = this.conta?.sites ?? [];
    const ul = h('ul', { class: 'ui-pub__list', attrs: { 'aria-label': 'Projetos' } });
    for (const p of list.projects) {
      const site = this.flow.site ?? M.siteForProject(sites, p.nome);
      const already = !this.flow.site && site;
      ul.append(
        h(
          'li',
          {},
          h(
            'button',
            { class: 'ui-pub__pick', type: 'button', on: { click: () => void this.loadDetect(p.path) } },
            h('span', { class: 'ui-pub__pick-name', text: p.nome }),
            h('span', { class: 'ui-pub__pick-sub', text: already ? `Já publicado em ${site.subdominio}` : p.path }),
          ),
        ),
      );
    }
    this.show(
      'project',
      h('h3', { text: this.flow.site ? `Qual pasta tem o site "${this.flow.site.nome}"?` : 'Qual projeto você quer publicar?' }),
      list.projects.length
        ? ul
        : h('p', { class: 'ui-pub__muted', text: `Nenhum projeto em ${list.dir} ainda. Peça a um agente para criar um e volte aqui.` }),
      h('p', { class: 'ui-pub__muted ui-pub__small', text: 'Projetos são as pastas dentro de ~/projetos. Publicar via GitHub: em breve.' }),
    );
  }

  // ------------------------------------------------------------ passo 2: tipo e comandos

  private async loadDetect(path: string): Promise<void> {
    this.loading('Olhando os arquivos do projeto…');
    try {
      const r = await api<{ projeto: ProjetoLocal; deteccao: Deteccao; segredos: SegredoEncontrado[] }>('POST', '/api/publish/detect', { path });
      const f = this.flow;
      f.projeto = r.projeto;
      f.deteccao = r.deteccao;
      f.segredos = r.segredos;
      const site = f.site ?? M.siteForProject(this.conta?.sites ?? [], r.projeto.nome);
      if (site) {
        f.site = site;
        f.siteExisted = true;
        f.env = site.envKeys.map((key) => ({ key, value: '', saved: true }));
      }
      f.tipo = r.deteccao.tipo;
      f.config = { ...r.deteccao.config };
      f.nome = slugSite(r.projeto.nome);
      f.handle = this.conta?.handle ?? this.conta?.handleSugerido ?? '';
      f.envDisponivel = await api<EnvImport>('POST', '/api/publish/env-import', { path: r.projeto.path }).catch(() => undefined);
      this.renderDetect();
    } catch (err) {
      this.show('project', h('h3', { text: 'Não deu para abrir esse projeto' }), this.errorBox(err), h('div', { class: 'ui-pub__actions' }, btn('Escolher outro', () => void this.renderProjects())));
    }
  }

  private renderDetect(): void {
    const f = this.flow;
    const d = f.deteccao!;
    const errs = h('div', { attrs: { 'aria-live': 'polite' } });
    const fieldsBox = h('div', { class: 'ui-pub__grid' });
    const select = h('select', { class: 'ui-pub__input', on: { change: () => ((f.tipo = select.value as Tipo), drawFields()) } });
    for (const t of TIPOS) select.append(h('option', { text: M.TIPO_LABEL[t], attrs: { value: t, selected: t === f.tipo } }));
    const drawFields = () => {
      const on = M.fieldsFor(f.tipo);
      const c = f.config;
      const set = (k: keyof SiteConfig) => (v: string) => ((c as unknown as Record<string, unknown>)[k] = v);
      const kids: HTMLElement[] = [];
      if (on.install) kids.push(field('Instalar dependências', input(c.install ?? '', { mono: true, placeholder: 'padrão do tipo', max: M.COMMAND_MAX, onInput: set('install') })));
      if (on.build) kids.push(field('Gerar o site (build)', input(c.build ?? '', { mono: true, placeholder: 'sem build', max: M.COMMAND_MAX, onInput: set('build') })));
      if (on.start) kids.push(field('Iniciar o app', input(c.start ?? '', { mono: true, placeholder: f.tipo === 'dockerfile' ? 'o do Dockerfile' : 'ex.: npm start', max: M.COMMAND_MAX, onInput: set('start') })));
      if (on.porta) {
        const porta = input(String(c.porta ?? ''), { type: 'number', onInput: (v) => (c.porta = Number(v)) });
        porta.min = '1';
        porta.max = '65535';
        porta.inputMode = 'numeric';
        kids.push(field('Porta do app', porta, 'A porta em que seu app escuta (a variável PORT também recebe esse número).'));
      }
      if (on.saida) kids.push(field('Pasta com o site pronto', input(c.saida ?? (f.tipo === 'static' ? '.' : 'dist'), { mono: true, onInput: set('saida') }), f.tipo === 'static' ? 'Onde está o index.html ("." = a pasta do projeto).' : 'Onde o build deixa os arquivos.'));
      if (on.spa) {
        const cb = h('input', { type: 'checkbox', on: { change: () => (c.spa = cb.checked) } });
        cb.checked = !!c.spa;
        kids.push(h('label', { class: 'ui-pub__check' }, cb, h('span', { text: 'Aplicativo de página única (toda rota abre o index.html)' })));
      }
      fieldsBox.replaceChildren(...kids);
    };
    drawFields();
    const avisos = d.avisos.length ? h('ul', { class: 'ui-pub__alert is-warn ui-pub__bullets' }, ...d.avisos.map((a) => h('li', { text: a }))) : null;
    this.show(
      'detect',
      h('h3', { text: `Como publicar "${f.projeto!.nome}"` }),
      h('p', { class: 'ui-pub__alert is-ok', text: d.motivo }),
      avisos,
      f.siteExisted && f.site ? h('p', { class: 'ui-pub__muted', text: `Este projeto já está no ar em ${f.site.subdominio}: vamos atualizá-lo.` }) : null,
      field('Tipo', select),
      fieldsBox,
      h('p', { class: 'ui-pub__muted ui-pub__small', text: 'Já preenchemos tudo pelo que achamos nos arquivos. Só mude se souber o que está fazendo.' }),
      errs,
      this.nav(
        () => void this.renderProjects(),
        () => {
          const probs = M.configProblems(f.tipo, f.config);
          if (probs.length) return errs.replaceChildren(h('ul', { class: 'ui-pub__alert is-error ui-pub__bullets', role: 'alert' }, ...probs.map((p) => h('li', { text: p }))));
          this.renderEnv();
        },
      ),
    );
  }

  private nav(back: (() => void) | null, next: () => void, nextText = 'Continuar'): HTMLElement {
    return h('div', { class: 'ui-pub__actions ui-pub__nav' }, back ? btn('Voltar', back) : h('span'), btn(nextText, next, 'ui-btn--primary'));
  }

  // ------------------------------------------------------------ passo 3: variáveis

  private renderEnv(): void {
    const f = this.flow;
    const errs = h('div', { attrs: { 'aria-live': 'polite' } });
    const table = h('div', { class: 'ui-pub__env', role: 'table', attrs: { 'aria-label': 'Variáveis de ambiente' } });
    const draw = () => {
      table.replaceChildren(h('div', { class: 'ui-pub__env-row is-head', role: 'row' }, h('span', { role: 'columnheader', text: 'Nome' }), h('span', { role: 'columnheader', text: 'Valor' }), h('span')));
      f.env.forEach((row, i) => {
        const k = input(row.key, {
          mono: true,
          placeholder: 'NOME_DA_VARIAVEL',
          label: `Nome da variável ${i + 1}`,
          onInput: (v) => {
            const up = v.toUpperCase().replace(/[^A-Z0-9_]/g, '_');
            if (up !== v) k.value = up;
            row.key = up;
            row.saved = false;
            f.envChanged = true;
          },
        });
        const val = input(row.value, {
          mono: true,
          placeholder: row.saved ? '(guardado; digite para trocar)' : 'valor',
          label: `Valor da variável ${i + 1}`,
          onInput: (v) => {
            row.value = v;
            f.envChanged = true;
          },
        });
        const del = iconButton(ICONS.close, `Remover ${row.key || 'variável'}`, () => {
          f.env.splice(i, 1);
          f.envChanged = true;
          draw();
        }, 'ui-icon-btn--sm');
        table.append(h('div', { class: 'ui-pub__env-row', role: 'row' }, h('span', { role: 'cell' }, k), h('span', { role: 'cell' }, val), h('span', { role: 'cell' }, del)));
      });
      if (!f.env.length) table.append(h('p', { class: 'ui-pub__muted ui-pub__small', text: 'Nenhuma variável. Se o seu app não precisa de senhas nem chaves, pode seguir.' }));
    };
    draw();
    const add = btn('+ Adicionar variável', () => {
      f.env.push({ key: '', value: '' });
      f.envChanged = true;
      draw();
      (table.querySelector('.ui-pub__env-row:last-child input') as HTMLInputElement | null)?.focus();
    });
    const imp = f.envDisponivel;
    const nImp = imp ? Object.keys(imp.vars).length : 0;
    const importBtn = nImp
      ? btn(`Importar ${nImp} do ${imp!.arquivos.join(' + ')}`, () => {
          f.env = M.mergeEnv(f.env, imp!.vars);
          f.envChanged = true;
          draw();
          this.ctx.announce(`${nImp} variáveis importadas.`);
        })
      : null;
    const segredos = f.segredos.length
      ? h(
          'div',
          { class: 'ui-pub__alert is-error', role: 'alert' },
          h('strong', { text: `Atenção: achamos ${f.segredos.length === 1 ? 'uma senha ou chave' : `${f.segredos.length} senhas ou chaves`} escrita${f.segredos.length === 1 ? '' : 's'} no código.` }),
          h('ul', { class: 'ui-pub__bullets' }, ...f.segredos.slice(0, 8).map((s) => h('li', {}, h('code', { text: `${s.arquivo}:${s.linha}` }), ` — ${s.rotulo}`)), f.segredos.length > 8 ? h('li', { text: `… e mais ${f.segredos.length - 8}` }) : null),
          h('p', { text: 'Elas iriam junto para a internet. O ideal: peça ao seu agente para tirá-las do código e ler de variáveis de ambiente (ex.: process.env.MINHA_CHAVE), e cadastre o valor aqui embaixo.' }),
        )
      : null;
    const ignored = imp?.ignoradas.length ? h('p', { class: 'ui-pub__muted ui-pub__small', text: `Ignoradas do .env (nome fora do padrão MAIÚSCULAS_E_NUMEROS, ou reservado como PORT): ${imp.ignoradas.join(', ')}` }) : null;
    this.show(
      'env',
      h('h3', { text: 'Senhas e chaves (variáveis de ambiente)' }),
      h('p', { class: 'ui-pub__muted', text: 'O que for segredo fica guardado aqui, fora do código. O arquivo .env nunca é enviado; importe dele se quiser.' }),
      segredos,
      table,
      h('div', { class: 'ui-pub__actions' }, add, importBtn),
      ignored,
      f.siteExisted && f.site?.envKeys.length ? h('p', { class: 'ui-pub__muted ui-pub__small', text: 'Por segurança os valores salvos não aparecem. Se mudar alguma variável, digite de novo os valores das outras (a lista inteira é trocada).' }) : null,
      errs,
      this.nav(
        () => this.renderDetect(),
        () => {
          f.env = f.env.filter((r) => r.key.trim() || r.value);
          const probs = M.envProblems(f.env, f.envChanged);
          if (probs.length) return errs.replaceChildren(h('ul', { class: 'ui-pub__alert is-error ui-pub__bullets', role: 'alert' }, ...probs.map((p) => h('li', { text: p }))));
          this.renderAddress();
        },
      ),
    );
  }

  // ------------------------------------------------------------ passo 4: endereço

  private renderAddress(): void {
    const f = this.flow;
    const conta = this.conta!;
    const base = conta.dominioBase || 'habblaude.app';
    if (f.site) {
      const doms = h('div', { class: 'ui-pub__doms' });
      this.drawDomains(doms, f.site);
      this.show(
        'address',
        h('h3', { text: 'Endereço do site' }),
        h('p', {}, f.siteExisted ? 'Este projeto já tem endereço: ' : 'Endereço criado: ', h('strong', { class: 'ui-pub__addr', text: f.site.subdominio })),
        doms,
        this.domainForm(f.site, doms),
        this.nav(f.siteExisted ? () => this.renderEnv() : null, () => this.renderPublish(), f.siteExisted ? 'Publicar de novo' : 'Publicar agora'),
      );
      return;
    }
    const errs = h('div', { attrs: { 'aria-live': 'polite' } });
    const preview = h('strong', { class: 'ui-pub__addr' });
    const upd = () => (preview.textContent = `https://${M.addressPreview(f.nome, f.handle, base)}`);
    const nome = input(f.nome, { mono: true, max: 30, onInput: (v) => ((f.nome = v.toLowerCase().replace(/[^a-z0-9-]/g, '-')), (nome.value = f.nome), upd()) });
    const handleField = conta.handle
      ? null
      : field(
          'Seu nome de usuário (vale para todos os seus sites)',
          input(f.handle, { mono: true, max: 20, onInput: (v) => ((f.handle = v.toLowerCase().replace(/[^a-z0-9]/g, '')), upd()) }),
          'De 3 a 20 letras minúsculas e números. Não dá para trocar depois de criar o primeiro site.',
        );
    const domInput = input(f.dominio, { mono: true, placeholder: 'www.minhaloja.com.br', onInput: (v) => (f.dominio = v) });
    const domBox = h('div', { class: 'ui-pub__domwrap', hidden: !f.querDominio }, field('Seu domínio', domInput, 'Depois mostramos os registros exatos para cadastrar onde você comprou o domínio.'));
    const cb = h('input', { type: 'checkbox', on: { change: () => ((f.querDominio = cb.checked), (domBox.hidden = !cb.checked)) } });
    cb.checked = f.querDominio;
    upd();
    const limit = conta.plano ? `Seu plano (${conta.plano.nome}) permite ${conta.plano.maxSites} site(s) e ${conta.plano.maxDominios} domínio(s) próprio(s).` : '';
    const create = async (button: HTMLButtonElement) => {
      const probs = [M.siteNameProblem(f.nome), !conta.handle ? M.handleProblem(f.handle) : undefined, f.querDominio ? M.domainProblem(M.normalizeDomain(f.dominio)) : undefined].filter(Boolean) as string[];
      if (probs.length) return errs.replaceChildren(h('ul', { class: 'ui-pub__alert is-error ui-pub__bullets', role: 'alert' }, ...probs.map((p) => h('li', { text: p }))));
      button.disabled = true;
      try {
        const r = await api<{ site: SiteView }>('POST', '/api/publish/sites', { nome: f.nome, tipo: f.tipo, config: M.cleanConfig(f.tipo, f.config), ...(conta.handle ? {} : { handle: f.handle }) });
        f.site = r.site;
        f.siteExisted = false;
        if (!conta.handle) conta.handle = f.handle;
        conta.sites = [...conta.sites, r.site];
        if (f.querDominio) {
          try {
            const d = await api<{ dominio: DominioView }>('POST', `/api/publish/sites/${encodeURIComponent(r.site.id)}/dominios`, { dominio: M.normalizeDomain(f.dominio) });
            f.site.dominios = [...f.site.dominios, d.dominio];
          } catch (err) {
            this.ctx.notify(`Site criado, mas o domínio não entrou: ${(err as Error).message}`, 'warn');
          }
        }
        if (f.site.dominios.length) this.renderAddress();
        else this.renderPublish();
      } catch (err) {
        button.disabled = false;
        const msg = err instanceof ApiError && err.code === 'site_limit' ? `${err.message.replace(/[.;]?\s*despublique um ou mude de plano\.?$/i, '')}. Despublique um site em "Meus sites" ou mude de plano no portal.` : (err as Error).message;
        errs.replaceChildren(h('p', { class: 'ui-pub__alert is-error', role: 'alert', text: msg }));
      }
    };
    const go = btn('Criar endereço e publicar', () => void create(go), 'ui-btn--primary');
    this.show(
      'address',
      h('h3', { text: 'Onde o site vai ficar' }),
      field('Nome do site', nome, 'Letras minúsculas, números e hífen.'),
      handleField,
      h('p', { class: 'ui-pub__preview' }, h('span', { class: 'ui-pub__muted', text: 'Seu endereço: ' }), preview),
      h('label', { class: 'ui-pub__check' }, cb, h('span', { text: 'Quero usar também um domínio meu (ex.: www.minhaloja.com.br)' })),
      domBox,
      limit ? h('p', { class: 'ui-pub__muted ui-pub__small', text: limit }) : null,
      errs,
      h('div', { class: 'ui-pub__actions ui-pub__nav' }, btn('Voltar', () => this.renderEnv()), go),
    );
  }

  /** Lista de domínios de um site com os registros DNS e checagem automática a cada 15 s. */
  private drawDomains(box: HTMLElement, site: SiteView): void {
    box.replaceChildren(...site.dominios.map((d) => this.domainBlock(site, d)));
  }

  private domainBlock(site: SiteView, d: DominioView): HTMLElement {
    const el = h('div', { class: `ui-pub__dom is-${d.status}` });
    const draw = (dom: DominioView) => {
      el.className = `ui-pub__dom is-${dom.status}`;
      const idx = site.dominios.findIndex((x) => x.nome === dom.nome);
      if (idx >= 0) site.dominios[idx] = dom;
      const head = h(
        'div',
        { class: 'ui-pub__dom-head' },
        h('strong', { text: dom.nome }),
        h('span', { class: `ui-pub__chip is-${dom.status === 'ok' ? 'ok' : 'warn'}`, text: dom.status === 'ok' ? 'OK, funcionando' : 'Pendente' }),
      );
      const kids: (HTMLElement | null)[] = [head];
      if (dom.status === 'pendente') {
        kids.push(h('p', { class: 'ui-pub__small', text: 'Cadastre exatamente estes registros no painel onde você comprou o domínio (Registro.br, GoDaddy, Cloudflare…):' }));
        const table = h('table', { class: 'ui-pub__dns' }, h('thead', {}, h('tr', {}, h('th', { text: 'Tipo' }), h('th', { text: 'Nome' }), h('th', { text: 'Valor' }), h('th', { attrs: { 'aria-label': 'Copiar' } }))));
        const tb = h('tbody');
        for (const r of dom.registros) {
          const copy = (text: string, what: string) =>
            iconButton(ICONS.copy, `Copiar ${what}`, () => void copyText(text).then((ok) => this.ctx.announce(ok ? `${what} copiado` : 'Não deu para copiar')), 'ui-icon-btn--sm');
          tb.append(
            h(
              'tr',
              {},
              h('td', { attrs: { 'data-label': 'Tipo' } }, h('code', { text: r.tipo })),
              h('td', { attrs: { 'data-label': 'Nome' } }, h('code', { text: r.nome }), copy(r.nome, 'nome')),
              h('td', { attrs: { 'data-label': 'Valor' } }, h('code', { text: r.valor }), copy(r.valor, 'valor')),
              h('td'),
            ),
          );
        }
        table.append(tb);
        kids.push(h('div', { class: 'ui-pub__dns-wrap' }, table));
        kids.push(h('p', { class: 'ui-pub__muted ui-pub__small', role: 'status', text: `Conferimos sozinhos a cada 15 segundos${dom.erro ? ` (última: ${dom.erro})` : ''}. O DNS pode levar de minutos a algumas horas.` }));
      } else if (dom.verificadoEm) kids.push(h('p', { class: 'ui-pub__muted ui-pub__small', text: `Verificado ${relTime(dom.verificadoEm)}. O HTTPS é ativado automaticamente.` }));
      const check = btn('Verificar agora', () => void verify(), 'ui-btn--sm');
      const remove = btn('Remover', () => void del(), 'ui-btn--sm');
      kids.push(h('div', { class: 'ui-pub__actions' }, dom.status === 'pendente' ? check : null, remove));
      el.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
      const key = `${site.id}|${dom.nome}`;
      if (dom.status === 'pendente') this.domainChecks.set(key, { siteId: site.id, nome: dom.nome, el, update: draw });
      else this.domainChecks.delete(key);
      this.scheduleDomainChecks();
    };
    const verify = async () => {
      try {
        const r = await api<{ dominio: DominioView }>('POST', `/api/publish/sites/${encodeURIComponent(site.id)}/dominios/${encodeURIComponent(d.nome)}/verificar`);
        if (r.dominio.status === 'ok') this.ctx.notify(`Domínio ${r.dominio.nome} funcionando!`, 'info');
        draw(r.dominio);
      } catch (err) {
        this.ctx.notify((err as Error).message, 'warn');
      }
    };
    const del = async () => {
      if (!confirm(`Remover o domínio ${d.nome} deste site?`)) return;
      try {
        await api('DELETE', `/api/publish/sites/${encodeURIComponent(site.id)}/dominios/${encodeURIComponent(d.nome)}`);
        site.dominios = site.dominios.filter((x) => x.nome !== d.nome);
        this.domainChecks.delete(`${site.id}|${d.nome}`);
        el.remove();
      } catch (err) {
        this.ctx.notify((err as Error).message, 'warn');
      }
    };
    draw(d);
    return el;
  }

  private domainTimer = false;
  private scheduleDomainChecks(): void {
    if (this.domainTimer || !this.domainChecks.size) return;
    this.domainTimer = true;
    this.later(() => {
      this.domainTimer = false;
      for (const [k, c] of [...this.domainChecks]) {
        if (!c.el.isConnected) {
          this.domainChecks.delete(k);
          continue;
        }
        void api<{ dominio: DominioView }>('POST', `/api/publish/sites/${encodeURIComponent(c.siteId)}/dominios/${encodeURIComponent(c.nome)}/verificar`)
          .then((r) => {
            if (!this.domainChecks.has(`${c.siteId}|${c.nome}`)) return;
            if (r.dominio.status === 'ok') this.ctx.notify(`Domínio ${r.dominio.nome} funcionando!`, 'info');
            c.update(r.dominio);
          })
          .catch(() => undefined);
      }
      this.scheduleDomainChecks();
    }, DOMAIN_CHECK_MS);
  }

  private domainForm(site: SiteView, box: HTMLElement): HTMLElement | null {
    const max = this.conta?.plano?.maxDominios ?? 0;
    if (site.dominios.length >= max) return null;
    const errs = h('div', { attrs: { 'aria-live': 'polite' } });
    const inp = input('', { mono: true, placeholder: 'www.minhaloja.com.br', label: 'Domínio próprio' });
    const add = btn('Adicionar domínio', () => void go(), 'ui-btn--sm');
    const wrap = h('details', { class: 'ui-pub__domadd' }, h('summary', { text: 'Usar um domínio meu' }), h('div', { class: 'ui-pub__inline' }, inp, add), errs);
    const go = async () => {
      const dom = M.normalizeDomain(inp.value);
      const p = M.domainProblem(dom);
      if (p) return errs.replaceChildren(h('p', { class: 'ui-pub__alert is-error', role: 'alert', text: p }));
      add.disabled = true;
      try {
        const r = await api<{ dominio: DominioView }>('POST', `/api/publish/sites/${encodeURIComponent(site.id)}/dominios`, { dominio: dom });
        site.dominios = [...site.dominios, r.dominio];
        box.append(this.domainBlock(site, r.dominio));
        inp.value = '';
        errs.replaceChildren();
        if (site.dominios.length >= max) wrap.remove();
      } catch (err) {
        errs.replaceChildren(h('p', { class: 'ui-pub__alert is-error', role: 'alert', text: (err as Error).message }));
      } finally {
        add.disabled = false;
      }
    };
    return wrap;
  }

  // ------------------------------------------------------------ passo 5: publicar

  private renderPublish(): void {
    const f = this.flow;
    const site = f.site!;
    const steps = h('ol', { class: 'ui-pub__progress' });
    const log = h('pre', { class: 'ui-pub__log', role: 'log', tabIndex: 0, attrs: { 'aria-label': 'Log da publicação', 'aria-live': 'off' } });
    const result = h('div', { attrs: { 'aria-live': 'assertive' } });
    const stepEl = (text: string) => {
      const li = h('li', { class: 'is-running', text });
      steps.append(li);
      return li;
    };
    this.show('publish', h('h3', { text: `Publicando "${site.nome}"` }), steps, log, result);
    const fail = (li: HTMLElement | undefined, err: unknown) => {
      li?.classList.replace('is-running', 'is-failed');
      result.replaceChildren(
        h('div', { class: 'ui-pub__alert is-error', role: 'alert' }, h('strong', { text: 'Não deu certo.' }), ' ', (err as Error).message ?? String(err)),
        h('div', { class: 'ui-pub__actions' }, btn('Tentar de novo', () => this.renderPublish(), 'ui-btn--primary'), btn('Revisar os comandos', () => this.reviewCommands())),
      );
    };
    void (async () => {
      let li: HTMLElement | undefined;
      try {
        const id = encodeURIComponent(site.id);
        if (f.siteExisted) {
          li = stepEl('Salvando a configuração');
          const r = await api<{ site: SiteView }>('PATCH', `/api/publish/sites/${id}`, { tipo: f.tipo, config: M.cleanConfig(f.tipo, f.config) });
          f.site = { ...r.site, dominios: r.site.dominios ?? site.dominios };
          li.className = 'is-done';
        }
        if (f.envChanged || (!f.siteExisted && f.env.length)) {
          li = stepEl('Guardando as variáveis');
          await api('PUT', `/api/publish/sites/${id}/env`, { vars: M.envObject(f.env) });
          f.env = f.env.map((r) => ({ key: r.key, value: '', saved: true }));
          f.envChanged = false;
          li.className = 'is-done';
        }
        li = stepEl('Empacotando e enviando o projeto');
        const r = await api<{ deploy: DeployView; pacote: PacoteInfo }>('POST', '/api/publish/deploy', { siteId: site.id, path: f.projeto!.path, requestId: f.requestId });
        f.requestId = undefined;
        li.className = 'is-done';
        li.textContent = `Projeto enviado (${r.pacote.arquivos} arquivos, ${M.formatBytes(r.pacote.tamanho)})`;
        for (const a of r.pacote.avisos) log.append(`${a}\n`);
        this.followDeploy(r.deploy.id, site, steps, log, result);
      } catch (err) {
        fail(li, err);
      }
    })();
  }

  private reviewCommands(): void {
    if (this.flow.deteccao) this.renderDetect();
    else if (this.flow.projeto) void this.loadDetect(this.flow.projeto.path);
    else void this.renderProjects();
  }

  /** Acompanha o build pelo SSE (reconexões descartam as linhas já mostradas). */
  private followDeploy(deployId: string, site: SiteView, steps: HTMLElement, log: HTMLElement, result: HTMLElement): void {
    const li = h('li', { class: 'is-running', text: 'Na fila para construir…' });
    steps.append(li);
    const st = { idx: 0, seen: 0 };
    let done = false;
    const es = new EventSource(`/api/publish/deploys/${encodeURIComponent(deployId)}/logs`);
    this.es = es;
    es.addEventListener('open', () => (st.idx = 0));
    es.addEventListener('log', (e) => {
      try {
        const lines = M.takeNewLines(st, (JSON.parse((e as MessageEvent).data) as { linhas: string[] }).linhas ?? []);
        if (!lines.length) return;
        const stick = log.scrollTop + log.clientHeight >= log.scrollHeight - 8;
        log.append(lines.join('\n') + '\n');
        if (stick) log.scrollTop = log.scrollHeight;
      } catch {
        // evento malformado
      }
    });
    es.addEventListener('status', (e) => {
      try {
        const s = (JSON.parse((e as MessageEvent).data) as { status: keyof typeof M.DEPLOY_STATUS_LABEL }).status;
        li.textContent = s === 'building' ? 'Construindo e subindo o site…' : `${M.DEPLOY_STATUS_LABEL[s] ?? s}…`;
      } catch {
        // ignora
      }
    });
    es.addEventListener('fim', (e) => {
      done = true;
      es.close();
      let fim: { status: string; url?: string; erro?: string } = { status: 'failed' };
      try {
        fim = JSON.parse((e as MessageEvent).data) as typeof fim;
      } catch {
        // ignora
      }
      if (fim.status === 'ok') {
        li.className = 'is-done';
        li.textContent = 'No ar!';
        const url = fim.url ?? site.url;
        this.ctx.notify(`"${site.nome}" está no ar: ${url}`, 'info');
        result.replaceChildren(
          h(
            'div',
            { class: 'ui-pub__done' },
            h('strong', { text: 'Seu site está no ar!' }),
            h('a', { class: 'ui-pub__url', text: url, attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } }),
            h('p', { class: 'ui-pub__muted ui-pub__small', text: 'Na primeira vez o HTTPS pode levar alguns segundos para ficar pronto.' }),
          ),
          h('div', { class: 'ui-pub__actions' }, h('a', { class: 'ui-btn ui-btn--primary', text: 'Abrir meu site', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' } }), btn('Publicar de novo', () => this.renderPublish()), btn('Meus sites', () => void this.showSites())),
        );
      } else {
        li.className = 'is-failed';
        li.textContent = fim.status === 'canceled' ? 'Cancelado (um envio mais novo entrou no lugar)' : 'O build falhou';
        result.replaceChildren(
          h('div', { class: 'ui-pub__alert is-error', role: 'alert' }, h('strong', { text: 'Não deu certo.' }), ' ', fim.erro ?? 'Veja o log acima para entender o que aconteceu.'),
          h('p', { class: 'ui-pub__muted ui-pub__small', text: 'Dica: copie o log e mostre ao seu agente — ele costuma saber o que corrigir.' }),
          h('div', { class: 'ui-pub__actions' }, btn('Copiar o log', () => void copyText(log.textContent ?? '').then(() => this.ctx.announce('Log copiado'))), btn('Revisar os comandos', () => this.reviewCommands()), btn('Tentar de novo', () => this.renderPublish(), 'ui-btn--primary')),
        );
      }
    });
    es.addEventListener('error', () => {
      // O EventSource reconecta sozinho; se o servidor recusou (erro HTTP), ele fecha: mostramos o motivo.
      if (!done && es.readyState === EventSource.CLOSED) {
        li.className = 'is-failed';
        result.replaceChildren(h('p', { class: 'ui-pub__alert is-warn', text: 'Perdemos o log ao vivo. A publicação continua: confira em "Meus sites".' }), h('div', { class: 'ui-pub__actions' }, btn('Meus sites', () => void this.showSites())));
      }
    });
  }

  /** Abre a janela só para acompanhar um deploy que já começou (pedido de agente aprovado). */
  private watchDeploy(deployId: string, siteId: string, projeto: string): void {
    if (!this.el.open) this.el.showModal();
    const site = this.conta?.sites.find((s) => s.id === siteId) ?? ({ id: siteId, nome: projeto, url: '' } as SiteView);
    const steps = h('ol', { class: 'ui-pub__progress' }, h('li', { class: 'is-done', text: 'Projeto enviado' }));
    const log = h('pre', { class: 'ui-pub__log', role: 'log', tabIndex: 0, attrs: { 'aria-label': 'Log da publicação' } });
    const result = h('div', { attrs: { 'aria-live': 'assertive' } });
    this.show('publish', h('h3', { text: `Publicando "${projeto}"` }), steps, log, result);
    this.followDeploy(deployId, site, steps, log, result);
  }

  // ------------------------------------------------------------ Meus sites

  private async showSites(): Promise<void> {
    this.loading('Carregando seus sites…');
    try {
      this.status = await api<PublishStatus>('GET', '/api/publish/status');
    } catch (err) {
      return this.show('sites', h('h3', { text: 'Meus sites' }), this.errorBox(err));
    }
    if (!this.ready()) return this.renderConnect();
    const conta = this.conta!;
    const list = h('div', { class: 'ui-pub__sites' });
    for (const s of conta.sites) list.append(this.siteCard(s));
    const plano = conta.plano ? `${conta.sites.length} de ${conta.plano.maxSites} site(s) do plano ${conta.plano.nome}.` : '';
    this.show(
      'sites',
      h('h3', { text: 'Meus sites' }),
      conta.sites.length ? list : h('div', { class: 'ui-pub__empty' }, h('p', { text: 'Você ainda não publicou nenhum site.' }), btn('Publicar um projeto', () => this.startNew(), 'ui-btn--primary')),
      plano ? h('p', { class: 'ui-pub__muted ui-pub__small', text: plano }) : null,
    );
  }

  private siteCard(s: SiteView): HTMLElement {
    const st = s.status;
    const logs = h('pre', { class: 'ui-pub__log is-app', hidden: true, tabIndex: 0, attrs: { 'aria-label': `Logs do app ${s.nome}` } });
    const doms = h('div', { class: 'ui-pub__doms' });
    this.drawDomains(doms, s);
    const confirmBox = h('div', { class: 'ui-pub__confirm', hidden: true, role: 'alert' });
    const card = h('article', { class: `ui-pub__site is-${st}`, attrs: { 'aria-label': s.nome } });
    const showLogs = async (b: HTMLButtonElement) => {
      if (!logs.hidden) {
        logs.hidden = true;
        b.textContent = 'Logs do app';
        return;
      }
      b.disabled = true;
      try {
        const r = await api<{ logs: string }>('GET', `/api/publish/sites/${encodeURIComponent(s.id)}/logs?linhas=200`);
        logs.textContent = r.logs || '(sem linhas ainda)';
        logs.hidden = false;
        b.textContent = 'Esconder logs';
        logs.scrollTop = logs.scrollHeight;
      } catch (err) {
        this.ctx.notify((err as Error).message, 'warn');
      } finally {
        b.disabled = false;
      }
    };
    const logsBtn = btn('Logs do app', () => void showLogs(logsBtn), 'ui-btn--sm');
    const unpublish = () => {
      confirmBox.hidden = false;
      const yes = btn('Sim, despublicar', () => void doDelete(yes), 'ui-btn--sm ui-pub__danger');
      confirmBox.replaceChildren(
        h('p', { text: `Tirar "${s.nome}" do ar? O site, os domínios e as variáveis são apagados. O projeto no seu escritório continua intacto.` }),
        h('div', { class: 'ui-pub__actions' }, btn('Cancelar', () => (confirmBox.hidden = true), 'ui-btn--sm'), yes),
      );
      yes.focus();
    };
    const doDelete = async (b: HTMLButtonElement) => {
      b.disabled = true;
      try {
        await api('DELETE', `/api/publish/sites/${encodeURIComponent(s.id)}`);
        this.ctx.notify(`"${s.nome}" saiu do ar.`, 'info');
        void this.showSites();
      } catch (err) {
        b.disabled = false;
        this.ctx.notify((err as Error).message, 'warn');
      }
    };
    const last = s.ultimoDeploy;
    const parts: (Node | null)[] = [
      h(
        'div',
        { class: 'ui-pub__site-head' },
        h('strong', { class: 'ui-pub__site-name', text: s.nome }),
        h('span', { class: `ui-pub__chip is-${st === 'no_ar' ? 'ok' : st === 'falhou' || st === 'suspenso' ? 'bad' : 'warn'}`, text: M.SITE_STATUS_LABEL[st] ?? st }),
      ),
      h('a', { class: 'ui-pub__url', text: s.url, attrs: { href: s.url, target: '_blank', rel: 'noopener noreferrer' } }),
      h('p', { class: 'ui-pub__muted ui-pub__small', text: `${M.TIPO_LABEL[s.tipo] ?? s.tipo}${last ? ` · último envio: ${M.DEPLOY_STATUS_LABEL[last.status] ?? last.status} ${relTime(last.terminouEm ?? last.criadoEm)}` : ' · ainda sem envio'}${last?.erro ? ` (${last.erro})` : ''}` }),
      st === 'suspenso' ? h('p', { class: 'ui-pub__alert is-warn', text: 'Suspenso: a assinatura ou o complemento de hospedagem não está ativo.' }) : null,
      doms,
      h(
        'div',
        { class: 'ui-pub__actions' },
        btn('Publicar de novo', () => void this.republish(s), 'ui-btn--sm'),
        logsBtn,
        btn('Despublicar', unpublish, 'ui-btn--sm ui-pub__danger-soft'),
      ),
      this.domainForm(s, doms),
      confirmBox,
      logs,
    ];
    card.append(...parts.filter((n): n is Node => !!n));
    return card;
  }

  /** "Publicar de novo": mesmo site, novo envio da pasta com o mesmo nome. */
  private async republish(site: SiteView): Promise<void> {
    this.loading('Preparando…');
    let projects: ProjetoLocal[] = [];
    try {
      projects = (await api<{ projects: ProjetoLocal[] }>('GET', '/api/publish/projects')).projects;
    } catch {
      // segue para a escolha manual
    }
    const p = projects.find((x) => slugSite(x.nome) === site.nome);
    this.flow = newFlow();
    this.flow.site = site;
    this.flow.siteExisted = true;
    this.flow.env = site.envKeys.map((key) => ({ key, value: '', saved: true }));
    if (!p) return this.renderProjects();
    this.flow.projeto = p;
    this.flow.tipo = site.tipo;
    this.flow.config = { ...site.config };
    this.renderPublish();
  }

  // ------------------------------------------------------------ pedidos dos agentes

  private async watchRequests(): Promise<void> {
    let since = -1;
    for (;;) {
      let r: Response;
      try {
        r = await fetch(`/api/publish/requests?wait=1&since=${since}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
      } catch {
        await new Promise((ok) => setTimeout(ok, 15_000));
        continue;
      }
      if (r.status === 403 || r.status === 404) {
        this.available = false;
        this.button.hidden = true;
        window.dispatchEvent(new Event('resize'));
        return;
      }
      if (!r.ok) {
        await new Promise((ok) => setTimeout(ok, 15_000));
        continue;
      }
      const j = (await r.json().catch(() => ({ version: since, requests: [] }))) as { version: number; requests: PublishRequest[] };
      since = j.version;
      for (const req of j.requests) {
        if (req.status === 'pending' && !this.asked.has(req.id)) {
          this.asked.add(req.id);
          this.askQueue.push(req);
        }
      }
      this.nextAsk();
    }
  }

  private nextAsk(): void {
    if (this.askEl.open) return;
    const req = this.askQueue.shift();
    if (!req) return;
    const who = req.origem && req.origem !== 'agente' ? req.origem : 'Um agente';
    const site = req.siteId ? this.conta?.sites.find((s) => s.id === req.siteId) : undefined;
    const err = h('div', { attrs: { 'aria-live': 'polite' } });
    const approve = async (b: HTMLButtonElement) => {
      b.disabled = true;
      try {
        const r = await api<{ request: PublishRequest }>('POST', `/api/publish/requests/${encodeURIComponent(req.id)}/approve`, {});
        this.currentAsk = undefined;
        this.askEl.close();
        this.ctx.notify(`Publicando "${req.projeto}"…`, 'info');
        if (r.request.deployId && r.request.siteId) {
          if (!this.status) this.status = await api<PublishStatus>('GET', '/api/publish/status').catch(() => undefined);
          this.watchDeploy(r.request.deployId, r.request.siteId, req.projeto);
        }
      } catch (e) {
        b.disabled = false;
        err.replaceChildren(h('p', { class: 'ui-pub__alert is-error', role: 'alert', text: (e as Error).message }));
      }
    };
    const reject = () => {
      this.rejectAsk();
      this.askEl.close();
    };
    const primary = req.siteId
      ? btn('Publicar', () => void approve(primary), 'ui-btn--primary')
      : btn('Abrir o assistente', () => {
          this.currentAsk = undefined;
          this.askEl.close();
          this.open({ path: req.path, requestId: req.id });
        }, 'ui-btn--primary');
    this.askEl.replaceChildren(
      h('div', { class: 'ui-dialog__head ui-pub__head' }, h('h2', { text: 'Publicar?', attrs: { id: 'ui-pub-ask-title' } })),
      h(
        'div',
        { class: 'ui-pub__body' },
        h(
          'p',
          { attrs: { id: 'ui-pub-ask-text' } },
          `${who} quer publicar o projeto `,
          h('strong', { text: req.projeto }),
          req.siteId ? ` de novo${site ? ` em ${site.subdominio}` : ''}. ` : ' na internet. ',
          req.siteId ? 'O código atual da pasta vai para o ar.' : 'Ele ainda não tem site: o assistente vai ajudar a criar.',
        ),
        h('p', { class: 'ui-pub__muted ui-pub__small', text: req.path }),
        err,
        h('div', { class: 'ui-pub__actions ui-pub__nav' }, btn('Agora não', reject), primary),
      ),
    );
    this.currentAsk = req;
    this.askEl.showModal();
    primary.focus();
  }

  private rejectAsk(): void {
    const req = this.currentAsk;
    this.currentAsk = undefined;
    if (req) void api('POST', `/api/publish/requests/${encodeURIComponent(req.id)}/reject`).catch(() => undefined);
  }
}
