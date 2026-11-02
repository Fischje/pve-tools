import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.js';
import { Engine } from '../src/engine.js';
import { Auth } from '../src/auth.js';
import { Provisioner, buildRemoteScript, shq, writeHostsFile } from '../src/provision.js';
// Server immer schließen, auch wenn ein Test vorher fehlschlägt (sonst hängt der Lauf).
const openApps = [];
after(() => { for (const a of openApps) { a.closeAllConnections?.(); a.close(); } });
import { createApp } from '../src/server.js';
import { EXPECTED_GATE_VERSION } from '../src/gate-version.js';

const PUB = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPubkeyPubkeyPubkeyPubkeyPubkeyPubkey diskmon@pve-disk-tool';
const FP = `SHA256:${'A'.repeat(43)}`;
const PW = 'root-Passwort/mit\'Sonderzeichen"$x';

test('Fernskript: Dateien werden abgelegt, Argumente richtig übergeben, Quell-IP aus SSH_CONNECTION', () => {
  const stub = '#!/usr/bin/env bash\necho "ARGS:$*"; test -f "$(dirname "$0")/gate.sh" && echo "GATE-DA"\n';
  const run = (o) => spawnSync('bash', ['-s'], { input: buildRemoteScript({ gate: '#!/bin/bash\necho gate\n', setup: stub, publicKey: PUB, ...o }), env: { PATH: process.env.PATH, SSH_CONNECTION: '192.168.1.20 5555 192.168.1.11 22' }, encoding: 'utf8' });
  let r = run({ action: 'install', bindIp: true });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`ARGS:${PUB.replace(/[+/]/g, '\\$&')} 192\\.168\\.1\\.20`));
  assert.match(r.stdout, /GATE-DA/);
  r = run({ action: 'install', bindIp: false });
  assert.doesNotMatch(r.stdout, /192\.168\.1\.20/);
  r = run({ action: 'remove', bindIp: true });
  assert.match(r.stdout, /ARGS:--entfernen/);
});

test('Fernskript: bösartiger Schlüssel wird abgelehnt, Zitieren ist sicher', () => {
  assert.throws(() => buildRemoteScript({ gate: 'g', setup: 's', publicKey: `ssh-ed25519 AAAA'; rm -rf / #`, action: 'install' }), /Ungültiger/);
  assert.throws(() => buildRemoteScript({ gate: 'g', setup: 's', publicKey: 'ssh-ed25519 AAAA\nsudo reboot', action: 'install' }));
  assert.equal(shq("a'b"), `'a'\\''b'`);
});

test('echte Skripte: Syntax des erzeugten Fernskripts', () => {
  const gate = readFileSync('host-setup/gate.sh', 'utf8'), setup = readFileSync('host-setup/setup-host.sh', 'utf8');
  const script = buildRemoteScript({ gate, setup, publicKey: PUB, action: 'install', bindIp: true, installPackages: true });
  assert.equal(spawnSync('bash', ['-n'], { input: script }).status, 0);
  assert.match(script, /DISKMON_PAKETE_INSTALLIEREN=1/);
});

function setup({ ssh, resolve, makeClientFails = false } = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'prov-'));
  const tmp = mkdtempSync(path.join(tmpdir(), 'prov-tmp-'));
  const calls = [];
  const runner = async (cmd, args, o = {}) => {
    calls.push({ cmd, args, env: o.env, input: o.input });
    if (cmd === 'ssh-keyscan') return { code: 0, stdout: `# 192.168.1.11:22 SSH-2.0\n${args.at(-1)} ssh-ed25519 AAAAhostkey\n`, stderr: '' };
    if (cmd === 'ssh-keygen' && args[0] === '-lf') return { code: 0, stdout: `256 ${FP} ${'x'} (ED25519)\n`, stderr: '' };
    if (cmd === 'ssh-keygen') { const f = args[args.indexOf('-f') + 1]; writeFileSync(f, 'PRIVATE'); writeFileSync(`${f}.pub`, `${PUB}\n`); return { code: 0, stdout: '', stderr: '' }; }
    if (cmd === 'ssh') return ssh ? ssh(args, o) : { code: 0, stdout: 'Fertig.', stderr: '' };
    throw new Error(`unerwartet: ${cmd}`);
  };
  const gate = { version: EXPECTED_GATE_VERSION };
  const client = { gateVersion: async () => gate.version, uptime: async () => 100, listDisks: async () => [{ device: '/dev/sda' }], zpool: async () => [], smart: async () => { throw new Error('egal'); } };
  const engine = new Engine({ db: openDb(null), hosts: [], makeClient: () => { if (makeClientFails) return { uptime: async () => { throw new Error('Permission denied'); } }; return client; } });
  const persisted = [];
  const prov = new Provisioner({ engine, dataDir, repoDir: path.resolve('.'), persist: async (h) => { persisted.push(JSON.parse(JSON.stringify(h))); }, runner, resolve: resolve ?? (async (a) => (a.startsWith('192.168.') ? [a] : ['8.8.8.8'])), tmp });
  const known = { pinned: true };
  prov.runner = async (cmd, args, o) => (cmd === 'ssh-keygen' && args[0] === '-F' ? { code: known.pinned ? 0 : 1, stdout: known.pinned ? 'x ssh-ed25519 AAAA' : '', stderr: '' } : runner(cmd, args, o));
  return { prov, engine, calls, persisted, dataDir, tmp, gate, known };
}
const req = (o = {}) => ({ id: 'pve', label: 'pve', address: '192.168.1.11', port: 22, kind: 'fest', window: { from: '08:00', to: '22:00' }, password: PW, fingerprint: FP, ...o });

