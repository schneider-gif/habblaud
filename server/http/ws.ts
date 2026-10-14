// WebSocket mínimo (RFC 6455) só para o terminal embutido: o servidor não tem dependências de runtime e o pacote da
// release (tgz) não leva node_modules. Cobre o que o navegador usa: handshake, quadros de texto/binário (com
// fragmentação), ping/pong e close. Sem extensões (permessage-deflate) e sem subprotocolos.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
/** Maior mensagem aceita do navegador (teclas, colar, resize): bem acima de um colar grande. */
export const WS_MAX_MESSAGE = 1024 * 1024;

/** Recusa o upgrade com uma resposta HTTP simples e fecha o socket. */
export function rejectUpgrade(socket: Duplex, status: number, message: string): void {
  const reason = status === 403 ? 'Forbidden' : status === 404 ? 'Not Found' : status === 400 ? 'Bad Request' : 'Error';
  const body = `${message}\n`;
  try {
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n` +
        `Cache-Control: no-store\r\nConnection: close\r\n\r\n${body}`,
    );
  } catch {
    socket.destroy();
  }
}

export function acceptKey(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

/** Monta um quadro do servidor (nunca mascarado). */
export function encodeFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const len = payload.length;
  let head: Buffer;
  if (len < 126) {
    head = Buffer.alloc(2);
    head[1] = len;
  } else if (len < 65536) {
    head = Buffer.alloc(4);
    head[1] = 126;
    head.writeUInt16BE(len, 2);
  } else {
    head = Buffer.alloc(10);
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(len), 2);
  }
  head[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([head, payload]);
}

export interface WsConnection extends EventEmitter {
  on(event: 'text', cb: (text: string) => void): this;
  on(event: 'binary', cb: (data: Buffer) => void): this;
  on(event: 'close', cb: (code: number) => void): this;
  sendText(text: string): void;
  sendBinary(data: Buffer): void;
  close(code?: number, reason?: string): void;
  readonly closed: boolean;
  /** Bytes esperando para sair (contrapressão do terminal). */
  readonly buffered: number;
}

class Connection extends EventEmitter implements WsConnection {
  closed = false;
  private buf: Buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private fragOpcode = 0;
  private fragSize = 0;

  constructor(private readonly socket: Duplex) {
    super();
    socket.on('data', (chunk: Buffer) => this.onData(chunk));
    socket.on('close', () => this.finish(1006));
    socket.on('error', () => this.finish(1006));
  }

  get buffered(): number {
    return (this.socket as unknown as { writableLength?: number }).writableLength ?? 0;
  }

  sendText(text: string): void {
    this.write(encodeFrame(0x1, Buffer.from(text, 'utf8')));
  }

  sendBinary(data: Buffer): void {
    this.write(encodeFrame(0x2, data));
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    const r = Buffer.from(reason.slice(0, 100), 'utf8');
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0);
    r.copy(p, 2);
    this.write(encodeFrame(0x8, p));
    this.finish(code);
    this.socket.end();
  }

  private write(frame: Buffer): void {
    if (this.closed) return;
    try {
      this.socket.write(frame);
    } catch {
      this.finish(1006);
    }
  }

  private finish(code: number): void {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code);
  }

  private fail(code: number): void {
    this.close(code);
    this.socket.destroy();
  }

  private onData(chunk: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    while (!this.closed) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      if (b0 & 0x70) return this.fail(1002); // RSV sem extensão negociada
      const opcode = b0 & 0x0f;
      const masked = (b1 & 0x80) !== 0;
      if (!masked) return this.fail(1002); // o cliente sempre mascara
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        const big = this.buf.readBigUInt64BE(2);
        if (big > BigInt(WS_MAX_MESSAGE)) return this.fail(1009);
        len = Number(big);
        off = 10;
      }
      if (len > WS_MAX_MESSAGE) return this.fail(1009);
      if (this.buf.length < off + 4 + len) return;
      const mask = this.buf.subarray(off, off + 4);
      const payload = Buffer.from(this.buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buf = this.buf.subarray(off + 4 + len);
      if (opcode >= 0x8) {
        if (!fin || len > 125) return this.fail(1002);
        if (opcode === 0x8) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1000;
          this.close(code === 1005 || code === 1006 ? 1000 : code);
          return;
        }
        if (opcode === 0x9) this.write(encodeFrame(0xa, payload));
        continue; // pong: nada a fazer
      }
      if (opcode === 0x0) {
        if (!this.fragOpcode) return this.fail(1002);
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.fragOpcode) return this.fail(1002);
        this.fragOpcode = opcode;
      } else return this.fail(1002);
      this.fragSize += payload.length;
      if (this.fragSize > WS_MAX_MESSAGE) return this.fail(1009);
      this.fragments.push(payload);
      if (!fin) continue;
      const data = this.fragments.length === 1 ? this.fragments[0] : Buffer.concat(this.fragments);
      const kind = this.fragOpcode;
      this.fragments = [];
      this.fragOpcode = 0;
      this.fragSize = 0;
      if (kind === 0x1) this.emit('text', data.toString('utf8'));
      else this.emit('binary', data);
    }
  }
}

/**
 * Faz o handshake (quem chama já conferiu Host/Origin e a trava do recurso). Devolve undefined (e responde 400) se o
 * pedido não for um upgrade WebSocket válido.
 */
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer): WsConnection | undefined {
  const key = req.headers['sec-websocket-key'];
  const upgrade = String(req.headers.upgrade ?? '').toLowerCase();
  if (req.method !== 'GET' || upgrade !== 'websocket' || typeof key !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(key) || req.headers['sec-websocket-version'] !== '13') {
    rejectUpgrade(socket, 400, 'esperado um upgrade WebSocket (versão 13)');
    return undefined;
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' + `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );
  const s = socket as Duplex & { setNoDelay?: (v: boolean) => void; setTimeout?: (ms: number) => void };
  s.setNoDelay?.(true);
  s.setTimeout?.(0);
  const conn = new Connection(socket);
  if (head.length) socket.unshift(head);
  return conn;
}
