import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { NameStore } from './names';
import { Office } from './office';
import { cleanRoomName, RoomLabelStore, RoomNameError } from './room-labels';

function makeOffice(roomLabels?: RoomLabelStore) {
  const clock = 1_000_000;
  return new Office({
    names: new NameStore(null),
    roomLabels,
    version: 't',
    startedAt: clock,
    accounts: () => [],
    sources: () => [],
    accountName: () => 'Conta C',
    now: () => clock,
  });
}

describe('nomes de sala', () => {
  it('cleanRoomName: apara, junta espaços, tira controle; vazio volta ao nome da pasta', () => {
    expect(cleanRoomName('  Loja   da\tAna \n')).toBe('Loja da Ana');
    expect(cleanRoomName('a\u0000b')).toBe('ab');
    expect(cleanRoomName('   ')).toBe('');
    expect(cleanRoomName('ç'.repeat(40))).toBe('ç'.repeat(40));
    expect(() => cleanRoomName('x'.repeat(41))).toThrow(RoomNameError);
    expect(() => cleanRoomName(3)).toThrow(RoomNameError);
  });

  it('RoomLabelStore grava em rooms.json, relê e apaga com nome vazio', () => {
    const f = join(tempDir().dir, 'dados', 'rooms.json');
    const s = new RoomLabelStore(f);
    s.load();
    s.set('/home/u/projetos/meu-site', 'Site da padaria');
    s.set('/home/u/projetos/jogo-pixel', 'Jogo');
    s.set('/home/u/projetos/jogo-pixel', '');
    expect(JSON.parse(readFileSync(f, 'utf8'))).toEqual({ version: 1, names: { '/home/u/projetos/meu-site': 'Site da padaria' } });
    const again = new RoomLabelStore(f);
    again.load();
    expect(again.get('/home/u/projetos/meu-site')).toBe('Site da padaria');
    expect(again.get('/home/u/projetos/jogo-pixel')).toBeUndefined();
  });

  it('RoomLabelStore: arquivo corrompido ou com lixo = sem nomes', () => {
    const f = join(tempDir().dir, 'rooms.json');
    writeFileSync(f, '{nao é json');
    const s = new RoomLabelStore(f);
    s.load();
    expect(s.get('/x')).toBeUndefined();
    writeFileSync(f, JSON.stringify({ version: 1, names: { '/a': 3, '/b': ' ', '/c': 'Certo' } }));
    s.load();
    expect([s.get('/a'), s.get('/b'), s.get('/c')]).toEqual([undefined, undefined, 'Certo']);
  });

  it('Office.renameRoom: só sala que existe; o nome vale no snapshot e nos avisos; vazio volta ao da pasta', () => {
    const office = makeOffice(new RoomLabelStore(null));
    expect(office.renameRoom('/p/loja', 'Loja')).toBe(false);
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/loja/', role: 'x', startedAt: 1_000_000, status: 'working' });
    office.commit();
    expect(office.renameRoom('/p/loja', 'Loja da Ana')).toBe(true);
    let r = office.commit();
    expect(r.changed).toBe(true);
    expect(r.snapshot.rooms.find((x) => x.id === '/p/loja')?.name).toBe('Loja da Ana');
    expect(office.roomName('/p/loja')).toBe('Loja da Ana');
    office.renameRoom('/p/loja', '');
    r = office.commit();
    expect(r.snapshot.rooms.find((x) => x.id === '/p/loja')?.name).toBe('loja');
  });

  it('Office sem RoomLabelStore não renomeia', () => {
    const office = makeOffice();
    office.addMain({ id: 'acc:1', account: 'acc', sessionId: 's1', cwd: '/p/loja', role: 'x', startedAt: 1_000_000, status: 'working' });
    expect(office.renameRoom('/p/loja', 'Loja')).toBe(false);
  });
});
