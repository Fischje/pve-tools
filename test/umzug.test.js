// Prüft das einmalige Umzugsskript (pve-disk-tool -> pve-tools) in einem Sandkasten: alle festen Pfade werden umgebogen,
// systemctl, curl und sleep sind Attrappen. Erfolgsfall und Rückweg bei einem Fehler.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, chmodSync, readlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function sandbox({ healthOk = true } = {}) {
  const T = mkdtempSync(path.join(tmpdir(), 'umzug-'));
  const P = (...f) => path.join(T, ...f);
  for (const d of ['opt', 'etc', 'root', 'bin', 'tmp']) mkdirSync(P(d));
  const alt = P('opt', 'pve-disk-tool');
  mkdirSync(path.join(alt, '.git'), { recursive: true }); mkdirSync(path.join(alt, 'data'));
  writeFileSync(path.join(alt, 'data', 'disktool.sqlite'), 'DB'); writeFileSync(path.join(alt, 'data', 'disktool.sqlite-wal'), 'WAL');
  writeFileSync(path.join(alt, 'install-sync.sh'), `#!/usr/bin/env bash\necho install-sync >> "${P('aufrufe.log')}"\n`); chmodSync(path.join(alt, 'install-sync.sh'), 0o755);
  writeFileSync(P('etc', 'pve-disk-tool.service'), `[Unit]\nDescription=pve-disk-tool (Platten-Gesundheit, nur LAN)\n\n[Service]\nWorkingDirectory=/opt/pve-disk-tool\nEnvironment=DATA_DIR=/opt/pve-disk-tool/data\nEnvironment=PORT=8080\nEnvironment=LISTEN=192.168.1.20\nExecStart=/usr/bin/node src/server.js\n`);
  const fake = (n, body) => { writeFileSync(P('bin', n), `#!/usr/bin/env bash\n${body}\n`); chmodSync(P('bin', n), 0o755); };
  fake('systemctl', `echo "systemctl $*" >> "${P('aufrufe.log')}"; exit 0`);
  fake('curl', `echo "curl $*" >> "${P('aufrufe.log')}"; exit ${healthOk ? 0 : 7}`);
  fake('sleep', 'exit 0');
  fake('git', 'exit 0');
  // Feste Pfade im Skript auf den Sandkasten umbiegen (in der Unit stehen weiter die echten Pfade, das Skript ersetzt sie).
  const src = readFileSync('umzug-pve-tools.sh', 'utf8')
    .replace('ALT=/opt/pve-disk-tool', `ALT=${alt}`).replace('NEU=/opt/pve-tools', `NEU=${P('opt', 'pve-tools')}`)
    .replace('ALT_UNIT=/etc/systemd/system/pve-disk-tool.service', `ALT_UNIT=${P('etc', 'pve-disk-tool.service')}`)
    .replace('NEU_UNIT=/etc/systemd/system/pve-tools.service', `NEU_UNIT=${P('etc', 'pve-tools.service')}`)
    .replace('SICHERUNG="/root/pve-disk-tool.service.vor-umzug"', `SICHERUNG="${P('root', 'sicherung.service')}"`)
    .replaceAll('/tmp/pve-disk-tool-sync.lock', P('tmp', 'a.lock')).replaceAll('/tmp/pve-tools-sync.lock', P('tmp', 'b.lock'))
    .replace('[[ $EUID -eq 0 ]] || fail "Bitte als root ausführen."', '');
  // Die Unit enthält die echten Pfade: für den Test auf den Sandkasten umschreiben, damit Datenordner und Ersetzung zusammenpassen.
  writeFileSync(P('etc', 'pve-disk-tool.service'), readFileSync(P('etc', 'pve-disk-tool.service'), 'utf8').replaceAll('/opt/pve-disk-tool', alt));
  writeFileSync(P('umzug.sh'), src);
  const run = () => spawnSync('bash', [P('umzug.sh')], { env: { PATH: `${P('bin')}:${process.env.PATH}` }, encoding: 'utf8' });
  const log = () => (existsSync(P('aufrufe.log')) ? readFileSync(P('aufrufe.log'), 'utf8') : '');
  return { T, P, alt, neu: P('opt', 'pve-tools'), run, log };
}

test('Umzug: Ordner, Datenbank, Dienst und Abgleich laufen danach unter pve-tools, alter Pfad bleibt als Verweis', () => {
  const s = sandbox();
  const r = s.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.ok(lstatSync(s.alt).isSymbolicLink() && readlinkSync(s.alt) === s.neu);
  assert.equal(readFileSync(path.join(s.neu, 'data', 'pvetools.sqlite'), 'utf8'), 'DB');
  assert.equal(readFileSync(path.join(s.neu, 'data', 'pvetools.sqlite-wal'), 'utf8'), 'WAL');
  assert.ok(!existsSync(path.join(s.neu, 'data', 'disktool.sqlite')));
  const unit = readFileSync(s.P('etc', 'pve-tools.service'), 'utf8');
  assert.match(unit, new RegExp(`WorkingDirectory=${s.neu}\\n`));
  assert.match(unit, new RegExp(`DATA_DIR=${s.neu}/data\\n`));
  assert.match(unit, /^Description=PVE-Tools/m);
  assert.match(unit, /LISTEN=192\.168\.1\.20/);
  assert.ok(!existsSync(s.P('etc', 'pve-disk-tool.service')));
  const log = s.log();
  assert.match(log, /systemctl stop pve-disk-tool-sync\.timer[\s\S]*systemctl stop pve-disk-tool\n[\s\S]*systemctl enable --now pve-tools\n[\s\S]*curl .*192\.168\.1\.20:8080[\s\S]*install-sync/);
  // zweiter Aufruf: nichts mehr zu tun
  const again = s.run();
  assert.equal(again.status, 0); assert.match(again.stdout, /Schon umgezogen/);
});

test('Umzug: antwortet der neue Dienst nicht, wird alles zurückgesetzt und der alte Dienst läuft wieder', () => {
  const s = sandbox({ healthOk: false });
  const r = s.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Zurückgesetzt/);
  assert.ok(lstatSync(s.alt).isDirectory() && !lstatSync(s.alt).isSymbolicLink());
  assert.ok(!existsSync(s.neu));
  assert.equal(readFileSync(path.join(s.alt, 'data', 'disktool.sqlite'), 'utf8'), 'DB');
  assert.ok(existsSync(path.join(s.alt, 'data', 'disktool.sqlite-wal')));
  assert.ok(existsSync(s.P('etc', 'pve-disk-tool.service')) && !existsSync(s.P('etc', 'pve-tools.service')));
  assert.match(s.log(), /systemctl enable --now pve-disk-tool\n[\s\S]*systemctl start pve-disk-tool-sync\.timer/);
  assert.doesNotMatch(s.log(), /install-sync/);
});

test('Umzug: bricht ab, wenn der Zielordner schon existiert', () => {
  const s = sandbox();
  mkdirSync(s.neu);
  const r = s.run();
  assert.notEqual(r.status, 0); assert.match(r.stderr, /gibt es schon/);
  assert.equal(s.log(), '', 'nichts angehalten');
});
