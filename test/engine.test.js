import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Engine, defaultsForHost } from '../src/engine.js';
import { DemoWorld, DemoTransport } from '../src/demo/world.js';
import { HostClient } from '../src/hostapi.js';

// Virtuelle Uhr: 2026-11-03 ist ein Dienstag.
function setup(start = new Date(2026, 10, 3, 9, 0)) {
  let t = start.getTime();
  const clock = () => new Date(t);
  const world = new DemoWorld(clock, { testMinutes: 10 });
  const db = openDb(null);
  const hosts = world.hosts;
  const engine = new Engine({ db, hosts, now: clock, makeClient: (h) => new HostClient(new DemoTransport(world, h.id)) });
  return { world, db, engine, advance: (min) => { t += min * 60000; }, clock };
}

test('Abfrage speichert Hosts, Platten und Messwerte', async () => {
  const { engine, db } = setup();
  await engine.pollHost('pve');
  const disks = db.disksOfHost('pve');
  assert.equal(disks.length, 11);
  assert.ok(db.getHostState('pve').reachable);
  const tank = db.getHostState('pve').pools.find((p) => p.name === 'tank');
  assert.equal(tank.vdevs[0].type, 'raidz2');
  assert.equal(tank.vdevs[0].devices.length, 6);
  assert.equal(tank.cap, 48, 'Füllstand kommt aus zpool list');
  assert.equal(tank.level, 'watch', 'Prüfsummenfehler an einem Gerät');
  assert.equal(db.getDisk('ZL2M2KFZ').polling_extended, 1079);
});

test('Host nicht erreichbar wird gemeldet und erholt sich', async () => {
  const { engine, db, world } = setup();
  world.setUp('pbs', false);
  await engine.pollHost('pbs');
  assert.equal(db.getHostState('pbs').reachable, false);
  world.setUp('pbs', true);
  await engine.pollHost('pbs');
  assert.equal(db.getHostState('pbs').reachable, true);
  assert.ok(db.events().some((e) => /wieder erreichbar/.test(e.text)));
});

test('Zeitplan startet einen Kurztest nach dem anderen und verbucht das Ergebnis', async () => {
  const { engine, db, advance } = setup();
  // Langtests sind schon erledigt, damit nur Kurztests fällig sind.
  await engine.pollHost('router');
  for (const d of db.disksOfHost('router')) db.setLastOk(d.serial, 'long', new Date(2026, 10, 1));
  await engine.tickHost('router');
  const running = db.runningRuns('router');
  assert.equal(running.length, 1, 'genau ein Test gleichzeitig (seriell)');
  assert.equal(running[0].kind, 'short');
  // weitere Ticks starten keine zweite Platte
  advance(1); await engine.tickHost('router');
  assert.equal(db.runningRuns('router').length, 1);
  // Test ist zu Ende, nach der Abfrage ist er verbucht und die nächste Platte startet
  advance(12); await engine.tickHost('router');
  const done = db.runsOfDisk(running[0].serial)[0];
  assert.equal(done.result, 'ok');
  assert.ok(db.getDisk(running[0].serial).last_short_ok);
  advance(1); await engine.tickHost('router');
  assert.equal(db.runningRuns('router').length, 1);
  assert.notEqual(db.runningRuns('router')[0].serial, running[0].serial);
});

test('Langtest auf dem pve wird in Abschnitte geteilt und am nächsten Tag fortgesetzt', async () => {
  const { engine, db, advance } = setup(new Date(2026, 10, 3, 9, 0));
  await engine.pollHost('pve');
  for (const d of db.disksOfHost('pve')) { db.setLastOk(d.serial, 'short', new Date(2026, 10, 1)); if (d.serial !== 'ZL2M2KFZ') db.setLastOk(d.serial, 'long', new Date(2026, 10, 1)); }
  await engine.tickHost('pve');
  const first = db.runningRuns('pve')[0];
  assert.equal(first.kind, 'select');
  assert.equal(first.lba_from, 0);
  assert.equal(db.getProgress('ZL2M2KFZ').nextLba, 0);
  advance(15); await engine.tickHost('pve'); // Abschnitt (simuliert 10 min) fertig
  const prog = db.getProgress('ZL2M2KFZ');
  assert.equal(prog.nextLba, first.lba_to + 1);
  assert.equal(prog.segments, 1);
  // am selben Tag keine weitere Platte (seriell, derselbe Langtest läuft weiter): nächster Abschnitt startet sofort im Fenster
  const next = db.runningRuns('pve')[0];
  assert.equal(next.serial, 'ZL2M2KFZ');
  assert.equal(next.lba_from, first.lba_to + 1);
});

