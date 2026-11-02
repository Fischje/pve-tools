import test from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { HostClient } from '../src/hostapi.js';
import { DemoWorld, DemoTransport } from '../src/demo/world.js';
import { Notifier, cleanMail } from '../src/notify.js';

async function setup({ polled = true } = {}) {
  let t = new Date(2026, 10, 3, 9, 0).getTime();
  const clock = () => new Date(t);
  const world = new DemoWorld(clock, { testMinutes: 10 });
  const db = openDb(null);
  const engine = new Engine({ db, hosts: world.hosts, now: clock, makeClient: (h) => new HostClient(new DemoTransport(world, h.id)) });
  const mails = []; const fail = { on: false };
  const notifier = new Notifier({ db, engine, send: async (m) => { if (fail.on) throw new Error('Verbindung abgelehnt'); mails.push(m); } });
  engine.notifier = notifier;
  if (polled) for (const h of world.hosts) await engine.pollHost(h.id);
  const mailCfg = { enabled: true, host: 'mail.example.org', port: 587, security: 'starttls', user: 'u', from: 'platten@example.org', to: 'admin@example.org', baseUrl: 'http://192.168.1.20:8080' };
  const enable = (extra = {}) => notifier.save({ ...mailCfg, ...extra }, { password: 'geheim123' });
  return { world, db, engine, notifier, mails, fail, enable, advance: (m) => { t += m * 60000; } };
}
const sample = (world, host, dev) => world.disk(host, dev).json;

test('Beim Einschalten werden bestehende Probleme still als bekannt gemerkt, keine Mailflut', async () => {
  const { engine, mails, enable } = await setup();
  enable();
  for (const h of ['router', 'pve', 'pbs']) await engine.pollHost(h);
  assert.equal(mails.length, 0);
});

test('ausgeschaltet oder unvollständig: keine Mails', async () => {
  const { engine, world, mails, notifier } = await setup();
  sample(world, 'pve', '/dev/nvme0n1').nvme_smart_health_information_log.percentage_used = 95;
  await engine.pollHost('pve');
  assert.equal(mails.length, 0);
  assert.equal(notifier.ready(), false);
});

test('Platte wechselt auf „Bald tauschen“: genau eine Mail, nicht bei jeder Abfrage', async () => {
  const { engine, world, mails, enable } = await setup();
  enable();
  sample(world, 'pve', '/dev/nvme0n1').nvme_smart_health_information_log.percentage_used = 95;
  await engine.pollHost('pve'); await engine.pollHost('pve'); await engine.pollHost('pve');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /\[Platten\] pve: Samsung SSD 980 1TB – Bald tauschen/);
  assert.match(mails[0].text, /Seriennummer: S649NL0T759253H/);
  assert.match(mails[0].text, /Was tun\?/);
  assert.match(mails[0].text, /http:\/\/192\.168\.1\.20:8080/);
  assert.deepEqual(mails[0].to, ['admin@example.org']);
  assert.equal(mails[0].password, 'geheim123');
});

test('Verschlechterung auf „Kritisch“ meldet erneut, Rückkehr zu „Gesund“ schickt Entwarnung', async () => {
  const { engine, world, mails, enable } = await setup();
  enable();
  const h = sample(world, 'pve', '/dev/nvme0n1').nvme_smart_health_information_log;
  h.percentage_used = 95; await engine.pollHost('pve');
  h.percentage_used = 100; await engine.pollHost('pve');
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /Kritisch/);
  h.percentage_used = 99; await engine.pollHost('pve'); // 99 % = „Bald tauschen“: Verbesserung, keine Mail
  assert.equal(mails.length, 2);
  h.percentage_used = 9; await engine.pollHost('pve');
  assert.equal(mails.length, 3);
  assert.match(mails[2].subject, /wieder in Ordnung/);
});

test('Entwarnungen lassen sich abschalten', async () => {
  const { engine, world, mails, enable } = await setup();
  enable({ notify: { disk: true, pool: true, test: true, recovery: false } });
  const h = sample(world, 'pve', '/dev/nvme0n1').nvme_smart_health_information_log;
  h.percentage_used = 95; await engine.pollHost('pve'); h.percentage_used = 9; await engine.pollHost('pve');
  assert.equal(mails.length, 1);
});

test('Platten-Mails lassen sich abschalten', async () => {
  const { engine, world, mails, enable } = await setup();
  enable({ notify: { disk: false, pool: true, test: true, recovery: true } });
  sample(world, 'pve', '/dev/nvme0n1').nvme_smart_health_information_log.percentage_used = 95;
  await engine.pollHost('pve');
  assert.equal(mails.length, 0);
});

