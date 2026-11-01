import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../src/schedule.js';

// 2026-11-01 ist ein Sonntag. Monat 10 = November (JS zählt ab 0).
const t = (day, h, m = 0) => new Date(2026, 10, day, h, m);
const SUN = 1, MON = 2, TUE = 3, WED = 4, THU = 5;
const pve = { ...S.DEFAULT_SETTINGS };
const router = { ...S.DEFAULT_SETTINGS, window: { from: '00:00', to: '24:00' } };
const pbs = { ...S.DEFAULT_SETTINGS, mode: 'manuell', dayEnd: '19:00' };

const disk = (o = {}) => ({
  serial: 'A', device: '/dev/sda', kind: 'hdd', running: null, paused: false,
  pollingShort: 1, pollingExtended: 1079, selective: true, totalLba: 23437770752,
  lastShortOk: t(1, 12), lastLongOk: t(1, 12), longProgress: null, ...o,
});
const host = (disks, o = {}) => ({ reachable: true, uptimeSec: 7200, zfsBusy: false, todayRuns: {}, approval: {}, disks, ...o });
// Ein Datum weit in der Zukunft/Vergangenheit, damit etwas fällig ist:
const OLD = new Date(2026, 0, 5);

test('Datumsrechnung: Monatsende wird gekürzt', () => {
  assert.equal(S.addMonths(new Date(2026, 0, 31), 1).getDate(), 28);
  assert.equal(S.addMonths(new Date(2026, 10, 15), 3).getMonth(), 1); // Feb 2027
});

test('Fenster PVE: Dienstag 09:00 offen bis 18:30 (Sperrzeit ab 19:00 minus 30 min)', () => {
  const w = S.testWindow(t(TUE, 9), pve, 3600);
  assert.equal(w.open, true);
  assert.equal(w.softEnd.getHours() * 60 + w.softEnd.getMinutes(), 18 * 60 + 30);
  assert.equal(w.minutesLeft, 570);
});

test('Anlaufzeit nach dem Hochfahren: 08:10 noch zu', () => {
  const w = S.testWindow(t(TUE, 8, 10), pve, 600);
  assert.equal(w.open, false);
  assert.match(w.reason, /Anlaufzeit/);
});

test('vor 08:00 läuft der PVE laut Plan noch nicht', () => {
  assert.equal(S.testWindow(t(TUE, 7, 0), pve, 99999).open, false);
});

test('Montag ist gesperrt, auch mit riesiger Laufzeit', () => {
  const w = S.testWindow(t(MON, 10), router, 99999);
  assert.equal(w.open, false);
  assert.equal(w.hardClosed, true);
});

test('Sperrzeit 19:00–01:00 über Mitternacht, nie testen', () => {
  assert.equal(S.testWindow(t(TUE, 19, 30), router, 99999).open, false);
  assert.equal(S.testWindow(t(TUE, 23, 59), router, 99999).open, false);
  assert.equal(S.testWindow(t(WED, 0, 30), router, 99999).open, false);
  assert.equal(S.testWindow(t(WED, 1, 0), router, 99999).open, true);
});

test('router (immer an): Mittwoch 02:00 offen bis 18:30', () => {
  const w = S.testWindow(t(WED, 2), router, 99999);
  assert.equal(w.open, true);
  assert.equal(w.minutesLeft, 16 * 60 + 30);
});

test('Sonntag 18:00: Ende ist die Sperrzeit um 19:00, nicht Montag 00:00', () => {
  const w = S.testWindow(t(SUN, 18), router, 99999);
  assert.equal(w.hardEnd.getHours(), 19);
});

test('PBS manuell: Tagesende 19:00 gilt, Start beliebig', () => {
  assert.equal(S.testWindow(t(TUE, 14), pbs, 1300).minutesLeft, 4 * 60 + 30);
});

test('Unbekannte Laufzeit => zu', () => {
  assert.equal(S.testWindow(t(TUE, 10), pve, null).open, false);
});

test('Pausierter Zeitplan startet nichts', () => {
  const d = S.decide(t(TUE, 10), { ...pve, enabled: false }, host([disk({ lastShortOk: OLD })]));
  assert.equal(d.action, 'none');
});

test('Nichts fällig => nichts tun', () => {
  assert.equal(S.decide(t(TUE, 10), pve, host([disk()])).action, 'none');
});

test('Kurztest: monatlich fällig, seriell: älteste Platte zuerst', () => {
  const st = host([disk({ serial: 'B', device: '/dev/sdb', lastShortOk: new Date(2026, 8, 1) }), disk({ serial: 'A', lastShortOk: new Date(2026, 9, 1), lastLongOk: t(1, 1) })]);
  const d = S.decide(t(TUE, 10), pve, st);
  assert.equal(d.action, 'start');
  assert.equal(d.kind, 'short');
  assert.equal(d.serial, 'B');
});

