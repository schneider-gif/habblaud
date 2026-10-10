// Seção "Vida social" da gaveta do agente: o que está fazendo numa roda, carteira de moedinhas,
// placar, personalidade, amizades/rivalidades com quem está no escritório e o extrato.
import type { AgentSocial } from '../world/api';
import type { UiContext } from './context';
import { h, setHidden, setText, setTitle } from './dom';
import { plural, relativeTime } from './format';

const NEED_UI = [
  ['agua', '💧', 'Água'],
  ['comida', '🍔', 'Comida'],
  ['lazer', '🎮', 'Lazer'],
] as const;

/** "+🪙10" / "−🪙10" (sinal tipográfico de menos). */
export function coinDelta(delta: number): string {
  return `${delta >= 0 ? '+' : '−'}🪙${Math.abs(delta)}`;
}

/** "3 vitórias · 1 derrota" (ou "Sem partidas ainda"). */
export function recordText(wins: number, losses: number): string {
  if (!wins && !losses) return 'Sem partidas ainda';
  return `${plural(wins, 'vitória', 'vitórias')} · ${plural(losses, 'derrota', 'derrotas')}`;
}

const LEDGER_SHOWN = 6;

export class SocialSection {
  readonly el: HTMLElement;
  private extra: HTMLElement;
  private doing: HTMLElement;
  private coins: HTMLElement;
  private earned: HTMLElement;
  private record: HTMLElement;
  private traits: HTMLElement;
  private phrase: HTMLElement;
  private friends: HTMLElement;
  private rivals: HTMLElement;
  private friendsRow: HTMLElement;
  private rivalsRow: HTMLElement;
  private ledger: HTMLElement;
  private ledgerBox: HTMLDetailsElement;
  private needsBox: HTMLElement;
  private needBars = new Map<string, { fill: HTMLElement; val: HTMLElement }>();
  private heart: HTMLElement;
  /** Assinaturas do que já está no DOM (só refaz as listas quando mudam). */
  private keys = { traits: '', bonds: '', ledger: '' };

  constructor(private ctx: UiContext) {
    const title = h('h3', { class: 'ui-sec__title', text: 'Vida social' });
    this.extra = h('span', { class: 'ui-sec__extra ui-social__balance' });
    this.doing = h('p', { class: 'ui-social__doing' });
    this.coins = h('strong', { class: 'ui-social__coins' });
    this.earned = h('span', { class: 'ui-social__earned' });
    this.record = h('span', { class: 'ui-social__record' });
    this.traits = h('div', { class: 'ui-social__traits' });
    this.phrase = h('p', { class: 'ui-social__phrase' });
    this.friends = h('span', { class: 'ui-social__names' });
    this.rivals = h('span', { class: 'ui-social__names' });
    this.friendsRow = h('p', { class: 'ui-social__bond' }, h('span', { class: 'ui-social__bond-label', text: '💛 Amizades' }), this.friends);
    this.rivalsRow = h('p', { class: 'ui-social__bond' }, h('span', { class: 'ui-social__bond-label', text: '⚔️ Rivalidades' }), this.rivals);
    this.ledger = h('ol', { class: 'ui-social__ledger' });
    this.ledgerBox = h('details', { class: 'ui-social__extract' }, h('summary', { text: 'Extrato' }), this.ledger);
    const wallet = h(
      'div',
      { class: 'ui-social__wallet' },
      h('span', { class: 'ui-social__purse', attrs: { 'aria-hidden': 'true' }, text: '🪙' }),
      h('div', { class: 'ui-social__wallet-body' }, h('div', { class: 'ui-social__wallet-line' }, this.coins, this.record), this.earned),
    );
    setTitle(wallet, 'Moedinhas fictícias: entra no escritório com um saldo, ganha 🪙10 por tarefa concluída e 🪙5 por pedido atendido, e aposta com os colegas. Ficam salvas no escritório (servidor).');
    // Bem-estar: coração + barras (água, comida, lazer). Só diversão: nada disso atrapalha o trabalho do agente.
    this.heart = h('button', { class: 'ui-needs__heart', type: 'button', text: '❤', attrs: { 'aria-expanded': 'true', 'aria-label': 'Bem-estar: água, comida e lazer' } });
    const rows = h('div', { class: 'ui-needs__rows' });
    for (const [k, emoji, label] of NEED_UI) {
      const fill = h('span', { class: `ui-needs__fill is-${k}` });
      const val = h('span', { class: 'ui-needs__val' });
      rows.append(h('div', { class: 'ui-needs__row' }, h('span', { class: 'ui-needs__label', text: `${emoji} ${label}` }), h('span', { class: 'ui-needs__bar' }, fill), val));
      this.needBars.set(k, { fill, val });
    }
    this.heart.addEventListener('click', () => {
      const open = rows.hidden;
      rows.hidden = !open;
      this.heart.setAttribute('aria-expanded', String(open));
    });
    this.needsBox = h('div', { class: 'ui-needs', attrs: { title: 'Só diversão: o agente enche as barras bebendo água ou café, comendo e jogando quando está à toa. Umas 3 vezes por dia de cada coisa deixa em 100%.' } }, this.heart, rows);
    this.el = h(
      'section',
      { class: 'ui-sec ui-social' },
      h('div', { class: 'ui-sec__head' }, title, this.extra),
      this.needsBox,
      this.doing,
      wallet,
      this.traits,
      this.phrase,
      this.friendsRow,
      this.rivalsRow,
      this.ledgerBox,
    );
  }