test('Test wird zur Sperrzeit abgebrochen und danach nicht neu gestartet', async () => {
  const { engine, db, world, advance, clock } = setup(new Date(2026, 10, 3, 18, 50));
  world.opts.testMinutes = 999;
  await engine.pollHost('router');
  const sda = db.disksOfHost('router').find((d) => d.device === '/dev/sda');
  await engine.startNow('router', sda.serial, { test: 'long', minutes: 10 }, 'manual');
  assert.equal(db.runningRuns('router').length, 1);
  advance(9); // 18:59
  await engine.tickHost('router');
  assert.equal(db.runningRuns('router').length, 0, 'abgebrochen vor 19:00');
  assert.equal(db.runsOfDisk(sda.serial)[0].result, 'interrupted');
  advance(30); await engine.tickHost('router');
  assert.equal(db.runningRuns('router').length, 0, 'in der Sperrzeit startet nichts');
  assert.equal(clock().getHours(), 19);
});

test('Montag startet nichts (auch nicht manuell)', async () => {
  const { engine, db } = setup(new Date(2026, 10, 2, 10, 0));
  await engine.pollHost('router');
  await engine.tickHost('router');
  assert.equal(db.runningRuns('router').length, 0);
  const sda = db.disksOfHost('router')[0];
  const r = await engine.startManual('router', sda.serial, 'short');
  assert.equal(r.ok, false);
  assert.match(r.reason, /Wochentag/);
});

test('pbs: Banner-Wahl „Heute nicht“ verhindert den Start, „Jetzt“ erlaubt ihn', async () => {
  const { engine, db } = setup(new Date(2026, 10, 3, 10, 0));
  engine.db.setHostSettings('pbs', { autoStart: false });
  await engine.pollHost('pbs');
  await engine.tickHost('pbs');
  assert.equal(db.runningRuns('pbs').length, 0, 'ohne Klick kein Start');
  engine.setApproval('pbs', 'now');
  await engine.tickHost('pbs');
  assert.equal(db.runningRuns('pbs').length, 1);
});

test('Standardwerte je Host-Art', () => {
  assert.equal(defaultsForHost({ kind: 'dauer' }).window.to, '24:00');
  assert.equal(defaultsForHost({ kind: 'manuell' }).mode, 'manuell');
  assert.deepEqual(defaultsForHost({ kind: 'fest' }).blockedWeekdays, [1]);
});

test('nach einem unterbrochenen Test wird dieselbe Platte nicht sofort neu gestartet (keine Endlosschleife)', async () => {
  const { engine, db, advance } = setup(new Date(2026, 10, 3, 9, 0));
  await engine.pollHost('router');
  const sda = db.disksOfHost('router').find((d) => d.device === '/dev/sda');
  const id = db.addRun({ serial: sda.serial, hostId: 'router', kind: 'long', started: new Date(2026, 10, 3, 8, 59), hoursAtStart: 1 });
  db.finishRun(id, 'interrupted', new Date(2026, 10, 3, 9, 0), 'Test');
  assert.equal(engine.buildState('router').disks.find((d) => d.serial === sda.serial).cooldown, true);
  await engine.tickHost('router');
  assert.ok(!db.runningRuns('router').some((r) => r.serial === sda.serial), 'dieselbe Platte startet nicht erneut');
  advance(13 * 60); // nach 13 Stunden ist die Wartezeit vorbei
  assert.equal(engine.buildState('router').disks.find((d) => d.serial === sda.serial).cooldown, false);
});

test('NVMe-Langtest im Demo wird richtig verbucht (kein „unterbrochen“)', async () => {
  const { engine, db, advance } = setup(new Date(2026, 10, 3, 9, 0));
  await engine.pollHost('router');
  const nv = db.disksOfHost('router').find((d) => d.device === '/dev/nvme0n1');
  await engine.startNow('router', nv.serial, { test: 'long', minutes: 10 }, 'manual');
  advance(20); await engine.pollHost('router');
  assert.equal(db.runsOfDisk(nv.serial)[0].result, 'ok');
  assert.ok(db.getDisk(nv.serial).last_long_ok);
});

