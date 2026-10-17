// Estado da vida social salvo no servidor (carteiras, placares, barrinhas e vínculos escolhidos), para valer em
// qualquer navegador. O cliente lê tudo em GET /api/state ao abrir e grava cada chave em PUT /api/state.
// Guarda o texto JSON de cada chave como veio (o formato é do cliente), só com chave fixa e limite de tamanho.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';

/** Chaves aceitas (mesmos nomes do localStorage do cliente). */
export const STATE_KEYS = ['habblaud.wallets.v1', 'habblaude.needs.v1', 'habblaude.social.v1'] as const;
/**
 * Chaves que só o servidor grava (o PUT /api/state recusa): decisões que a página não pode desfazer sozinha, como
 * o cartão de boas-vindas já pulado (server/welcome/welcome.ts). Vão no mesmo arquivo e no GET.
 */
export const SERVER_STATE_KEYS = ['habblaud.boasvindas.v1'] as const;
export type ServerStateKey = (typeof SERVER_STATE_KEYS)[number];
export type StateKey = (typeof STATE_KEYS)[number] | ServerStateKey;
const ALL_KEYS: readonly StateKey[] = [...STATE_KEYS, ...SERVER_STATE_KEYS];
/** Maior valor por chave (bytes do texto JSON). */
export const STATE_MAX_BYTES = 200 * 1024; // cabe no limite de corpo da API (256 KB)

export class StateError extends Error {}

export class StateStore {
  private data: Partial<Record<StateKey, string>> = {};
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      for (const k of ALL_KEYS) if (typeof j[k] === 'string') this.data[k] = j[k] as string;
    } catch {
      // primeira vez ou arquivo corrompido: começa vazio
    }
  }

  all(): Partial<Record<StateKey, string>> {
    return { ...this.data };
  }

  set(key: unknown, value: unknown): void {
    if (typeof key !== 'string' || !(STATE_KEYS as readonly string[]).includes(key)) throw new StateError('chave desconhecida');
    if (typeof value !== 'string') throw new StateError('valor precisa ser texto JSON');
    if (Buffer.byteLength(value) > STATE_MAX_BYTES) throw new StateError('valor grande demais');
    try {
      JSON.parse(value);
    } catch {
      throw new StateError('valor não é JSON');
    }
    this.data[key as StateKey] = value;
    this.scheduleFlush();
  }

  /** Lê uma chave do servidor (texto JSON) ou undefined. */
  getServer(key: ServerStateKey): string | undefined {
    return this.data[key];
  }

  /** Grava uma chave que só o servidor controla (sem passar pela lista do PUT). */
  setServer(key: ServerStateKey, value: string): void {
    this.data[key] = value;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, 2_000);
    this.timer.unref?.();
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
      log.clearOnce('state-write');
    } catch (err) {
      log.warnOnce('state-write', `Não foi possível gravar ${this.file} (${errMsg(err)}); a vida social vale só nesta execução.`);
    }
  }
}
