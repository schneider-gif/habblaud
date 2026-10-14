// Portas TCP escutando por pasta de projeto, lidas do /proc (Linux). Nada de porta fixa: vários escritórios
// (VMs ou contêineres no mesmo host) rodam lado a lado, então cada projeto usa a porta que o agente escolher e o
// Habblaud só descobre qual é, mapeando socket → processo → pasta (cwd). Fora do Linux, nada é encontrado.
import { readdir, readFile, readlink } from 'node:fs/promises';
import { inside } from '../missions/detect';

/** Sockets em LISTEN de /proc/net/tcp{,6}: inode → porta. */
export function listeningSockets(text: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 10 || cols[3] !== '0A') continue;
    const port = parseInt(cols[1].split(':').pop() ?? '', 16);
    if (Number.isInteger(port) && port > 0 && cols[9] !== '0') out.set(cols[9], port);
  }
  return out;
}

export interface ProcSockets {
  cwd: string;
  /** Inodes dos sockets abertos pelo processo. */
  inodes: readonly string[];
}

/** Portas por pasta: cada processo com cwd dentro da pasta empresta as portas dos seus sockets em LISTEN. */
export function portsByDir(dirs: readonly string[], sockets: ReadonlyMap<string, number>, procs: readonly ProcSockets[]): Map<string, number[]> {
  const out = new Map<string, number[]>(dirs.map((d) => [d, []]));
  for (const p of procs) {
    const ports = p.inodes.map((i) => sockets.get(i)).filter((n): n is number => n !== undefined);
    if (!ports.length) continue;
    for (const d of dirs) if (inside(p.cwd, d)) out.get(d)!.push(...ports);
  }
  for (const [d, ports] of out) out.set(d, [...new Set(ports)].sort((a, b) => a - b));
  return out;
}

/** Lê o /proc do usuário atual (processos de outros usuários dão erro e ficam de fora). Máx. 4000 processos. */
export async function listeningPortsByDir(dirs: readonly string[]): Promise<Map<string, number[]>> {
  if (process.platform !== 'linux' || !dirs.length) return new Map(dirs.map((d) => [d, []]));
  const sockets = new Map<string, number>();
  for (const f of ['/proc/net/tcp', '/proc/net/tcp6']) {
    try {
      for (const [k, v] of listeningSockets(await readFile(f, 'utf8'))) sockets.set(k, v);
    } catch {
      // sem IPv6 ou sem /proc
    }
  }
  if (!sockets.size) return new Map(dirs.map((d) => [d, []]));
  const procs: ProcSockets[] = [];
  let pids: string[] = [];
  try {
    pids = (await readdir('/proc')).filter((n) => /^\d+$/.test(n)).slice(0, 4000);
  } catch {
    // sem /proc
  }
  for (const pid of pids) {
    try {
      const cwd = await readlink(`/proc/${pid}/cwd`);
      if (!dirs.some((d) => inside(cwd, d))) continue;
      const inodes: string[] = [];
      for (const fd of await readdir(`/proc/${pid}/fd`)) {
        const m = /^socket:\[(\d+)\]$/.exec(await readlink(`/proc/${pid}/fd/${fd}`).catch(() => ''));
        if (m) inodes.push(m[1]);
      }
      procs.push({ cwd, inodes });
    } catch {
      // processo sumiu ou é de outro usuário
    }
  }
  return portsByDir(dirs, sockets, procs);
}