test('Kurztest fällt nie auf Montag, nächster erlaubter Tag ist Dienstag', () => {
  const st = host([disk({ lastShortOk: new Date(2026, 9, 2, 12) })]); // fällig am 2.11. (Montag)
  assert.equal(S.decide(t(MON, 10), pve, st).action, 'none');
  assert.equal(S.decide(t(TUE, 10), pve, st).action, 'start');
  assert.equal(S.nextAllowedDay(new Date(2026, 9, 2, 12), 1, t(SUN, 12), pve).getDate(), 3);
});

test('seriell: läuft schon ein Test, startet keine zweite Platte', () => {
  const st = host([disk({ running: { type: 'short' } }), disk({ serial: 'B', device: '/dev/sdb', lastShortOk: OLD })]);
  const d = S.decide(t(TUE, 10), pve, st);
  assert.equal(d.action, 'none');
});

test('Kurztest wird nicht kurz vor Fensterende gestartet', () => {
  const d = S.decide(t(TUE, 18, 28), pve, host([disk({ lastShortOk: OLD, lastLongOk: t(1, 1) })]));
  assert.equal(d.action, 'none');
});

test('Langtest hat Vorrang vor Kurztest', () => {
  const st = host([disk({ lastShortOk: OLD, lastLongOk: OLD })]);
  const d = S.decide(t(TUE, 9), pve, st);
  assert.equal(d.kind, 'long');
});

test('Langtest Exos: passt nicht in einen Tag => Abschnitt, der ins Fenster passt (mit Reserve)', () => {
  const st = host([disk({ lastLongOk: OLD })]);
  const d = S.decide(t(TUE, 9), pve, st);
  assert.equal(d.action, 'start');
  assert.equal(d.test.test, 'select');
  assert.equal(d.test.from, 0);
  assert.ok(d.test.minutes <= 570 / 1.1 + 1);
  assert.ok(d.test.to < 23437770752 - 1);
  assert.equal(d.test.last, false);
});

test('Langtest wird am nächsten Tag am gemerkten Sektor fortgesetzt und endet mit dem Rest', () => {
  const total = 23437770752;
  const first = S.decide(t(TUE, 9), pve, host([disk({ lastLongOk: OLD })])).test;
  const adv = S.advanceProgress(null, first, total, first.minutes);
  assert.equal(adv.done, false);
  assert.equal(adv.progress.nextLba, first.to + 1);
  const second = S.decide(t(WED, 9), pve, host([disk({ lastLongOk: OLD, longProgress: adv.progress })])).test;
  assert.equal(second.from, first.to + 1);
  assert.ok(second.to > second.from);
  const adv2 = S.advanceProgress(adv.progress, second, total, second.minutes);
  assert.equal(adv2.done, adv2.progress === undefined);
  // Rest passt komplett:
  const rest = S.decide(t(THU, 9), pve, host([disk({ lastLongOk: OLD, longProgress: { nextLba: total - 1000, totalLba: total, lbaPerMin: 21700000 } })])).test;
  assert.equal(rest.to, total - 1);
  assert.equal(rest.last, true);
  assert.equal(S.advanceProgress(null, rest, total, 1).done, true);
});

test('Langtest PBS-Platte (637 min): auch bei Start um 08:00 reicht ein Tag knapp nicht => Abschnitt', () => {
  const d6 = { pollingExtended: 637, totalLba: 11721045168, lastLongOk: OLD };
  const d = S.decide(t(TUE, 8, 30), pbs, host([disk(d6)], { uptimeSec: 3600 })); // 600 min frei, 637 * 1,1 = 701 nötig
  assert.equal(d.test.test, 'select');
  assert.ok(d.test.minutes <= 600 / 1.1 + 1);
  // Mit 24-h-Fenster (router) passt derselbe Langtest am Stück:
  assert.equal(S.decide(t(WED, 2), router, host([disk(d6)])).test.test, 'long');
});

test('Langtest PBS: zu kurzes Fenster am Nachmittag => Abschnitt, bei 14:00 etwa 4,5 h', () => {
  const d = S.decide(t(TUE, 14), pbs, host([disk({ pollingExtended: 637, totalLba: 11721045168, lastLongOk: OLD })], { uptimeSec: 1300 }));
  assert.equal(d.test.test, 'select');
  assert.ok(d.test.minutes <= 4.5 * 60 / 1.1 + 1);
});

test('Platte ohne selektive Tests: wartet, bis das Fenster reicht', () => {
  const ssd = disk({ kind: 'ssd', pollingExtended: 700, selective: false, lastLongOk: OLD });
  const d = S.decide(t(TUE, 9), pve, host([ssd]));
  assert.equal(d.action, 'none');
  assert.match(d.reason, /am Stück/);
  assert.equal(S.decide(t(WED, 2), router, host([ssd])).test.test, 'long'); // im 24-h-Fenster des router passt es
});

