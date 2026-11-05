import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { HostClient } from '../src/hostapi.js';
import { DemoWorld, DemoTransport } from '../src/demo/world.js';
import { Notifier } from '../src/notify.js';
import { cleanBackupSettings } from '../src/orchestrator.js';

async function setup({ allDays = true } = {}) {
  let t = new Date(2026, 10, 3, 9, 0).getTime();
  const clock = () => new Date(t);
  const world = new DemoWorld(clock, { testMinutes: 10 });
  world.pbsGate = 99; // der PBS kennt die neuen Rechte (in der Demo sonst absichtlich veraltet)
  const db = openDb(null);
  const engine = new Engine({ db, hosts: world.hosts, now: clock, makeClient: (h) => new HostClient(new DemoTransport(world, h.id)) });
  const mails = [];
  const notifier = new Notifier({ db, engine, send: async (m) => { mails.push(m); } });
  engine.notifier = notifier;
  for (const h of world.hosts) await engine.pollHost(h.id);
  notifier.save({ enabled: true, host: 'mail.example.org', port: 587, security: 'starttls', user: 'u', from: 'a@example.org', to: 'b@example.org' }, { password: 'geheim123' });
  const advance = async (min) => { t += min * 60000; for (const h of world.hosts) await engine.pollHost(h.id); };
  /** Neuer Boot des PBS: aus, wieder an, Wartezeit abwarten. */
  const bootPbs = async (waitMin = 21) => { world.setUp('pbs', false); await engine.pollHost('pbs'); world.setUp('pbs', true); await engine.pollHost('pbs'); await advance(waitMin); };
  const calls = (id) => (world.state.get(id).snapCalls ?? []).filter((c) => /^(backup-start|poweroff)/.test(c));
  // Die meisten Tests laufen an einem Dienstag: dafür alle Tage als Backup-Tage. Die Voreinstellung (nur Montag) prüft ein eigener Test.
  if (allDays) engine.orch.save({ backupDays: [0, 1, 2, 3, 4, 5, 6] });
  return { world, db, engine, notifier, mails, advance, bootPbs, calls, o: engine.orch };
}

test('Einstellungen: nur gültige Werte', () => {
  const ids = ['router', 'pve', 'pbs'];
  assert.throws(() => cleanBackupSettings({ storage: 'pbs; id' }, ids), /Speicher/);
  assert.throws(() => cleanBackupSettings({ waitAfterBootMin: 999 }, ids), /Wartezeit/);
  assert.throws(() => cleanBackupSettings({ pbsHostId: 'x' }, ids), /unbekannt/);
  assert.throws(() => cleanBackupSettings({ mode: 'quatsch' }, ids), /Betriebsart/);
  assert.throws(() => cleanBackupSettings({ hosts: { nope: { select: 'all' } } }, ids), /Host unbekannt/);
  assert.throws(() => cleanBackupSettings({ hosts: { pve: { select: 'exclude', ids: ['a'] } } }, ids), /Gast-IDs/);
  assert.throws(() => cleanBackupSettings({ hosts: { pve: { select: 'only', ids: [] } } }, ids), /mindestens einen/);
  assert.throws(() => cleanBackupSettings({ order: ['pve', 'pve'] }, ids), /Reihenfolge/);
  const ok = cleanBackupSettings({ hosts: { pve: { select: 'exclude', ids: [112, 109, 112] }, router: { select: 'exclude', ids: [] } } }, ids);
  assert.deepEqual(ok.hosts.pve, { enabled: true, select: 'exclude', ids: [109, 112] });
  assert.equal(ok.hosts.router.select, 'all', 'Ausschluss ohne Gäste heißt: alle');
});

test('Voreinstellung wie im alten Orchestrator: router alle, pve alle außer der Liste; PBS ist der Host der Art „manuell“', async () => {
  const { o } = await setup();
  assert.equal(o.settings().pbsHostId, 'pbs');
  assert.deepEqual(o.order(), ['router', 'pve']);
  assert.deepEqual(o.selection('router'), { enabled: true, select: 'all', ids: [] });
  assert.deepEqual(o.selection('pve').ids, [109, 112, 113, 114, 116, 119, 117, 159, 161, 171]);
});

