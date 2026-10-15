// Painel "GitHub" do escritório (botão da barra superior, ou o "⋯"; a missão "Leve para o GitHub" também abre).
// Tudo pelo gh no shell do usuário (server/github): "Conectar GitHub" abre o terminal embutido rodando
// `gh auth login --web` (o link e o código aparecem lá, com o link clicável inteiro); logado, mostra o @usuário e os
// atalhos: clonar um repositório em ~/projetos (e abrir um agente Claude ou Codex nele), criar um repositório privado a
// partir de uma pasta de ~/projetos (com confirmação explícita) e os PRs abertos. O token nunca passa por aqui.
import type { UiContext } from './context';
import { h, iconButton } from './dom';
import { ENGINE_LABEL, type Engine } from './engine';
import { ICONS } from './icons';

export interface GithubStatusView {
  available?: boolean;
  reason?: string;
  installed?: boolean;
  loggedIn?: boolean;
  login?: string;
  name?: string;
  error?: string;
}

interface Repo {
  name: string;
  nameWithOwner: string;
  updatedAt?: string;
  isPrivate?: boolean;
  url?: string;
  description?: string;
}
interface Pr {
  number: number;
  title: string;
  url: string;
  repo: string;
}
interface Folder {
  name: string;
  git: boolean;
  remote?: string;
}

/** Texto do cabeçalho do painel conforme o estado. Puro (testado). */
export function githubHeadline(s: GithubStatusView | null): string {
  if (!s) return 'Conferindo o GitHub…';
  if (s.available === false) return `GitHub indisponível${s.reason ? `: ${s.reason}` : ''}`;
  if (!s.installed) return s.error ?? 'O GitHub CLI (gh) não está instalado neste escritório.';
  if (!s.loggedIn) return 'GitHub não conectado';
  return `Conectado como @${s.login ?? '?'}${s.name ? ` (${s.name})` : ''}`;
}

/** Confirmação antes de criar/publicar um repositório. Puro (testado). */
export function createConfirmText(login: string | undefined, folder: string, visibility: 'private' | 'public'): string {
  const vis = visibility === 'public' ? 'PÚBLICO (qualquer pessoa vê o código)' : 'privado';
  return `Criar o repositório ${vis} ${login ? `${login}/` : ''}${folder} no GitHub e enviar (push) o conteúdo de ~/projetos/${folder}?`;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { cache: 'no-store' });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

export class GithubPanel {
  readonly el: HTMLDialogElement;
  private body: HTMLElement;
  private status: GithubStatusView | null = null;
  private repos: Repo[] | null = null;
  private folders: Folder[] | null = null;
  private prs: Pr[] | null = null;
  private busy = false;
  private msg: { text: string; level: 'info' | 'warn' } | null = null;
  /** Último clone feito: oferece abrir um agente nele. */
  private cloned: { name: string } | null = null;

