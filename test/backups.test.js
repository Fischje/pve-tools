import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGuests, parseSnapshots, parseTasks, parseVzdumpLog, parseAutosnap, describeCron, summarizeRun, failureCause } from '../src/backups.js';

test('Gäste: LXC und VMs mit Tags, Status und Vorlagen', () => {
  const g = parseGuests('lxc\t[{"vmid":109,"name":"nginx","status":"running","tags":"autosnap;community-script;proxy"},{"vmid":141,"name":"media","status":"stopped","tags":""}]\nqemu\t[{"vmid":100,"name":"vm","status":"running","template":1}]\nmuell\t[]\nlxc\tkaputt');
  assert.equal(g.length, 3);
  assert.deepEqual(g[0], { vmid: 109, type: 'lxc', name: 'nginx', status: 'running', tags: ['autosnap', 'community-script', 'proxy'], template: false });
  assert.deepEqual(g[1].tags, []);
  assert.equal(g[2].template, true);
});

test('Snapshots: Namen von proxmox-autosnap werden erkannt, „current“ ignoriert', () => {
  const s = parseSnapshots('lxc\t109\t[{"name":"autohourly261102105500","snaptime":1793613300,"description":"autosnap"},{"name":"autoweekly261101002500","snaptime":1793489100},{"name":"automonthly261101004500","snaptime":1793490300},{"name":"vor-update","snaptime":1700000000},{"name":"current"}]\nlxc\t112\t[]');
  assert.deepEqual(s.map((x) => x.label), ['hourly', 'weekly', 'monthly', null]);
  assert.equal(s[0].vmid, 109);
  assert.equal(s[0].ts, 1793613300000);
  assert.equal(s.length, 4, 'von Hand angelegte Snapshots bleiben sichtbar, haben aber kein Label');
  assert.equal(parseSnapshots('lxc\t109\t[{"name":"auto_hourly_261102_105500","snaptime":1}]')[0].label, 'hourly', 'auch das lesbare Namensformat');
});

test('Aufgabenliste', () => {
  const t = parseTasks('[{"upid":"UPID:pve:1:2:3:vzdump::root@pam:","starttime":1793584500,"endtime":1793587500,"status":"OK","user":"root@pam"},{"upid":"UPID:pve:4:5:6:vzdump::root@pam:","starttime":1793600000}]');
  assert.equal(t.length, 2);
  assert.equal(t[0].status, 'OK');
  assert.equal(t[0].end - t[0].start, 3000000);
  assert.equal(t[1].end, null, 'laufende Aufgabe hat noch kein Ende');
  assert.deepEqual(parseTasks('kein json'), []);
});

const LOG = [
  'INFO: starting new backup job: vzdump --all 1 --exclude 109,112 --storage pbs --mode snapshot --compress zstd',
  'INFO: Starting Backup of VM 113 (lxc)', 'INFO: Backup started at 2026-11-02 08:15:03', 'INFO: Finished Backup of VM 113 (00:01:22)',
  'INFO: Starting Backup of VM 114 (lxc)', 'ERROR: Backup of VM 114 failed - command \'lxc-info -n 114\' failed: exit code 1',
  'INFO: Starting Backup of VM 118 (lxc)', 'INFO: Finished Backup of VM 118 (01:02:03)',
  'INFO: Starting Backup of VM 121 (qemu)',
  'INFO: Backup job finished with errors', 'TASK ERROR: job errors',
];
test('vzdump-Protokoll: Ergebnis je Gast, Dauer, Fehlertext, Abbruch', () => {
  for (const input of [JSON.stringify(LOG.map((t, i) => ({ n: i + 1, t }))), LOG.join('\n')]) {
    const r = parseVzdumpLog(input);
    assert.equal(r.job, 'errors');
    const by = Object.fromEntries(r.guests.map((g) => [g.vmid, g]));
    assert.deepEqual([by[113].result, by[113].seconds], ['ok', 82]);
    assert.equal(by[114].result, 'failed');
    assert.match(by[114].note, /lxc-info/);
    assert.equal(by[118].seconds, 3723);
    assert.equal(by[121].result, 'interrupted', 'begonnen, aber nie fertig');
    assert.equal(by[121].type, 'qemu');
  }
  assert.equal(parseVzdumpLog('INFO: Starting Backup of VM 1 (lxc)\nINFO: Finished Backup of VM 1 (00:00:05)\nINFO: Backup job finished successfully\nTASK OK').job, 'ok');
  assert.deepEqual(parseVzdumpLog('').guests, []);
});

