import { describe, expect, it } from 'vitest';
import type { MissionsView, MissionView } from '../../../shared/missions';
import { boardHint, confetti, currentMission, kicker, levelProgress, parseMissionsView, stepsText } from './missions-model';

const m = (n: number, state: MissionView['state'], extra: Partial<MissionView> = {}): MissionView => ({
  id: (['primeiro-site', 'peca-melhoria', 'jogo-pixel', 'leve-github', 'api-banco'] as const)[n - 1],
  number: n,
  state,
  coins: 100,
  xp: 100,
  ...(state === 'locked' ? {} : { title: `Missão ${n}`, why: 'w', goal: 'g', example: 'e', project: '~/projetos/x' }),
  ...extra,
});
const view = (states: MissionView['state'][], extra: Partial<MissionsView> = {}): MissionsView => ({
  missions: states.map((s, i) => m(i + 1, s)),
  wallet: { coins: 0, ledger: [] },
  xp: 0,
  level: { level: 1, name: 'Estagiário', floor: 0, next: 100 },
  streak: 0,
  celebrate: [],
  ...extra,
});

describe('modelo do quadro de missões', () => {
  it('parseMissionsView aceita só o formato do servidor', () => {
    const v = view(['available', 'locked']);
    expect(parseMissionsView(JSON.parse(JSON.stringify(v)))).toEqual(v);
    expect(parseMissionsView(null)).toBeNull();
    expect(parseMissionsView({ missions: 'x' })).toBeNull();
    expect(parseMissionsView({ ...v, missions: [{ id: 'x' }] })).toBeNull();
  });

  it('missão da vez: a liberada ou a em andamento', () => {
    expect(currentMission(view(['done', 'active', 'locked']))?.number).toBe(2);
    expect(currentMission(view(['available', 'locked']))?.number).toBe(1);
    expect(currentMission(view(['done', 'done']))).toBeUndefined();
  });

  it('balão sobre o quadro: comemoração > missão nova > em andamento; nada com tudo concluído', () => {
    expect(boardHint(view(['done', 'available'], { celebrate: ['primeiro-site'] }))).toBe('🏆 Missão concluída!');
    expect(boardHint(view(['available', 'locked']))).toBe('📋 Missão nova: Missão 1');
    expect(boardHint(view(['done', 'active']))).toBe('📋 Missão 2 em andamento');
    expect(boardHint(view(['done', 'done']))).toBeUndefined();
  });

  it('conta do Claude que saiu vira o balão (aviso, sem bloquear)', () => {
    expect(boardHint(view(['done', 'done'], { authLost: true }))).toBe('⚠ Sua conta do Claude saiu — conecte de novo');
  });

  it('balão da Missão 0 chama para o login', () => {
    const v = view(['active', 'locked']);
    v.missions[0] = { ...v.missions[0], number: 0, title: 'Conecte sua conta do Claude' };
    expect(boardHint(v)).toBe('📋 Primeiro passo: Conecte sua conta do Claude');
  });

  it('título da missão: a 0 é preparação', () => {
    expect(kicker(m(1, 'active', { number: 0 }), 6)).toBe('Missão 0 · preparação · em andamento');
    expect(kicker(m(2, 'available'), 6)).toBe('Missão 2 de 5');
  });

  it('passos conferidos', () => {
    expect(stepsText(m(1, 'active', { steps: [{ label: 'a', ok: true }, { label: 'b', ok: false }] }))).toBe('1 de 2 passos');
    expect(stepsText(m(1, 'active'))).toBe('');
  });

  it('progresso do nível', () => {
    expect(levelProgress({ ...view([]), xp: 150, level: { level: 2, name: 'x', floor: 100, next: 250 } })).toBeCloseTo(1 / 3);
    expect(levelProgress({ ...view([]), xp: 5000, level: { level: 6, name: 'x', floor: 1000 } })).toBe(1);
  });

  it('confete determinístico (mesma semente, mesmos pedaços), dentro da tela', () => {
    const a = confetti(7, 30);
    expect(a).toEqual(confetti(7, 30));
    expect(a).toHaveLength(30);
    for (const p of a) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(100);
      expect(p.delay).toBeGreaterThanOrEqual(0);
    }
  });
});