test('Abfragerhythmus: einstellbar, Host aus wird seltener gefragt, laufender Test enger', async () => {
  const { engine, db, world, advance } = setup(new Date(2026, 10, 3, 9, 0));
  assert.deepEqual(engine.pollingSettings(), { idleMinutes: 30, offlineMinutes: 30, runningMinutes: 5 });
  db.setSetting('polling', JSON.stringify({ idleMinutes: 60, offlineMinutes: 45, runningMinutes: 10 }));
  assert.equal(engine.pollingSettings().idleMinutes, 60);
  db.setSetting('polling', JSON.stringify({ idleMinutes: 1, offlineMinutes: 9999, runningMinutes: 'x' }));
  assert.deepEqual(engine.pollingSettings(), { idleMinutes: 5, offlineMinutes: 240, runningMinutes: 5 }, 'ungültige Werte werden begrenzt');
  db.setSetting('polling', JSON.stringify({ idleMinutes: 60, offlineMinutes: 45, runningMinutes: 10 }));
  for (const h of world.hosts) db.setHostSettings(h.id, { enabled: false }); // keine Tests, nur Abfragen zählen
  let polls = 0; const orig = engine.pollHost.bind(engine); engine.pollHost = async (id) => { if (id === 'router') polls++; return orig(id); };
  await engine.tickHost('router'); assert.equal(polls, 1);
  advance(30); await engine.tickHost('router'); assert.equal(polls, 1, 'nach 30 min noch nicht (Normalbetrieb 60)');
  advance(31); await engine.tickHost('router'); assert.equal(polls, 2);
  world.setUp('router', false);
  advance(61); await engine.tickHost('router'); assert.equal(polls, 3);
  advance(30); await engine.tickHost('router'); assert.equal(polls, 3, 'ausgeschalteter Host: 45 min');
  advance(16); await engine.tickHost('router'); assert.equal(polls, 4);
});

test('Skript-Version des Hosts wird gespeichert', async () => {
  const { engine, db } = setup();
  const { EXPECTED_GATE_VERSION } = await import('../src/gate-version.js');
  await engine.pollHost('pve'); await engine.pollHost('pbs');
  assert.equal(db.getHostState('pve').gateVersion, EXPECTED_GATE_VERSION);
  assert.equal(db.getHostState('pbs').gateVersion, 3);
});

const calls = (world, id) => world.state.get(id).snapCalls ?? [];

test('Snapshots durch das Tool: standardmäßig bleibt es beim Cron, nach der Übernahme löst das Tool aus (nur einmal je Slot)', async () => {
  const { engine, world, advance } = setup();
  await engine.pollHost('pve');
  assert.deepEqual(engine.hostRights('pve'), ['snapshots']);
  await engine.tickHost('pve');
  assert.deepEqual(calls(world, 'pve'), [], 'ohne Übernahme löst das Tool nichts aus');
  await engine.setSnapMode('pve', 'tool');
  assert.deepEqual(calls(world, 'pve'), ['snap-cron off'], 'erst Cron aus');
  await engine.tickHost('pve');
  const first = calls(world, 'pve').filter((c) => c.startsWith('snap-run'));
  assert.deepEqual(first.sort(), ['snap-run hourly', 'snap-run monthly force', 'snap-run weekly'], 'stündlich plus Nachholen von Woche und Monat');
  await engine.tickHost('pve');
  assert.equal(calls(world, 'pve').filter((c) => c.startsWith('snap-run')).length, 3, 'im selben Slot nicht noch einmal');
  advance(60); // nächster Stunden-Slot
  await engine.pollHost('pve');
  await engine.tickHost('pve');
  assert.equal(calls(world, 'pve').filter((c) => c === 'snap-run hourly').length, 2);
  await engine.setSnapMode('pve', 'cron');
  assert.equal(calls(world, 'pve').at(-1), 'snap-cron on');
  assert.equal(engine.snapCtl('pve').mode, 'cron');
});

test('Snapshots: ohne freigegebenes Recht keine Übernahme; Montag (Pausentag) wird nichts ausgelöst', async () => {
  const { engine, world } = setup();
  await engine.pollHost('router');
  await assert.rejects(() => engine.setSnapMode('router', 'tool'), /nicht freigegeben/);
  assert.deepEqual(calls(world, 'router'), []);
  const m = setup(new Date(2026, 10, 2, 9, 0)); // Montag
  await m.engine.pollHost('pve'); await m.engine.pollBackups('pve', m.engine.client('pve'), m.clock(), true);
  await m.engine.setSnapMode('pve', 'tool');
  await m.engine.tickHost('pve');
  assert.equal(calls(m.world, 'pve').filter((c) => c.startsWith('snap-run')).length, 0);
});

