import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Auth, hashPassword, verifyPassword } from '../src/auth.js';
import { HostClient } from '../src/hostapi.js';
import { DemoWorld, DemoTransport } from '../src/demo/world.js';
// Server immer schließen, auch wenn ein Test vorher fehlschlägt (sonst hängt der Lauf).
const openApps = [];
after(() => { for (const a of openApps) { a.closeAllConnections?.(); a.close(); } });
import { createApp, isPrivateIp } from '../src/server.js';
import { cleanSettings } from '../src/service.js';
import { Notifier } from '../src/notify.js';

async function boot() {
  const clock = () => new Date(2026, 10, 3, 9, 0);
  const world = new DemoWorld(clock);
  const db = openDb(null);
  const engine = new Engine({ db, hosts: world.hosts, now: clock, makeClient: (h) => new HostClient(new DemoTransport(world, h.id)) });
  for (const h of world.hosts) await engine.pollHost(h.id);
  const auth = new Auth(db);
  const sent = [], failSend = { on: false };
  engine.notifier = new Notifier({ db, engine, send: async (m) => { if (failSend.on) throw new Error('Anmeldung am Mailserver abgelehnt'); sent.push(m); } });
  const app = createApp({ db, engine, auth, allowPublic: true });
  openApps.push(app);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  const call = async (method, path, body, cookie) => {
    const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'disktool', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* HTML */ }
    return { status: r.status, json, text, cookie: r.headers.get('set-cookie') };
  };
  return { app, call, engine, db, sent, failSend, close: () => app.close() };
}

test('Passwort-Hash prüft richtig und falsch', () => {
  const h = hashPassword('geheim1234');
  assert.equal(verifyPassword('geheim1234', h), true);
  assert.equal(verifyPassword('falsch', h), false);
  assert.equal(verifyPassword('x', 'kaputt'), false);
});

test('lokale Adressen erkannt', () => {
  for (const ip of ['192.168.1.5', '10.0.0.1', '172.16.3.3', '127.0.0.1', '::1', '::ffff:192.168.0.2', 'fd12::1']) assert.equal(isPrivateIp(ip), true, ip);
  for (const ip of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) assert.equal(isPrivateIp(ip), false, ip);
});

test('Einstellungen werden geprüft', () => {
  assert.throws(() => cleanSettings({ shortIntervalMonths: 0 }));
  assert.throws(() => cleanSettings({ blockedWeekdays: [0, 1, 2, 3, 4, 5, 6] }));
  assert.throws(() => cleanSettings({ window: { from: '25:00', to: '10:00' } }));
  assert.deepEqual(cleanSettings({ longIntervalMonths: 4, blockedWeekdays: [1, 1, 2], window: { from: '8:00', to: '24:00' } }), { longIntervalMonths: 4, blockedWeekdays: [1, 2], window: { from: '08:00', to: '24:00' } });
});

test('ohne Passwort offen, nach dem Setzen Anmeldung nötig', async () => {
  const { call, close } = await boot();
  assert.equal((await call('GET', '/api/auth/status')).json.passwordSet, false);
  assert.equal((await call('GET', '/api/overview')).status, 200);
  const set = await call('POST', '/api/auth/password', { password: 'kurz' });
  assert.equal(set.status, 400);
  const ok = await call('POST', '/api/auth/password', { password: 'sehr-geheim-123' });
  assert.equal(ok.status, 200);
  assert.match(ok.cookie, /HttpOnly/);
  assert.equal((await call('GET', '/api/overview')).status, 401);
  assert.equal((await call('POST', '/api/auth/login', { password: 'falsch' })).status, 401);
  const login = await call('POST', '/api/auth/login', { password: 'sehr-geheim-123' });
  const cookie = login.cookie.split(';')[0];
  assert.equal((await call('GET', '/api/overview', null, cookie)).status, 200);
  // Passwort ändern erfordert das alte
  assert.equal((await call('POST', '/api/auth/password', { password: 'neues-passwort-1' }, cookie)).status, 401);
  assert.equal((await call('POST', '/api/auth/password', { current: 'sehr-geheim-123', password: 'neues-passwort-1' }, cookie)).status, 200);
  assert.equal((await call('GET', '/api/overview', null, cookie)).status, 401, 'alte Anmeldung ist nach der Änderung ungültig');
  close();
});

test('Brute-Force-Schutz: nach 5 Fehlversuchen gesperrt', async () => {
  const { call, close } = await boot();
  await call('POST', '/api/auth/password', { password: 'sehr-geheim-123' });
  for (let i = 0; i < 5; i++) await call('POST', '/api/auth/login', { password: 'x' + i });
  assert.equal((await call('POST', '/api/auth/login', { password: 'sehr-geheim-123' })).status, 429);
  close();
});

