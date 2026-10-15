// Aviso global da plataforma: lê um JSON central (HABBLAUD_ANNOUNCE_URL) a cada 10 min e põe o aviso no snapshot.
// Formato: {"id", "title", "body", "logo"?, "until"?, "confetti"?} ou {} / null para nenhum aviso.
// Quem decide quando mostrar é o cliente (aba visível e alguém usando; uma vez por navegador).
import type { Announcement } from '../../shared/types';
import { errMsg, log } from '../log';

export const POLL_EVERY_MS = 10 * 60_000;
const TIMEOUT_MS = 10_000;

/** Valida o JSON; `logo` só vale em https na mesma origem do JSON; vencido (`until`) = nenhum aviso. */
export function parseAnnouncement(raw: unknown, source: string, now: number): Announcement | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : undefined);
  const id = typeof o.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(o.id) ? o.id : undefined;
  const title = str(o.title, 120);
  const body = str(o.body, 400);
  if (!id || !title || !body) return undefined;
  if (typeof o.until === 'string') {
    const until = Date.parse(o.until);
    if (!Number.isFinite(until) || until <= now) return undefined;
  }
  let logo: string | undefined;
  try {
    const u = new URL(String(o.logo), source);
    if (o.logo && u.protocol === 'https:' && u.origin === new URL(source).origin) logo = u.href;
  } catch {
    // logo inválido: aviso sem imagem
  }
  return { id, title, body, logo, confetti: o.confetti !== false };
}

export class AnnouncementPoller {
  private current: Announcement | undefined;
  private raw: unknown;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly url: string | undefined,
    private readonly onChange: () => void,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  /** Recalcula a cada leitura: um aviso que vence some sem esperar a próxima consulta. */
  get(): Announcement | undefined {
    return this.url ? parseAnnouncement(this.raw, this.url, Date.now()) : undefined;
  }

  start(): void {
    if (!this.url) return;
    void this.poll();
    this.timer = setInterval(() => void this.poll(), POLL_EVERY_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async poll(): Promise<void> {
    try {
      const res = await this.fetchFn(this.url!, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.raw = await res.json();
      log.clearOnce('announce');
    } catch (err) {
      // Falha mantém o último aviso lido.
      log.warnOnce('announce', `Aviso global: leitura de ${this.url} falhou (${errMsg(err)}).`);
    }
    const next = this.get();
    if (JSON.stringify(next) !== JSON.stringify(this.current)) {
      this.current = next;
      this.onChange();
    }
  }
}
