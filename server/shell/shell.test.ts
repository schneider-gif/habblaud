// Terminal embutido: trava (Host, Origin, desligado por env, demo), protocolo do WebSocket e, no Linux com tmux e
// script(1), um shell de verdade aberto como o usuário que roda o servidor (nunca root).
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanLink, shellOffReason } from '../config';
import { readJson, sendJson } from '../http/app';
import { encodeFrame } from '../http/ws';
import { createShellRoutes, wsOriginOk } from './http';
import { AGENT_SESSION, attachCommand, clampSize, SHELL_SESSION, ShellService, shellEnv, type PtyHandle } from './service';
import { setupAgents, WAIT_LOGIN, WAIT_SETUP } from './setup';

const LINUX = { platform: 'linux' as NodeJS.Platform, uid: 1000 };
const LOCAL = { HABBLAUD_HOST: '127.0.0.1' };

describe('shellOffReason (quando o shell pode existir)', () => {
  it('liga com bind local, Linux e usuário comum', () => {
    expect(shellOffReason(LOCAL, '127.0.0.1', false, LINUX)).toBeUndefined();
  });
  it('HABBLAUD_SHELL=0 desliga', () => {
    expect(shellOffReason({ ...LOCAL, HABBLAUD_SHELL: '0' }, '127.0.0.1', false, LINUX)).toMatch(/HABBLAUD_SHELL=0/);
    expect(shellOffReason({ ...LOCAL, HABBLAUD_SHELL: 'off' }, '127.0.0.1', false, LINUX)).toMatch(/HABBLAUD_SHELL/);
    expect(shellOffReason({ ...LOCAL, HABBLAUD_SHELL: '1' }, '127.0.0.1', false, LINUX)).toBeUndefined();
  });
  it('porta exposta na rede desliga (mesma trava do terminal)', () => {
    expect(shellOffReason({}, '0.0.0.0', false, LINUX)).toMatch(/exposta/);
    expect(shellOffReason({}, '0.0.0.0', true, LINUX)).toMatch(/HABBLAUD_BIND/);
    expect(shellOffReason({ HABBLAUD_TERMINAL: '0' }, '127.0.0.1', false, LINUX)).toMatch(/HABBLAUD_TERMINAL/);
  });
  it('nunca como root, só no Linux e nunca com a demonstração', () => {
    expect(shellOffReason(LOCAL, '127.0.0.1', false, { platform: 'linux', uid: 0 })).toMatch(/root/);
    expect(shellOffReason(LOCAL, '127.0.0.1', false, { platform: 'darwin', uid: 501 })).toMatch(/Linux/);
    expect(shellOffReason({ ...LOCAL, HABBLAUD_DEMO: '1' }, '127.0.0.1', false, LINUX)).toMatch(/demonstração/);
  });
});

describe('links rápidos e saneamento', () => {
  it('cleanLink aceita só http(s)', () => {
    expect(cleanLink('https://coder.habblaude.com/@ana/escritorio.main/apps/code-server/')).toBe('https://coder.habblaude.com/@ana/escritorio.main/apps/code-server/');
    expect(cleanLink('javascript:alert(1)')).toBeUndefined();
    expect(cleanLink('  ')).toBeUndefined();
    expect(cleanLink('não é url')).toBeUndefined();
  });
  it('attachCommand só aceita sessões conhecidas', () => {
    expect(attachCommand('terminal-3', 120, 40)).toBe("stty rows 40 cols 120 2>/dev/null; exec tmux -u attach-session -t '=terminal-3'");
    expect(attachCommand('agente-mabc12', 80, 24)).toContain("'=agente-mabc12'");
    expect(() => attachCommand("terminal-1'; rm -rf ~", 80, 24)).toThrow();
    expect(() => attachCommand('main', 80, 24)).toThrow();
    expect(SHELL_SESSION.test('terminal-12')).toBe(true);
    expect(AGENT_SESSION.test('agente-$(x)')).toBe(false);
  });
  it('clampSize limita colunas e linhas', () => {
    expect(clampSize(9999, -3)).toEqual({ cols: 500, rows: 5 });
    expect(clampSize('abc', undefined)).toEqual({ cols: 100, rows: 30 });
  });
  it('shellEnv tira o tmux do pai e as credenciais do agente do Coder', () => {
    const env = shellEnv({ PATH: '/bin', TMUX: '/tmp/x,1,0', TMUX_PANE: '%1', CODER_AGENT_TOKEN: 'segredo', HB_AGENT_INIT: 'x', HABBLAUD_ALLOWED_HOSTS: 'a', LANG: 'C' });
    expect(env).toMatchObject({ PATH: '/bin', TERM: 'xterm-256color', LANG: 'C.UTF-8' });
    for (const k of ['TMUX', 'TMUX_PANE', 'CODER_AGENT_TOKEN', 'HB_AGENT_INIT', 'HABBLAUD_ALLOWED_HOSTS']) expect(env[k]).toBeUndefined();
  });
  it('wsOriginOk exige Origin igual à origem da página', () => {
    expect(wsOriginOk('http://127.0.0.1:4747', '127.0.0.1:4747')).toBe(true);
    expect(wsOriginOk('https://escritorio--ws--ana.habblaude.com', 'escritorio--ws--ana.habblaude.com')).toBe(true);
    expect(wsOriginOk(undefined, '127.0.0.1:4747')).toBe(false);
    expect(wsOriginOk('http://evil.example', '127.0.0.1:4747')).toBe(false);
    expect(wsOriginOk('http://127.0.0.1:9999', '127.0.0.1:4747')).toBe(false);
    expect(wsOriginOk('null', '127.0.0.1:4747')).toBe(false);
  });
});