test('POST ohne Schutz-Header wird abgelehnt (CSRF)', async () => {
  const { app, close } = await boot();
  const r = await fetch(`http://127.0.0.1:${app.address().port}/api/hosts/pve/poll`, { method: 'POST' });
  assert.equal(r.status, 403);
  close();
});

test('Übersicht: Hosts, Bewertung der Beispielplatten, Zusammenfassung', async () => {
  const { call, close } = await boot();
  const o = (await call('GET', '/api/overview')).json;
  assert.deepEqual(o.hosts.map((h) => h.id), ['router', 'pve', 'pbs']);
  const router = o.hosts.find((h) => h.id === 'router');
  const ssd = router.disks.find((d) => d.serial === '210623444409');
  assert.equal(ssd.level, 'replace');
  assert.equal(ssd.remainingLife, 14);
  const pve = o.hosts.find((h) => h.id === 'pve');
  assert.equal(pve.disks.find((d) => d.serial === 'ZHZ0RHKE').level, 'replace');
  assert.equal(pve.disks.find((d) => d.serial === 'ZL2M2KFZ').level, 'ok');
  assert.match(o.summary.text, /Aufmerksamkeit/);
  assert.equal(o.hosts.find((h) => h.id === 'pbs').banner.autoStart, true);
  close();
});

test('Einstellungen speichern und Test per Knopf starten', async () => {
  const { call, close, engine } = await boot();
  assert.equal((await call('PUT', '/api/hosts/pve/settings', { longIntervalMonths: 4 })).status, 200);
  assert.equal(engine.settings('pve').longIntervalMonths, 4);
  assert.equal((await call('PUT', '/api/hosts/pve/settings', { longIntervalMonths: 99 })).status, 400);
  const r = await call('POST', '/api/disks/ZL2M2KFZ/test', { type: 'short' });
  assert.equal(r.status, 200);
  const o = (await call('GET', '/api/overview')).json;
  assert.equal(o.hosts.find((h) => h.id === 'pve').disks.find((d) => d.serial === 'ZL2M2KFZ').running.type, 'short');
  // zweiter Test auf demselben Host: seriell, abgelehnt
  assert.equal((await call('POST', '/api/disks/ZL2M6GPD/test', { type: 'short' })).status, 409);
  close();
});

test('statische Dateien: Pfad-Tricks werden abgewehrt', async () => {
  const { app, close } = await boot();
  const r = await fetch(`http://127.0.0.1:${app.address().port}/..%2fpackage.json`);
  assert.equal(r.status, 404);
  close();
});

// ---- Statistik, Testliste, Pools (mit erfundenem Verlauf) ----
async function bootSeeded() {
  const clock = () => new Date(2026, 10, 3, 9, 0);
  const world = new DemoWorld(clock);
  const db = openDb(null);
  const engine = new Engine({ db, hosts: world.hosts, now: clock, makeClient: (h) => new HostClient(new DemoTransport(world, h.id)) });
  for (const h of world.hosts) await engine.pollHost(h.id);
  const { seedDemo } = await import('../src/demo/seed.js');
  seedDemo(db, world.hosts, clock());
  const app = createApp({ db, engine, auth: new Auth(db), allowPublic: true });
  openApps.push(app);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const get = (p) => fetch(`http://127.0.0.1:${app.address().port}${p}`).then((r) => r.json());
  return { get, close: () => app.close(), db, engine };
}

test('Statistik: Summen, zwölf Monate, Host-Aufteilung', async () => {
  const { get, close } = await bootSeeded();
  const s = await get('/api/stats');
  assert.deepEqual(Object.keys(s.hosts).sort(), ['pbs', 'pve', 'router']);
  assert.ok(s.global.totals.runs > 100);
  assert.equal(s.global.byMonth.length, 12);
  const sum = Object.values(s.hosts).reduce((a, h) => a + h.totals.runs, 0);
  assert.equal(sum, s.global.totals.runs, 'Host-Statistiken ergeben zusammen die Gesamtstatistik');
  assert.equal(s.hosts.pve.disks.count, 11);
  assert.equal(s.hosts.pve.pools.length, 3);
  assert.ok(s.hosts.pve.tempDaily.length >= 30);
  assert.ok(s.global.totals.longCompleted > 10);
  assert.ok(s.global.totals.failed >= 1, 'der Fehlschlag der Seagate ist im Verlauf');
  close();
});

