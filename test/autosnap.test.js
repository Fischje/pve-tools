// Prüft den verwalteten Wrapper (host-setup/autosnap-run), die schreibenden Gate-Befehle und die Übernahme der alten Werte beim Einrichten.
// Pfade, die sonst unter /etc und /usr/local liegen, werden für den Test auf ein temporäres Verzeichnis umgebogen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const T = mkdtempSync(path.join(tmpdir(), 'autosnap-'));
const P = (f) => path.join(T, f);
const bin = P('bin'); mkdirSync(bin); mkdirSync(P('cron.d'));
const sub = (text) => text
  .replaceAll('/etc/diskmon/rechte', P('rechte')).replaceAll('/etc/autosnap.conf', P('conf')).replaceAll('/etc/autosnap.disabled', P('disabled'))
  .replaceAll('/usr/local/sbin/autosnap-run', P('autosnap-run')).replaceAll('/usr/local/sbin/proxmox-autosnap.py', P('proxmox-autosnap.py'))
  .replaceAll('/run/diskmon-snap.lock', P('lock')).replaceAll('/etc/cron.d/', P('cron.d') + '/');
const script = (name, body) => { writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
script('date', 'case "$*" in "+%u") echo "${FAKE_U:-3}";; "+%d") echo "${FAKE_D:-15}";; "-d yesterday +%u") echo "${FAKE_YU:-2}";; *) /bin/date "$@";; esac');
script('logger', 'cat >/dev/null');
script('pct', 'if [ "$1" = list ]; then printf "VMID Status Lock Name\\n109 running  a\\n112 stopped  b\\n113 running  c\\n118 running  d\\n"; else case "$2" in 109|112) echo "tags: autosnap;x";; 113) echo "tags: other";; *) echo "tags: autosnap";; esac; fi');
writeFileSync(P('proxmox-autosnap.py'), '#!/usr/bin/env bash\necho "$*" >> "$CALLS"\n'); chmodSync(P('proxmox-autosnap.py'), 0o755);
writeFileSync(P('autosnap-run'), sub(readFileSync('host-setup/autosnap-run', 'utf8'))); chmodSync(P('autosnap-run'), 0o755);
writeFileSync(P('gate.sh'), sub(readFileSync('host-setup/gate.sh', 'utf8'))); chmodSync(P('gate.sh'), 0o755);
const base = { PATH: `${bin}:${process.env.PATH}`, CALLS: P('calls') };
const calls = () => (existsSync(P('calls')) ? readFileSync(P('calls'), 'utf8').trim().split('\n').filter(Boolean) : []);
const reset = () => { for (const f of ['calls', 'conf', 'disabled', 'rechte', 'lock']) spawnSync('rm', ['-f', P(f)]); };
const wrap = (label, env = {}) => spawnSync('bash', [P('autosnap-run'), label], { env: { ...base, ...env }, encoding: 'utf8' });
const gate = (cmd, env = {}) => { const r = spawnSync('bash', [P('gate.sh')], { env: { ...base, ...env, SSH_ORIGINAL_COMMAND: cmd }, encoding: 'utf8' }); return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() }; };

test('Wrapper: ohne Konfiguration die bisherigen Werte (8/1/1, Tag autosnap, alle mit Tag)', () => {
  reset();
  assert.equal(wrap('hourly').status, 0);
  assert.deepEqual(calls(), ['--autosnap --tags autosnap --label hourly --keep 8 --check-free-space --mute']);
  reset(); wrap('weekly'); assert.match(calls()[0], /--label weekly --keep 1 /);
});

test('Wrapper: Werte aus /etc/autosnap.conf, nur laufende Container mit Tag', () => {
  reset();
  writeFileSync(P('conf'), 'KEEP_HOURLY=12\nKEEP_WEEKLY=2\nKEEP_MONTHLY=3\nPAUSE_DAY=0\nMONTHLY_DAY=1\nTAG=autosnap\nONLY_RUNNING=1\nQUATSCH=$(id)\nKEEP_HOURLY=abc\n');
  wrap('hourly', { FAKE_U: '1' }); // Montag, aber kein Pausentag (0)
  assert.deepEqual(calls(), ['--autosnap --vmid 109 118 --label hourly --keep 12 --check-free-space --mute']);
});

