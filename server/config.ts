// Configuração do servidor a partir das variáveis de ambiente (documentadas em server/README.md).
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverClaudeDirs } from './accounts/detect';
import { parseAllowedHosts } from './http/guard';
import { parseGithubRepo } from './updates/checker';

export interface ServerConfig {
  port: number;
  host: string;
  /** `--dev`: Vite em middleware mode (HMR) no mesmo servidor. */
  dev: boolean;
  /** Liga o simulador de demonstração ao iniciar. */
  demo: boolean;
  /** HABBLAUD_DEMO_LOCKED: demonstração proibida (escritório de cliente; agentes fictícios só confundem). */
  demoLocked: boolean;
  /** Rodando dentro de um container (PIDs do registro são do host: não dá para checá-los). */
  inDocker: boolean;
  home: string;
  /** Config dirs do Claude Code observados (um por conta). */
  claudeDirs: string[];
  /** Onde o Habblaud guarda o próprio estado (nomes persistidos). */
  dataDir: string;
  /**
   * Pasta com o uso capturado pelo statusline do Claude Code (scripts/statusline-tap.mjs):
   * HABBLAUD_USAGE_DIR ou ~/.habblaud/usage. No Docker, o docker-up monta essa pasta em /usage.
   */
  usageDir: string;
  /** Nomes extras aceitos no cabeçalho Host/Origin (HABBLAUD_ALLOWED_HOSTS); localhost e IPs sempre valem. */
  allowedHosts: Set<string>;
  /**
   * Terminal somente leitura (GET /api/agents/:id/terminal) ligado: só com bind local, isto é, com o
   * Habblaud acessível apenas pelo próprio computador (ver terminalOffReason).
   */
  terminal: boolean;
  /**
   * Terminal embutido (shell de verdade, ver server/shell/service.ts) permitido: mesma trava do terminal (bind local),
   * só no Linux, nunca como root, nunca com a demonstração ligada na partida; HABBLAUD_SHELL=0 desliga. Ver shellOffReason.
   */
  shell: boolean;
  /** Link rápido da barra superior (HABBLAUD_VSCODE_URL): só URL http(s); sem a variável, o botão não aparece. */
  links: { vscode?: string };
  /** Grava a linha do tempo do escritório para o timelapse (<dataDir>/timeline); HABBLAUD_TIMELINE=0 desliga. */
  timeline: boolean;
  /** Raiz do projeto (onde fica o package.json); serve dist/client a partir daqui. */
  rootDir: string;
  version: string;
  /** Repositório no GitHub ("dono/nome", do campo `repository` do package.json) onde saem as versões novas. */
  repo?: string;
  /** Consulta o GitHub atrás de versão nova (server/updates/checker.ts); HABBLAUD_UPDATE_CHECK=0 desliga. */
  updateCheck: boolean;
}

export function isTruthy(v: string | undefined): boolean {
  return !!v && /^(1|true|yes|sim|on)$/i.test(v.trim());
}

/** Sobe a partir de `from` até achar o package.json do projeto. */
export function findRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 6; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, 'utf8')) as { name?: unknown }).name;
        if (name === 'habblaud') return dir;
      } catch {
        // package.json ilegível: continua subindo
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(from, '..');
}

/** Versão e repositório do package.json. */
function readPackage(rootDir: string): { version: string; repo?: string } {
  try {
    const pkg = JSON.parse(readFileSync(join(rootDir, 'package.json'), 'utf8')) as { version?: unknown; repository?: unknown };
    return { version: typeof pkg.version === 'string' ? pkg.version : '0.0.0', repo: parseGithubRepo(pkg.repository) };
  } catch {
    return { version: '0.0.0' };
  }
}

export function detectDocker(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.HABBLAUD_IN_DOCKER !== undefined) return isTruthy(env.HABBLAUD_IN_DOCKER);
  return existsSync('/.dockerenv');
}

/**
 * Endereço de escuta que só o próprio computador alcança: 127.0.0.0/8, `::1` (com ou sem colchetes)
 * ou `localhost`. `0.0.0.0`, `::`, IPs de rede e nomes quaisquer não contam.
 */
export function isLoopbackBind(value: string | undefined): boolean {
  let v = value?.trim().toLowerCase() ?? '';
  if (v.startsWith('[') && v.endsWith(']')) v = v.slice(1, -1);
  if (v === 'localhost') return true;
  const family = isIP(v);
  if (family === 4) return v.startsWith('127.');
  if (family !== 6) return false;
  try {
    // Forma canônica (0:0:0:0:0:0:0:1 -> [::1]).
    return new URL(`http://[${v}]/`).hostname === '[::1]';
  } catch {
    return false;
  }
}