test('erfundener Verlauf hält sich an die Zeitplanregeln: nie montags, nie 19–01 Uhr', async () => {
  const { get, close } = await bootSeeded();
  const s = await get('/api/stats');
  const hm = s.global.heatmap;
  assert.equal(hm[1].reduce((a, b) => a + b, 0), 0, 'Montag (Index 1) ist leer');
  for (const h of [19, 20, 21, 22, 23, 0]) assert.equal(hm.reduce((a, row) => a + row[h], 0), 0, `Stunde ${h}`);
  close();
});

test('Testliste: laufende Tests, Filter nach Host', async () => {
  const { get, close, engine } = await bootSeeded();
  const nv = engine.db.disksOfHost('router')[0];
  await engine.startNow('router', nv.serial, { test: 'long', minutes: 30 }, 'manual');
  const all = await get('/api/tests?limit=50');
  assert.equal(all.running.length, 1);
  assert.equal(all.running[0].hostId, 'router');
  assert.equal(all.running[0].plannedMinutes, 30);
  assert.equal(all.runs.length, 50);
  const pve = await get('/api/tests?host=pve&limit=1000');
  assert.ok(pve.runs.every((r) => r.hostId === 'pve'));
  assert.equal(pve.running.length, 0);
  close();
});

test('Pools: vdev-Baum, Zuordnung zu Platten, Füllstand, Bewertung', async () => {
  const { get, close } = await bootSeeded();
  const o = await get('/api/overview');
  const pve = o.hosts.find((h) => h.id === 'pve');
  const tank = pve.pools.find((p) => p.name === 'tank');
  assert.equal(tank.vdevs[0].type, 'raidz2');
  assert.equal(tank.cap, 48);
  const bad = tank.vdevs[0].devices.find((d) => d.cksum === 3);
  assert.equal(bad.serial, 'ZHZ0RHKE', 'Gerät im vdev ist der richtigen Platte zugeordnet');
  assert.equal(bad.diskLevel, 'replace');
  assert.equal(tank.level, 'watch');
  assert.ok(tank.findings.some((f) => f.code === 'vdev-errors'));
  const rpool = pve.pools.find((p) => p.name === 'rpool');
  assert.ok(rpool.vdevs[0].devices.every((d) => d.serial), 'beide Samsung zugeordnet');
  close();
});

test('Überblick meldet veraltete Prüfskripte, Abfrage-Einstellungen lassen sich ändern', async () => {
  const { call, close } = await boot();
  const o = (await call('GET', '/api/overview')).json;
  assert.equal(o.hosts.find((h) => h.id === 'pbs').gate.outdated, true);
  assert.equal(o.hosts.find((h) => h.id === 'pve').gate.outdated, false);
  assert.equal((await call('PUT', '/api/settings/polling', { idleMinutes: 60, offlineMinutes: 30, runningMinutes: 5 })).status, 200);
  assert.equal((await call('GET', '/api/settings/polling')).json.idleMinutes, 60);
  assert.equal((await call('PUT', '/api/settings/polling', { idleMinutes: 1, offlineMinutes: 30, runningMinutes: 5 })).status, 400);
  close();
});

test('Mail-API: ohne Oberflächen-Passwort gesperrt, Passwort wird nie ausgegeben, Testmail und Zusammenfassung', async () => {
  const { call: raw, close, sent, failSend } = await boot();
  let cookie = null;
  const call = (m, p, b) => raw(m, p, b, cookie);
  const cfg = { enabled: true, host: 'mail.example.org', port: 587, security: 'starttls', user: 'u', password: 'mailgeheim1', from: 'platten@example.org', to: 'admin@example.org' };
  assert.equal((await call('GET', '/api/mail')).json.passwordSet, false);
  assert.equal((await call('PUT', '/api/mail', cfg)).status, 403);
  cookie = (await call('POST', '/api/auth/password', { password: 'sehr-geheim-123' })).cookie.split(';')[0];
  const saved = await call('PUT', '/api/mail', cfg);
  assert.equal(saved.status, 200);
  assert.equal(saved.json.passwordSet, true);
  assert.equal(saved.json.config.enabled, true);
  assert.ok(saved.json.config.baselineAt, 'bekannte Probleme wurden beim Einschalten übernommen');
  assert.ok(!JSON.stringify(saved.json).includes('mailgeheim1'));
  assert.ok(!JSON.stringify((await call('GET', '/api/overview')).json).includes('mailgeheim1'));
  assert.equal((await call('POST', '/api/mail/test')).status, 200);
  assert.equal(sent.at(-1).password, 'mailgeheim1');
  assert.equal((await call('POST', '/api/mail/digest')).status, 200);
  assert.match(sent.at(-1).subject, /Zusammenfassung/);
  failSend.on = true;
  const bad = await call('POST', '/api/mail/test');
  assert.equal(bad.status, 502);
  assert.match(bad.json.error, /abgelehnt/);
  assert.equal((await call('PUT', '/api/mail', { port: 99999 })).status, 400);
  assert.equal((await call('PUT', '/api/mail', { to: 'kein-mail' })).status, 400);
  // Passwort löschen
  await call('PUT', '/api/mail', { clearPassword: true });
  assert.equal((await call('GET', '/api/mail')).json.passwordSet, false);
  close();
});