test('Fingerabdruck holen', async () => {
  const { prov } = setup();
  const r = await prov.scan({ address: '192.168.1.11', port: 22 });
  assert.equal(r.keys[0].sha256, FP);
  assert.equal(r.keys[0].type, 'ED25519');
});

test('nur Hosts im lokalen Netz, Adresse wird geprüft', async () => {
  const { prov } = setup();
  await assert.rejects(prov.scan({ address: 'example.com', port: 22 }), /lokalen Netz/);
  await assert.rejects(prov.scan({ address: '192.168.1.1; rm -rf /', port: 22 }), /Ungültige Adresse/);
  await assert.rejects(prov.scan({ address: '192.168.1.11', port: 99999 }), /Port/);
});

test('Einrichtung: Passwort nur über Umgebungsvariable, nie in Argumenten/Eingabe/Antwort; Host wird aufgenommen', async () => {
  const { prov, engine, calls, persisted, tmp } = setup({ ssh: () => ({ code: 0, stdout: `Fertig. (Passwort war ${PW})`, stderr: '' }) });
  const r = await prov.run(req());
  assert.equal(r.ok, true, JSON.stringify(r));
  const ssh = calls.find((c) => c.cmd === 'ssh');
  assert.equal(ssh.env.DISKTOOL_PW, PW);
  assert.equal(ssh.env.SSH_ASKPASS_REQUIRE, 'force');
  assert.ok(!JSON.stringify(ssh.args).includes(PW), 'Passwort steht in den Argumenten');
  assert.ok(!ssh.input.includes(PW), 'Passwort steht im Fernskript');
  assert.ok(!JSON.stringify(r).includes(PW), 'Passwort steht in der Antwort');
  assert.ok(ssh.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(ssh.args.includes('PubkeyAuthentication=no'));
  assert.ok(ssh.args.includes('root@192.168.1.11'));
  assert.deepEqual(readdirSync(tmp), [], 'Hilfsdatei (askpass) wurde aufgeräumt');
  assert.equal(engine.hosts.length, 1);
  assert.equal(persisted.at(-1)[0].id, 'pve');
  assert.deepEqual(persisted.at(-1)[0].window, { from: '08:00', to: '22:00' });
  assert.ok(!JSON.stringify(persisted).includes(PW));
});

test('Fingerabdruck fehlt oder stimmt nicht => Abbruch, nichts verbunden', async () => {
  const { prov, calls } = setup();
  await assert.rejects(prov.run(req({ fingerprint: '' })), /Fingerabdruck/);
  await assert.rejects(prov.run(req({ fingerprint: `SHA256:${'B'.repeat(43)}` })), /geändert/);
  assert.ok(!calls.some((c) => c.cmd === 'ssh'));
});

test('falsches Passwort: verständliche Meldung, Host wird nicht aufgenommen', async () => {
  const { prov, engine } = setup({ ssh: () => ({ code: 255, stdout: '', stderr: 'root@192.168.1.11: Permission denied (publickey,password).' }) });
  const r = await prov.run(req());
  assert.equal(r.ok, false);
  assert.match(r.error, /Passwort ist falsch/);
  assert.equal(engine.hosts.length, 0);
});

test('Einrichtung ok, aber neuer Zugang funktioniert nicht: Host nicht aufgenommen, Hinweis auf die Quell-IP', async () => {
  const { prov, engine } = setup({ makeClientFails: true });
  const r = await prov.run(req());
  assert.equal(r.ok, false);
  assert.match(r.error, /Quell-IP/);
  assert.equal(engine.hosts.length, 0);
});

test('Kennung und Art werden geprüft, doppelte Kennung abgelehnt', async () => {
  const { prov } = setup();
  await assert.rejects(prov.run(req({ id: 'Mein Host!' })), /Kennung/);
  await assert.rejects(prov.run(req({ kind: 'irgendwas' })), /Host-Art/);
  assert.equal((await prov.run(req())).ok, true);
  await assert.rejects(prov.run(req()), /schon/);
});

test('Zugang entfernen (und optional aus der Liste löschen)', async () => {
  const { prov, engine, calls } = setup();
  await prov.run(req());
  const r = await prov.run({ hostId: 'pve', action: 'remove', password: PW, fingerprint: FP, removeFromList: true });
  assert.equal(r.ok, true);
  assert.match(calls.filter((c) => c.cmd === 'ssh').at(-1).input, /--entfernen/);
  assert.equal(engine.hosts.length, 0);
});

test('Schlüsselpaar wird beim ersten Mal erzeugt, Rechte siehe Datei', async () => {
  const { prov, dataDir } = setup();
  assert.equal(await prov.publicKey(), PUB);
  assert.ok(existsSync(path.join(dataDir, 'ssh', 'id_ed25519')));
});

test('hosts.json wird atomar geschrieben', async () => {
  const f = path.join(mkdtempSync(path.join(tmpdir(), 'hosts-')), 'hosts.json');
  await writeHostsFile(f, [{ id: 'a' }]);
  assert.deepEqual(JSON.parse(readFileSync(f, 'utf8')), [{ id: 'a' }]);
});

// ---- Server ----
async function boot({ withProvisioner = true } = {}) {
  const s = setup();
  const db = s.engine.db;
  const auth = new Auth(db);
  const app = createApp({ db, engine: s.engine, auth, allowPublic: true, provisioner: withProvisioner ? s.prov : null });
  openApps.push(app);
  await new Promise((r) => app.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.address().port}`;
  let cookie = '';
  const call = async (method, p, body) => {
    const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'disktool', ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const set = r.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    return { status: r.status, json: await r.json().catch(() => ({})) };
  };
  return { call, close: () => app.close(), ...s };
}

test('Server: Einrichtung nur mit gesetztem Oberflächen-Passwort', async () => {
  const { call, close } = await boot();
  assert.equal((await call('POST', '/api/setup/fingerprint', { address: '192.168.1.11' })).status, 403);
  await call('POST', '/api/auth/password', { password: 'sehr-geheim-123' });
  const fp = await call('POST', '/api/setup/fingerprint', { address: '192.168.1.11' });
  assert.equal(fp.status, 200);
  assert.equal(fp.json.keys[0].sha256, FP);
  const run = await call('POST', '/api/setup/run', req());
  assert.equal(run.status, 200);
  assert.equal(run.json.ok, true);
  assert.ok(!JSON.stringify(run.json).includes(PW));
  assert.equal((await call('DELETE', '/api/hosts/pve')).status, 200);
  close();
});

test('Server: im Demo-Modus nicht verfügbar, öffentliche Adressen abgelehnt, Fehlversuche begrenzt', async () => {
  const demo = await boot({ withProvisioner: false });
  assert.equal((await demo.call('POST', '/api/setup/fingerprint', { address: '192.168.1.11' })).status, 400);
  demo.close();
  const { call, close } = await boot();
  await call('POST', '/api/auth/password', { password: 'sehr-geheim-123' });
  assert.equal((await call('POST', '/api/setup/fingerprint', { address: 'example.com' })).status, 400);
  for (let i = 0; i < 4; i++) await call('POST', '/api/setup/fingerprint', { address: 'example.com' });
  assert.equal((await call('POST', '/api/setup/fingerprint', { address: '192.168.1.11' })).status, 429);
  close();
});

test('Aktualisieren: nur Passwort nötig, Fingerabdruck stammt von der Einrichtung', async () => {
  const { prov, calls, gate } = setup();
  await prov.run(req());
  gate.version = EXPECTED_GATE_VERSION;
  const r = await prov.run({ hostId: 'pve', action: 'update', password: PW });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.updated, true);
  const ssh = calls.filter((c) => c.cmd === 'ssh').at(-1);
  assert.ok(ssh.args.includes('StrictHostKeyChecking=yes'));
  assert.doesNotMatch(ssh.input, /bash "\$T\/setup-host\.sh" --entfernen/);
  assert.match(ssh.input, /bash "\$T\/setup-host\.sh" 'ssh-ed25519/);
  assert.ok(!JSON.stringify(r).includes(PW));
});

test('Aktualisieren: ohne gespeicherten Fingerabdruck oder unbekannten Host abgelehnt', async () => {
  const { prov, known } = setup();
  await prov.run(req());
  known.pinned = false;
  await assert.rejects(prov.run({ hostId: 'pve', action: 'update', password: PW }), /Fingerabdruck gespeichert/);
  await assert.rejects(prov.run({ action: 'update', password: PW }), /bekannt/);
});

test('Aktualisieren: meldet der Host danach noch die alte Version, ist das ein Fehler', async () => {
  const { prov, gate } = setup();
  await prov.run(req());
  gate.version = 1;
  const r = await prov.run({ hostId: 'pve', action: 'update', password: PW });
  assert.equal(r.ok, false);
  assert.match(r.error, /Version 1/);
});
