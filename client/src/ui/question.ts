// Responder pelo escritório as perguntas com opções do Claude (ferramenta AskUserQuestion): cartão com as perguntas,
// as opções (escolha única ou várias), o campo "Outro" e Enviar. A resposta vai por POST /api/agents/:id/answer, que
// dirige o diálogo no terminal do agente pelo tmux (server/questions). O cartão aparece no terminal (chat) e na
// gaveta do agente; some quando a pergunta é respondida, por aqui ou no próprio terminal.
import type { AgentInfo, AskAnswer, AskQuestion, AskQuestionInfo } from '../../../shared/types';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { linkifyInto } from './linkify';

/** Mesmo limite do servidor (server/questions/ask.ts OTHER_MAX). */
export const OTHER_MAX = 1_000;
/** Aviso da caixa de mensagem enquanto há pergunta aberta (o texto digitado fica guardado na caixa). */
export const QUESTION_WAIT_TEXT = 'O agente está esperando você responder a pergunta acima';

/** Rascunho da resposta de uma pergunta (o que está marcado no cartão). */
export interface QuestionDraft {
  selected: number[];
  otherOn: boolean;
  other: string;
}

export function emptyDrafts(questions: readonly AskQuestion[]): QuestionDraft[] {
  return questions.map(() => ({ selected: [], otherOn: false, other: '' }));
}

/** Marca/desmarca a opção `i` (escolha única: troca; o "Outro" é a posição options.length). */
export function toggleOption(q: AskQuestion, d: QuestionDraft, i: number): QuestionDraft {
  const isOther = i === q.options.length;
  if (!q.multiSelect) return isOther ? { ...d, selected: [], otherOn: true } : { ...d, selected: [i], otherOn: false };
  if (isOther) return { ...d, otherOn: !d.otherOn };
  const has = d.selected.includes(i);
  return { ...d, selected: has ? d.selected.filter((n) => n !== i) : [...d.selected, i].sort((a, b) => a - b) };
}

/** O que falta para enviar (undefined = pronto). */
export function missingAnswer(questions: readonly AskQuestion[], drafts: readonly QuestionDraft[]): string | undefined {
  for (let i = 0; i < questions.length; i++) {
    const d = drafts[i];
    const label = questions.length > 1 ? `Pergunta ${i + 1}: ` : '';
    if (d.otherOn && !d.other.trim()) return `${label}escreva o texto de “Outro”.`;
    if (!d.selected.length && !d.otherOn) return `${label}${questions[i].multiSelect ? 'marque ao menos uma opção.' : 'escolha uma opção.'}`;
  }
  return undefined;
}

/** Rascunhos -> corpo de POST /answer. */
export function draftsToAnswers(drafts: readonly QuestionDraft[]): AskAnswer[] {
  return drafts.map((d) => {
    const other = d.otherOn ? d.other.replace(/\s+/g, ' ').trim().slice(0, OTHER_MAX) : '';
    return other ? { selected: d.selected, other } : { selected: d.selected };
  });
}

type Phase = 'idle' | 'sending' | 'sent';

/** Cartão da pergunta pendente de um agente. `variant` muda só o estilo (no terminal ou na gaveta). */
export class QuestionCard {
  readonly el: HTMLElement;
  private key = '';
  private agentId = '';
  private q: AskQuestionInfo | null = null;
  private drafts: QuestionDraft[] = [];
  private phase: Phase = 'idle';
  private body: HTMLElement;
  private sendBtn: HTMLButtonElement;
  private status: HTMLElement;
  private remote: HTMLElement;
  private inputs: { boxes: HTMLInputElement[]; other: HTMLInputElement }[] = [];