test('Update-Schutz: Pools im Format einer älteren Version (ohne vdev-Baum) bringen die Übersicht nicht zum Absturz', async () => {
  const { call, close, db, engine } = await boot();
  const old = { name: 'tank', state: 'ONLINE', scan: 'scrub repaired 0B in 05:10:12 with 0 errors on Sun Oct 11 05:34:13 2026', errors: 'No known data errors', busy: false, level: 'ok', findings: [] };
  const hs = db.getHostState('pve');
  db.setHostState('pve', { ...hs, pools: [old] });
  const o = await call('GET', '/api/overview');
  assert.equal(o.status, 200, JSON.stringify(o.json));
  const tank = o.json.hosts.find((h) => h.id === 'pve').pools[0];
  assert.deepEqual(tank.vdevs, []);
  assert.equal(tank.scan.state, 'finished', 'der alte Scrub-Text wird weiterhin ausgewertet');
  assert.equal((await call('GET', '/api/stats')).status, 200);
  assert.equal((await call('GET', '/api/tests')).status, 200);
  // ... und die nächste Abfrage ersetzt sie durch die neue Form
  await engine.pollHost('pve');
  assert.ok(db.getHostState('pve').pools.find((p) => p.name === 'tank').vdevs.length > 0);
  close();
});

test('Backups und Snapshots: Gäste, Snapshot-Stand, Backup-Läufe und Zustand der Snapshot-Skripte aus deinen Skripten', async () => {
  const { call, close, engine } = await boot();
  await engine.pollHost('router', { force: true }); await engine.pollHost('pve', { force: true }); await engine.pollHost('pbs', { force: true });
  const b = (await call('GET', '/api/backups')).json;
  const pve = b.hosts.find((h) => h.id === 'pve'), router = b.hosts.find((h) => h.id === 'router'), pbs = b.hosts.find((h) => h.id === 'pbs');
  // Prüfskript ab Version 4 ist Voraussetzung: der veraltete PBS liefert nichts
  assert.equal(pbs.supported, false);
  assert.equal(pbs.guests.length, 0);
  assert.equal(pve.supported, true);
  assert.equal(pve.guests.length, 16);
  // proxmox-autosnap: Aufbewahrung, Pausentag und Cron kommen aus dem Wrapper, nicht aus Annahmen
  assert.deepEqual(pve.autosnap.keep, { hourly: 8, weekly: 1, monthly: 1 });
  assert.equal(pve.autosnap.pauseDay, 1);
  assert.equal(pve.autosnap.enabled, true);
  assert.deepEqual(pve.autosnap.cron.map((c) => c.text), ['stündlich um :05', 'wöchentlich So 00:25', 'monatlich am 1. und 2. um 00:45']);
  // Snapshots
  const g112 = pve.guests.find((g) => g.vmid === 112);
  assert.equal(g112.snapshots.hourly.count, 8);
  assert.equal(g112.snapshots.weekly.count, 1);
  assert.equal(g112.tagged, true);
  assert.equal(pve.guests.find((g) => g.vmid === 141).tagged, false, 'ohne Tag keine Snapshots erwartet');
  // wöchentlicher Snapshot fehlt bei 119/161 auf dem pve: Hinweis, kein Alarm
  const g119 = pve.guests.find((g) => g.vmid === 119);
  assert.ok(g119.findings.some((f) => f.level === 'info' && /wöchentlich/.test(f.text)));
  assert.equal(g119.level, 'info');
  // Backups: Läufe mit Protokoll, ein Fehlschlag auf dem pve
  assert.ok(pve.tasks.length >= 5);
  const bad = pve.tasks.find((x) => x.failed > 0);
  assert.ok(bad, 'Fehlschlag vom 12.10. ist im Verlauf');
  assert.equal(bad.guests.find((x) => x.result === 'failed').vmid, 164);
  assert.equal(router.guests.find((g) => g.vmid === 109).backup.result, 'ok', 'Router sichert alle Gäste, der pve schließt 109 aus');
  assert.equal(pve.guests.find((g) => g.vmid === 109).backup, null, 'ausgeschlossen: kein Backup bekannt, kein Alarm');
  assert.ok(b.lastRun && b.kpi.guests === 24);
  close();
});

