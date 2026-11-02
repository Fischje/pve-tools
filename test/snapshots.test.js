import test from 'node:test';
import assert from 'node:assert/strict';
import { lastSlots, dueSnapshots, nextSlots } from '../src/snapshots.js';

const d = (y, mo, da, h = 0, mi = 0) => new Date(y, mo - 1, da, h, mi, 0);

test('Zeitpunkte: letzter stündlicher, wöchentlicher und monatlicher Slot', () => {
  const s = lastSlots(d(2026, 11, 4, 14, 20), 1); // Mittwoch
  assert.deepEqual(s.hourly, d(2026, 11, 4, 14, 5));
  assert.deepEqual(s.weekly, d(2026, 11, 1, 0, 25)); // Sonntag
  assert.deepEqual(s.monthly, d(2026, 11, 1, 0, 45)); // Sonntag, kein Pausentag
  assert.deepEqual(lastSlots(d(2026, 11, 4, 14, 3), 1).hourly, d(2026, 11, 4, 13, 5));
});

test('Ist der 1. der Pausentag (Montag), läuft der Monatslauf am 2.', () => {
  assert.deepEqual(lastSlots(d(2027, 2, 10, 12, 0), 1).monthly, d(2027, 2, 2, 0, 45));
  assert.deepEqual(lastSlots(d(2027, 2, 1, 12, 0), 1).monthly, d(2027, 1, 1, 0, 45)); // am 1. selbst (Montag) noch nicht fällig
  assert.deepEqual(nextSlots(d(2027, 1, 20, 12, 0), 1).monthly, d(2027, 2, 2, 0, 45));
});

test('fällig: stündlich im laufenden Slot, nicht doppelt, nicht am Pausentag, nicht kurz nach dem Hochfahren', () => {
  const now = d(2026, 11, 4, 14, 10); // Mittwoch
  const last = { weekly: { ts: d(2026, 11, 1, 0, 26).getTime(), ok: true }, monthly: { ts: d(2026, 11, 1, 0, 46).getTime(), ok: true } };
  assert.deepEqual(dueSnapshots(now, { pauseDay: 1, last, uptimeSec: 7200 }).map((x) => x.label), ['hourly']);
  const done = { ...last, hourly: { ts: d(2026, 11, 4, 14, 6).getTime(), ok: true } };
  assert.deepEqual(dueSnapshots(now, { pauseDay: 1, last: done, uptimeSec: 7200 }), []);
  assert.deepEqual(dueSnapshots(d(2026, 11, 2, 14, 10), { pauseDay: 1, last, uptimeSec: 7200 }), [], 'Montag ist Pausentag');
  assert.deepEqual(dueSnapshots(now, { pauseDay: 1, last, uptimeSec: 120 }), [], 'Container laufen noch nicht');
  assert.deepEqual(dueSnapshots(now, { pauseDay: 1, enabled: false, last, uptimeSec: 7200 }), [], 'Schalter aus');
});

test('verpasste Wochen-/Monatsläufe werden nachgeholt, verpasste Stundenläufe nicht', () => {
  // Host war nachts aus und läuft seit 08:00; letzter Lauf des Tools war vor einer Woche.
  const now = d(2026, 11, 4, 8, 40);
  const old = { weekly: { ts: d(2026, 10, 25, 0, 26).getTime(), ok: true }, monthly: { ts: d(2026, 10, 1, 0, 46).getTime(), ok: true }, hourly: { ts: d(2026, 11, 3, 21, 6).getTime(), ok: true } };
  const due = dueSnapshots(now, { pauseDay: 1, last: old, uptimeSec: 2400 });
  assert.deepEqual(due.map((x) => x.label).sort(), ['hourly', 'monthly', 'weekly']);
  assert.equal(due.find((x) => x.label === 'monthly').force, true, 'Monat wird mit force ausgelöst, sonst blockt das Datumsfenster im autosnap-Skript');
  // Der stündliche Slot von 08:05 ist um 09:04 schon fast eine Stunde her: Lauf wurde für ihn erledigt, der nächste Slot (09:05) ist noch nicht da.
  assert.ok(!dueSnapshots(d(2026, 11, 4, 9, 4), { pauseDay: 1, last: { ...old, hourly: { ts: d(2026, 11, 4, 8, 6).getTime(), ok: true } }, uptimeSec: 7200 }).some((x) => x.label === 'hourly'));
});

test('Fehlschlag: erst nach 15 Minuten erneut versuchen', () => {
  const now = d(2026, 11, 4, 14, 20);
  const last = { weekly: { ts: d(2026, 11, 1, 0, 26).getTime(), ok: true }, monthly: { ts: d(2026, 11, 1, 0, 46).getTime(), ok: true } };
  assert.equal(dueSnapshots(now, { last: { ...last, hourly: { ts: d(2026, 11, 4, 14, 8).getTime(), ok: false } }, uptimeSec: 9999 }).some((x) => x.label === 'hourly'), false);
  assert.equal(dueSnapshots(d(2026, 11, 4, 14, 30), { last: { ...last, hourly: { ts: d(2026, 11, 4, 14, 8).getTime() - 3600e3, ok: false } }, uptimeSec: 9999 }).some((x) => x.label === 'hourly'), true);
});