test('Betriebsart „beobachten“: das Tool startet nichts, auch nicht bei frisch gestartetem PBS', async () => {
  const { o, bootPbs, calls } = await setup();
  await bootPbs(); await o.tick();
  assert.equal(o.job(), null);
  assert.deepEqual(calls('router'), []);
});

test('Beim Einschalten von „steuern“ startet nicht sofort ein Lauf (aktueller Boot gilt als erledigt)', async () => {
  const { o, advance, calls } = await setup();
  o.save({ mode: 'steuern' });
  await advance(30); await o.tick();
  assert.equal(o.job(), null);
  assert.deepEqual(calls('router'), []);
});

test('Voller Lauf: erst router, dann pve, danach fährt der PBS herunter', async () => {
  const { o, advance, bootPbs, calls, world, mails } = await setup();
  o.save({ mode: 'steuern' });
  await bootPbs(19); await o.tick();
  assert.equal(o.job(), null, 'Wartezeit nach dem Hochfahren (20 min) noch nicht um');
  await advance(2); await o.tick();
  let job = o.job();
  assert.equal(job.phase, 'läuft');
  assert.deepEqual(job.hosts.map((h) => [h.id, h.state]), [['router', 'läuft'], ['pve', 'wartet']]);
  assert.deepEqual(calls('router'), ['backup-start pbs all']);
  assert.deepEqual(calls('pve'), [], 'pve erst, wenn router fertig ist');
  await advance(31); await o.tick();
  job = o.job();
  assert.deepEqual(job.hosts.map((h) => [h.id, h.state]), [['router', 'ok'], ['pve', 'läuft']]);
  assert.deepEqual(calls('pve'), ['backup-start pbs exclude 109,112,113,114,116,119,117,159,161,171']);
  await advance(31); await o.tick();
  job = o.job();
  assert.equal(job.phase, 'fertig');
  assert.equal(job.shutdown, 'angefordert');
  assert.deepEqual(calls('pbs'), ['poweroff']);
  assert.equal(world.state.get('pbs').up, false);
  assert.equal(o.lastJob().id, job.id);
  assert.ok(mails.some((m) => m.subject.startsWith('[Backup] Lauf abgeschlossen')), 'Mail über den Erfolg');
  // derselbe Boot startet keinen zweiten Lauf
  await o.tick(); assert.equal(calls('router').length, 1);
});

test('Fehlgeschlagener Gast: PBS bleibt an, Mail mit Ursache', async () => {
  const { o, advance, bootPbs, calls, world, mails } = await setup();
  world.state.get('router').vzFail = 112;
  o.save({ mode: 'steuern' });
  await bootPbs(); await o.tick();
  await advance(31); await o.tick(); await advance(31); await o.tick();
  const job = o.job();
  assert.equal(job.phase, 'fehler');
  assert.equal(job.shutdown, 'nein');
  assert.deepEqual(calls('pbs'), [], 'kein Herunterfahren');
  assert.equal(world.state.get('pbs').up, true);
  const router = job.hosts.find((h) => h.id === 'router');
  assert.equal(router.state, 'fehler');
  assert.deepEqual(router.failedGuests.map((g) => g.vmid), [112]);
  const m = mails.find((x) => x.subject.startsWith('[Backup] Lauf NICHT'));
  assert.ok(m);
  assert.match(m.text, /Fehlgeschlagen: 112/);
  assert.match(m.text, /PBS bleibt an/);
});

test('Speicher nicht aktiv oder Host nicht erreichbar: nach der Wartezeit wird der Host übersprungen, PBS bleibt an', async () => {
  const { o, advance, bootPbs, calls, world } = await setup();
  world.state.get('pve').storageDown = true;
  o.save({ mode: 'steuern', hostWaitMin: 10 });
  await bootPbs(); await o.tick();
  await advance(31); await o.tick();   // router fertig, pve wartet auf den Speicher
  assert.equal(o.job().hosts.find((h) => h.id === 'pve').state, 'wartet');
  assert.deepEqual(calls('pve'), []);
  await advance(11); await o.tick();
  const job = o.job();
  assert.equal(job.hosts.find((h) => h.id === 'pve').state, 'fehlt');
  assert.match(job.hosts.find((h) => h.id === 'pve').note, /nicht aktiv/);
  assert.equal(job.phase, 'fehler'); assert.deepEqual(calls('pbs'), []);
});