test('Snapshots: Fehlschlag wird gemerkt und erst nach 15 Minuten wiederholt', async () => {
  const { engine, world, advance } = setup();
  await engine.pollHost('pve');
  await engine.setSnapMode('pve', 'tool');
  world.state.get('pve').snapFail = true;
  await engine.tickHost('pve');
  const n = () => calls(world, 'pve').filter((c) => c === 'snap-run hourly').length;
  assert.equal(n(), 1);
  assert.equal(engine.snapLast('pve').hourly.ok, false);
  advance(5); await engine.tickHost('pve');
  assert.equal(n(), 1, 'nach 5 min noch nicht wieder');
  world.state.get('pve').snapFail = false;
  advance(15); await engine.pollHost('pve'); await engine.tickHost('pve');
  assert.equal(engine.snapLast('pve').hourly.ok, true);
});

test('Snapshots: lässt sich der Cron nicht ausschalten, bleibt es beim Cron und es gibt eine Fehlermeldung', async () => {
  const { engine, world } = setup();
  await engine.pollHost('pve');
  world.state.get('pve').cronStuck = true;
  await assert.rejects(() => engine.setSnapMode('pve', 'tool'), /ließ sich nicht ausschalten/);
  assert.equal(engine.snapCtl('pve').mode, 'cron');
});

test('Snapshot-Planung: Zeitpunkte im Tool, Aufbewahrung und Pausentag über den verwalteten Wrapper', async () => {
  const { engine, world } = setup();
  await engine.pollHost('pve');
  const as = () => engine.db.getAutosnap('pve');
  assert.equal(as().managed, true);
  assert.deepEqual(as().keep, { hourly: 8, weekly: 1, monthly: 1 });
  await engine.setSnapPlan('pve', { plan: { hourlyMinute: 30, weeklyDay: 6, weeklyTime: '03:00' }, keep: { hourly: 12, monthly: 3 }, pauseDay: null });
  assert.deepEqual(as().keep, { hourly: 12, weekly: 1, monthly: 3 });
  assert.equal(as().pauseDay, null, 'kein Pausentag');
  assert.equal(engine.snapCtl('pve').plan.hourlyMinute, 30);
  assert.equal(engine.snapCtl('pve').plan.weeklyDay, 6);
  assert.ok(world.state.get('pve').snapCalls.some((c) => c === 'snap-conf 12 1 3 0 1'));
  await engine.setSnapPlan('pve', { pauseDay: 0 });
  assert.equal(as().pauseDay, 0, 'Sonntag als Pausentag');
  await assert.rejects(() => engine.setSnapPlan('pve', { keep: { hourly: 0 } }), /erlaubt sind 1 bis 99/);
  await assert.rejects(() => engine.setSnapPlan('pve', { plan: { hourlyMinute: 61 } }), /erlaubt sind 0 bis 59/);
  await assert.rejects(() => engine.setSnapPlan('pve', { plan: { monthlyDay: 31 } }), /erlaubt sind 1 bis 28/);
  assert.match(await engine.snapDryRun('pve', 'hourly'), /Container/);
  await engine.pollHost('router');
  await assert.rejects(() => engine.setSnapPlan('router', { plan: { hourlyMinute: 10 } }), /nicht freigegeben/);
});

test('Snapshot-Planung: neue Zeitpunkte bestimmen, wann das Tool auslöst', async () => {
  const { engine, world, advance } = setup(new Date(2026, 10, 3, 9, 28)); // Dienstag 09:28
  await engine.pollHost('pve');
  await engine.setSnapPlan('pve', { plan: { hourlyMinute: 30 } });
  await engine.setSnapMode('pve', 'tool');
  world.state.get('pve').snapCalls.length = 0;
  await engine.tickHost('pve');
  assert.equal(world.state.get('pve').snapCalls.filter((c) => c === 'snap-run hourly').length, 0, '09:28 ist vor 09:30: der letzte Slot (08:30) liegt über 55 Minuten zurück');
  advance(4); await engine.pollHost('pve'); await engine.tickHost('pve'); // 09:32
  assert.equal(world.state.get('pve').snapCalls.filter((c) => c === 'snap-run hourly').length, 1);
});
