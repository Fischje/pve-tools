// Ende-zu-Ende: HostClient -> echtes Prüfskript (host-setup/gate.sh) in einem Sandkasten.
// So fallen Fehler auf, die die Demo nicht zeigt, z. B. dass das Prüfskript ein Zeichen ablehnt, das das Tool schickt
// (am 16.11.2026: „gate: unerlaubte Zeichen“ beim Komma in der Ausschlussliste).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { HostClient } from '../src/hostapi.js';

const T = mkdtempSync(path.join(tmpdir(), 'gate-echt-'));
const P = (f) => path.join(T, f);
const bin = P('bin'); mkdirSync(bin);
const fake = (name, body) => { writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(path.join(bin, name), 0o755); };
// Aufrufe protokollieren statt ausführen
fake('systemd-run', `echo "systemd-run $*" >> "${P('aufrufe.log')}"`);
fake('vzdump', 'exit 0');
fake('pvesm', 'printf "Name Type Status Total Used Available %%\\n$3 pbs active 100 50 50 50%%\\n"');
// Wie Proxmox: ohne --source all/active liefert die Aufgabenliste nur beendete Aufgaben, ein laufendes Backup fehlt dann.
fake('pvesh', `if [[ "$*" == *"/tasks "* ]]; then
  fin='{"upid":"UPID:pve:00000001:00000001:6A000000:vzdump::root@pam:","starttime":1793000000,"endtime":1793000600,"status":"OK","type":"vzdump"}'
  run='{"upid":"UPID:pve:00000002:00000002:6A000100:vzdump::root@pam:","starttime":1793100000,"type":"vzdump"}'
  if [[ "$*" == *"--source all"* || "$*" == *"--source active"* ]]; then echo "[$run,$fin]"; else echo "[$fin]"; fi
fi`);
fake('hostname', 'echo pve');
fake('ip', 'echo "default via 192.168.1.1 dev vmbr0 proto kernel"');
fake('ethtool', 'printf "Settings for $1:\\n\\tWake-on: g\\n"');
writeFileSync(P('autosnap-run'), `#!/usr/bin/env bash\necho "autosnap-run $* FORCE=\${FORCE:-}" >> "${P('aufrufe.log')}"\n`); chmodSync(P('autosnap-run'), 0o755);
writeFileSync(P('rechte'), 'snapshots\nbackup-starten\nherunterfahren\nenergie\n');
fake('dmidecode', 'case "$2" in baseboard-product-name) echo "B760M DS3H";; bios-version) echo F12;; *) echo X;; esac');
fake('lspci', 'printf "0000:03:00.0 SATA controller: ASMedia ASM1166\\n\\t\\tLnkCap:\\tPort #0, ASPM L0s L1, Exit Latency L1 <64us\\n\\t\\tLnkCtl:\\tASPM Disabled; RCB 64 bytes\\n"');
fake('setpci', `echo "setpci $*" >> "${P('aufrufe.log')}"`);
fake('systemctl', `echo "systemctl $*" >> "${P('aufrufe.log')}"; [[ "$1" == is-enabled ]] && echo enabled; exit 0`);
fake('logger', 'exit 0');
writeFileSync(P('pvetools-aspm'), readFileSync('host-setup/pvetools-aspm', 'utf8').replaceAll('/etc/pvetools-aspm.conf', P('aspm.conf'))); chmodSync(P('pvetools-aspm'), 0o755);
writeFileSync(P('aspm.service'), '[Unit]\n');
const gate = readFileSync('host-setup/gate.sh', 'utf8')
  .replaceAll('/etc/diskmon/rechte', P('rechte')).replaceAll('/usr/local/sbin/autosnap-run', P('autosnap-run'))
  .replaceAll('/run/diskmon-snap.lock', P('lock')).replaceAll('/usr/local/sbin/pvetools-aspm', P('pvetools-aspm')).replaceAll('/etc/pvetools-aspm.conf', P('aspm.conf')).replaceAll('/etc/systemd/system/pvetools-aspm.service', P('aspm.service')).replaceAll('/etc/autosnap.conf', P('conf')).replaceAll('/etc/autosnap.disabled', P('disabled'));
writeFileSync(P('gate.sh'), gate);