  constructor(
    private ctx: UiContext,
    variant: 'term' | 'drawer',
  ) {
    this.body = h('div', { class: 'ui-ask__body' });
    this.sendBtn = h('button', { class: 'ui-btn ui-perm__btn ui-perm__btn--allow', type: 'submit' }, 'Enviar resposta');
    this.status = h('p', { class: 'ui-perm__status', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.remote = h('p', { class: 'ui-perm__note', hidden: true, text: 'Responder por aqui só funciona com o Habblaude acessível pelo próprio computador. Por enquanto, responda no terminal.' });
    const form = h(
      'form',
      { class: 'ui-ask__form' },
      this.body,
      this.remote,
      h('div', { class: 'ui-perm__actions' }, this.sendBtn, h('span', { class: 'ui-ask__hint', text: 'ou responda no terminal do agente' })),
      this.status,
    );
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.send();
    });
    this.el = h(
      'section',
      { class: `ui-perm ui-ask ui-ask--${variant}`, hidden: true, tabIndex: -1, attrs: { 'aria-label': 'Pergunta do agente' } },
      h('div', { class: 'ui-perm__head ui-ask__head' }, h('span', { class: 'ui-perm__icon', text: '?', attrs: { 'aria-hidden': 'true' } }), h('strong', { class: 'ui-perm__title', text: 'O agente pergunta' })),
      form,
    );
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  render(agent: AgentInfo | undefined): void {
    const q = agent && agent.status !== 'offline' && agent.status !== 'done' ? agent.question : undefined;
    if (!agent || !q) {
      setHidden(this.el, true);
      this.key = '';
      this.q = null;
      return;
    }
    const key = `${agent.id}|${q.toolUseId}`;
    if (key !== this.key) {
      this.key = key;
      this.agentId = agent.id;
      this.q = q;
      this.drafts = emptyDrafts(q.questions);
      this.phase = 'idle';
      this.status.classList.remove('is-error');
      setText(this.status, '');
      this.build();
    }
    setHidden(this.el, false);
    // O servidor confere o Host (rota /answer); aqui só o recurso ligado neste escritório.
    const local = this.ctx.store.mock || !!this.ctx.store.snapshot?.meta.terminal;
    setHidden(this.remote, local);
    const busy = this.phase !== 'idle' || !local;
    this.sendBtn.disabled = busy;
    for (const row of this.inputs) {
      for (const b of row.boxes) b.disabled = busy;
      row.other.disabled = busy;
    }
  }

  /** Monta as perguntas (só quando a pergunta muda; depois, render só liga/desliga). */
  private build(): void {
    const q = this.q!;
    this.inputs = [];
    const name = `ask-${Math.random().toString(36).slice(2, 8)}`;
    const tabs = q.fromScreen?.tabs ?? 1;
    this.body.replaceChildren(
      ...(tabs > 1 ? [h('p', { class: 'ui-ask__kind', text: `O diálogo tem ${tabs} perguntas: as próximas aparecem aqui depois que você enviar esta.` })] : []),
      ...q.questions.map((question, qi) => {
        const boxes: HTMLInputElement[] = [];
        const type = question.multiSelect ? 'checkbox' : 'radio';
        const opts = question.options.map((o, oi) => {
          const box = h('input', { type, class: 'ui-perm__check', attrs: { name: `${name}-${qi}` } });
          box.addEventListener('change', () => this.toggle(qi, oi));
          boxes.push(box);
          return h(
            'label',
            { class: 'ui-ask__opt' },
            box,
            h('span', { class: 'ui-ask__opt-text' }, h('span', { class: 'ui-ask__label', text: o.label }), o.description ? h('span', { class: 'ui-ask__desc', text: o.description }) : ''),
          );
        });
        const otherBox = h('input', { type, class: 'ui-perm__check', attrs: { name: `${name}-${qi}`, 'aria-label': 'Outro' } });
        otherBox.addEventListener('change', () => this.toggle(qi, question.options.length));
        boxes.push(otherBox);
        const other = h('input', { type: 'text', class: 'ui-ask__other', attrs: { maxlength: String(OTHER_MAX), placeholder: 'Outro: escreva sua resposta', 'aria-label': `Outro (pergunta ${qi + 1})` } });
        other.addEventListener('input', () => {
          const d = this.drafts[qi];
          this.drafts[qi] = { ...d, other: other.value, otherOn: other.value.trim() ? true : d.otherOn && !!other.value };
          if (this.drafts[qi].otherOn && !question.multiSelect) this.drafts[qi].selected = [];
          this.syncBoxes(qi);
        });
        this.inputs.push({ boxes, other });
        return h(
          'fieldset',
          { class: 'ui-ask__q' },
          h('legend', { class: 'ui-ask__question' }, question.header ? h('span', { class: 'ui-ask__tag', text: question.header }) : '', h('span', { text: question.question })),
          question.multiSelect ? h('p', { class: 'ui-ask__kind', text: 'pode marcar mais de uma' }) : '',
          ...opts,
          h('label', { class: 'ui-ask__opt ui-ask__opt--other' }, otherBox, other),
        );
      }),
    );
  }

  private toggle(qi: number, oi: number): void {
    const question = this.q!.questions[qi];
    this.drafts[qi] = toggleOption(question, this.drafts[qi], oi);
    this.syncBoxes(qi);
    if (oi === question.options.length && this.drafts[qi].otherOn) requestAnimationFrame(() => this.inputs[qi].other.focus());
  }

  private syncBoxes(qi: number): void {
    const d = this.drafts[qi];
    const { boxes } = this.inputs[qi];
    boxes.forEach((b, i) => (b.checked = i === boxes.length - 1 ? d.otherOn : d.selected.includes(i)));
  }

  private async send(): Promise<void> {
    const q = this.q;
    const agentId = this.agentId;
    if (!q || this.phase !== 'idle') return;
    const missing = missingAnswer(q.questions, this.drafts);
    if (missing) {
      this.status.classList.add('is-error');
      setText(this.status, missing);
      return;
    }
    const key = this.key;
    this.phase = 'sending';
    this.status.classList.remove('is-error');
    setText(this.status, 'Enviando a resposta ao terminal do agente…');
    this.ctx.invalidate();
    let error: string | undefined;
    try {
      error = await this.ctx.store.answerQuestion(agentId, { toolUseId: q.toolUseId, answers: draftsToAnswers(this.drafts) });
    } catch {
      error = 'Não foi possível falar com o Habblaude. Responda no terminal.';
    }
    if (this.key !== key) return;
    if (error) {
      this.phase = 'idle';
      this.status.classList.add('is-error');
      setText(this.status, error);
    } else {
      this.phase = 'sent';
      setText(this.status, 'Resposta enviada.');
      this.ctx.announce(`Resposta enviada: ${this.ctx.agent(agentId)?.name ?? 'agente'}.`);
    }
    this.ctx.invalidate();
  }
}

/** Teclas dos botões do cartão de diálogo (nomes do tmux) e o que aparece neles. */
const DIALOG_BUTTONS: [key: string, text: string, title: string][] = [
  ['Up', '↑', 'Sobe uma opção'],
  ['Down', '↓', 'Desce uma opção'],
  ['Left', '←', 'Aba anterior / volta'],
  ['Right', '→', 'Próxima aba / avança'],
  ['Tab', 'Tab', 'Troca de aba (ex.: /permissions)'],
  ['Enter', 'Enter', 'Confirma a opção marcada com ❯'],
  ['Escape', 'Esc', 'Cancela / fecha a tela'],
];

/**
 * Cartão de uma tela de seleção no terminal do agente que o Habblaude não conhece (ex.: "Teach auto mode about your
 * environment?"): mostra o trecho do terminal e os botões ↑ ↓ Enter Esc, que apertam a tecla no pane.
 */
const KIND_UNKNOWN =
  'Tela no terminal: use os botões ou as teclas do seu teclado (↑ ↓ ← → Tab Enter Esc). Para escrever num campo da tela, digite na caixa de mensagem e envie; depois confirme com Enter.';

/** Tecla do teclado do navegador → tecla do tmux. Shift+Tab volta a aba. */
export function dialogKeyOf(e: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): string | undefined {
  if (e.ctrlKey || e.altKey || e.metaKey) return undefined;
  const map: Record<string, string> = { ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Enter', Escape: 'Escape', Backspace: 'BSpace' };
  if (e.key === 'Tab') return e.shiftKey ? 'BTab' : 'Tab';
  return map[e.key];
}
const KIND_LOGIN = 'Entrar na conta do Claude: abra o link, faça o login e cole o código na caixa de mensagem.';

export class DialogCard {
  readonly el: HTMLElement;
  private agentId = '';
  private busy = false;
  private pre: HTMLElement;
  private kind: HTMLElement;
  private login = false;
  private status: HTMLElement;
  private buttons: HTMLButtonElement[];

  constructor(
    private ctx: UiContext,
    variant: 'term' | 'drawer',
  ) {
    this.pre = h('pre', { class: 'ui-ask__screen', attrs: { 'aria-label': 'Trecho do terminal do agente' } });
    this.kind = h('p', { class: 'ui-ask__kind' });
    this.status = h('p', { class: 'ui-perm__status', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.buttons = DIALOG_BUTTONS.map(([key, text, title]) =>
      h('button', { class: 'ui-btn ui-perm__btn ui-ask__key', type: 'button', title, on: { click: () => void this.press(key) } }, text),
    );
    this.el = h(
      'section',
      {
        class: `ui-perm ui-ask ui-ask--${variant}`,
        hidden: true,
        tabIndex: 0,
        attrs: { 'aria-label': 'Tela no terminal do agente: as setas, Tab, Enter e Esc vão para o terminal' },
        on: { keydown: (e: Event) => this.onKey(e as KeyboardEvent) },
      },
      h('div', { class: 'ui-perm__head ui-ask__head' }, h('span', { class: 'ui-perm__icon', text: '⌨', attrs: { 'aria-hidden': 'true' } }), h('strong', { class: 'ui-perm__title', text: 'O terminal do agente espera você' })),
      this.kind,
      this.pre,
      h('div', { class: 'ui-perm__actions' }, ...this.buttons),
      this.status,
    );
  }

  get visible(): boolean {
    return !this.el.hidden;
  }

  /** Tela de login à mostra: a caixa de mensagem manda o código colado (as outras telas seguram o texto). */
  get loginVisible(): boolean {
    return this.visible && this.login;
  }

  render(agent: AgentInfo | undefined): void {
    const d = agent && agent.status !== 'offline' && agent.status !== 'done' && !agent.question && !agent.permission ? agent.dialog : undefined;
    if (!agent || !d) {
      setHidden(this.el, true);
      if (this.agentId !== (agent?.id ?? '')) setText(this.status, '');
      this.agentId = agent?.id ?? '';
      return;
    }
    if (agent.id !== this.agentId) {
      this.agentId = agent.id;
      this.status.classList.remove('is-error');
      setText(this.status, '');
    }
    const appeared = this.el.hidden;
    setHidden(this.el, false);
    if (appeared && !d.login) queueMicrotask(() => this.focusIfIdle());
    this.login = !!d.login;
    setText(this.kind, d.login ? KIND_LOGIN : KIND_UNKNOWN);
    // o link do login precisa abrir: o trecho vira texto com as URLs clicáveis (nada de HTML vindo da tela)
    this.pre.replaceChildren();
    linkifyInto(this.pre, d.text);
    const local = this.ctx.store.mock || !!this.ctx.store.snapshot?.meta.terminal;
    for (const b of this.buttons) b.disabled = this.busy || !local;
  }

  /** Teclado físico com o cartão em foco: as teclas vão para o terminal (botões continuam valendo). */
  private onKey(e: KeyboardEvent): void {
    if (e.target instanceof HTMLButtonElement && (e.key === 'Enter' || e.key === ' ')) return; // botão em foco: clique
    const key = dialogKeyOf(e);
    if (!key || this.el.hidden || this.buttons.every((b) => b.disabled && !this.busy)) return;
    e.preventDefault();
    e.stopPropagation();
    void this.press(key);
  }

  /** Põe o foco no cartão para o teclado já funcionar (só se a pessoa não estiver digitando em outro campo). */
  focusIfIdle(): void {
    const a = document.activeElement;
    if (a && a !== document.body && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || (a as HTMLElement).isContentEditable)) return;
    this.el.focus({ preventScroll: true });
  }

  /** Texto da caixa de mensagem para o campo da tela (sem Enter). Devolve o erro, se houver. */
  async typeText(text: string): Promise<string | undefined> {
    if (!this.agentId) return 'Nenhuma tela à mostra.';
    try {
      return await this.ctx.store.pressDialogKey(this.agentId, { text });
    } catch {
      return 'Não foi possível falar com o Habblaude. Responda no terminal.';
    }
  }

  private async press(key: string): Promise<void> {
    const agentId = this.agentId;
    if (!agentId || this.busy) return;
    this.busy = true;
    this.status.classList.remove('is-error');
    this.ctx.invalidate();
    let error: string | undefined;
    try {
      error = await this.ctx.store.pressDialogKey(agentId, { key });
    } catch {
      error = 'Não foi possível falar com o Habblaude. Responda no terminal.';
    }
    this.busy = false;
    if (this.agentId === agentId) {
      if (error) this.status.classList.add('is-error');
      setText(this.status, error ?? '');
    }
    this.ctx.invalidate();
  }
}
