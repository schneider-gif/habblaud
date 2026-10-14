import { describe, expect, it } from 'vitest';
import { mergeTabs, nextActiveTab, shellTabLabel, shellWsUrl } from './shell';

describe('terminal embutido (modelo)', () => {
  it('WebSocket na mesma origem: ws em http, wss em https', () => {
    expect(shellWsUrl({ protocol: 'http:', host: '127.0.0.1:4747' }, 'terminal-1', 100, 30)).toBe('ws://127.0.0.1:4747/api/shell/ws?session=terminal-1&cols=100&rows=30');
    expect(shellWsUrl({ protocol: 'https:', host: 'escritorio--ws--ana.habblaude.com' }, 'agente-x1', 80, 24)).toMatch(/^wss:\/\/escritorio--ws--ana\.habblaude\.com\/api\/shell\/ws\?session=agente-x1&/);
  });
  it('rótulo da aba: número e programa (shell genérico vira "shell")', () => {
    expect(shellTabLabel({ n: 1, command: 'bash' })).toBe('1 · shell');
    expect(shellTabLabel({ n: 2, command: 'vim' })).toBe('2 · vim');
    expect(shellTabLabel({ n: 3, command: '' })).toBe('3 · shell');
  });
  it('agentes em configuração vêm antes das abas do servidor', () => {
    const tabs = mergeTabs([{ id: 'terminal-1', n: 1, command: 'bash', cwd: '/', createdAt: 0, attached: 0 }], [{ id: 'agente-x', label: 'Configurar · Bia', kind: 'agent' }]);
    expect(tabs.map((t) => t.id)).toEqual(['agente-x', 'terminal-1']);
  });
  it('fechar uma aba ativa a vizinha', () => {
    const tabs = ['a', 'b', 'c'].map((id) => ({ id, label: id, kind: 'shell' as const }));
    expect(nextActiveTab(tabs, 'b')).toBe('c');
    expect(nextActiveTab(tabs, 'c')).toBe('b');
    expect(nextActiveTab(tabs.slice(0, 1), 'a')).toBeNull();
  });
});