test('Läuft schon ein vzdump (z. B. vom alten Skript), wird er übernommen statt doppelt gestartet', async () => {
  const { o, engine, bootPbs, calls } = await setup();
  await engine.client('router').backupStart('pbs', { select: 'all', ids: [] }); // „alter Orchestrator“
  o.save({ mode: 'steuern' });
  await bootPbs(); await o.tick();
  const r = o.job().hosts.find((h) => h.id === 'router');
  assert.equal(r.state, 'läuft');
  assert.match(r.note, /übernommen/);
  assert.equal(calls('router').length, 1, 'kein zweiter Start');
});

test('Ohne Recht „Backups starten“ gibt es einen Fehler statt eines Starts; ohne Recht „Herunterfahren“ bleibt der PBS an', async () => {
  const { o, advance, bootPbs, calls, world, engine } = await setup();
  world.rights = new Map([['router', ['backup-starten']], ['pve', ['snapshots']], ['pbs', []]]);
  for (const h of world.hosts) await engine.pollHost(h.id);
  o.save({ mode: 'steuern' });
  await bootPbs(); await o.tick();
  assert.equal(o.job().hosts.find((h) => h.id === 'pve').state, 'wartet');
  await advance(31); await o.tick();
  assert.equal(o.job().hosts.find((h) => h.id === 'pve').state, 'fehler');
  assert.match(o.job().hosts.find((h) => h.id === 'pve').note, /Recht/);
  assert.deepEqual(calls('pve'), []);
  // alles in Ordnung, aber ohne Recht zum Herunterfahren
  world.rights.set('pve', ['backup-starten']);
  for (const h of world.hosts) await engine.pollHost(h.id);
  await bootPbs(); await o.tick(); await advance(31); await o.tick(); await advance(31); await o.tick();
  const job = o.job();
  assert.equal(job.phase, 'fertig'); assert.equal(job.shutdown, 'fehlt-recht');
  assert.deepEqual(calls('pbs'), []);
});

test('Während ein Backup auf dem Host läuft, startet das Tool keine Platten-Tests', async () => {
  const { o, engine, bootPbs } = await setup();
  o.save({ mode: 'steuern' });
  assert.equal(engine.buildState('router').backupBusy, false);
  await bootPbs(); await o.tick();
  assert.equal(engine.buildState('router').backupBusy, true);
  assert.equal(engine.buildState('pve').backupBusy, false);
});

test('Trockenlauf zeigt Auswahl und Probleme, startet aber nichts; Abbrechen beendet nur die Steuerung', async () => {
  const { o, calls, world, bootPbs } = await setup();
  world.state.get('pve').storageDown = true;
  const plan = await o.dryRun();
  assert.deepEqual(plan.hosts.map((h) => h.id), ['router', 'pve']);
  const pve = plan.hosts.find((h) => h.id === 'pve');
  assert.equal(pve.excluded > 0, true);
  assert.ok(pve.guests.every((g) => ![109, 112, 113].includes(g.vmid)));
  assert.match(pve.command, /--exclude 109,112,113/);
  assert.ok(plan.problems.some((p) => /Speicher/.test(p)), plan.problems.join('|'));
  assert.deepEqual(calls('router'), []); assert.deepEqual(calls('pve'), []);
  o.save({ mode: 'steuern' }); await bootPbs(); await o.tick();
  o.abort();
  assert.equal(o.job().phase, 'abgebrochen');
  assert.throws(() => o.abort(), /kein Backup-Lauf/);
});

test('Von Hand starten: nur bei erreichbarem PBS und nie doppelt', async () => {
  const { o, world } = await setup();
  const j = await o.startNow();
  assert.equal(j.manual, true); assert.equal(j.phase, 'läuft');
  await assert.rejects(() => o.startNow(), /schon ein Backup-Lauf/);
  o.abort();
  world.setUp('pbs', false);
  const { engine } = o; await engine.pollHost('pbs');
  await assert.rejects(() => o.startNow(), /nicht erreichbar/);
});

