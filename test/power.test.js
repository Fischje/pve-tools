import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readTasmota, parseStatus8 } from '../src/tasmota.js';
import { dailyKwh, avgWatts, PowerMeters } from '../src/power.js';
import { openDb } from '../src/db.js';

const STATUS8 = { StatusSNS: { Time: '2026-11-21T14:00:00', ENERGY: { TotalStartTime: '2025-01-01T00:00:00', Total: 1234.567, Yesterday: 1.9, Today: 1.2, Power: 82, ApparentPower: 90, ReactivePower: 30, Factor: 0.91, Voltage: 231, Current: 0.39 } } };

test('Tasmota „Status 8“: Leistung und Zähler; Passwort wird mitgeschickt; Fehler verständlich', async () => {
  assert.deepEqual(parseStatus8(STATUS8), { power: 82, today: 1.2, yesterday: 1.9, total: 1234.567, voltage: 231, time: '2026-11-21T14:00:00' });
  assert.equal(parseStatus8({ StatusSNS: { ENERGY: { Power: [10, 5], Today: [0.1, 0.2], Yesterday: 0, Total: 3 } } }).power, 15, 'mehrkanalige Geräte: Summe');
  assert.throws(() => parseStatus8({ StatusSNS: { Time: 'x' } }), /Keine Energiewerte/);
  // echter HTTP-Weg gegen einen kleinen Server, der wie Tasmota antwortet
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); const u = new URL(req.url, 'http://x'); res.end(JSON.stringify(u.searchParams.get('password') === 'falsch' ? { WARNING: 'Need user=<username>&password=<password>' } : STATUS8)); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const addr = `127.0.0.1:${srv.address().port}`.replace(/:(\d+)$/, '');
  const get = (url, t) => new Promise((resolve, reject) => http.get(url.replace(`http://${addr}/`, `http://127.0.0.1:${srv.address().port}/`), { timeout: t }, (res) => { let d = ''; res.on('data', (c) => { d += c; }); res.on('end', () => resolve(d)); }).on('error', reject));
  assert.equal((await readTasmota('127.0.0.1', { get })).power, 82);
  await readTasmota('127.0.0.1', { password: 'geheim', get });
  assert.match(seen.at(-1), /cmnd=Status\+8&user=admin&password=geheim/);
  await assert.rejects(() => readTasmota('127.0.0.1', { password: 'falsch', get }), /Passwort fehlt oder ist falsch/);
  await assert.rejects(() => readTasmota('a;b', { get }), /Ungültige Adresse/);
  srv.close();
});

test('Tageswerte aus dem Zähler und mittlere Leistung', () => {
  const d = (h, m = 0) => new Date(2026, 10, 20, h, m).getTime();
  const s = [{ ts: d(0, 5), watts: 80, total: 100 }, { ts: d(12), watts: 100, total: 101 }, { ts: d(23, 55), watts: 60, total: 101.9 }, { ts: d(24, 5), watts: 70, total: 102 }];
  assert.deepEqual(dailyKwh(s), [{ day: '2026-11-20', kwh: 1.9 }, { day: '2026-11-21', kwh: 0.1 }]);
  // Zähler zurückgesetzt und unmöglicher Sprung: werden ignoriert
  const r = [{ ts: d(1), total: 50 }, { ts: d(2), total: 50.1 }, { ts: d(3), total: 0.05 }, { ts: d(4), total: 0.15 }, { ts: d(4, 5), total: 900 }, { ts: d(5), total: 900.1 }];
  assert.deepEqual(dailyKwh(r), [{ day: '2026-11-20', kwh: 0.3 }]);
  assert.equal(avgWatts(s, d(0), d(23, 59)), 80);
  assert.equal(avgWatts(s, d(30), d(31)), null);
});

test('Steckdosen speichern (nur lokales Netz, Passwort getrennt), jede Minute lesen, alle 5 Minuten speichern', async () => {
  let t = new Date(2026, 10, 21, 10, 0).getTime();
  const db = openDb(null);
  const engine = { db, hosts: [{ id: 'pve' }], now: () => new Date(t) };
  let w = 80;
  const pm = new PowerMeters(engine, { read: async (a, o) => { if (a === '10.0.0.9') throw new Error('nicht erreichbar'); return { power: w, today: 1, yesterday: 2, total: 100 + t / 3.6e9, pw: o.password }; }, resolve: async (a) => [a.startsWith('8.') ? a : a] });
  await assert.rejects(() => pm.save([{ id: 'x', address: '8.8.8.8' }]), /lokalen Netz/);
  await assert.rejects(() => pm.save([{ id: 'X Y', address: '10.0.0.5' }]), /Ungültige/);
  await assert.rejects(() => pm.save([{ id: 'a', address: '10.0.0.5', hostId: 'nope' }]), /Host unbekannt/);
  await assert.rejects(() => pm.save([], '99'), /Strompreis/);
  await pm.save([{ id: 'steckdose-pve', label: 'pve', address: '10.0.0.5', hostId: 'pve', password: 'geheim' }, { id: 'aus', address: '10.0.0.9' }], '0,32');
  assert.equal(pm.price(), 0.32);
  assert.ok(!JSON.parse(db.getSetting('power_meters')).some((m) => 'password' in m), 'Passwort nicht in der Liste');
  assert.equal(db.getSetting('power_pw:steckdose-pve'), 'geheim');
  for (let i = 0; i < 5; i++) { w = 80 + i * 10; await pm.tick(); t += 60000; }
  assert.equal(pm.latest.get('steckdose-pve').power, 120);
  assert.equal(pm.latest.get('aus').error, 'nicht erreichbar');
  const rows = db.powerSince('steckdose-pve', 0);
  assert.equal(rows.length, 1); assert.equal(rows[0].watts, 80, 'erster Wert gleich gespeichert');
  await pm.tick(); t += 60000;
  for (let i = 0; i < 4; i++) { await pm.tick(); t += 60000; }
  assert.equal(db.powerSince('steckdose-pve', 0).length, 2);
  await pm.save([{ id: 'steckdose-pve', label: 'pve', address: '10.0.0.5', hostId: 'pve' }]);
  assert.equal(db.getSetting('power_pw:steckdose-pve'), 'geheim', 'ohne neues Passwort bleibt das alte');
  assert.equal(db.getSetting('power_pw:aus'), null);
});
