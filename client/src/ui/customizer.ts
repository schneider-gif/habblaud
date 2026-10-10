// Editor de agente: nome + boneco (cabelo, roupa, acessórios, barba e cores) com prévia ao vivo. Serve para abrir um
// agente novo (POST /api/agents/new, com pasta) e para personalizar um que já está no escritório
// (POST /api/agents/:id/profile). As opções vêm de shared/profile.ts, a mesma lista que o servidor valida.
import type { AgentInfo } from '../../../shared/types';
import {
  ACCESSORIES,
  BOTTOM_STYLES,
  FACIAL_HAIR,
  HAIR_STYLES,
  NAME_MAX,
  TOP_STYLES,
  type AppearanceOverride,
} from '../../../shared/profile';
import { appearanceFromSeed, characterSprite, poseFrameCount, poseFrameDuration, type Appearance } from '../art';
import type { UiContext } from './context';
import { h, iconButton } from './dom';
import { ICONS } from './icons';

const L = {
  hairStyle: {
    short: 'Curto', buzz: 'Raspado', spiky: 'Espetado', side_part: 'Repartido', curly: 'Cacheado', afro: 'Black power', bob: 'Chanel',
    long: 'Comprido', ponytail: 'Rabo de cavalo', bun: 'Coque', pigtails: 'Maria-chiquinha', mohawk: 'Moicano', bald: 'Careca', wavy: 'Ondulado',
  },
  topStyle: { tshirt: 'Camiseta', hoodie: 'Moletom', shirt_tie: 'Camisa e gravata', sweater: 'Suéter', jacket: 'Jaqueta', blouse: 'Blusa', polo: 'Polo' },
  bottomStyle: { pants: 'Calça', shorts: 'Bermuda', skirt: 'Saia' },
  accessory: { none: 'Nenhum', glasses: 'Óculos', sunglasses: 'Óculos escuros', headphones: 'Fone', cap: 'Boné', beanie: 'Gorro', earrings: 'Brincos', bow: 'Laço' },
  facialHair: { none: 'Sem barba', stubble: 'Barba por fazer', beard: 'Barba', mustache: 'Bigode', goatee: 'Cavanhaque' },
} as const;

const SKIN = ['#ffe2cc', '#f6cfb0', '#eab894', '#d69f78', '#bd8560', '#9a6444', '#7a4a31', '#5a3623'];
const HAIR = ['#2b2530', '#3f2c22', '#5f3c28', '#87593a', '#b0703c', '#d6ae68', '#ebdcb0', '#8f929b', '#d9dbe0', '#ff5cad', '#c8ff32', '#ff814a', '#5b8fe0', '#8f6ad8', '#3fb3a0'];
const CLOTHES = ['#c8ff32', '#ff5cad', '#ff814a', '#6fd3ff', '#8f6ad8', '#e2604f', '#4a86d8', '#4bab72', '#efb54a', '#36b0b0', '#211735', '#3d4352', '#2b2b33', '#f1efe9', '#b49c72', '#6e4c38'];
const EYES = ['#2b2236', '#4a2f22', '#5a3b22', '#2f5f9e', '#3c7a52', '#8f6ad8'];

type Mode = { kind: 'new' } | { kind: 'edit'; agent: AgentInfo };
type EnumKey = 'hairStyle' | 'topStyle' | 'bottomStyle' | 'accessory' | 'facialHair';
type ColorKey = 'skin' | 'hair' | 'eyes' | 'top' | 'topAccent' | 'bottom' | 'shoes' | 'accessoryColor';

export class AgentCustomizer {
  readonly el: HTMLDialogElement;
  private mode: Mode = { kind: 'new' };
  private ap!: Appearance;
  private seed = 1;
  private titleEl: HTMLElement;
  private nameInput: HTMLInputElement;
  private folderRow: HTMLElement;
  private folderInput: HTMLInputElement;
  private folderList: HTMLDataListElement;
  private canvas: HTMLCanvasElement;
  private saveBtn: HTMLButtonElement;
  private errEl: HTMLElement;
  private selects = new Map<EnumKey, HTMLSelectElement>();
  private swatches = new Map<ColorKey, HTMLElement>();
  private lookBtns = new Map<'f' | 'm', HTMLButtonElement>();
  private facialRow!: HTMLElement;
  private timer: ReturnType<typeof setInterval> | null = null;
  private frame = 0;
  private busy = false;