const AUTOSNAP = `schalter: an
== wrapper
#!/bin/bash
PAUSE_DAY=1            # 1 = Montag
TAG="autosnap"
case "$LABEL" in
    hourly)  KEEP=8 ;;
    weekly)  KEEP=1 ;;
    monthly) KEEP=1
             if [ -z "$FORCE" ]; then true; fi ;;
esac
== cron
PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

5 * * * *     root  autosnap-run hourly
25 0 * * 0    root  autosnap-run weekly
45 0 1,2 * *  root  autosnap-run monthly
== log
2026-11-02T11:05:01+01:00 pve autosnap[4242]: VM 112 - Creating snapshot autohourly261102110501
-- No entries --
`;
test('autosnap: Schalter, Aufbewahrung, Pausentag, Cron und Meldungen aus deinen echten Skripten', () => {
  const a = parseAutosnap(AUTOSNAP);
  assert.equal(a.enabled, true);
  assert.deepEqual(a.keep, { hourly: 8, weekly: 1, monthly: 1 });
  assert.equal(a.pauseDay, 1);
  assert.equal(a.tag, 'autosnap');
  assert.deepEqual(a.cron.map((c) => c.text), ['stündlich um :05', 'wöchentlich So 00:25', 'monatlich am 1. und 2. um 00:45']);
  assert.equal(a.log.length, 1);
  assert.equal(parseAutosnap(AUTOSNAP.replace('schalter: an', 'schalter: aus')).enabled, false);
  assert.equal(parseAutosnap('').known, false);
});

test('Cron-Beschreibung', () => {
  assert.equal(describeCron('0 3 * * 1'), 'wöchentlich Mo 03:00');
  assert.equal(describeCron('*/5 * * * *'), '*/5 * * * *');
});

// Fehlerbilder wie in deiner Anzeige: Die Ursache steht bei LXC meist VOR der letzten ERROR-Zeile.
const FAIL = [
  'INFO: starting new backup job: vzdump --all 1 --storage pbs --mode snapshot --compress zstd',
  'INFO: Starting Backup of VM 101 (qemu)', 'INFO: status = running',
  'ERROR: Backup of VM 101 failed - backup write data failed: command error: write_data upload error: connection closed because of a broken pipe',
  'INFO: Starting Backup of VM 118 (lxc)', 'INFO: create storage snapshot \'vzdump\'',
  'ERROR: Error: error trying to connect: tcp connect error: No route to host (os error 113)', 'INFO: remove vzdump snapshot',
  "ERROR: Backup of VM 118 failed - command 'lxc-usernsexec -m u:0:100000:65536 -m g:0:100000:65536 -- /usr/bin/proxmox-backup-client backup --crypt-mode=n root.pxar:/mnt' failed: exit code 255",
  'INFO: Starting Backup of VM 140 (qemu)', "ERROR: Backup of VM 140 failed - VM 140 qmp command 'backup' failed - backup connect failed: command error: client error (Connect)",
  'INFO: Starting Backup of VM 150 (lxc)', 'ERROR: Backup of VM 150 failed - unable to create snapshot: out of space',
  'INFO: Backup job finished with errors', 'TASK ERROR: job errors',
];
test('Fehlgrund: Verbindungsabbruch wird erkannt, auch wenn er VOR der letzten ERROR-Zeile steht', () => {
  const r = parseVzdumpLog(FAIL.join('\n'));
  const by = Object.fromEntries(r.guests.map((g) => [g.vmid, g]));
  assert.equal(by[101].cause, 'verbindung');
  assert.match(by[101].note, /broken pipe/);
  assert.equal(by[118].cause, 'verbindung', 'LXC: Grund steht in der Zeile davor');
  assert.match(by[118].note, /tcp connect error/);
  assert.match(by[118].detail, /remove vzdump snapshot/);
  assert.equal(by[140].cause, 'verbindung');
  assert.equal(by[150].cause, 'sonstiges');
  assert.match(by[150].note, /out of space/);
});

test('Lauf-Zusammenfassung: Ursache „Verbindung“ erst, wenn die meisten Fehlschläge dazu passen', () => {
  const r = parseVzdumpLog(FAIL.join('\n'));
  assert.deepEqual(summarizeRun(r.guests), { total: 4, failed: 4, connection: 3, cause: 'verbindung' });
  assert.equal(summarizeRun([{ result: 'failed', cause: 'sonstiges' }, { result: 'failed', cause: 'verbindung' }, { result: 'ok' }]).cause, null);
  assert.equal(summarizeRun([{ result: 'failed', cause: 'verbindung' }, { result: 'ok' }]).cause, null, 'ein einzelner Fehlschlag macht noch keinen Verbindungsausfall');
  assert.equal(failureCause('alles gut'), 'sonstiges');
});