describe('setupAgents (agentes abertos pelo escritório sem sessão do Claude)', () => {
  const s = { session: 'agente-abc', pid: 4242, cwd: '/home/ubuntu/projetos/meu-site', createdAt: 1_000, command: 'claude' };
  it('sem login: precisa de você para conectar a conta', () => {
    expect(setupAgents([s], { account: '.claude', hasAgentPid: () => false, connected: false, now: 2_000 })).toEqual([
      { id: '.claude:4242', session: 'agente-abc', cwd: s.cwd, createdAt: 1_000, status: 'waiting', waitingFor: WAIT_LOGIN },
    ]);
  });
  it('com login: abrindo nos primeiros segundos, depois termine a configuração', () => {
    expect(setupAgents([s], { account: '.claude', hasAgentPid: () => false, connected: true, now: 3_000 })[0].status).toBe('idle');
    expect(setupAgents([s], { account: '.claude', hasAgentPid: () => false, connected: true, now: 60_000 })[0].waitingFor).toBe(WAIT_SETUP);
  });
  it('some quando o agente de verdade chega', () => {
    expect(setupAgents([s], { account: '.claude', hasAgentPid: (p) => p === 4242, connected: false, now: 2_000 })).toEqual([]);
  });
});

// ------------------------------------------------------------------ servidor com as rotas do shell

interface Srv {
  port: number;
  close: () => Promise<void>;
}

const servers: Srv[] = [];
afterEach(async () => {
  while (servers.length) await servers.pop()!.close();
});

/** PTY falso: ecoa o que chega, com o prefixo "eco:", e guarda os resizes. */
function fakePty(log: string[]): (session: string, cols: number, rows: number) => PtyHandle {
  return (session, cols, rows) => {
    log.push(`attach ${session} ${cols}x${rows}`);
    let data: (b: Buffer) => void = () => undefined;
    let exit: (c: number | null) => void = () => undefined;
    return {
      onData: (cb) => void (data = cb),
      onExit: (cb) => void (exit = cb),
      write: (d) => {
        const s = String(d);
        if (s === 'exit\r') return exit(0);
        data(Buffer.from(`eco:${s}`));
      },
      resize: (c, r) => void log.push(`resize ${c}x${r}`),
      pause: () => undefined,
      resume: () => undefined,
      kill: () => void log.push('kill'),
    };
  };
}

