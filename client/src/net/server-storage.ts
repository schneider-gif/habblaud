// Armazenamento da vida social no servidor (GET/PUT /api/state): carteiras, placares, barrinhas e vínculos valem em
// qualquer navegador. Interface igual à do localStorage (StorageLike) para Wallets/Needs não mudarem.
// O que já estava no navegador sobe para o servidor na primeira vez; o navegador continua como cópia de segurança.
import { browserStorage, type StorageLike } from '../world/social/wallet';

const KEYS = ['habblaud.wallets.v1', 'habblaude.needs.v1', 'habblaude.social.v1'] as const;
const PUSH_DELAY_MS = 1_500;

export class ServerStorage implements StorageLike {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly cache: Record<string, string>,
    private readonly local: StorageLike | null,
  ) {
    for (const k of KEYS) {
      if (cache[k] !== undefined) continue;
      const v = local?.getItem(k);
      if (v) this.setItem(k, v); // migração: sobe o que só existia neste navegador
    }
  }

  getItem(key: string): string | null {
    return this.cache[key] ?? null;
  }

  setItem(key: string, value: string): void {
    this.cache[key] = value;
    try {
      this.local?.setItem(key, value);
    } catch {
      // navegador cheio/bloqueado: o servidor basta
    }
    if (!(KEYS as readonly string[]).includes(key)) return;
    clearTimeout(this.timers.get(key));
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void fetch('/api/state', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value }) }).catch(() => undefined);
      }, PUSH_DELAY_MS),
    );
  }
}

/** Lê o estado do servidor (até 2,5 s); sem servidor, fica com o localStorage como antes. */
export async function loadSharedStorage(): Promise<StorageLike | null> {
  const local = browserStorage();
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 2_500);
    const r = await fetch('/api/state', { cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    if (!r.ok) return local;
    const data = (await r.json()) as Record<string, unknown>;
    const cache: Record<string, string> = {};
    for (const [k, v] of Object.entries(data)) if (typeof v === 'string') cache[k] = v;
    return new ServerStorage(cache, local);
  } catch {
    return local;
  }
}
