import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize } from '../src/smart.js';
import { rate } from '../src/rating.js';
import * as fx from '../src/demo/fixtures.js';

const r = (json, opts) => rate(normalize(json), opts);
const codes = (res) => res.findings.map((f) => f.code);

test('gesunde Exos: Gesund, Score 100', () => {
  const res = r(fx.exos12());
  assert.equal(res.level, 'ok');
  assert.equal(res.score, 100);
  assert.deepEqual(codes(res), ['all-good']);
});

test('normalize: Typ, Kapazität, Testdauern, selektive Tests', () => {
  const d = normalize(fx.exos12());
  assert.equal(d.kind, 'hdd');
  assert.equal(d.serial, 'ZL2M2KFZ');
  assert.equal(d.selftest.pollingExtended, 1079);
  assert.equal(d.selftest.selective, true);
  assert.equal(d.totalLba, 23437770752);
  assert.equal(normalize(fx.wdSsd86()).kind, 'ssd');
  assert.equal(normalize(fx.nvme()).kind, 'nvme');
});

test('Seagate-Fall: Lesefehler im Langtest => Bald tauschen, CRC-Hinweis auf Kabel', () => {
  const res = r(fx.seagateDefekt());
  assert.equal(res.level, 'replace');
  assert.ok(codes(res).includes('test-failed'));
  assert.ok(codes(res).includes('uncorrect'));
  const crc = res.findings.find((f) => f.code === 'crc');
  assert.ok(crc, 'CRC-Befund fehlt');
  assert.match(crc.advice, /Kabel/);
  assert.ok(res.score <= 45);
});

test('Seagate-Fall: steigende umgelagerte Sektoren sind ebenfalls Bald tauschen', () => {
  const res = r(fx.exos12({ reallocated: 16 }), { baseline: { reallocated: 10 } });
  assert.equal(res.level, 'replace');
  assert.ok(codes(res).includes('realloc-rising'));
});

test('umgelagerte Sektoren stabil => nur Beobachten', () => {
  const res = r(fx.exos12({ reallocated: 16 }), { baseline: { reallocated: 16 } });
  assert.equal(res.level, 'watch');
});

test('wartende/nicht korrigierbare Sektoren => Kritisch', () => {
  assert.equal(r(fx.exos12({ pending: 1 })).level, 'critical');
  assert.equal(r(fx.exos12({ uncorrectable: 2 })).level, 'critical');
});

test('SMART FAILED => Kritisch', () => {
  assert.equal(r(fx.exos12({ passed: false })).level, 'critical');
});

test('CRC steigt => Beobachten (nicht Tauschen)', () => {
  const res = r(fx.exos12({ crc: 50 }), { baseline: { crc: 10 } });
  assert.equal(res.level, 'watch');
});

test('WD-SSD im router: 86 % verbraucht => Bald tauschen, sonst keine Defekte', () => {
  const res = r(fx.wdSsd86());
  assert.equal(res.level, 'replace');
  assert.equal(res.wearUsed, 86);
  assert.equal(res.remainingLife, 14);
  assert.match(res.findings[0].text, /Restlebensdauer 14/);
  assert.ok(codes(res).includes('power-loss'));
  assert.equal(res.score, 14);
});

test('SSD-Stufen nach Restlebensdauer', () => {
  assert.equal(r(fx.wdSsd86({ wearValue: 8 })).level, 'critical');
  assert.equal(r(fx.wdSsd86({ wearValue: 35 })).level, 'watch');
  assert.equal(r(fx.wdSsd86({ wearValue: 70 })).level, 'ok');
});

test('NVMe: Lexar 2 % => Gesund, Ausgezeichnet', () => {
  const res = r(fx.nvme());
  assert.equal(res.level, 'ok');
  assert.equal(res.healthText, 'Ausgezeichnet');
});

test('NVMe-Stufen', () => {
  assert.equal(r(fx.nvme({ used: 75 })).level, 'watch');
  assert.equal(r(fx.nvme({ used: 92 })).level, 'replace');
  assert.equal(r(fx.nvme({ used: 100 })).level, 'critical');
  assert.equal(r(fx.nvme({ criticalWarning: 4 })).level, 'critical');
  assert.equal(r(fx.nvme({ spare: 3, spareThreshold: 5 })).level, 'critical');
  assert.equal(r(fx.nvme({ mediaErrors: 2 })).level, 'watch');
  assert.equal(r(fx.nvme({ mediaErrors: 5 }), { baseline: { mediaErrors: 2 } }).level, 'replace');
  assert.equal(r(fx.nvme({ temp: 75 })).level, 'watch');
});

test('Standby wird nicht bewertet und nicht als Fehler gezählt', () => {
  const res = r(fx.standby());
  assert.equal(res.level, 'unknown');
  assert.equal(res.findings[0].code, 'standby');
});

test('Altershinweis ab 30000 h ändert die Stufe nicht', () => {
  const res = r(fx.hdd6({ hours: 31000 }));
  assert.equal(res.level, 'ok');
  assert.ok(codes(res).includes('old'));
});

test('abgebrochener Test (Fensterende) ist kein Fehler', () => {
  const j = fx.exos12();
  j.ata_smart_self_test_log.standard.table.unshift(fx.ataLogEntry('extended', 2, 11990));
  assert.equal(r(j).level, 'ok');
});

test('früherer Fehlschlag mit späterem Erfolg => Beobachten', () => {
  const j = fx.exos12();
  j.ata_smart_self_test_log.standard.table = [fx.ataLogEntry('extended', 0, 11900), fx.ataLogEntry('extended', 7, 8000)];
  const res = r(j);
  assert.equal(res.level, 'watch');
  assert.ok(codes(res).includes('test-failed-old'));
});

test('Hinweis, wenn der letzte Langtest lange zurückliegt', () => {
  const res = r(fx.wdSsd86());
  assert.ok(codes(res).includes('long-old'));
});

test('ein später abgebrochener Test überdeckt einen früheren Fehlschlag nicht', () => {
  const j = fx.exos12();
  j.ata_smart_self_test_log.standard.table = [fx.ataLogEntry('extended', 2, 11990), fx.ataLogEntry('extended', 7, 11000), fx.ataLogEntry('extended', 0, 8000)];
  const res = r(j);
  assert.equal(res.level, 'replace');
  assert.ok(codes(res).includes('test-failed'));
});

test('Einschaltvorgänge, geschriebene Datenmenge und unsaubere Abschaltungen werden gelesen', () => {
  const n = normalize(fx.nvme({ unsafe: 137 }));
  assert.equal(n.powerCycles, 40);
  assert.equal(n.bytesWritten, 20000000 * 512000); // 10,24 TB
  assert.equal(n.unsafeShutdowns, 137);
  const ssd = normalize(fx.wdSsd86());
  assert.equal(ssd.powerCycles, 198);
  assert.equal(ssd.bytesWritten, 44780 * 2 ** 30); // Host_Writes_GiB
  assert.equal(ssd.unsafeShutdowns, 99);
  const hdd = fx.exos12(); hdd.ata_smart_attributes.table.push({ id: 241, name: 'Total_LBAs_Written', value: 100, worst: 100, thresh: 0, when_failed: '', raw: { value: 1000000, string: '1000000' } });
  assert.equal(normalize(hdd).bytesWritten, 1000000 * 512);
  assert.equal(normalize(fx.hdd6()).bytesWritten, null, 'ohne passendes Attribut: unbekannt statt geraten');
});