/**
 * Por que o terminal somente leitura fica desligado (undefined = ligado). Os transcripts têm a conversa
 * inteira, então ele só liga quando o Habblaud não fica exposto além do próprio computador:
 * - Node: o HABBLAUD_HOST precisa ser loopback;
 * - Docker: o processo sempre escuta em 0.0.0.0 dentro do container e quem decide a exposição é a porta
 *   publicada no host, HABBLAUD_BIND (o docker-compose.yml repassa o mesmo valor ao container). Ausente
 *   ou vazia = desligado: sem ela não dá para saber se a porta está exposta.
 * HABBLAUD_TERMINAL com qualquer valor que não seja "ligado" (0, false, off...) desliga; não existe forma
 * de ligar com a porta exposta.
 */
export function terminalOffReason(env: NodeJS.ProcessEnv, host: string, inDocker: boolean): string | undefined {
  const flag = env.HABBLAUD_TERMINAL?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_TERMINAL=${flag}`;
  if (inDocker) {
    const bind = env.HABBLAUD_BIND?.trim();
    if (!bind) return 'HABBLAUD_BIND não chegou ao container, então a porta pode estar exposta na rede';
    return isLoopbackBind(bind) ? undefined : `a porta está exposta na rede: HABBLAUD_BIND=${bind}`;
  }
  return isLoopbackBind(host) ? undefined : `a porta está exposta na rede: HABBLAUD_HOST=${host}`;
}

/**
 * Por que o terminal embutido fica desligado (undefined = permitido; o tmux e o script(1) ainda são conferidos na
 * partida). É um shell como o usuário do Habblaud, então exige tudo o que o terminal somente leitura exige e mais:
 * - HABBLAUD_SHELL com valor "desligado" (0, false, off...) desliga;
 * - mesma trava do terminal (terminalOffReason: acessível só pelo próprio computador ou pelo proxy de HABBLAUD_LOCAL_HOSTS);
 * - Linux (tmux + script do util-linux);
 * - nunca como root (o shell herdaria o root);
 * - nada de shell com a demonstração ligada (HABBLAUD_DEMO; ligar o demo depois também recusa, em shell/http.ts).
 */
export function shellOffReason(
  env: NodeJS.ProcessEnv,
  host: string,
  inDocker: boolean,
  sys: { platform: NodeJS.Platform; uid: number | undefined } = { platform: process.platform, uid: process.getuid?.() },
): string | undefined {
  const flag = env.HABBLAUD_SHELL?.trim();
  if (flag && !isTruthy(flag)) return `HABBLAUD_SHELL=${flag}`;
  const term = terminalOffReason(env, host, inDocker);
  if (term) return term;
  if (sys.platform !== 'linux') return 'o terminal embutido só funciona no Linux';
  if (sys.uid === 0) return 'o Habblaud está rodando como root (o shell seria root): rode como um usuário comum';
  if (isTruthy(env.HABBLAUD_DEMO)) return 'modo demonstração ligado';
  return undefined;
}

/** URL http(s) do link rápido (HABBLAUD_VSCODE_URL); qualquer outra coisa é ignorada. */
export function cleanLink(raw: string | undefined): string | undefined {
  const v = raw?.trim();
  if (!v) return undefined;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, argv: string[] = process.argv): ServerConfig {
  const home = env.HOME || homedir();
  const inDocker = detectDocker(env);
  const port = Number.parseInt(env.HABBLAUD_PORT ?? '', 10);
  const rootDir = findRoot(dirname(fileURLToPath(import.meta.url)));
  const host = env.HABBLAUD_HOST?.trim() || '127.0.0.1';
  const pkg = readPackage(rootDir);
  return {
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 4747,
    host,
    dev: argv.includes('--dev'),
    demo: isTruthy(env.HABBLAUD_DEMO),
    demoLocked: isTruthy(env.HABBLAUD_DEMO_LOCKED),
    inDocker,
    home,
    claudeDirs: discoverClaudeDirs(env, home),
    dataDir: resolve(env.HABBLAUD_DATA_DIR?.trim() || (inDocker ? '/data' : join(home, '.habblaud'))),
    usageDir: resolve(env.HABBLAUD_USAGE_DIR?.trim() || join(home, '.habblaud', 'usage')),
    allowedHosts: parseAllowedHosts(env.HABBLAUD_ALLOWED_HOSTS),
    terminal: terminalOffReason(env, host, inDocker) === undefined,
    shell: shellOffReason(env, host, inDocker) === undefined,
    links: { vscode: cleanLink(env.HABBLAUD_VSCODE_URL) },
    timeline: !env.HABBLAUD_TIMELINE?.trim() || isTruthy(env.HABBLAUD_TIMELINE),
    rootDir,
    version: pkg.version,
    repo: pkg.repo,
    updateCheck: !env.HABBLAUD_UPDATE_CHECK?.trim() || isTruthy(env.HABBLAUD_UPDATE_CHECK),
  };
}
