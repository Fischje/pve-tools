import test from 'node:test';
import assert from 'node:assert/strict';
import { magicPacket, sendWol, macFromArp, parseNetinfo } from '../src/wol.js';

test('Magic Packet: 6 × FF und 16 × die MAC-Adresse', () => {
  const p = magicPacket('A8-A1-59-12-34-56');
  assert.equal(p.length, 102);
  assert.ok(p.subarray(0, 6).every((b) => b === 0xff));
  for (let i = 0; i < 16; i++) assert.deepEqual([...p.subarray(6 + i * 6, 12 + i * 6)], [0xa8, 0xa1, 0x59, 0x12, 0x34, 0x56]);
  assert.throws(() => magicPacket('a8:a1:59:12:34'), /MAC/);
  assert.throws(() => magicPacket('zz:a1:59:12:34:56'), /MAC/);
});

test('Senden: dreimal je Broadcast-Adresse, mit Broadcast-Erlaubnis', async () => {
  const sent = []; let bc = false, closed = false;
  const fake = { once() {}, bind(_p, cb) { cb(); }, setBroadcast(v) { bc = v; }, send(buf, port, host, cb) { sent.push([buf.length, port, host]); cb(); }, close() { closed = true; } };
  const r = await sendWol('a8:a1:59:12:34:56', { broadcast: '255.255.255.255, 192.168.1.255', socketFactory: () => fake });
  assert.equal(r.packets, 6); assert.equal(bc, true); assert.equal(closed, true);
  assert.deepEqual(sent[0], [102, 9, '255.255.255.255']); assert.deepEqual(sent[1], [102, 9, '192.168.1.255']);
});

test('MAC aus ARP-Tabelle und aus dem Prüfskript', () => {
  const arp = 'IP address       HW type     Flags       HW address            Mask     Device\n192.168.1.3      0x1         0x2         a8:a1:59:12:34:56     *        eth0\n192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        eth0\n';
  assert.equal(macFromArp('192.168.1.3', arp), 'a8:a1:59:12:34:56');
  assert.equal(macFromArp('192.168.1.9', arp), null, 'unvollständiger Eintrag zählt nicht');
  assert.equal(macFromArp('192.168.1.4', arp), null);
  assert.deepEqual(parseNetinfo('dev=vmbr0\nphys=enp3s0\nmac=a8:a1:59:12:34:56\nwol=g\n'), { dev: 'vmbr0', phys: 'enp3s0', mac: 'a8:a1:59:12:34:56', wol: 'g' });
  assert.equal(parseNetinfo('mac=kaputt').mac, undefined);
});