test('Langtest: eine Platte nach der anderen, erst die begonnene', () => {
  const a = disk({ serial: 'A', device: '/dev/sda', lastLongOk: OLD });
  const b = disk({ serial: 'B', device: '/dev/sdb', lastLongOk: new Date(2025, 0, 1), longProgress: { nextLba: 1000, totalLba: 23437770752, lbaPerMin: 21000000 } });
  const d = S.decide(t(TUE, 9), pve, host([a, b]));
  assert.equal(d.serial, 'B');
});

test('nie Kurz- und Langtest am selben Tag', () => {
  const long = host([disk({ lastLongOk: OLD })], { todayRuns: { short: true } });
  assert.match(S.decide(t(TUE, 9), pve, long).reason, /Kurztest/);
  const short = host([disk({ lastShortOk: OLD })], { todayRuns: { long: true } });
  assert.match(S.decide(t(TUE, 9), pve, short).reason, /Langtest/);
});

test('ZFS-Scrub läuft => nichts starten', () => {
  const d = S.decide(t(TUE, 9), pve, host([disk({ lastShortOk: OLD })], { zfsBusy: true }));
  assert.equal(d.action, 'none');
});

test('Host nicht erreichbar => nichts', () => {
  assert.equal(S.decide(t(TUE, 9), pve, host([disk({ lastShortOk: OLD })], { reachable: false })).action, 'none');
});

test('laufender Test wird um 19:00 abgebrochen, kurz vorher noch nicht', () => {
  const st = host([disk({ running: { type: 'long' } })]);
  assert.equal(S.decide(t(TUE, 18, 40), pve, st).action, 'none');
  assert.equal(S.decide(t(TUE, 18, 58), pve, st).action, 'abort');
  assert.equal(S.decide(t(TUE, 19, 1), pve, st).action, 'abort');
});

test('laufender Test am Sonntagabend wird nicht in den Montag hinein weitergeführt', () => {
  const st = host([disk({ running: { type: 'long' } })]);
  assert.equal(S.decide(t(SUN, 18, 59), router, st).action, 'abort');
});

test('PBS manuell: „Heute nicht“ und „Später“ blockieren', () => {
  const base = [disk({ lastShortOk: OLD, lastLongOk: t(1, 1) })];
  assert.equal(S.decide(t(TUE, 10), pbs, host(base, { uptimeSec: 1500 })).action, 'start');
  assert.equal(S.decide(t(TUE, 10), pbs, host(base, { uptimeSec: 1500, approval: { skipDate: S.dayKey(t(TUE, 10)) } })).action, 'none');
  assert.equal(S.decide(t(TUE, 10), pbs, host(base, { uptimeSec: 1500, approval: { snoozeUntil: t(TUE, 12) } })).action, 'none');
  assert.equal(S.decide(t(TUE, 13), pbs, host(base, { uptimeSec: 1500, approval: { snoozeUntil: t(TUE, 12) } })).action, 'start');
});

test('PBS ohne Auto-Start wartet auf Klick', () => {
  const s = { ...pbs, autoStart: false };
  const base = [disk({ lastShortOk: OLD, lastLongOk: t(1, 1) })];
  assert.equal(S.decide(t(TUE, 10), s, host(base, { uptimeSec: 1500 })).action, 'none');
  assert.equal(S.decide(t(TUE, 10), s, host(base, { uptimeSec: 1500, approval: { goNow: true } })).action, 'start');
});

test('PBS am Montag (Backup-Tag) startet nie, auch wenn der PBS läuft', () => {
  const d = S.decide(t(MON, 10), pbs, host([disk({ lastShortOk: OLD })], { uptimeSec: 3000 }));
  assert.equal(d.action, 'none');
  assert.match(d.reason, /Wochentag/);
});

test('pausierte Platte wird übersprungen', () => {
  assert.equal(S.decide(t(TUE, 9), pve, host([disk({ paused: true, lastShortOk: OLD })])).action, 'none');
});

test('canStartManual: Sperrzeit gilt auch für „Jetzt starten“', () => {
  const st = host([disk()]);
  assert.equal(S.canStartManual(t(TUE, 20), pve, st, 'A', 'short').ok, false);
  assert.equal(S.canStartManual(t(MON, 10), pve, st, 'A', 'short').ok, false);
  assert.equal(S.canStartManual(t(TUE, 10), pve, st, 'A', 'short').ok, true);
  assert.equal(S.canStartManual(t(TUE, 10), pve, st, 'A', 'long').test.test, 'select');
});

test('nextPlanned: Kurztest nächster erlaubter Tag, Langtest nach Intervall', () => {
  const n = S.nextPlanned(t(SUN, 12), pve, disk({ lastShortOk: new Date(2026, 9, 2, 12), lastLongOk: new Date(2026, 7, 31, 12) }));
  assert.equal(n.short.getDate(), 3); // 2.11. ist Montag -> 3.11.
  // 31.8. + 3 Monate = 30.11. (ein Montag) -> erster erlaubter Tag ist der 1.12.
  assert.equal(n.long.getMonth(), 11);
  assert.equal(n.long.getDate(), 1);
});
