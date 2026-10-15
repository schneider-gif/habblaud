// Aviso global (meta.announcement, lido pelo servidor de um JSON central): modal com logo e confete.
// Só aparece com alguém usando o escritório (aba visível e clique/tecla no último minuto); se ninguém estiver
// usando, espera a próxima interação. Uma vez por navegador (ids vistos em localStorage).
import type { Announcement } from '../../../shared/types';
import type { UiComponent, UiContext } from './context';
import { h, prefersReducedMotion, setHidden } from './dom';
import { confetti } from './missions-model';
import { safeLocalStorage } from './prefs';

const SEEN_KEY = 'habblaud:announce-seen';
const ACTIVE_MS = 60_000;
const CONFETTI_MS = 3_000;

export class AnnouncementDialog implements UiComponent {
  readonly el: HTMLElement;
  private lastInput = -Infinity;
  private shown = false;

  constructor(
    private ctx: UiContext,
    private fx: HTMLElement,
  ) {
    this.el = h('div', { class: 'ui-announce', role: 'dialog', hidden: true, attrs: { 'aria-modal': 'true', 'aria-labelledby': 'ui-announce-title' } });
    const mark = () => {
      this.lastInput = Date.now();
      this.render();
    };
    for (const ev of ['pointerdown', 'keydown', 'wheel']) window.addEventListener(ev, mark, { passive: true, capture: true });
  }

  render(): void {
    if (this.shown) return;
    const a = this.ctx.store.liveSnapshot?.meta.announcement;
    if (!a || seen().includes(a.id)) return;
    if (document.visibilityState !== 'visible' || Date.now() - this.lastInput > ACTIVE_MS) return;
    this.shown = true;
    markSeen(a.id);
    this.open(a);
  }

  private open(a: Announcement): void {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      close();
    };
    const close = () => {
      window.removeEventListener('keydown', onKey, true);
      setHidden(this.el, true);
      this.el.replaceChildren();
    };
    const ok = h('button', { class: 'ui-btn ui-btn--primary', type: 'button', text: 'Bora!', on: { click: close } });
    this.el.replaceChildren(
      h(
        'div',
        { class: 'ui-announce__card' },
        a.logo ? h('img', { class: 'ui-announce__logo', attrs: { src: a.logo, alt: '' } }) : h('span'),
        h('strong', { class: 'ui-announce__title', text: a.title, attrs: { id: 'ui-announce-title' } }),
        h('p', { class: 'ui-announce__body', text: a.body }),
        ok,
      ),
    );
    // Captura: o atalho global de Esc (fechar painéis) não pode engolir o fechamento do aviso.
    window.addEventListener('keydown', onKey, true);
    setHidden(this.el, false);
    ok.focus();
    if (a.confetti && !prefersReducedMotion()) {
      const layer = h('div', { class: 'ui-missions-fx__burst' });
      for (const p of confetti(Date.now(), 120)) {
        layer.append(h('i', { class: 'ui-missions-fx__bit', style: `left:${p.x}%;--dx:${p.dx}px;--delay:${p.delay}ms;--size:${p.size}px;background:${p.color}` }));
      }
      this.fx.append(layer);
      setTimeout(() => layer.remove(), CONFETTI_MS);
    }
  }
}

function seen(): string[] {
  try {
    const v = JSON.parse(safeLocalStorage()?.getItem(SEEN_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function markSeen(id: string): void {
  try {
    safeLocalStorage()?.setItem(SEEN_KEY, JSON.stringify([...seen(), id].slice(-20)));
  } catch {
    // sem localStorage: pode reaparecer no próximo carregamento
  }
}