test('Wrapper: Pausentag, FORCE und Hauptschalter', () => {
  reset();
  wrap('hourly', { FAKE_U: '1' }); assert.deepEqual(calls(), [], 'Montag ist Pausentag');
  wrap('hourly', { FAKE_U: '1', FORCE: '1' }); assert.equal(calls().length, 1, 'FORCE umgeht den Pausentag');
  reset(); writeFileSync(P('disabled'), '');
  wrap('hourly', { FORCE: '1' }); assert.deepEqual(calls(), [], 'Hauptschalter gilt auch mit FORCE');
  const d = wrap('hourly', { DRYRUN: '1' });
  assert.match(d.stdout, /autosnap-run v2, Bezeichnung hourly, Aufbewahrung 8/);
  assert.match(calls()[0], /--dryrun$/);
  reset(); writeFileSync(P('conf'), 'PAUSE_DAY=3\n');
  wrap('hourly', { FAKE_U: '3' }); assert.deepEqual(calls(), [], 'Pausentag aus der Konfiguration');
});

test('Wrapper: Monatslauf nur am Monatstag, nach einem Pausentag am Folgetag, sonst nicht', () => {
  reset();
  wrap('monthly', { FAKE_D: '01', FAKE_U: '3' }); assert.equal(calls().length, 1);
  reset(); wrap('monthly', { FAKE_D: '15', FAKE_U: '3' }); assert.deepEqual(calls(), []);
  reset(); wrap('monthly', { FAKE_D: '02', FAKE_U: '2', FAKE_YU: '1' }); assert.equal(calls().length, 1, 'der 2., weil der 1. ein Montag (Pausentag) war');
  reset(); wrap('monthly', { FAKE_D: '02', FAKE_U: '4', FAKE_YU: '3' }); assert.deepEqual(calls(), [], 'der 2. ohne Pausentag davor');
  reset(); wrap('monthly', { FAKE_D: '15', FAKE_U: '3', FORCE: '1' }); assert.equal(calls().length, 1, 'FORCE umgeht das Datumsfenster');
  reset(); writeFileSync(P('conf'), 'MONTHLY_DAY=10\n'); wrap('monthly', { FAKE_D: '10', FAKE_U: '3' }); assert.equal(calls().length, 1, 'Monatstag aus der Konfiguration');
  assert.equal(wrap('daily').status, 2);
});

test('Prüfskript: schreibende Befehle brauchen das Recht und prüfen ihre Argumente', () => {
  reset();
  assert.match(gate('snap-conf 8 1 1 1 1').err, /nicht freigegeben/);
  writeFileSync(P('rechte'), 'snapshots\n');
  assert.equal(gate('rechte').out, 'snapshots');
  const ok = gate('snap-conf 12 2 3 7 5');
  assert.equal(ok.code, 0);
  assert.equal(readFileSync(P('conf'), 'utf8'), 'KEEP_HOURLY=12\nKEEP_WEEKLY=2\nKEEP_MONTHLY=3\nPAUSE_DAY=7\nMONTHLY_DAY=5\nTAG=autosnap\nONLY_RUNNING=0\n');
  writeFileSync(P('conf'), 'KEEP_HOURLY=1\nTAG=meintag\nONLY_RUNNING=1\n');
  gate('snap-conf 8 1 1 1 1');
  assert.match(readFileSync(P('conf'), 'utf8'), /TAG=meintag\nONLY_RUNNING=1\n$/, 'Auswahl bleibt erhalten');
  for (const c of ['snap-conf 0 1 1 1 1', 'snap-conf 100 1 1 1 1', 'snap-conf 8 53 1 1 1', 'snap-conf 8 1 37 1 1', 'snap-conf 8 1 1 8 1', 'snap-conf 8 1 1 1 29', 'snap-conf 8 1 1 1 0', 'snap-conf 8 1 1 1', 'snap-conf a 1 1 1 1', 'snap-conf 8 1 1 1 1 1', 'snap-conf 8 1 1 1 1; id']) {
    assert.equal(gate(c).code, 64, c);
  }
  assert.equal(readFileSync(P('conf'), 'utf8').includes('KEEP_HOURLY=8'), true);
});

