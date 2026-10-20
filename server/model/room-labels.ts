// Nomes de sala escolhidos no escritório, persistidos por pasta em <dataDir>/rooms.json.
// Só o nome que aparece muda: a pasta, os agentes e o histórico do Claude continuam onde estão.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { errMsg, log } from '../log';

interface RoomsFile {
  version: 1;
  names: Record<string, string>;
}

export const ROOM_NAME_MAX = 40;

export class RoomNameError extends Error {}

/** Nome válido para a sala; '' = voltar ao nome da pasta. Lança RoomNameError se não servir. */
export function cleanRoomName(v: unknown): string {
  if (typeof v !== 'string') throw new RoomNameError('nome da sala inválido');
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/\s+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if ([...s].length > ROOM_NAME_MAX) throw new RoomNameError(`nome da sala com mais de ${ROOM_NAME_MAX} caracteres`);
  return s;
}

export class RoomLabelStore {
  private names = new Map<string, string>();

  /** `file` null = só em memória (testes ou diretório de dados indisponível). */
  constructor(private readonly file: string | null) {}

  load(): void {
    if (!this.file) return;
    try {
      const j = JSON.parse(readFileSync(this.file, 'utf8')) as Partial<RoomsFile>;
      for (const [path, name] of Object.entries(j.names ?? {})) if (typeof name === 'string' && name.trim()) this.names.set(path, name);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn(`rooms.json ilegível (${errMsg(err)}); salas com o nome da pasta.`);
    }
  }

  get(path: string): string | undefined {
    return this.names.get(path);
  }

  /** Grava o nome da sala da pasta `path`; '' apaga (volta ao nome da pasta). */
  set(path: string, name: string): void {
    if (name) this.names.set(path, name);
    else this.names.delete(path);
    this.flush();
  }

  private flush(): void {
    if (!this.file) return;
    const data: RoomsFile = { version: 1, names: Object.fromEntries(this.names) };
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(`${this.file}.tmp`, JSON.stringify(data, null, 2));
      renameSync(`${this.file}.tmp`, this.file);
    } catch (err) {
      log.warnOnce(`rooms-save:${errMsg(err)}`, `Não gravei ${this.file}: ${errMsg(err)}`);
    }
  }
}
