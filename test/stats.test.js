import test from 'node:test';
import assert from 'node:assert/strict';
import { summarize } from '../src/stats.js';
import { openDb } from '../src/db.js';

const now = new Date(2026, 10, 15, 12, 0); // Sonntag, 15.11.2026
const at = (d, h = 10, m = 0) => new Date(2026, 10, d, h, m).getTime();
const run = (o) => ({ serial: 'A', hostId: 'pve', kind: 'short', started: at(10), ended: at(10, 10, 2), result: 'ok', completesLong: 0, ...o });
const disk = (o = {}) => ({ serial: 'A', hostId: 'pve', device: '/dev/sda', model: 'M', kind: 'hdd', level: 'ok', lastShortOk: at(10), lastLongOk: new Date(2026, 8, 1).toISOString(), temperature: 40, hours: 20000, capacityBytes: 12e12, wearUsed: null, ...o });

test('Summen, Erfolgsquote und laufende Tests', () => {
  const s = summarize({ now, disks: [disk()], runs: [run(), run({ result: 'failed' }), run({ result: 'interrupted' }), run({ result: 'running', ended: null })] });
  assert.equal(s.totals.runs, 4);
  assert.equal(s.totals.ok, 1);
  assert.equal(s.totals.failed, 1);
  assert.equal(s.totals.interrupted, 1);
  assert.equal(s.totals.running, 1);
  assert.equal(s.totals.successRate, 50); // nur beendete, bewertbare Läufe zählen (ok / (ok + fehlgeschlagen))
});

test('Kurz- und Langtests getrennt, Abschnitte zählen zu „long“, komplette Langtests separat', () => {
  const s = summarize({ now, disks: [disk()], runs: [run(), run({ kind: 'select', ended: at(10, 20), completesLong: 0 }), run({ kind: 'select', started: at(11), ended: at(11, 14), completesLong: 1 }), run({ kind: 'long', started: at(12), ended: at(12, 11), completesLong: 1 })] });
  assert.equal(s.byKind.short.n, 1);
  assert.equal(s.byKind.long.n, 3);
  assert.equal(s.totals.longCompleted, 2);
  assert.equal(s.duration.short.avgMin, 2);
  assert.equal(s.duration.segment.n, 2);
  assert.equal(s.duration.long.avgMin, 60);
});

test('zwölf Monate, Wochentag/Stunden-Verteilung', () => {
  const s = summarize({ now, disks: [], runs: [run({ started: at(10, 8, 30) }), run({ started: new Date(2026, 9, 6, 14).getTime(), ended: null })] });
  assert.equal(s.byMonth.length, 12);
  assert.equal(s.byMonth.at(-1).key, '2026-11');
  assert.equal(s.byMonth.at(-1).ok, 1);
  assert.equal(s.byMonth.at(-2).key, '2026-10');
  assert.equal(s.heatmap[new Date(2026, 10, 10).getDay()][8], 1); // Dienstag 08 Uhr
  assert.equal(s.heatmap.flat().reduce((a, b) => a + b, 0), 2);
});

test('Abdeckung: Tage seit dem letzten Test', () => {
  const s = summarize({ now, runs: [], disks: [disk({ lastShortOk: null }), disk({ serial: 'B', lastShortOk: new Date(2026, 10, 5).toISOString() })] });
  assert.equal(s.coverage[0].daysShort, null);
  assert.equal(s.coverage[1].daysShort, 10);
  assert.ok(s.coverage[1].daysLong > 60);
});

test('Plattenwerte und Stufen', () => {
  const s = summarize({ now, runs: [], disks: [disk(), disk({ serial: 'B', kind: 'nvme', level: 'watch', temperature: 60, hours: 4000, wearUsed: 10, capacityBytes: 4e12 })] });
  assert.deepEqual(s.disks.byKind, { hdd: 1, ssd: 0, nvme: 1 });
  assert.equal(s.disks.avgTemp, 50);
  assert.equal(s.disks.maxTemp, 60);
  assert.equal(s.disks.capacityBytes, 16e12);
  assert.equal(s.disks.avgWearUsed, 10);
  assert.equal(s.levels.watch, 1);
});

test('Zeitleiste: nur die letzten 14 Tage', () => {
  const s = summarize({ now, disks: [], runs: [run({ started: at(14) }), run({ started: new Date(2026, 9, 1).getTime() })] });
  assert.equal(s.timeline.length, 1);
});

test('Erfolgsquote ist nur 100, wenn es keinen Fehlschlag gab', () => {
  const runs = Array.from({ length: 335 }, () => run()).concat([run({ result: 'failed' })]);
  assert.equal(summarize({ now, disks: [], runs }).totals.successRate, 99.7);
  assert.equal(summarize({ now, disks: [], runs: runs.slice(0, 335) }).totals.successRate, 100);
});

test('leer: keine Division durch null', () => {
  const s = summarize({ now, disks: [], runs: [] });
  assert.equal(s.totals.successRate, null);
  assert.equal(s.duration.long.avgMin, null);
});

test('Datenbank: Migration ergänzt Spalten einer älteren Datenbank, Läufe und Tagestemperatur', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  // „Alte“ Datenbank ohne die neuen Spalten
  const old = new DatabaseSync(path.join(dir, 'disktool.sqlite'));
  old.exec("CREATE TABLE testrun (id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, host_id TEXT NOT NULL, kind TEXT NOT NULL, started INTEGER NOT NULL, ended INTEGER, lba_from INTEGER, lba_to INTEGER, hours_at_start INTEGER, result TEXT NOT NULL DEFAULT 'running', note TEXT, origin TEXT); INSERT INTO testrun(serial,host_id,kind,started,result) VALUES('X','h','short',1000,'ok');");
  old.close();
  const db = openDb(dir);
  const runs = db.allRuns(0);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].completesLong, 0);
  const id = db.addRun({ serial: 'X', hostId: 'h', kind: 'long', started: new Date(2026, 10, 1), plannedMinutes: 90 });
  db.markCompletesLong(id);
  assert.equal(db.allRuns(0).find((r) => r.id === id).completesLong, 1);
  db.upsertDisk('h', { serial: 'X', device: '/dev/sda', model: 'M', kind: 'hdd', capacityBytes: 1, totalLba: 1, selftest: { pollingShort: 1, pollingExtended: 2, selective: true, running: false, remainingPercent: null } }, new Date(), false);
  db.addSample('X', new Date(2026, 10, 1, 8), { temp: 30 }); db.addSample('X', new Date(2026, 10, 1, 9), { temp: 40 });
  const t = db.tempDaily('h', 0);
  assert.equal(t.length, 1);
  assert.equal(t[0].avg, 35);
  assert.equal(t[0].max, 40);
  db.close();
});
