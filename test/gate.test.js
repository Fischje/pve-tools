import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Falsche lsblk/smartctl vor dem PATH, damit wir nur die Prüflogik des Gate-Skripts testen.
const bin = mkdtempSync(path.join(tmpdir(), 'gate-'));
writeFileSync(path.join(bin, 'lsblk'), '#!/usr/bin/env bash\nif [[ "$*" == *"-dn"* ]]; then printf "sda disk\\nsda1 part\\nnvme0n1 disk\\nloop0 loop\\n"; else echo "lsblk $*"; fi\n');
writeFileSync(path.join(bin, 'smartctl'), '#!/usr/bin/env bash\necho "smartctl $*"\n');
writeFileSync(path.join(bin, 'zpool'), '#!/usr/bin/env bash\necho "zpool $*"\n');
for (const f of ['lsblk', 'smartctl', 'zpool']) chmodSync(path.join(bin, f), 0o755);
const gate = path.resolve('host-setup/gate.sh');

function run(command) {
  const r = spawnSync('bash', [gate], { env: { PATH: `${bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

test('erlaubte Befehle', () => {
  assert.match(run('list').out, /^lsblk -J -d -b/);
  assert.equal(run('smart /dev/sda').out, 'smartctl -j -a /dev/sda');
  assert.equal(run('smart /dev/nvme0n1 standby').out, 'smartctl -j -a -n standby /dev/nvme0n1');
  assert.equal(run('test /dev/sda short').out, 'smartctl -j -t short /dev/sda');
  assert.equal(run('test /dev/sda long').out, 'smartctl -j -t long /dev/sda');
  assert.equal(run('test /dev/sda abort').out, 'smartctl -j -X /dev/sda');
  assert.equal(run('select /dev/sda 0 1000').out, 'smartctl -j -t select,0-1000 /dev/sda');
  assert.match(run('uptime').out, /^[0-9.]+$/);
  assert.equal(run('zpool').out, 'zpool status -p');
  assert.equal(run('zpoollist').out, 'zpool list -H -p -o name,size,alloc,free,frag,cap,health');
});

test('abgelehnt: Partition, Loop-Gerät, unbekanntes Gerät, Pfad-Tricks', () => {
  for (const c of ['smart /dev/sda1', 'smart /dev/loop0', 'smart /dev/sdz', 'smart /dev/../etc/passwd', 'smart sda', 'smart /dev/sda; id']) {
    assert.equal(run(c).code, 64, c);
  }
});

test('abgelehnt: Shell-Zeichen, falsche Argumente, unbekannte Befehle', () => {
  for (const c of ['', 'list; id', 'list && id', 'smart /dev/sda $(id)', 'smart /dev/sda `id`', 'test /dev/sda format', 'test /dev/sda', 'select /dev/sda 10 5', 'select /dev/sda a b', 'select /dev/sda 0 99999999999999', 'bash', 'cat /etc/shadow', 'list extra', 'zpoollist -v', 'zpool destroy tank', 'smart /dev/sda wake', 'test /dev/sda short -d scsi']) {
    assert.equal(run(c).code, 64, `"${c}"`);
  }
});

test('Syntax beider Skripte', () => {
  execFileSync('bash', ['-n', gate]);
  execFileSync('bash', ['-n', path.resolve('host-setup/setup-host.sh')]);
});