async function startShellServer(o: { offReason?: string; demo?: boolean; service: ShellService | undefined }): Promise<Srv> {
  const routes = createShellRoutes({
    service: o.service,
    offReason: () => o.offReason,
    isDemo: () => o.demo === true,
    allowedHosts: new Set(['habblaud.lan', 'escritorio.lan']),
    localHosts: new Set(['escritorio.lan']),
    sendJson,
    readJson,
  });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (!routes.api(req, res, url)) sendJson(res, 404, { error: 'rota desconhecida' });
  });
  const upgraded = new Set<{ destroy: () => void }>();
  server.on('upgrade', (req, socket, head) => {
    upgraded.add(socket);
    if (!routes.upgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  const port = (server.address() as AddressInfo).port;
  const srv = {
    port,
    close: () =>
      new Promise<void>((ok) => {
        for (const sock of upgraded) sock.destroy();
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
  servers.push(srv);
  return srv;
}

function fakeService(log: string[], sessions = ['terminal-1']): ShellService {
  return new ShellService({
    home: '/home/ubuntu',
    env: { PATH: '/bin' },
    tmux: async (args) => {
      log.push(`tmux ${args[0]}`);
      if (args[0] === 'list-sessions') return sessions.map((s) => `${s}\t1700000000\t0\tbash\t/home/ubuntu\t123`).join('\n');
      return '';
    },
    spawnPty: fakePty(log),
  });
}

interface WsClient {
  status: number;
  body: string;
  socket?: Socket;
  messages: { text?: string; bin?: string }[];
  send: (obj: unknown) => void;
  waitFor: (pred: (all: string) => boolean, ms?: number) => Promise<string>;
}

/** Cliente WebSocket cru (para escolher Host e Origin à vontade). */
function wsConnect(port: number, path: string, headers: Record<string, string>): Promise<WsClient> {
  return new Promise((ok, fail) => {
    const key = randomBytes(16).toString('base64');
    const req = http.request({
      port,
      host: '127.0.0.1',
      path,
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': key, 'Sec-WebSocket-Version': '13', ...headers },
    });
    req.on('response', (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => ok({ status: res.statusCode ?? 0, body, messages: [], send: () => undefined, waitFor: async () => '' }));
    });
    req.on('upgrade', (res, socket) => {
      const messages: WsClient['messages'] = [];
      let buf = Buffer.alloc(0);
      let all = '';
      socket.on('data', (c: Buffer) => {
        buf = Buffer.concat([buf, c]);
        while (buf.length >= 2) {
          let len = buf[1] & 0x7f;
          let off = 2;
          if (len === 126) {
            if (buf.length < 4) return;
            len = buf.readUInt16BE(2);
            off = 4;
          }
          if (buf.length < off + len) return;
          const op = buf[0] & 0x0f;
          const payload = buf.subarray(off, off + len).toString('utf8');
          buf = buf.subarray(off + len);
          if (op === 1) messages.push({ text: payload });
          else if (op === 2) {
            messages.push({ bin: payload });
            all += payload;
          }
        }
      });
      const send = (obj: unknown) => {
        const frame = encodeFrame(1, Buffer.from(JSON.stringify(obj)));
        // quadros do cliente são mascarados (bit de máscara + chave de 4 bytes)
        const headLen = frame[1] === 126 ? 4 : 2;
        const mask = randomBytes(4);
        const payload = Buffer.from(frame.subarray(headLen));
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        const head = Buffer.from(frame.subarray(0, headLen));
        head[1] |= 0x80;
        socket.write(Buffer.concat([head, mask, payload]));
      };
      const waitFor = (pred: (all: string) => boolean, ms = 8000) =>
        new Promise<string>((done, bad) => {
          const t0 = Date.now();
          const tick = () => {
            if (pred(all)) return done(all);
            if (Date.now() - t0 > ms) return bad(new Error(`tempo esgotado; saída até agora: ${JSON.stringify(all.slice(-400))}`));
            setTimeout(tick, 30);
          };
          tick();
        });
      ok({ status: res.statusCode ?? 101, body: '', socket, messages, send, waitFor });
    });
    req.on('error', fail);
    req.end();
  });
}

describe('WebSocket /api/shell/ws (trava)', () => {
  it('recusa Host que não é permitido (DNS rebinding)', async () => {
    const log: string[] = [];
    const { port } = await startShellServer({ service: fakeService(log) });
    const r = await wsConnect(port, '/api/shell/ws?session=terminal-1', { Host: 'evil.example.com', Origin: 'http://evil.example.com' });
    expect(r.status).toBe(403);
    expect(log.filter((l) => l.startsWith('attach'))).toEqual([]);
  });

  it('recusa Host permitido mas não local (proxy/túnel sem HABBLAUD_LOCAL_HOSTS)', async () => {
    const { port } = await startShellServer({ service: fakeService([]) });
    const r = await wsConnect(port, '/api/shell/ws?session=terminal-1', { Host: 'habblaud.lan', Origin: 'http://habblaud.lan' });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/próprio computador/);
  });

  it('recusa sem Origin ou com Origin de outro site (cross-site WebSocket hijacking)', async () => {
    const { port } = await startShellServer({ service: fakeService([]) });
    const host = `127.0.0.1:${port}`;
    expect((await wsConnect(port, '/api/shell/ws?session=terminal-1', { Host: host })).status).toBe(403);
    expect((await wsConnect(port, '/api/shell/ws?session=terminal-1', { Host: host, Origin: 'http://evil.example.com' })).status).toBe(403);
  });

  it('desligado por env (HABBLAUD_SHELL=0): upgrade e rotas recusados', async () => {
    const off = shellOffReason({ ...LOCAL, HABBLAUD_SHELL: '0' }, '127.0.0.1', false, LINUX);
    const { port } = await startShellServer({ service: fakeService([]), offReason: off });
    const host = `127.0.0.1:${port}`;
    const r = await wsConnect(port, '/api/shell/ws?session=terminal-1', { Host: host, Origin: `http://${host}` });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/HABBLAUD_SHELL=0/);
    const j = (await (await fetch(`http://${host}/api/shell`)).json()) as { available: boolean; reason: string };
    expect(j).toMatchObject({ available: false });
    const post = await fetch(`http://${host}/api/shell/tabs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(post.status).toBe(403);
  });

  it('sem shell durante a demonstração', async () => {
    const { port } = await startShellServer({ service: fakeService([]), demo: true });
    const host = `127.0.0.1:${port}`;
    const r = await wsConnect(port, '/api/shell/ws?session=terminal-1', { Host: host, Origin: `http://${host}` });
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/demonstração/);
  });

  it('sessão inválida ou inexistente', async () => {
    const { port } = await startShellServer({ service: fakeService([]) });
    const host = `127.0.0.1:${port}`;
    expect((await wsConnect(port, '/api/shell/ws?session=main', { Host: host, Origin: `http://${host}` })).status).toBe(400);
    expect((await wsConnect(port, '/api/shell/ws?session=terminal-9', { Host: host, Origin: `http://${host}` })).status).toBe(404);
  });
});

describe('WebSocket /api/shell/ws (protocolo, PTY falso)', () => {
  it('anexa, repassa teclas e resize, avisa a saída e mata só o cliente ao fechar', async () => {
    const log: string[] = [];
    const { port } = await startShellServer({ service: fakeService(log, ['terminal-1', 'agente-xyz']) });
    const host = `127.0.0.1:${port}`;
    const c = await wsConnect(port, '/api/shell/ws?session=terminal-1&cols=90&rows=20', { Host: host, Origin: `http://${host}` });
    expect(c.status).toBe(101);
    expect(log).toContain('attach terminal-1 90x20');
    c.send({ t: 'i', d: 'ls\r' });
    await c.waitFor((all) => all.includes('eco:ls\r'));
    c.send({ t: 'r', c: 132, r: 41 });
    await new Promise((r) => setTimeout(r, 50));
    expect(log).toContain('resize 132x41');
    c.send({ t: 'i', d: 'exit\r' });
    await new Promise((r) => setTimeout(r, 80));
    expect(c.messages.some((m) => m.text && JSON.parse(m.text).t === 'exit')).toBe(true);
  });

  it('proxy local liberado (HABBLAUD_LOCAL_HOSTS, ex.: app do Coder) com Origin da mesma origem', async () => {
    const log: string[] = [];
    const routes = await startShellServer({ service: fakeService(log) });
    // escritorio.lan está em allowedHosts e em localHosts (como o template do Coder faz): abre.
    const r = await wsConnect(routes.port, '/api/shell/ws?session=terminal-1', { Host: 'escritorio.lan', Origin: 'https://escritorio.lan' });
    expect(r.status).toBe(101);
    r.socket?.destroy();
  });

  it('GET /api/shell lista as abas e POST cria terminal-N no HOME', async () => {
    const log: string[] = [];
    const { port } = await startShellServer({ service: fakeService(log, ['terminal-1', 'terminal-3', 'main']) });
    const base = `http://127.0.0.1:${port}`;
    const j = (await (await fetch(`${base}/api/shell`)).json()) as { available: boolean; tabs: { id: string }[] };
    expect(j.available).toBe(true);
    expect(j.tabs.map((t) => t.id)).toEqual(['terminal-1', 'terminal-3']);
    const r = await fetch(`${base}/api/shell/tabs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"cols":100,"rows":30}' });
    expect(r.status).toBe(201);
    expect(((await r.json()) as { tab: { id: string } }).tab.id).toBe('terminal-2');
    expect(log).toContain('tmux new-session');
  });
});

// ------------------------------------------------------------------ shell de verdade (Linux + tmux + script)

function hasCmd(cmd: string, args: string[]): boolean {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}
const REAL = process.platform === 'linux' && process.getuid?.() !== 0 && hasCmd('tmux', ['-V']) && hasCmd('script', ['--version']);

describe.skipIf(!REAL)('shell de verdade (tmux + script)', () => {
  it('abre como o usuário do servidor (nunca root), executa comandos e sobrevive a reconectar', async () => {
    const tmuxDir = mkdtempSync(join(tmpdir(), 'hb-shell-test-'));
    const env: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmuxDir };
    delete env.TMUX;
    const service = new ShellService({ home: tmpdir(), env, shell: '/bin/sh' });
    try {
      expect(await service.probe()).toBeUndefined();
      const tab = await service.create({ cols: 100, rows: 30 });
      expect(tab.id).toBe('terminal-1');
      const { port } = await startShellServer({ service });
      const host = `127.0.0.1:${port}`;
      const c = await wsConnect(port, `/api/shell/ws?session=${tab.id}&cols=100&rows=30`, { Host: host, Origin: `http://${host}` });
      expect(c.status).toBe(101);
      c.send({ t: 'i', d: 'echo "QUEM=$(id -un) UID=$(id -u)"; export MARCA=viva\r' });
      const out = await c.waitFor((all) => /QUEM=\S+ UID=\d+/.test(all));
      const m = /QUEM=(\S+) UID=(\d+)/.exec(out)!;
      expect(m[1]).toBe(userInfo().username);
      expect(Number(m[2])).not.toBe(0);
      // redimensionar: stty -F no PTY do cliente tmux -> SIGWINCH -> o pane (sem barra de status) fica 132x40
      c.send({ t: 'r', c: 132, r: 40 });
      await new Promise((r) => setTimeout(r, 400));
      c.send({ t: 'i', d: 'echo TAM=$(stty size)\r' });
      await c.waitFor((all) => all.includes('TAM=40 132'));
      c.socket!.destroy();
      // "recarregar a página": conecta de novo e a mesma sessão continua (variável exportada antes ainda existe)
      await new Promise((r) => setTimeout(r, 300));
      expect((await service.list()).map((t) => t.id)).toEqual(['terminal-1']);
      const c2 = await wsConnect(port, `/api/shell/ws?session=${tab.id}&cols=132&rows=40`, { Host: host, Origin: `http://${host}` });
      c2.send({ t: 'i', d: 'echo "MARCA=$MARCA COLS=$(tput cols 2>/dev/null || stty size)"\r' });
      await c2.waitFor((all) => all.includes('MARCA=viva'));
      c2.socket!.destroy();
    } finally {
      try {
        execFileSync('tmux', ['kill-server'], { env, stdio: 'ignore' });
      } catch {
        // já não havia servidor
      }
      rmSync(tmuxDir, { recursive: true, force: true });
    }
  }, 20_000);
});

describe('SetupWatcher: login feito num agente reabre os outros parados no onboarding', () => {
  it('reabre só quem não tem conversa e não está anexado, quando a conta fica pronta', async () => {
    const { SetupWatcher } = await import('./setup');
    const sessions = [
      { session: 'agente-a', pid: 10, cwd: '/h/p', createdAt: 0, command: 'claude', attached: 1 }, // onde o login foi feito
      { session: 'agente-b', pid: 11, cwd: '/h/p', createdAt: 0, command: 'claude', attached: 0 },
      { session: 'agente-c', pid: 12, cwd: '/h/p', createdAt: 0, command: 'claude', attached: 0 },
      { session: 'agente-d', pid: 13, cwd: '/h/p', createdAt: 0, command: 'claude', attached: 0 }, // já tem conversa
    ];
    let ready = false;
    const restarted: string[] = [];
    const w = new SetupWatcher({
      list: async () => sessions,
      connected: async () => ready,
      ready: async () => ready,
      hasAgentPid: (pid) => pid === 13,
      apply: () => undefined,
      restart: async (s) => void restarted.push(s.session),
      account: '.claude',
    });
    await w.scan();
    expect(restarted).toEqual([]);
    ready = true;
    expect(await w.restartPending()).toBe(2);
    expect(restarted).toEqual(['agente-b', 'agente-c']);
    w.stop();
  });
});
