import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Ursprung ("GitHub") mit Zweig main, Arbeitskopie im LXC, falsche systemctl/curl, echte update.sh und sync.sh.
function world({ cloneBranch = 'main' } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'syn-'));
  const sh = (cwd, cmd) => { const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8' }); if (r.status) throw new Error(r.stderr + r.stdout); return r.stdout; };
  const origin = path.join(root, 'origin'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  mkdirSync(origin); mkdirSync(bin);
  sh(origin, 'git init -q -b main && git config user.email t@t && git config user.name t');
  for (const f of ['update.sh', 'sync.sh']) { copyFileSync(path.resolve(f), path.join(origin, f)); chmodSync(path.join(origin, f), 0o755); }
  const pkg = (cmd) => writeFileSync(path.join(origin, 'package.json'), JSON.stringify({ name: 'x', v: Math.random(), scripts: { test: cmd } }));
  pkg('node -e "process.exit(0)"'); sh(origin, 'git add -A && git commit -qm v1');
  sh(root, `git clone -q ${origin} work`);
  sh(work, 'git config user.email t@t && git config user.name t');
  if (cloneBranch !== 'main') sh(work, `git checkout -q -b ${cloneBranch}`);
  writeFileSync(path.join(bin, 'systemctl'), `#!/usr/bin/env bash\n[[ "$1" == show ]] && exit 0\n[[ "$1" == is-active ]] && exit 0\necho "$@" >> "${root}/systemctl.log"\nexit 0\n`);
  writeFileSync(path.join(bin, 'curl'), `#!/usr/bin/env bash\n[[ -f "${root}/down" ]] && exit 22\nexit 0\n`);
  for (const f of ['systemctl', 'curl']) chmodSync(path.join(bin, f), 0o755);
  mkdirSync(path.join(work, 'data')); writeFileSync(path.join(work, 'data', 'disktool.sqlite'), 'DB');
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, LISTEN: '127.0.0.1' };
  const run = () => spawnSync('bash', [path.join(work, 'sync.sh')], { cwd: work, env, encoding: 'utf8' });
  const release = (testCmd = 'node -e "process.exit(0)"') => { pkg(testCmd); sh(origin, 'git add -A && git commit -qm "neue Version"'); };
  const starts = () => (existsSync(path.join(root, 'systemctl.log')) ? readFileSync(path.join(root, 'systemctl.log'), 'utf8').split('\n').filter((l) => l.startsWith('start')).length : 0);
  return { root, work, origin, run, release, sh, starts, head: () => sh(work, 'git rev-parse --short HEAD').trim(), branch: () => sh(work, 'git rev-parse --abbrev-ref HEAD').trim() };
}

test('Abgleich: nichts Neues => nichts passiert, kein Neustart', () => {
  const w = world();
  const r = w.run();
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
  assert.equal(w.starts(), 0);
});

test('Abgleich: neue Version auf main wird geholt, getestet und der Dienst neu gestartet', () => {
  const w = world(); const vorher = w.head();
  w.release();
  const r = w.run();
  assert.equal(r.status, 0, r.stderr);
  assert.notEqual(w.head(), vorher);
  assert.match(r.stdout, /aktualisiert/);
  assert.equal(w.starts(), 1);
});

test('Abgleich: wechselt vom Entwicklungszweig auf main', () => {
  const w = world({ cloneBranch: 'claude/test' });
  w.release();
  assert.equal(w.branch(), 'claude/test');
  const r = w.run();
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(w.branch(), 'main');
  assert.equal(w.starts(), 1);
});

test('Abgleich: kaputte Version wird zurückgerollt und nicht alle 5 Minuten neu versucht', () => {
  const w = world(); const vorher = w.head();
  w.release('node -e "process.exit(1)"');
  let r = w.run();
  assert.match(r.stdout, /FEHLER/);
  assert.equal(w.head(), vorher);
  assert.equal(w.starts(), 0, 'Dienst wurde nicht angefasst');
  const marker = readFileSync(path.join(w.work, 'data', 'sync-fehler'), 'utf8').trim();
  assert.match(marker, /^[0-9a-f]{40}$/);
  r = w.run(); // zweiter Lauf: gleiche kaputte Version
  assert.equal(r.stdout.trim(), '', 'kein neuer Versuch');
  // eine neue, gute Version wird wieder genommen
  w.release();
  r = w.run();
  assert.match(r.stdout, /aktualisiert/);
  assert.equal(existsSync(path.join(w.work, 'data', 'sync-fehler')), false);
});

test('Abgleich: antwortet der Dienst nicht, Rückfall auf die alte Version (Dienst läuft wieder)', () => {
  const w = world(); const vorher = w.head();
  w.release();
  writeFileSync(path.join(w.root, 'down'), '');
  const r = w.run();
  assert.match(r.stdout, /FEHLER/);
  assert.equal(w.head(), vorher);
  assert.ok(w.starts() >= 2, 'Dienst wurde nach dem Rückfall wieder gestartet');
}, { timeout: 30000 });

test('Abgleich: lokal geänderte Dateien blockieren das Update mit Warnung', () => {
  const w = world(); const vorher = w.head();
  w.release();
  writeFileSync(path.join(w.work, 'package.json'), '{"name":"hier geändert"}');
  const r = w.run();
  assert.match(r.stdout, /WARNUNG/);
  assert.equal(w.head(), vorher);
});

test('Abgleich: GitHub nicht erreichbar => ruhig beenden', () => {
  const w = world();
  w.sh(w.work, `git remote set-url origin ${path.join(w.root, 'gibt-es-nicht')}`);
  const r = w.run();
  assert.equal(r.status, 0);
  assert.match(r.stdout, /fetch fehlgeschlagen/);
});

test('Skripte: Syntax', () => {
  for (const f of ['update.sh', 'sync.sh', 'install-sync.sh']) assert.equal(spawnSync('bash', ['-n', path.resolve(f)]).status, 0, f);
});
