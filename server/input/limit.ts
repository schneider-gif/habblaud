// Limite de agentes rodando ao mesmo tempo (plano do escritório Habblaude: Recepção 1, Sala 2, Andar 4).
//
// Ligado por HABBLAUD_MAX_AGENTS (ou HB_MAX_AGENTES, que o template do escritório já passa ao container); sem a variável
// (ou 0/inválida) não há limite. O "+ Novo agente", o "Retomar" e as missões passam por spawn(), que recusa com 409 e a
// mesma mensagem do porteiro da imagem (/usr/local/bin/claude e codex, que é a trava final para quem abre pelo
// terminal). A contagem segue a mesma regra do porteiro: processos top-level do Claude Code e do Codex (subagentes
// rodam dentro do mesmo processo; um claude aberto de dentro de outro agente não conta), sem os comandos rápidos
// (--version, `claude plugin|mcp ...`, `codex login ...`).
import { readdirSync, readFileSync } from 'node:fs';

export interface AgentLimit {
  max: number;
  /** recepcao | sala | andar (nome no texto da recusa). */
  plan?: string;
  upgradeUrl: string;
}

export const DEFAULT_UPGRADE_URL = 'app.habblaude.com/planos';
const PLAN_NAMES: Record<string, string> = { recepcao: 'Recepção', sala: 'Sala', andar: 'Andar' };

export function agentLimitFromEnv(env: NodeJS.ProcessEnv): AgentLimit | undefined {
  const raw = (env.HABBLAUD_MAX_AGENTS ?? '').trim() || (env.HB_MAX_AGENTES ?? '').trim();
  if (!/^\d{1,4}$/.test(raw)) return undefined;
  const max = Number(raw);
  if (max < 1) return undefined;
  const plan = ((env.HABBLAUD_PLAN ?? '').trim() || (env.HB_PLANO ?? '').trim()).toLowerCase();
  return { max, plan: PLAN_NAMES[plan] ? plan : undefined, upgradeUrl: (env.HABBLAUD_UPGRADE_URL ?? '').trim() || DEFAULT_UPGRADE_URL };
}

export function planName(plan: string | undefined): string | undefined {
  return plan ? PLAN_NAMES[plan] : undefined;
}

/** Mesmo texto do porteiro da imagem. */
export function limitMessage(limit: AgentLimit, running: number): string {
  const name = planName(limit.plan);
  const who = name ? `Seu plano ${name}` : 'Seu plano';
  if (limit.max === 1) return `${who} permite 1 agente por vez e já há ${running} rodando. Feche o outro agente ou faça upgrade em ${limit.upgradeUrl}.`;
  return `${who} permite ${limit.max} agentes ao mesmo tempo e já há ${running} rodando. Feche um deles ou faça upgrade em ${limit.upgradeUrl}.`;
}

// ------------------------------------------------------------------ classificação (igual ao hb-porteiro)

export type AgentEngine = 'claude' | 'codex';

const QUICK: Record<AgentEngine, ReadonlySet<string>> = {
  claude: new Set(['-v', '-V', '--version', '-h', '--help', 'help', 'agents', 'attach', 'auth', 'auto-mode', 'doctor', 'gateway', 'import', 'install', 'logs', 'mcp', 'plugin', 'plugins', 'purge', 'respawn', 'rm', 'setup-token', 'stop', 'kill', 'ultrareview', 'update', 'upgrade', 'config', 'migrate-installer', 'login', 'logout']),
  codex: new Set(['-V', '--version', '-h', '--help', 'help', 'agents', 'login', 'logout', 'mcp', 'mcp-server', 'plugin', 'app-server', 'remote-control', 'completion', 'update', 'doctor', 'sandbox', 'debug', 'apply', 'a', 'queue', 'archive', 'delete', 'migrate-rollouts', 'unarchive', 'cloud', 'exec-server', 'features', 'generate-ts', 'responses-api-proxy', 'stdio-to-uds']),
};
const HELP_ANYWHERE = new Set(['-h', '--help', '-V', '--version']);

/** Comando rápido (não abre agente)? */
export function isQuickCommand(engine: AgentEngine, args: readonly string[]): boolean {
  if (!args.length) return false;
  if (QUICK[engine].has(args[0])) return true;
  return args.slice(0, 6).some((a) => a.startsWith('-') && HELP_ANYWHERE.has(a)) && !args.some((a) => a === '-p' || a === '--print');
}

function basename(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

/** O processo é o claude/codex (lançador Node, binário nativo ou process.title)? Devolve a ferramenta e os argumentos. */
export function classifyArgv(argv: readonly string[]): { engine: AgentEngine; args: string[] } | undefined {
  if (!argv.length) return undefined;
  const a0 = argv[0];
  const base = basename(a0);
  // binário nativo (o claude 2.1 é um ELF .../claude-code/bin/claude.exe; o codex tem o vendorizado) ou process.title
  if (base === 'claude' || base === 'codex' || base === 'claude.exe') return { engine: base === 'codex' ? 'codex' : 'claude', args: argv.slice(1) };
  if (base.startsWith('node') && argv.length > 1) {
    const script = argv[1];
    const sb = basename(script);
    if (sb === 'claude' || script.includes('@anthropic-ai/claude-code/')) return { engine: 'claude', args: argv.slice(2) };
    if (sb === 'codex' || sb === 'codex.js' || script.includes('@openai/codex/')) return { engine: 'codex', args: argv.slice(2) };
  }
  if (a0.includes('/@openai/codex') || a0.includes('/codex-linux')) return { engine: 'codex', args: argv.slice(1) };
  if (a0.includes('/@anthropic-ai/claude-code')) return { engine: 'claude', args: argv.slice(1) };
  return undefined;
}

export interface ProcInfo {
  ppid: number;
  argv: string[];
}

/** Sessões de agente top-level na tabela de processos (pid -> info). */
export function agentPids(procs: ReadonlyMap<number, ProcInfo>): number[] {
  const isAgentProc = (pid: number) => {
    const p = procs.get(pid);
    return !!p && classifyArgv(p.argv) !== undefined;
  };
  const hasAgentAncestor = (pid: number) => {
    const seen = new Set<number>();
    let cur = procs.get(pid)?.ppid ?? 0;
    while (cur > 1 && !seen.has(cur)) {
      seen.add(cur);
      if (isAgentProc(cur)) return true;
      cur = procs.get(cur)?.ppid ?? 0;
    }
    return false;
  };
  const out: number[] = [];
  for (const [pid, p] of procs) {
    const c = classifyArgv(p.argv);
    if (!c || isQuickCommand(c.engine, c.args) || hasAgentAncestor(pid)) continue;
    out.push(pid);
  }
  return out.sort((a, b) => a - b);
}

/** Lê /proc (Linux). Fora do Linux, mapa vazio. */
export function readProcs(root = '/proc'): Map<number, ProcInfo> {
  const out = new Map<number, ProcInfo>();
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return out;
  }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`${root}/${name}/stat`, 'latin1');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      const raw = readFileSync(`${root}/${name}/cmdline`, 'utf8').replace(/\0+$/, '');
      out.set(Number(name), { ppid: Number.isSafeInteger(ppid) ? ppid : 0, argv: raw ? raw.split('\0') : [] });
    } catch {
      // processo saiu no meio da leitura
    }
  }
  return out;
}

/** O processo ainda existe? */
export function pidAlive(pid: number, root = '/proc'): boolean {
  try {
    readFileSync(`${root}/${pid}/stat`, 'latin1');
    return true;
  } catch {
    return false;
  }
}