/** Transport wie SshTransport, aber lokal: der Befehl landet in SSH_ORIGINAL_COMMAND des Prüfskripts. */
const transport = { async run(command) { const r = spawnSync('bash', [P('gate.sh')], { env: { PATH: `${bin}:${process.env.PATH}`, SSH_ORIGINAL_COMMAND: command }, encoding: 'utf8' }); return { code: r.status, stdout: r.stdout, stderr: r.stderr }; } };
const client = new HostClient(transport);
const log = () => (existsSync(P('aufrufe.log')) ? readFileSync(P('aufrufe.log'), 'utf8').trim().split('\n') : []);

test('Backup starten über das echte Prüfskript: alle, Ausschlussliste mit Komma, nur bestimmte Gäste', async () => {
  await client.backupStart('pbs', { select: 'all', ids: [] });
  await client.backupStart('pbs', { select: 'exclude', ids: [109, 112, 113, 114, 116, 119, 117, 159, 161, 171] });
  await client.backupStart('pbs', { select: 'only', ids: [118, 121] });
  const l = log().filter((x) => x.startsWith('systemd-run'));
  assert.match(l[0], /vzdump --all 1 --storage pbs --mode snapshot --compress zstd --notes-template \{\{guestname\}\}$/);
  assert.match(l[1], /vzdump --all 1 --exclude 109,112,113,114,116,119,117,159,161,171 --storage pbs/);
  assert.match(l[2], /vzdump 118 121 --storage pbs/);
});

test('Weitere Befehle des Tools über das echte Prüfskript', async () => {
  assert.deepEqual(await client.rights(), ['snapshots', 'backup-starten', 'herunterfahren', 'energie']);
  assert.equal((await client.storageActive('pbs')).active, true);
  assert.equal((await client.snapRun('monthly', { force: true })).ok, true);
  assert.ok(log().some((x) => x === 'autosnap-run monthly FORCE=1'));
  await client.snapConf({ keepHourly: 8, keepWeekly: 1, keepMonthly: 1, pauseDay: 1, monthlyDay: 1 });
  assert.match(readFileSync(P('conf'), 'utf8'), /KEEP_HOURLY=8/);
  await client.poweroff();
  assert.ok(log().some((x) => /systemd-run .*systemctl poweroff/.test(x)));
  const n = await client.netinfo();
  assert.equal(n.dev, 'vmbr0');
  await assert.rejects(() => client.backupStart('pbs', { select: 'exclude', ids: ['1;id'] }), /unerlaubte Zeichen|ungültige Liste/);
});

test('Aufgabenliste über das echte Prüfskript enthält auch das laufende Backup (sonst gibt das Tool nach 10 Minuten auf)', async () => {
  const tasks = await client.backupTasks();
  const running = tasks.filter((t) => t.start && !t.end);
  assert.equal(running.length, 1, 'laufende Aufgabe fehlt: --source all im Prüfskript?');
  assert.equal(tasks.length, 2);
});

test('Energie über das echte Prüfskript: Bestandsaufnahme, ASPM einschalten, Ausnahmen, Start-Dienst', async () => {
  const e = await client.energy();
  assert.equal(e.system['baseboard-product-name'], 'B760M DS3H');
  assert.equal(e.aspm.installed, true); assert.equal(e.aspm.boot, 'enabled');
  assert.deepEqual(e.pci.map((p) => [p.addr, p.cap, p.ctl]), [['0000:03:00.0', 'L0sL1', 'none']]);
  await client.aspmExclude(['0000:03:00.0']);
  assert.equal(readFileSync(P('aspm.conf'), 'utf8'), 'EXCLUDE=0000:03:00.0\n');
  assert.deepEqual((await client.energy()).aspm.exclude, ['0000:03:00.0']);
  assert.match(await client.aspmApply(), /ausgenommen/);
  await client.aspmExclude([]);
  assert.match(await client.aspmApply(), /0000:03:00.0: ASPM L0sL1 eingeschaltet/);
  assert.ok(log().includes('setpci -s 0000:03:00.0 CAP_EXP+10.b=03:03'));
  await client.aspmOff('0000:03:00.0');
  await client.aspmBoot(true);
  assert.ok(log().includes('systemctl enable pvetools-aspm.service'));
  await assert.rejects(() => client.aspmExclude(['0000:03:00.0;id']), /unerlaubte Zeichen|ungültige Adresse/);
  await assert.rejects(() => client.aspmOff('kaputt'), /aspm-off/);
});
