// Diálogos desconhecidos na tela do agente: findDialog com telas reais do Claude Code 2.1.295 (confiança na pasta,
// imports do CLAUDE.md), a "Teach auto mode about your environment?" num TUI falso, telas que NÃO são diálogo (prompt
// normal, agente trabalhando, pergunta com opções) e o DialogWatcher (snapshot, teclas, cartão próprio). Dados sintéticos.
import { describe, expect, it } from 'vitest';
import type { AgentInfo } from '../../shared/types';
import { setQuiet } from '../log';
import { applyDialog, DialogWatcher, findDialog, WAITING_FOR_DIALOG, type DialogKey } from './dialogs';
import { FakeAskTui } from './fake-tui';

setQuiet(true);

const SEP = '─'.repeat(100);

/** Tela real (2.1.295): confiança na pasta. */
const TRUST = [
  'Permission deny rule (../.claude/settings.json): Bash(cat ~/.vibe-*:*) mixes * with the trailing :* prefix syntax',
  '',
  SEP,
  ' Accessing workspace:',
  '',
  ' /home/schneider/hbq-test',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open source',
  " project, or work from your team). If not, take a moment to review what's in this folder first.",
  '',
  " Claude Code'll be able to read, edit, and execute files here.",
  '',
  ' Security guide',
  '',
  ' ❯ No, exit',
  '   Yes, I trust this folder',
  '',
  ' Enter to confirm · Esc to cancel',
].join('\n');

/** Tela real (2.1.295): imports de fora da pasta no CLAUDE.md. */
const IMPORTS = [
  SEP,
  '  Allow external CLAUDE.md file imports?',
  '  This project\'s CLAUDE.md or .claude/rules imports files outside the current working directory. Never allow this for',
  '  third-party repositories.',
  '  External imports:',
  '    /home/schneider/.claude/RTK.md',
  '  ❯ No, disable external imports',
  '    Yes, allow external imports',
  '  Enter to confirm · Esc to cancel',
].join('\n');

/** Prompt normal (nada a responder). */
const PROMPT = ['● ok, recebi.', '', SEP, '❯ ', SEP, '  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents'].join('\n');
/** Agente trabalhando. */
const WORKING = ['❯ faça X', '', '✻ Pondering… (12s · esc to interrupt)', '', SEP, '❯ ', SEP, '  ? for shortcuts'].join('\n');

/** TUI falso da tela "Teach auto mode about your environment?" (simulada: opções numeradas, Enter confirma). */
class FakeTeachTui {
  cursor = 0;
  closed: 'yes' | 'no' | 'never' | 'esc' | null = null;
  readonly options = ['Yes, set it up', 'Not now', "Don't ask again"];
  key(k: DialogKey): void {
    if (this.closed) return;
    if (k === 'Up') this.cursor = Math.max(0, this.cursor - 1);
    else if (k === 'Down') this.cursor = Math.min(this.options.length - 1, this.cursor + 1);
    else if (k === 'Escape') this.closed = 'esc';
    else this.closed = (['yes', 'no', 'never'] as const)[this.cursor];
  }
  screen(): string {
    if (this.closed) return PROMPT;
    return [
      '● Pronto.',
      '',
      SEP,
      ' Teach auto mode about your environment?',
      '',
      ' Auto mode works better when it knows which hosts, repos and buckets you trust.',
      '',
      ...this.options.map((o, i) => ` ${i === this.cursor ? '❯' : ' '} ${i + 1}. ${o}`),
      '',
      ' Enter to confirm · ↑/↓ to navigate · Esc to cancel',
    ].join('\n');
  }
}

describe('findDialog', () => {
  it('acha a tela de confiança na pasta (real) e corta no separador', () => {
    const d = findDialog(TRUST)!;
    expect(d.startsWith(' Accessing workspace:')).toBe(true);
    expect(d).toContain('❯ No, exit');
    expect(d.trimEnd().endsWith('Enter to confirm · Esc to cancel')).toBe(true);
    expect(d).not.toContain('Permission deny rule');
  });
  it('acha a tela de imports do CLAUDE.md (real)', () => {
    expect(findDialog(IMPORTS)).toContain('Allow external CLAUDE.md file imports?');
  });
  it('acha a "Teach auto mode"', () => {
    expect(findDialog(new FakeTeachTui().screen())).toContain('Teach auto mode about your environment?');
  });
  it('rodapé quebrado em duas linhas (terminal estreito)', () => {
    const narrow = [SEP, ' Algo novo?', ' ❯ 1. Sim', '   2. Não', 'Enter to select · ↑/↓ to navigate · ctrl+g to edit in Vim ·', 'Esc to cancel'].join('\n');
    expect(findDialog(narrow)?.endsWith('Esc to cancel')).toBe(true);
  });
  it('prompt normal, agente trabalhando ou tela vazia: nada', () => {
    expect(findDialog(PROMPT)).toBeUndefined();
    expect(findDialog(WORKING)).toBeUndefined();
    expect(findDialog('')).toBeUndefined();
  });
  it('rodapé sem cursor de seleção: nada', () => {
    expect(findDialog([SEP, ' Carregando…', ' Esc to cancel'].join('\n'))).toBeUndefined();
  });
});