  constructor(private readonly ctx: UiContext) {
    this.body = h('div', { class: 'ui-gh__body' });
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-gh', attrs: { 'aria-labelledby': 'ui-gh-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { attrs: { id: 'ui-gh-title' }, text: '🐙 GitHub' }), iconButton(ICONS.close, 'Fechar', () => this.el.close(), 'ui-icon-btn--sm')),
      this.body,
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
  }

  open(): void {
    if (!this.el.open) this.el.showModal();
    this.msg = null;
    this.cloned = null;
    this.draw();
    void this.load(true);
  }

  private async load(fresh: boolean): Promise<void> {
    try {
      this.status = await getJson<GithubStatusView>(`/api/github/status${fresh ? '?fresh=1' : ''}`);
    } catch (err) {
      this.status = { available: false, reason: (err as Error).message };
    }
    this.draw();
  }

  private async run(fn: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.msg = null;
    this.draw();
    try {
      await fn();
    } catch (err) {
      this.msg = { text: (err as Error).message, level: 'warn' };
    } finally {
      this.busy = false;
      this.draw();
    }
  }

  private connect(): void {
    this.ctx.openShell({ program: 'gh' });
    this.msg = { text: 'No terminal: abra o link (ou copie), digite o código mostrado e autorize. Depois clique em "Já conectei".', level: 'info' };
    this.el.close();
  }

  private loadRepos(): void {
    void this.run(async () => {
      this.repos = (await getJson<{ repos: Repo[] }>('/api/github/repos')).repos;
    });
  }

  private loadFolders(): void {
    void this.run(async () => {
      this.folders = (await getJson<{ folders: Folder[] }>('/api/github/folders')).folders;
    });
  }

  private loadPrs(): void {
    void this.run(async () => {
      this.prs = (await getJson<{ prs: Pr[] }>('/api/github/prs')).prs;
    });
  }

  private clone(repo: string): void {
    void this.run(async () => {
      const r = await postJson<{ name: string }>('/api/github/clone', { repo });
      this.cloned = { name: r.name };
      this.msg = { text: `Clonado em ~/projetos/${r.name}.`, level: 'info' };
    });
  }

  private create(folder: string, visibility: 'private' | 'public'): void {
    if (!confirm(createConfirmText(this.status?.login, folder, visibility))) return;
    void this.run(async () => {
      const r = await postJson<{ url?: string; repo: string }>('/api/github/create', { folder, visibility, confirm: true });
      this.msg = { text: `Repositório criado e enviado: ${r.url ?? r.repo}`, level: 'info' };
      this.folders = null;
    });
  }

  private openAgent(name: string, engine: Engine): void {
    void this.run(async () => {
      await postJson('/api/agents/new', { cwd: `projetos/${name}`, engine });
      this.ctx.notify(`Agente ${ENGINE_LABEL[engine]} abrindo em ~/projetos/${name}: aparece no escritório em alguns segundos.`);
      this.el.close();
    });
  }

  private draw(): void {
    const s = this.status;
    const parts: (HTMLElement | null)[] = [h('p', { class: 'ui-gh__status', text: githubHeadline(s) })];
    if (this.msg) parts.push(h('p', { class: `ui-gh__msg ui-gh__msg--${this.msg.level}`, role: this.msg.level === 'warn' ? 'alert' : 'status', text: this.msg.text }));
    if (s && s.available !== false && s.installed && !s.loggedIn) {
      parts.push(
        h('p', { class: 'ui-gh__hint', text: 'Conecte a sua conta do GitHub pelo terminal do escritório (código de dispositivo). O Habblaud nunca vê nem guarda o seu token: ele fica com o gh.' }),
        h(
          'div',
          { class: 'ui-gh__row' },
          h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Conectar GitHub', on: { click: () => this.connect() } }),
          h('button', { class: 'ui-btn', type: 'button', text: '↻ Já conectei', on: { click: () => void this.load(true) } }),
        ),
      );
    }
    if (s?.loggedIn) {
      parts.push(this.cloneSection(), this.createSection(), this.prSection());
    }
    this.body.replaceChildren(...parts.filter((p): p is HTMLElement => !!p));
  }

  private cloneSection(): HTMLElement {
    const sel = h('select', { class: 'ui-cust__select ui-gh__select', attrs: { 'aria-label': 'Repositório' } });
    for (const r of this.repos ?? []) sel.append(h('option', { attrs: { value: r.nameWithOwner }, text: `${r.nameWithOwner}${r.isPrivate ? ' 🔒' : ''}${r.updatedAt ? ` · ${r.updatedAt.slice(0, 10)}` : ''}` }));
    const sec = h(
      'section',
      { class: 'ui-gh__sec' },
      h('h3', { text: 'Clonar repositório' }),
      this.repos === null
        ? h('button', { class: 'ui-btn', type: 'button', text: 'Listar meus repositórios', on: { click: () => this.loadRepos() } })
        : this.repos.length
          ? h('div', { class: 'ui-gh__row' }, sel, h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Clonar em ~/projetos', on: { click: () => this.clone(sel.value) } }))
          : h('p', { class: 'ui-gh__hint', text: 'Nenhum repositório na sua conta ainda.' }),
    );
    if (this.cloned) {
      const name = this.cloned.name;
      sec.append(
        h(
          'div',
          { class: 'ui-gh__row' },
          h('span', { text: `Abrir um agente em ~/projetos/${name}:` }),
          h('button', { class: 'ui-btn', type: 'button', text: 'Claude', on: { click: () => this.openAgent(name, 'claude') } }),
          h('button', { class: 'ui-btn ui-btn--codex', type: 'button', text: 'Codex', on: { click: () => this.openAgent(name, 'codex') } }),
        ),
      );
    }
    return sec;
  }

  private createSection(): HTMLElement {
    const free = (this.folders ?? []).filter((f) => !f.remote);
    const sel = h('select', { class: 'ui-cust__select ui-gh__select', attrs: { 'aria-label': 'Pasta de ~/projetos' } });
    for (const f of free) sel.append(h('option', { attrs: { value: f.name }, text: `~/projetos/${f.name}${f.git ? '' : ' (sem git ainda)'}` }));
    const pub = h('input', { type: 'checkbox', attrs: { id: 'ui-gh-public' } });
    return h(
      'section',
      { class: 'ui-gh__sec' },
      h('h3', { text: 'Novo repositório a partir de uma pasta' }),
      this.folders === null
        ? h('button', { class: 'ui-btn', type: 'button', text: 'Escolher uma pasta de ~/projetos', on: { click: () => this.loadFolders() } })
        : free.length
          ? h(
              'div',
              { class: 'ui-gh__col' },
              h('div', { class: 'ui-gh__row' }, sel),
              h('label', { class: 'ui-gh__check' }, pub, h('span', { text: ' Público (sem marcar = privado)' })),
              h('div', { class: 'ui-gh__row' }, h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Criar repositório e enviar…', on: { click: () => this.create(sel.value, pub.checked ? 'public' : 'private') } })),
            )
          : h('p', { class: 'ui-gh__hint', text: 'Todas as pastas de ~/projetos já têm repositório (ou não há pastas).' }),
    );
  }

  private prSection(): HTMLElement {
    return h(
      'section',
      { class: 'ui-gh__sec' },
      h('h3', { text: 'Meus PRs abertos' }),
      this.prs === null
        ? h('div', { class: 'ui-gh__row' }, h('button', { class: 'ui-btn', type: 'button', text: 'Ver meus PRs', on: { click: () => this.loadPrs() } }), h('a', { class: 'ui-link-btn', text: 'Abrir no GitHub ↗', attrs: { href: 'https://github.com/pulls', target: '_blank', rel: 'noopener noreferrer' } }))
        : this.prs.length
          ? h('ul', { class: 'ui-gh__prs' }, ...this.prs.map((p) => h('li', {}, h('a', { text: `${p.repo}#${p.number} — ${p.title}`, attrs: { href: p.url, target: '_blank', rel: 'noopener noreferrer' } }))))
          : h('p', { class: 'ui-gh__hint', text: 'Nenhum PR aberto seu. ' }, h('a', { text: 'Abrir no GitHub ↗', attrs: { href: 'https://github.com/pulls', target: '_blank', rel: 'noopener noreferrer' } })),
    );
  }
}