test('Prüfskript: snap-run, snap-dryrun, snap-switch, snap-cron', () => {
  reset(); writeFileSync(P('rechte'), 'snapshots\n');
  assert.equal(gate('snap-run hourly').code, 0);
  assert.match(calls()[0], /--label hourly/);
  reset(); writeFileSync(P('rechte'), 'snapshots\n');
  gate('snap-run monthly force', { FAKE_D: '15' }); assert.match(calls()[0], /--label monthly/, 'force umgeht das Datumsfenster');
  assert.match(gate('snap-dryrun weekly').out, /autosnap-run v2/);
  assert.equal(gate('snap-run daily').code, 64);
  assert.equal(gate('snap-run hourly extra').code, 64);
  assert.equal(gate('snap-switch off').out, 'schalter: aus'); assert.ok(existsSync(P('disabled')));
  assert.equal(gate('snap-switch on').out, 'schalter: an'); assert.ok(!existsSync(P('disabled')));
  writeFileSync(P('cron.d/proxmox-autosnap'), '5 * * * * root autosnap-run hourly\n');
  assert.equal(gate('snap-cron off').out, 'cron: vom-tool-aus');
  assert.ok(existsSync(P('cron.d/proxmox-autosnap.tool-aus')) && !existsSync(P('cron.d/proxmox-autosnap')));
  assert.equal(gate('snap-cron on').out, 'cron: an');
  assert.equal(gate('snap-cron status').out, 'cron: an');
  // alter Wrapper ohne v2-Kennung: Probelauf wird abgelehnt
  writeFileSync(P('autosnap-run'), '#!/bin/bash\necho alt\n'); chmodSync(P('autosnap-run'), 0o755);
  assert.match(gate('snap-dryrun hourly').err, /verwaltete Version/);
});

test('Einrichten: Werte des alten Wrappers werden in /etc/autosnap.conf übernommen, der alte Wrapper bleibt als Sicherung', () => {
  const setup = readFileSync('host-setup/setup-host.sh', 'utf8');
  const from = setup.indexOf('# Mit dem Recht "snapshots"'), to = setup.indexOf('tmp="$(mktemp)"');
  assert.ok(from > 0 && to > from);
  const block = sub(setup.slice(from, to)).replaceAll(' -o root -g root', ''); // der Test läuft ohne root (CI)
  const oldPve = readFileSync('test/fixtures/autosnap-run-pve.sh', 'utf8');
  for (const [name, old, expect] of [
    ['pve', oldPve, 'KEEP_HOURLY=8\nKEEP_WEEKLY=1\nKEEP_MONTHLY=1\nPAUSE_DAY=1\nMONTHLY_DAY=1\nTAG=autosnap\nONLY_RUNNING=1\n'],
    ['router', readFileSync('test/fixtures/autosnap-run-router.sh', 'utf8'), 'KEEP_HOURLY=8\nKEEP_WEEKLY=1\nKEEP_MONTHLY=1\nPAUSE_DAY=1\nMONTHLY_DAY=1\nTAG=autosnap\nONLY_RUNNING=0\n'],
  ]) {
    reset();
    for (const f of readdirSync(T)) if (f.startsWith('autosnap-run.vorher')) spawnSync('rm', ['-f', P(f)]);
    writeFileSync(P('autosnap-run'), old); chmodSync(P('autosnap-run'), 0o755);
    const H = P('hier'); mkdirSync(H, { recursive: true }); writeFileSync(path.join(H, 'autosnap-run'), readFileSync('host-setup/autosnap-run', 'utf8'));
    const r = spawnSync('bash', ['-c', `set -euo pipefail; HIER=${H}; ZIEL=${P('ziel')}; ${block}`], { env: { ...base, DISKMON_RECHTE: 'snapshots' }, encoding: 'utf8' });
    assert.equal(r.status, 0, `${name}: ${r.stderr}`);
    assert.equal(readFileSync(P('conf'), 'utf8'), expect, name);
    assert.match(readFileSync(P('autosnap-run'), 'utf8'), /^# autosnap-run v2/m);
    assert.ok(readdirSync(T).some((f) => f.startsWith('autosnap-run.vorher-')), `${name}: Sicherung des alten Wrappers`);
    // zweiter Lauf: kein weiteres Backup des schon verwalteten Wrappers, Konfiguration bleibt
    writeFileSync(P('conf'), 'KEEP_HOURLY=20\n');
    const n = readdirSync(T).filter((f) => f.startsWith('autosnap-run.vorher-')).length;
    spawnSync('bash', ['-c', `set -euo pipefail; HIER=${H}; ZIEL=${P('ziel')}; ${block}`], { env: { ...base, DISKMON_RECHTE: 'snapshots' }, encoding: 'utf8' });
    assert.equal(readdirSync(T).filter((f) => f.startsWith('autosnap-run.vorher-')).length, n);
    assert.equal(readFileSync(P('conf'), 'utf8'), 'KEEP_HOURLY=20\n');
  }
});