test('ZFS: neuer Fehlerzähler und DEGRADED werden gemeldet, steigende Zahlen nicht erneut', async () => {
  const { engine, world, mails, enable } = await setup();
  enable();
  const tank = world.hosts.find((x) => x.id === 'pve').pools.find((p) => p.name === 'tank');
  await engine.pollHost('pve');
  assert.equal(mails.length, 0, 'der bekannte Prüfsummenfehler an der Seagate wurde beim Einschalten als bekannt gemerkt');
  tank.vdevs[0].devs[0].c = 2; await engine.pollHost('pve');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /\[ZFS\] pve: Pool tank/);
  tank.vdevs[0].devs[0].c = 9; tank.vdevs[0].devs[2].c = 7; await engine.pollHost('pve');
  assert.equal(mails.length, 1, 'höhere Zahlen sind kein neuer Anlass');
  tank.state = 'DEGRADED'; await engine.pollHost('pve');
  assert.equal(mails.length, 2);
  assert.match(mails[1].text, /DEGRADED/);
});

test('ZFS: alles wieder gut => Entwarnung', async () => {
  const { engine, world, mails, enable } = await setup();
  enable();
  const tank = world.hosts.find((x) => x.id === 'pve').pools.find((p) => p.name === 'tank');
  tank.vdevs[0].devs[0].c = 2; await engine.pollHost('pve');
  tank.vdevs[0].devs.forEach((d) => { d.c = 0; }); await engine.pollHost('pve');
  assert.equal(mails.length, 2);
  assert.match(mails[1].subject, /wieder in Ordnung/);
});

test('fehlgeschlagener Selbsttest: eine Mail, unterbrochener Test keine', async () => {
  const { engine, db, world, mails, enable, advance } = await setup();
  enable();
  const nv = db.disksOfHost('router').find((d) => d.device === '/dev/nvme0n1');
  await engine.startNow('router', nv.serial, { test: 'long', minutes: 30 }, 'manual');
  world.finish(world.disk('router', '/dev/nvme0n1'), 7);
  advance(20); await engine.pollHost('router'); await engine.pollHost('router');
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /\[Selbsttest\] router: WD Red SN700 500GB – Langtest fehlgeschlagen/);
  await engine.startNow('router', nv.serial, { test: 'long', minutes: 30 }, 'manual');
  world.finish(world.disk('router', '/dev/nvme0n1'), 2); // unterbrochen
  advance(20); await engine.pollHost('router');
  assert.equal(mails.length, 1);
});

test('Mailserver nicht erreichbar: es wird später erneut versucht und nur einmal im Protokoll gemeldet', async () => {
  const { engine, db, world, mails, fail, enable } = await setup();
  enable();
  sample(world, 'pve', '/dev/nvme0n1').nvme_smart_health_information_log.percentage_used = 95;
  fail.on = true;
  await engine.pollHost('pve'); await engine.pollHost('pve'); await engine.pollHost('pve');
  assert.equal(mails.length, 0);
  assert.equal(db.events().filter((e) => /Mail konnte nicht gesendet werden/.test(e.text)).length, 1);
  fail.on = false; await engine.pollHost('pve');
  assert.equal(mails.length, 1, 'beim nächsten Versuch geht die Mail raus');
});

test('Testmail und Zusammenfassung', async () => {
  const { notifier, mails, enable } = await setup();
  await assert.rejects(notifier.sendTest(), /Server, Absender und Empfänger/);
  enable();
  await notifier.sendTest();
  assert.match(mails[0].subject, /Testmail/);
  await notifier.sendDigest();
  assert.match(mails[1].subject, /Zusammenfassung: 2 Platten brauchen Aufmerksamkeit/);
  assert.match(mails[1].text, /WDC WDS500G2B0A-00SM50 \(\/dev\/sda\): Bald tauschen/);
  assert.match(mails[1].text, /Pool tank/);
});

test('Passwort wird nie in der öffentlichen Konfiguration ausgegeben', async () => {
  const { notifier, enable } = await setup();
  enable();
  const pub = notifier.publicConfig();
  assert.equal(pub.passwordSet, true);
  assert.ok(!JSON.stringify(pub).includes('geheim123'));
  notifier.save({}, { clearPassword: true });
  assert.equal(notifier.publicConfig().passwordSet, false);
});

test('Einstellungen werden geprüft', () => {
  assert.throws(() => cleanMail({ port: 0 }), /Port/);
  assert.throws(() => cleanMail({ security: 'egal' }), /Verschlüsselung/);
  assert.throws(() => cleanMail({ from: 'kaputt' }), /Absender/);
  assert.throws(() => cleanMail({ to: 'a@b.de, nope' }), /keine gültige Adresse/);
  assert.throws(() => cleanMail({ to: 'a@b.de b@b.de c@b.de d@b.de e@b.de f@b.de' }), /höchstens 5/);
  assert.throws(() => cleanMail({ host: 'mail.example.org\r\nX' }), /ungültig/);
  assert.throws(() => cleanMail({ baseUrl: 'javascript:alert(1)' }), /http/);
  assert.deepEqual(cleanMail({ to: 'a@b.de; c@d.de', port: '465', security: 'ssl' }), { to: 'a@b.de, c@d.de', port: 465, security: 'ssl' });
});