  constructor(private ctx: UiContext) {
    this.titleEl = h('h2', { attrs: { id: 'ui-cust-title' } });
    const close = iconButton(ICONS.close, 'Fechar', () => this.el.close(), 'ui-icon-btn--sm');
    this.canvas = h('canvas', { class: 'ui-cust__preview', attrs: { width: '120', height: '168', 'aria-hidden': 'true' } });
    const shuffle = h('button', { class: 'ui-btn', type: 'button', text: '🎲 Sortear', on: { click: () => this.randomize() } });

    this.nameInput = h('input', { class: 'ui-cust__input', type: 'text', attrs: { maxlength: String(NAME_MAX), placeholder: 'Ex.: Bia', autocomplete: 'off', id: 'ui-cust-name' } });
    this.folderInput = h('input', { class: 'ui-cust__input', type: 'text', attrs: { placeholder: 'vazio = pasta inicial', list: 'ui-cust-folders', autocomplete: 'off', id: 'ui-cust-folder' } });
    this.folderList = h('datalist', { attrs: { id: 'ui-cust-folders' } });
    this.folderRow = h('label', { class: 'ui-cust__field' }, h('span', { text: 'Pasta do projeto' }), this.folderInput, this.folderList);

    const look = h('div', { class: 'ui-cust__seg', role: 'group', attrs: { 'aria-label': 'Estilo' } });
    for (const [k, label] of [['f', 'Feminino'], ['m', 'Masculino']] as const) {
      const b = h('button', { class: 'ui-btn', type: 'button', text: label, on: { click: () => this.set({ look: k, ...(k === 'f' ? { facialHair: 'none' } : {}) }) } });
      this.lookBtns.set(k, b);
      look.append(b);
    }

    const sel = (key: EnumKey, label: string, values: readonly string[]) => {
      const s = h('select', { class: 'ui-cust__select', on: { change: () => this.set({ [key]: s.value } as Partial<Appearance>) } });
      for (const v of values) s.append(h('option', { attrs: { value: v }, text: (L[key] as Record<string, string>)[v] ?? v }));
      this.selects.set(key, s);
      return h('label', { class: 'ui-cust__field' }, h('span', { text: label }), s);
    };
    const colors = (key: ColorKey, label: string, palette: readonly string[]) => {
      const row = h('div', { class: 'ui-cust__swatches', role: 'group', attrs: { 'aria-label': label } });
      for (const c of palette) {
        row.append(h('button', { class: 'ui-cust__swatch', type: 'button', title: c, attrs: { 'aria-label': `${label} ${c}`, 'data-color': c, style: `background:${c}` }, on: { click: () => this.set({ [key]: c } as Partial<Appearance>) } }));
      }
      this.swatches.set(key, row);
      return h('div', { class: 'ui-cust__field' }, h('span', { text: label }), row);
    };
    this.facialRow = sel('facialHair', 'Barba', FACIAL_HAIR);

    this.errEl = h('p', { class: 'ui-cust__err', role: 'alert', hidden: true });
    this.saveBtn = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', on: { click: () => void this.save() } });
    const cancel = h('button', { class: 'ui-btn', type: 'button', text: 'Cancelar', on: { click: () => this.el.close() } });

    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-cust', attrs: { 'aria-labelledby': 'ui-cust-title' } },
      h('div', { class: 'ui-dialog__head' }, this.titleEl, close),
      h(
        'div',
        { class: 'ui-cust__body' },
        h('div', { class: 'ui-cust__stage' }, this.canvas, shuffle),
        h(
          'div',
          { class: 'ui-cust__form' },
          h('label', { class: 'ui-cust__field' }, h('span', { text: 'Nome' }), this.nameInput),
          this.folderRow,
          h('div', { class: 'ui-cust__field' }, h('span', { text: 'Estilo' }), look),
          colors('skin', 'Pele', SKIN),
          sel('hairStyle', 'Cabelo', HAIR_STYLES),
          colors('hair', 'Cor do cabelo', HAIR),
          colors('eyes', 'Olhos', EYES),
          this.facialRow,
          sel('topStyle', 'Parte de cima', TOP_STYLES),
          colors('top', 'Cor de cima', CLOTHES),
          colors('topAccent', 'Detalhe', CLOTHES),
          sel('bottomStyle', 'Parte de baixo', BOTTOM_STYLES),
          colors('bottom', 'Cor de baixo', CLOTHES),
          colors('shoes', 'Sapatos', CLOTHES),
          sel('accessory', 'Acessório', ACCESSORIES),
          colors('accessoryColor', 'Cor do acessório', CLOTHES),
        ),
      ),
      h('div', { class: 'ui-cust__foot' }, this.errEl, cancel, this.saveBtn),
    );
    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.el.close();
    });
    this.el.addEventListener('close', () => this.stop());
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.save();
    });
  }

  /** Abre para um agente novo (sem argumento) ou para personalizar `agent`. */
  open(agent?: AgentInfo): void {
    this.errEl.hidden = true;
    if (agent) {
      this.mode = { kind: 'edit', agent };
      this.seed = agent.seed;
      this.ap = { ...appearanceFromSeed(agent.seed, { look: agent.appearance?.look ?? agent.look }), ...(agent.appearance ?? {}) } as Appearance;
      this.nameInput.value = agent.name;
      this.titleEl.textContent = `Personalizar ${agent.name}`;
      this.saveBtn.textContent = 'Salvar';
      this.folderRow.hidden = true;
    } else {
      this.mode = { kind: 'new' };
      this.randomize(false);
      this.nameInput.value = '';
      this.folderInput.value = '';
      this.titleEl.textContent = 'Novo agente';
      this.saveBtn.textContent = 'Abrir agente';
      this.folderRow.hidden = false;
      void this.loadFolders();
    }
    this.sync();
    if (!this.el.open) this.el.showModal();
    this.nameInput.focus();
    this.start();
  }

  private async loadFolders(): Promise<void> {
    try {
      const j = (await (await fetch('/api/agents/new', { cache: 'no-store' })).json()) as { folders?: string[] };
      this.folderList.replaceChildren(...(j.folders ?? []).map((f) => h('option', { attrs: { value: f } })));
    } catch {
      // sem sugestões: o campo continua livre
    }
  }

  private randomize(sync = true): void {
    this.seed = (Math.random() * 2 ** 32) >>> 0;
    this.ap = appearanceFromSeed(this.seed);
    if (sync) this.sync();
  }

  private set(p: Partial<Appearance>): void {
    this.ap = { ...this.ap, ...p };
    if (this.ap.look === 'f') this.ap.facialHair = 'none';
    this.sync();
  }

  /** Reflete o estado no formulário e redesenha a prévia. */
  private sync(): void {
    for (const [k, s] of this.selects) s.value = String(this.ap[k] ?? 'none');
    for (const [k, row] of this.swatches) {
      const cur = String(this.ap[k] ?? '').toLowerCase();
      for (const b of row.children) (b as HTMLElement).classList.toggle('is-on', (b as HTMLElement).dataset.color === cur);
    }
    for (const [k, b] of this.lookBtns) b.setAttribute('aria-pressed', String(this.ap.look === k));
    this.facialRow.hidden = this.ap.look === 'f';
    this.draw();
  }

  private draw(): void {
    const c = this.canvas.getContext('2d');
    if (!c) return;
    c.imageSmoothingEnabled = false;
    c.clearRect(0, 0, this.canvas.width, this.canvas.height);
    try {
      const sp = characterSprite({ appearance: this.ap, dir: 'down', pose: 'stand', frame: this.frame % Math.max(1, poseFrameCount('stand')) });
      const scale = Math.floor(Math.min(this.canvas.width / sp.canvas.width, this.canvas.height / sp.canvas.height));
      const w = sp.canvas.width * scale, hh = sp.canvas.height * scale;
      c.drawImage(sp.canvas, Math.round((this.canvas.width - w) / 2), this.canvas.height - hh, w, hh);
    } catch {
      // arte indisponível: prévia vazia
    }
  }

  private start(): void {
    this.stop();
    this.timer = setInterval(() => {
      this.frame++;
      this.draw();
    }, Math.max(250, poseFrameDuration('stand')));
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** O que vai para o servidor: só os campos que o editor controla. */
  private override(): AppearanceOverride {
    const a = this.ap;
    const out: AppearanceOverride = {
      look: a.look, hairStyle: a.hairStyle, topStyle: a.topStyle, bottomStyle: a.bottomStyle ?? 'pants', accessory: a.accessory,
      skin: a.skin, hair: a.hair, eyes: a.eyes, top: a.top, topAccent: a.topAccent, bottom: a.bottom, shoes: a.shoes, accessoryColor: a.accessoryColor,
    };
    if (a.look === 'm') out.facialHair = a.facialHair ?? 'none';
    return out;
  }

  private async save(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.saveBtn.disabled = true;
    this.errEl.hidden = true;
    const name = this.nameInput.value.trim();
    const body: Record<string, unknown> = { appearance: this.override() };
    if (name) body.name = name;
    const isNew = this.mode.kind === 'new';
    if (isNew) body.cwd = this.folderInput.value.trim();
    const url = this.mode.kind === 'edit' ? `/api/agents/${encodeURIComponent(this.mode.agent.id)}/profile` : '/api/agents/new';
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      if (!r.ok) {
        this.errEl.textContent = j.error ?? 'Não foi possível salvar.';
        this.errEl.hidden = false;
        return;
      }
      this.el.close();
      this.ctx.notify(isNew ? `${name || 'O novo agente'} está chegando: aparece no escritório em alguns segundos.` : 'Agente atualizado.');
    } catch {
      this.errEl.textContent = 'Não foi possível falar com o escritório.';
      this.errEl.hidden = false;
    } finally {
      this.busy = false;
      this.saveBtn.disabled = false;
    }
  }
}
