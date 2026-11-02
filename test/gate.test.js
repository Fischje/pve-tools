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
writeFileSync(path.join(bin, 'journalctl'), '#!/usr/bin/env bash\nif [[ "$1" == "-k" ]]; then printf "2026-11-01T16:35:07+01:00 h kernel: ata4: SATA link up 1.5 Gbps\\n2026-11-01T16:35:08+01:00 h kernel: eth0: irrelevant\\n"; fi\n');
writeFileSync(path.join(bin, 'pvesh'), '#!/usr/bin/env bash\ncase "$2" in\n */lxc) echo \'[{"vmid":109},{"vmid":112}]\' ;;\n */qemu) echo \'[]\' ;;\n */snapshot) echo \'[{"name":"current"}]\' ;;\n *) echo "pvesh $*" ;;\nesac\n');
for (const f of ['lsblk', 'smartctl', 'zpool', 'journalctl', 'pvesh']) chmodSync(path.join(bin, f), 0o755);
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
  assert.match(run('version').out, /^\d+$/);
  assert.equal(run('zpool').out, 'zpool status -p');
  assert.equal(run('zpoollist').out, 'zpool list -H -p -o name,size,alloc,free,frag,cap,health');
});

test('Backup-Überwachung (nur lesend): Gäste, Snapshots, vzdump-Aufgaben, Protokoll, Zustand der Snapshot-Skripte', () => {
  const g = run('guests').out.split('\n');
  assert.match(g[0], /^lxc\t\[\{"vmid":109\},\{"vmid":112\}\]$/);
  assert.equal(g[1], 'qemu\t[]');
  const sn = run('snapshots').out.split('\n');
  assert.deepEqual(sn, ['lxc\t109\t[{"name":"current"}]', 'lxc\t112\t[{"name":"current"}]']);
  assert.match(run('tasks').out, /tasks --typefilter vzdump --limit 40 --output-format json$/);
  const upid = 'UPID:pve:0000ABCD:0123ABCD:6543210A:vzdump::root@pam:';
  assert.match(run(`tasklog ${upid}`).out, /tasks\/UPID:pve:.*\/log --limit 20000/);
  assert.match(run('autosnap').out, /^schalter: (an|aus)/);
});

test('Backup-Überwachung: ungültige UPID und Zusatzargumente werden abgelehnt', () => {
  for (const c of ['tasklog', 'tasklog foo', 'tasklog UPID:x', 'tasklog UPID:pve:0000ABCD:0123ABCD:6543210A:vzdump::root@pam: extra', 'guests 1', 'snapshots all', 'tasks 5', 'autosnap on', 'tasklog UPID:pve:0000ABCD:..:../etc/passwd:vzdump::root@pam:;id']) {
    assert.equal(run(c).code, 64, c);
  }
});

test('abgelehnt: Partition, Loop-Gerät, unbekanntes Gerät, Pfad-Tricks', () => {
  for (const c of ['smart /dev/sda1', 'smart /dev/loop0', 'smart /dev/sdz', 'smart /dev/../etc/passwd', 'smart sda', 'smart /dev/sda; id']) {
    assert.equal(run(c).code, 64, c);
  }
});

test('abgelehnt: Shell-Zeichen, falsche Argumente, unbekannte Befehle', () => {
  for (const c of ['', 'list; id', 'list && id', 'smart /dev/sda $(id)', 'smart /dev/sda `id`', 'test /dev/sda format', 'test /dev/sda', 'select /dev/sda 10 5', 'select /dev/sda a b', 'select /dev/sda 0 99999999999999', 'bash', 'cat /etc/shadow', 'list extra', 'version 2', 'zpoollist -v', 'zpool destroy tank', 'smart /dev/sda wake', 'test /dev/sda short -d scsi']) {
    assert.equal(run(c).code, 64, `"${c}"`);
  }
});

test('Syntax beider Skripte', () => {
  execFileSync('bash', ['-n', gate]);
  execFileSync('bash', ['-n', path.resolve('host-setup/setup-host.sh')]);
});

test('kernel: nur Zeilen zu Verbindungsfehlern, keine Argumente', () => {
  const k = run('kernel');
  assert.equal(k.code, 0);
  assert.match(k.out, /ata4: SATA link up 1\.5 Gbps/);
  assert.doesNotMatch(k.out, /eth0/);
  assert.equal(run('kernel 5').code, 64);
});