function setup(screens: { tui?: FakeTeachTui; text?: string; covered?: boolean } = {}) {
  const agent = { id: 'a1', kind: 'main', engine: 'claude', status: 'idle' } as unknown as AgentInfo;
  let dirty = 0;
  const keys: string[] = [];
  const w = new DialogWatcher({
    office: { list: () => [agent], markDirty: () => void dirty++ },
    input: {
      screen: async () => screens.tui?.screen() ?? screens.text,
      navKeys: async (_id, k) => {
        keys.push(...k);
        for (const x of k) screens.tui?.key(x);
      },
    },
    covered: () => !!screens.covered,
    now: () => 42,
    sleep: async () => {},
  });
  return { agent, w, keys, dirty: () => dirty };
}

describe('DialogWatcher', () => {
  it('põe o diálogo no snapshot e o tira quando some', async () => {
    const tui = new FakeTeachTui();
    const s = setup({ tui });
    await s.w.poll();
    expect(s.w.dialogOf('a1')?.text).toContain('Teach auto mode');
    expect(s.w.dialogOf('a1')?.at).toBe(42);
    expect(s.dirty()).toBe(1);
    await s.w.poll();
    expect(s.dirty()).toBe(1); // mesma tela: não suja de novo
    tui.closed = 'no';
    await s.w.poll();
    expect(s.w.dialogOf('a1')).toBeUndefined();
    expect(s.dirty()).toBe(2);
  });

  it('↓ e Enter pelos botões respondem a tela "Teach auto mode"', async () => {
    const tui = new FakeTeachTui();
    const s = setup({ tui });
    await s.w.poll();
    expect(await s.w.pressKey('a1', { key: 'Down' })).toEqual({ dialog: true });
    expect(s.w.dialogOf('a1')?.text).toContain('❯ 2. Not now');
    expect(await s.w.pressKey('a1', { key: 'Enter' })).toEqual({ dialog: false });
    expect(tui.closed).toBe('no');
    expect(s.keys).toEqual(['Down', 'Enter']);
  });

  it('Esc também passa (só pelos botões do diálogo)', async () => {
    const tui = new FakeTeachTui();
    const s = setup({ tui });
    await s.w.poll();
    await s.w.pressKey('a1', { key: 'Escape' });
    expect(tui.closed).toBe('esc');
  });

  it('tecla inválida ou sem diálogo na tela: recusa sem apertar nada', async () => {
    const s = setup({ text: PROMPT });
    await expect(s.w.pressKey('a1', { key: 'Enter' })).rejects.toMatchObject({ status: 404 });
    await expect(s.w.pressKey('a1', { key: 'C-c' })).rejects.toMatchObject({ status: 400 });
    expect(s.keys).toEqual([]);
  });

  it('pergunta com opções ou pedido de permissão (cartão próprio): fica de fora', async () => {
    const covered = setup({ text: TRUST, covered: true });
    await covered.w.poll();
    expect(covered.w.dialogOf('a1')).toBeUndefined();
    const ask = setup({ text: new FakeAskTui([{ question: 'Qual?', multiSelect: false, options: [{ label: 'a' }, { label: 'b' }] }]).screen() });
    await ask.w.poll();
    expect(ask.w.dialogOf('a1')).toBeUndefined();
  });

  it('agente fora do tmux: nada', async () => {
    const s = setup({});
    await s.w.poll();
    expect(s.w.dialogOf('a1')).toBeUndefined();
  });
});

describe('applyDialog', () => {
  const d = { text: 'x', at: 1 };
  it('agente passa a esperar a pessoa', () => {
    const a = applyDialog({ status: 'idle' } as AgentInfo, d);
    expect(a).toMatchObject({ dialog: d, status: 'waiting', waitingFor: WAITING_FOR_DIALOG });
  });
  it('não mexe em agente que saiu nem quando já há pergunta ou permissão', () => {
    expect(applyDialog({ status: 'offline' } as AgentInfo, d).dialog).toBeUndefined();
    expect(applyDialog({ status: 'waiting', question: {} } as AgentInfo, d).dialog).toBeUndefined();
    expect(applyDialog({ status: 'waiting', permission: {} } as AgentInfo, d).dialog).toBeUndefined();
  });
});
