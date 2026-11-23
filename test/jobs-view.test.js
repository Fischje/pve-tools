// „Läuft gerade“ auf der Übersicht: welche Jobs erscheinen, wohin ein Klick führt, was als Nächstes kommt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { collectJobs, nextBackupAt } from '../web/jobs-view.js';

const data = { now: '2026-11-23T09:00:00Z', hosts: [{ id: 'pve', label: 'pve' }, { id: 'pbs', label: 'pbs (backup)' }] };
const control = (job) => ({ job, settings: { backupDays: [1], wakeTime: '08:00' } });

test('nichts läuft: nächster Backup-Tag und nächste Snapshots', () => {
  const backups = { now: '2026-11-24T10:00:00', control: control(null),
    hosts: [{ id: 'pve', label: 'pve', snapRunning: null, runningJob: null, snapControl: { mode: 'tool', next: { hourly: '2026-11-24T11:00:00', daily: null } } }] };
  const { jobs, next } = collectJobs({ data, tests: { running: [] }, backups });
  assert.equal(jobs.length, 0);
  assert.match(next[0].text, /^Backup-Lauf Mo, 30\.11\. 08:00$/);
  assert.deepEqual(next[0].go, { view: 'backups', tabs: { bk: 'lauf' } });
  assert.match(next[1].text, /^Snapshots pve 11:00$/);
});

test('Backup-Lauf, Snapshot und Test laufen gleichzeitig', () => {
  const job = { phase: 'läuft', manual: false, startedAt: '2026-11-23T08:00:00', hosts: [{ id: 'pve', state: 'läuft' }, { id: 'pbs', state: 'wartet' }] };
  const backups = { now: '2026-11-23T08:30:00', control: control(job), hosts: [
    { id: 'pve', label: 'pve', runningJob: { start: '2026-11-23T08:05:00' }, snapRunning: { label: 'hourly', since: '2026-11-23T08:29:00', manual: false }, snapControl: { mode: 'tool', next: {} } },
  ] };
  const tests = { running: [{ hostId: 'pbs', serial: 'S1', model: 'TOSHIBA', device: '/dev/sdb', kind: 'long', started: '2026-11-23T07:30:00', remainingPercent: 70 }] };
  const { jobs, next } = collectJobs({ data, tests, backups });
  assert.deepEqual(jobs.map((j) => j.kind), ['backup', 'snap', 'test']); // vzdump auf pve gehört zum Lauf, keine doppelte Zeile
  assert.match(jobs[0].title, /Backup-Lauf \(geplant\)/);
  assert.match(jobs[0].detail, /pve sichert gerade/);
  assert.match(jobs[0].detail, /seit 30 min/);
  assert.equal(jobs[0].progress, 0);
  assert.deepEqual(jobs[1].go, { view: 'backups', tabs: { bk: 'snapshots', 'bk-host': 'pve' } });
  assert.equal(jobs[2].progress, 30);
  assert.deepEqual(jobs[2].go, { view: 'host', hostId: 'pbs', hostTab: 'disks', focus: 'S1' });
  assert.ok(!next.some((n) => /Backup-Lauf/.test(n.text)), 'während eines Laufs kein „nächster Lauf“');
});

test('Backup auf einem Host ohne Lauf des Tools (eigener Proxmox-Job)', () => {
  const backups = { now: '2026-11-23T20:10:00', control: control(null), hosts: [{ id: 'pve', label: 'pve', runningJob: { start: '2026-11-23T20:00:00', job: 'backup-xyz' }, snapRunning: null, snapControl: { mode: 'cron' } }] };
  const { jobs } = collectJobs({ data, tests: { running: [] }, backups });
  assert.equal(jobs.length, 1);
  assert.match(jobs[0].detail, /läuft seit 10 min · Proxmox-Job/);
  assert.deepEqual(jobs[0].go, { view: 'backups', tabs: { bk: 'laeufe', 'bk-host': 'pve' } });
});

test('nextBackupAt: heute nach der Weckzeit zählt nicht mehr', () => {
  assert.equal(nextBackupAt({ backupDays: [1], wakeTime: '08:00' }, new Date('2026-11-23T07:00:00')).getDate(), 23);
  assert.equal(nextBackupAt({ backupDays: [1], wakeTime: '08:00' }, new Date('2026-11-23T09:00:00')).getDate(), 30);
  assert.equal(nextBackupAt({ backupDays: [] }, new Date()), null);
});