test('Backups: Abfrage höchstens einmal pro Stunde, außer auf Knopfdruck', async () => {
  const { engine, db } = await boot();
  let calls = 0; const orig = engine.client('pve').guests.bind(engine.client('pve')); engine.client('pve').guests = async () => { calls++; return orig(); };
  await engine.pollHost('pve', { force: true }); assert.equal(calls, 1);
  await engine.pollHost('pve'); assert.equal(calls, 1, 'zweite Abfrage direkt danach liest die Backup-Daten nicht neu');
  assert.ok(db.guestsOf('pve').length > 0);
  await engine.pollHost('pve', { force: true }); assert.equal(calls, 2);
});

test('Backups: Verbindungsausfall zum PBS wird als Ursache des Laufs angezeigt, laufender Lauf getrennt davon', async () => {
  const { call, close, engine, db } = await boot();
  await engine.pollHost('pve', { force: true });
  const now = engine.now().getTime();
  // Beendeter Lauf, bei dem alle Gäste an der Verbindung scheitern (PBS war zwischendurch aus)
  const failed = 'wirklich fehlgeschlagener Lauf';
  const up = 'UPID:pve:0000FFFF:00000001:6543210A:vzdump::root@pam:';
  db.upsertTask('pve', { upid: up, start: now - 20 * 3600e3, end: now - 20 * 3600e3 + 3 * 60e3, status: 'job errors', user: 'root@pam' });
  db.setTaskResult(up, 'errors', [112, 118, 121, 164].map((vmid) => ({ vmid, type: 'lxc', result: 'failed', seconds: null, note: 'error trying to connect: tcp connect error', cause: 'verbindung', detail: 'x' })));
  // Neuerer, noch laufender Lauf (kein Ende)
  db.upsertTask('pve', { upid: 'UPID:pve:0000EEEE:00000002:6543210B:vzdump::root@pam:', start: now - 30 * 60e3, end: null, status: null, user: 'root@pam' });
  const pve = (await call('GET', '/api/backups')).json.hosts.find((h) => h.id === 'pve');
  assert.ok(pve.runningJob, 'laufender Lauf wird erkannt');
  assert.equal(pve.runningJob.parsed, false, 'unfertige Läufe werden nicht ausgewertet');
  const lr = pve.lastRun;
  assert.equal(lr.upid, up, failed);
  assert.equal(lr.summary.cause, 'verbindung');
  assert.equal(lr.summary.failed, 4);
  const g = pve.guests.find((x) => x.vmid === 118);
  assert.equal(g.backup.cause, 'verbindung');
  assert.match(g.findings.find((f) => f.level === 'replace').text, /Verbindung zum PBS/);
  assert.doesNotMatch(g.findings.find((f) => f.level === 'replace').text, /lxc-usernsexec/, 'kein abgeschnittener Befehl mehr als Begründung');
  assert.equal((await call('GET', '/api/backups')).json.kpi.failedCause, 'verbindung');
  close();
});

test('Update-Schutz: Backup-Tabellen einer älteren Version werden ergänzt und die Protokolle neu gelesen', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const path = await import('node:path');
  const dir = mkdtempSync(path.join(tmpdir(), 'bk-mig-'));
  const old = new DatabaseSync(path.join(dir, 'disktool.sqlite'));
  old.exec("CREATE TABLE backup_task (upid TEXT PRIMARY KEY, host_id TEXT NOT NULL, start INTEGER, end INTEGER, status TEXT, user TEXT, job TEXT, parsed INTEGER DEFAULT 0); CREATE TABLE backup_guest (upid TEXT NOT NULL, vmid INTEGER NOT NULL, type TEXT, result TEXT, seconds INTEGER, note TEXT, PRIMARY KEY (upid, vmid)); INSERT INTO backup_task VALUES('U','pve',1,2,'OK','root@pam','ok',1); INSERT INTO backup_guest VALUES('U',101,'qemu','failed',NULL,'abgeschnitten');");
  old.close();
  const db2 = openDb(dir);
  assert.equal(db2.unparsedTasks('pve').length, 1, 'der Lauf wird neu gelesen, damit der Fehlergrund erscheint');
  assert.equal(db2.taskGuests('U')[0].cause, null);
  db2.close();
});
