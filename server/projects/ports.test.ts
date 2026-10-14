import { describe, expect, it } from 'vitest';
import { listeningSockets, portsByDir } from './ports';

const TCP = [
  '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
  '   0: 0100007F:A3D1 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5551 1 0000000000000000 100 0 0 10 0',
  '   1: 0100007F:1F90 0100007F:D2A0 01 00000000:00000000 00:00000000 00000000  1000        0 5552 1 0000000000000000 20 4 30 10 -1',
  '   2: 00000000:1287 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 5553 1 0000000000000000 100 0 0 10 0',
].join('\n');

describe('portas por projeto (/proc)', () => {
  it('listeningSockets: só LISTEN (0A), porta em hexadecimal → inode', () => {
    expect(listeningSockets(TCP)).toEqual(new Map([['5551', 41937], ['5553', 4743]]));
  });
  it('portsByDir: porta → pasta do processo dono do socket; nunca uma porta fixa', () => {
    const sockets = listeningSockets(TCP);
    const procs = [
      { cwd: '/h/projetos/minha-api', inodes: ['5551'] },
      { cwd: '/h/projetos/minha-api-2', inodes: ['5553'] },
      { cwd: '/h/outro', inodes: ['9999'] },
    ];
    const m = portsByDir(['/h/projetos/minha-api', '/h/projetos/meu-site'], sockets, procs);
    expect(m.get('/h/projetos/minha-api')).toEqual([41937]);
    expect(m.get('/h/projetos/meu-site')).toEqual([]);
  });
});
