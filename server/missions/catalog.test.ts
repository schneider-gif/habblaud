import { describe, expect, it } from 'vitest';
import { levelFor, MISSIONS, missionById, PROJECT_SLUG_RE } from './catalog';

describe('catálogo das missões', () => {
  it('seis missões em ordem (a 0 é a conta do Claude), com moedas e XP', () => {
    expect(MISSIONS.map((m) => [m.number, m.id, m.coins])).toEqual([
      [0, 'conta-claude', 50],
      [1, 'primeiro-site', 100],
      [2, 'peca-melhoria', 100],
      [3, 'jogo-pixel', 150],
      [4, 'leve-github', 200],
      [5, 'api-banco', 250],
    ]);
    for (const m of MISSIONS) expect(m.xp).toBeGreaterThan(0);
  });

  it('todo texto pt-BR existe; o objetivo nunca é um pedido pronto e o exemplo fica separado', () => {
    for (const m of MISSIONS) {
      const t = m.text.pt;
      expect([t.title, t.why, t.goal, t.example].every((s) => s.trim().length > 0)).toBe(true);
      expect(t.goal).not.toBe(t.example);
      // porquê em uma linha
      expect(t.why).not.toContain('\n');
    }
  });

  it('pastas dos projetos: slug válido em ~/projetos', () => {
    for (const m of MISSIONS) if (m.project !== null) expect(PROJECT_SLUG_RE.test(m.project)).toBe(true);
    // Missão 0: no HOME, sem pasta de projeto
    expect(missionById('conta-claude')?.project).toBeNull();
    expect(missionById('peca-melhoria')?.project).toBe(missionById('primeiro-site')?.project);
  });

  it('nenhum texto fixa porta (vários escritórios rodam lado a lado)', () => {
    for (const m of MISSIONS) expect(JSON.stringify(m.text)).not.toMatch(/\b(3000|5173|8080|8000|4747)\b/);
  });

  it('missionById só aceita ids conhecidos', () => {
    expect(missionById('api-banco')?.number).toBe(5);
    expect(missionById('conta-claude')?.number).toBe(0);
    expect(missionById('x')).toBeUndefined();
    expect(missionById(undefined)).toBeUndefined();
    expect(missionById('__proto__')).toBeUndefined();
  });

  it('níveis por XP', () => {
    expect(levelFor(0)).toMatchObject({ level: 1, floor: 0, next: 100 });
    expect(levelFor(99).level).toBe(1);
    expect(levelFor(100)).toMatchObject({ level: 2, floor: 100 });
    const max = levelFor(1_000_000);
    expect(max.next).toBeUndefined();
    expect(max.name.length).toBeGreaterThan(0);
  });
});

describe('Missão 0', () => {
  it('passos concretos, conta própria e aviso de não afiliação; ativa sozinha', () => {
    const m = missionById('conta-claude')!;
    expect(m.text.pt.title).toBe('Conecte sua conta do Claude ou da OpenAI (Codex)');
    expect(m.text.pt.why).toBe('Sem isso os agentes não conseguem trabalhar. Qualquer uma das duas serve.');
    expect(m.text.pt.goal).toContain('claude');
    expect(m.text.pt.goal).toContain('codex');
    expect(m.text.pt.goal).toContain('Sign in with Device Code');
    expect(m.text.pt.goal).toContain('Você usa a sua própria conta ou chave; o uso é cobrado direto pela Anthropic ou pela OpenAI. Não somos afiliados.');
    expect(m.auto).toBe(true);
  });
});