  /** Atualiza com o agente `id`; some quando o mundo não sabe dele (já saiu, ou mundo antigo). */
  render(id: string, now: number): void {
    const s: AgentSocial | null = this.ctx.world.social?.(id) ?? null;
    setHidden(this.el, !s);
    if (!s) return;
    setText(this.extra, `🪙 ${s.coins}`);
    setHidden(this.needsBox, !s.needs);
    if (s.needs) {
      const mood = (s.needs.agua + s.needs.comida + s.needs.lazer) / 3;
      this.heart.style.filter = `saturate(${0.25 + mood / 133}) brightness(${0.75 + mood / 400})`;
      for (const [k] of NEED_UI) {
        const v = Math.round(s.needs[k]);
        const bar = this.needBars.get(k)!;
        bar.fill.style.width = `${v}%`;
        bar.fill.classList.toggle('is-low', v < 25);
        setText(bar.val, `${v}%`);
      }
    }
    setText(this.doing, s.doing ?? '');
    setHidden(this.doing, !s.doing);
    setText(this.coins, `${s.coins} moedinhas`);
    setText(this.record, recordText(s.wins, s.losses));
    setText(this.earned, `${coinDelta(s.earned)} ganhos trabalhando`);
    setText(this.phrase, `Bordão: “${s.catchphrase}”`);

    const tk = s.traits.map((t) => t.label).join('|');
    if (tk !== this.keys.traits) {
      this.keys.traits = tk;
      this.traits.replaceChildren(...s.traits.map((t) => h('span', { class: 'ui-trait', title: t.desc, text: `${t.emoji} ${t.label}` })));
    }

    const bk = s.bonds.map((b) => `${b.id}:${b.kind}:${b.name}:${b.record?.join('-') ?? ''}`).join('|');
    if (bk !== this.keys.bonds) {
      this.keys.bonds = bk;
      const link = (b: AgentSocial['bonds'][number]) => {
        const label = b.record ? `${b.name} (${b.record[0]}×${b.record[1]})` : b.name;
        return h('button', {
          class: 'ui-social__name',
          type: 'button',
          text: label,
          title: b.record ? `Retrospecto contra ${b.name}: ${recordText(b.record[0], b.record[1])}` : `Ver ${b.name}`,
          on: { click: () => this.ctx.select({ type: 'agent', id: b.id }, { focus: true }) },
        });
      };
      const friends = s.bonds.filter((b) => b.kind === 'amizade');
      const rivals = s.bonds.filter((b) => b.kind === 'rivalidade');
      this.friends.replaceChildren(...friends.map(link));
      this.rivals.replaceChildren(...rivals.map(link));
      setHidden(this.friendsRow, !friends.length);
      setHidden(this.rivalsRow, !rivals.length);
    }

    const items = s.ledger.slice(0, LEDGER_SHOWN);
    const lk = items.map((e) => `${e.at}:${e.delta}:${e.text}`).join('|') + `@${Math.floor(now / 30_000)}`;
    if (lk !== this.keys.ledger) {
      this.keys.ledger = lk;
      this.ledger.replaceChildren(
        ...items.map((e) =>
          h(
            'li',
            { class: `ui-social__entry ${e.delta >= 0 ? 'is-plus' : 'is-minus'}` },
            h('span', { class: 'ui-social__delta', text: coinDelta(e.delta) }),
            h('span', { class: 'ui-social__what', text: `${e.icon} ${e.text}` }),
            h('time', { class: 'ui-social__when', text: relativeTime(e.at, now) }),
          ),
        ),
      );
    }
    setHidden(this.ledgerBox, !items.length);
  }
}
