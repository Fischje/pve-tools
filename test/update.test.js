import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, copyFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Zwei Git-Ordner (Ursprung und Arbeitskopie), falsche systemctl/curl, echtes update.sh.
function world() {
  const root = mkdtempSync(path.join(tmpdir(), 'upd-'));
  const sh = (cwd, cmd) => { const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr); return r.stdout; };
  const origin = path.join(root, 'origin'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  mkdirSync(origin); mkdirSync(bin);
  sh(origin, 'git init -q -b main && git config user.email t@t && git config user.name t');
  writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', scripts: { test: 'node -e "process.exit(0)"' } }));
  sh(origin, 'git add -A && git commit -qm v1');
  sh(root, `git clone -q ${origin} work`);
  copyFileSync(path.resolve('update.sh'), path.join(origin, 'update.sh')); chmodSync(path.join(origin, 'update.sh'), 0o755);
  sh(origin, 'git add -A && git commit -qm "update.sh"');
  sh(work, 'git pull -q');
  writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\necho "$@" >> "${root}/systemctl.log"\n[[ -f "${root}/start-fails" && "$1" == start ]] && exit 1\nexit 0\n`);
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\n[[ -f "${root}/down" ]] && exit 22\nexit 0\n`);
  for (const f of ['systemctl', 'curl']) chmodSync(path.join(bin, f), 0o755);
  mkdirSync(path.join(work, 'data')); writeFileSync(path.join(work, 'data', 'disktool.sqlite'), 'DB');
  const run = () => spawnSync('bash', [path.join(work, 'update.sh')], { cwd: work, env: { PATH: `${bin}:${process.env.PATH}`, HOME: process.env.HOME ?? root, LISTEN: '127.0.0.1' }, encoding: 'utf8' });
  const release = (testCmd, quickCmd) => { writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', v: Math.random(), scripts: { test: testCmd, ...(quickCmd ? { 'test:quick': quickCmd } : {}) } })); sh(origin, 'git add -A && git commit -qm "neue Version"'); };
  return { root, work, run, release, sh, head: () => sh(work, 'git rev-parse --short HEAD').trim() };
}

test('Update: neue Version wird geholt, getestet, Datenbank gesichert, Dienst neu gestartet', () => {
  const w = world(); const vorher = w.head();
  w.release('node -e "process.exit(0)"');
  const r = w.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.notEqual(w.head(), vorher);
  assert.match(r.stdout, /läuft/);
  const sicherungen = readdirSync(path.join(w.work, 'data')).filter((n) => n.startsWith('vor-update-'));
  assert.equal(sicherungen.length, 1);
  assert.equal(readFileSync(path.join(w.work, 'data', sicherungen[0], 'disktool.sqlite'), 'utf8'), 'DB');
  assert.match(readFileSync(path.join(w.root, 'systemctl.log'), 'utf8'), /stop[\s\S]*start/);
});

test('Update: schlagen die Tests fehl, bleibt die alte Version', () => {
  const w = world(); const vorher = w.head();
  w.release('node -e "process.exit(1)"');
  const r = w.run();
  assert.notEqual(r.status, 0);
  assert.equal(w.head(), vorher, 'zurückgerollt');
  assert.match(r.stderr, /Tests/);
});

test('Update: antwortet der Dienst nicht, wird zurückgerollt', () => {
  const w = world(); const vorher = w.head();
  w.release('node -e "process.exit(0)"');
  writeFileSync(path.join(w.root, 'down'), '');
  const r = w.run();
  assert.notEqual(r.status, 0);
  assert.equal(w.head(), vorher);
}, { timeout: 30000 });

test('Update: bereits aktuell, und lokale Änderungen werden nicht überschrieben', () => {
  const w = world();
  assert.match(w.run().stdout, /Bereits auf dem neuesten Stand/);
  writeFileSync(path.join(w.work, 'package.json'), '{"name":"geaendert"}');
  const r = w.run();
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /lokale Änderungen/);
});

test('Update: auf dem LXC läuft die schnelle Testauswahl, wenn es sie gibt (die volle Suite prüft GitHub vorher)', () => {
  const w = world(); const vorher = w.head();
  w.release('node -e "process.exit(1)"', 'node -e "process.exit(0)"'); // volle Suite würde fehlschlagen, die schnelle nicht
  const r = w.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.notEqual(w.head(), vorher);
});

test('Update: schlägt die schnelle Testauswahl fehl, wird zurückgerollt und der Grund steht im Protokoll', () => {
  const w = world(); const vorher = w.head();
  w.release('node -e "process.exit(0)"', 'node -e "console.error(\'SCHNELL-FEHLER\'); process.exit(1)"');
  const r = w.run();
  assert.notEqual(r.status, 0);
  assert.equal(w.head(), vorher);
  assert.match(readFileSync(path.join(w.work, 'data', 'letzter-testlauf.log'), 'utf8'), /SCHNELL-FEHLER/);
});

test('Datenbank: neuer Name pvetools.sqlite, eine alte disktool.sqlite wird weiter benutzt, bis sie umbenannt ist', async () => {
  const { openDb } = await import('../src/db.js');
  const { mkdtempSync: mk, existsSync: ex } = await import('node:fs');
  const { tmpdir: td } = await import('node:os');
  const neu = mk(path.join(td(), 'db-neu-'));
  openDb(neu).setSetting('x', '1');
  assert.ok(ex(path.join(neu, 'pvetools.sqlite')) && !ex(path.join(neu, 'disktool.sqlite')));
  const alt = mk(path.join(td(), 'db-alt-'));
  const { DatabaseSync } = await import('node:sqlite');
  const o = new DatabaseSync(path.join(alt, 'disktool.sqlite')); o.exec('CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)'); o.exec("INSERT INTO settings VALUES ('alt','ja')"); o.close();
  const db = openDb(alt);
  assert.equal(db.getSetting('alt'), 'ja', 'alte Datenbank wird weiter benutzt');
  assert.ok(!ex(path.join(alt, 'pvetools.sqlite')), 'keine zweite, leere Datenbank');
});