test('Backup-Tage: Voreinstellung Montag; an anderen Tagen wird nicht gesichert, der PBS bleibt an, „Jetzt Backup starten“ geht weiter', async () => {
  const { o, bootPbs, calls, world, db } = await setup({ allDays: false }); // Dienstag, 3.11.2026
  assert.deepEqual(o.settings().backupDays, [1]);
  o.save({ mode: 'steuern' });
  await bootPbs(); await o.tick();
  assert.equal(o.job(), null, 'kein Lauf an einem Dienstag');
  assert.deepEqual(calls('router'), []); assert.deepEqual(calls('pbs'), []);
  assert.equal(world.state.get('pbs').up, true, 'PBS bleibt an');
  assert.ok(db.getSetting('backup_lastskip'));
  await o.tick(); assert.equal(o.job(), null, 'auch beim nächsten Takt nicht');
  const plan = await o.dryRun();
  assert.ok(plan.notes.some((n) => /kein Backup-Tag/.test(n)));
  const j = await o.startNow();
  assert.equal(j.manual, true, 'von Hand geht es trotzdem');
});

test('Backup-Tage sind einstellbar, ungültige Tage werden abgelehnt', async () => {
  const { o, bootPbs, calls } = await setup({ allDays: false });
  assert.throws(() => o.save({ backupDays: [7] }), /Backup-Tage/);
  assert.throws(() => o.save({ backupDays: 'mo' }), /Backup-Tage/);
  o.save({ mode: 'steuern', backupDays: [2, 2, 1] });
  assert.deepEqual(o.settings().backupDays, [1, 2]);
  await bootPbs(); await o.tick();
  assert.equal(o.job().phase, 'läuft', 'Dienstag ist jetzt Backup-Tag');
  assert.deepEqual(calls('router'), ['backup-start pbs all']);
});

test('Kein Backup-Tag: auch ein von Hand gestarteter Lauf fährt den PBS danach nicht herunter', async () => {
  const { o, advance, calls } = await setup({ allDays: false }); // Dienstag
  o.save({ mode: 'steuern' });
  await o.startNow(); await advance(31); await o.tick(); await advance(31); await o.tick();
  const job = o.job();
  assert.equal(job.phase, 'fertig');
  assert.equal(job.shutdown, 'kein-backup-tag');
  assert.deepEqual(calls('pbs'), []);
});

test('PBS einschalten (Wake-on-LAN) und von Hand herunterfahren', async () => {
  const { o, engine, world, calls } = await setup();
  const sent = [];
  o.sendWol = async (mac, opt) => { sent.push([mac, opt.broadcast]); return { packets: 3, targets: [opt.broadcast] }; };
  await o.tick(); // lernt die MAC-Adresse über das Prüfskript (netinfo)
  assert.equal(o.wolTarget().mac, 'a8:a1:59:12:34:56');
  await assert.rejects(() => o.wake(), /läuft schon/);
  await o.powerOff();
  assert.deepEqual(calls('pbs'), ['poweroff']);
  await engine.pollHost('pbs');
  await assert.rejects(() => o.powerOff(), /nicht erreichbar/);
  await o.wake();
  assert.deepEqual(sent, [['a8:a1:59:12:34:56', '255.255.255.255']]);
  o.save({ wolMac: 'AA-BB-CC-DD-EE-FF', wolBroadcast: '192.168.1.255' });
  await o.wake();
  assert.deepEqual(sent.at(-1), ['aa:bb:cc:dd:ee:ff', '192.168.1.255'], 'von Hand eingetragene Adresse hat Vorrang');
  assert.throws(() => o.save({ wolMac: 'aa:bb' }), /MAC/);
  assert.throws(() => o.save({ wolBroadcast: '999.1.1.1' }), /Broadcast/);
  world.setUp('pbs', true); await engine.pollHost('pbs');
  o.save({ mode: 'steuern' }); await o.startNow();
  await assert.rejects(() => o.powerOff(), /Backup-Lauf/);
});
