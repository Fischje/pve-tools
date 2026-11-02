import test from 'node:test';
import assert from 'node:assert/strict';
import { parseZpoolStatus, parseZpoolList, ratePool, parseScan, normalizePool } from '../src/zfs.js';

const STATUS = `  pool: tank
 state: ONLINE
  scan: scrub repaired 0B in 05:10:12 with 0 errors on Sun Oct 12 05:34:13 2026
config:

\tNAME                                   STATE     READ WRITE CKSUM
\ttank                                   ONLINE       0     0     0
\t  raidz2-0                             ONLINE       0     0     0
\t    ata-ST12000NM003G-2MT113_ZL2M2KFZ  ONLINE       0     0     0
\t    ata-ST12000NM0248-2H3111_ZHZ0RHKE  ONLINE       0     0     3
\t    sdd                                ONLINE       0     0     0
\tlogs
\t  nvme0n1p4                            ONLINE       0     0     0
\tcache
\t  nvme1n1p5                            ONLINE       0     0     0
\tspares
\t  sdx                                  AVAIL

errors: No known data errors

  pool: rpool
 state: DEGRADED
status: One or more devices could not be used because the label is missing or
\tinvalid.  Sufficient replicas exist for the pool to continue functioning in a
\tdegraded state.
action: Replace the device using 'zpool replace'.
  scan: resilver in progress since Tue Nov  3 10:00:00 2026
\t1.20T scanned at 1.0G/s, 400G issued at 500M/s, 3.00T total
\t10.00% done, 05:00:00 to go
config:

\tNAME         STATE     READ WRITE CKSUM
\trpool        DEGRADED     0     0     0
\t  mirror-0   DEGRADED     0     0     0
\t    sda3     ONLINE       0     0     0
\t    sdb3     UNAVAIL      0     0     0  cannot open
\t  nvme2n1p3  ONLINE       0     0     0

errors: No known data errors
`;

test('Pools, vdev-Baum und Sektionen werden gelesen', () => {
  const [tank, rpool] = parseZpoolStatus(STATUS);
  assert.equal(tank.name, 'tank');
  assert.equal(tank.state, 'ONLINE');
  const data = tank.vdevs.filter((v) => v.section === 'data');
  assert.equal(data.length, 1);
  assert.equal(data[0].type, 'raidz2');
  assert.equal(data[0].devices.length, 3);
  assert.equal(data[0].devices[1].cksum, 3);
  assert.equal(tank.vdevs.find((v) => v.section === 'logs').type, 'disk');
  assert.equal(tank.vdevs.find((v) => v.section === 'cache').name, 'nvme1n1p5');
  assert.equal(tank.vdevs.find((v) => v.section === 'spares').state, 'AVAIL');
  assert.equal(rpool.vdevs[0].type, 'mirror');
  assert.equal(rpool.vdevs[0].devices[1].note, 'cannot open');
  assert.equal(rpool.vdevs[1].type, 'disk', 'einzelne Platte im Pool (Stripe)');
});

test('Scrub und Resilver', () => {
  const [tank, rpool] = parseZpoolStatus(STATUS);
  assert.equal(tank.scan.state, 'finished');
  assert.equal(tank.scan.kind, 'scrub');
  assert.equal(tank.scan.errors, 0);
  assert.ok(tank.scan.finishedAt);
  assert.equal(tank.busy, false);
  assert.equal(rpool.scan.kind, 'resilver');
  assert.equal(rpool.scan.state, 'running');
  assert.equal(rpool.scan.percent, 10);
  assert.equal(rpool.busy, true);
  assert.match(rpool.status, /label is missing or invalid/);
  assert.equal(parseScan('none requested').state, 'none');
  assert.equal(parseScan('scrub canceled on Sun Oct 12 05:34:13 2026').state, 'canceled');
});

test('zpool list', () => {
  const l = parseZpoolList('tank\t72000000000000\t20000000000000\t52000000000000\t4\t27\tONLINE\nrpool\t1\t1\t0\t-\t100\tONLINE\n');
  assert.equal(l.tank.cap, 27);
  assert.equal(l.tank.size, 72000000000000);
  assert.equal(l.rpool.frag, null);
});

test('Bewertung: gesunder Pool, Fehlerzähler, defekter Pool, voller Pool, alter Scrub', () => {
  const now = new Date(2026, 10, 3);
  const [tank, rpool] = parseZpoolStatus(STATUS);
  const t = ratePool(tank, now);
  assert.equal(t.level, 'watch');
  assert.ok(t.findings.some((x) => x.code === 'vdev-errors' && /3 Prüfsummenfehler/.test(x.text)));
  assert.equal(ratePool(rpool, now).level, 'critical');
  const clean = parseZpoolStatus(STATUS.replace(/ZHZ0RHKE  ONLINE       0     0     3/, 'ZHZ0RHKE  ONLINE       0     0     0'))[0];
  assert.equal(ratePool(clean, now).level, 'ok');
  assert.equal(ratePool({ ...clean, cap: 85 }, now).level, 'watch');
  assert.equal(ratePool({ ...clean, cap: 93 }, now).level, 'replace');
  assert.equal(ratePool(clean, new Date(2027, 2, 1)).level, 'watch'); // Scrub vom Oktober, jetzt März
  assert.equal(ratePool({ ...clean, errors: '2 data errors, use \'-v\' for a list' }, now).level, 'critical');
});

test('Pools älterer Versionen und kaputte Einträge werden angeglichen statt abzustürzen', () => {
  const n = normalizePool({ name: 'x', state: 'ONLINE', scan: 'none requested' });
  assert.deepEqual(n.vdevs, []);
  assert.equal(n.scan.state, 'none');
  assert.equal(ratePool({ name: 'x', state: 'DEGRADED' }, new Date()).level, 'critical');
  assert.doesNotThrow(() => ratePool({}, new Date()));
  assert.doesNotThrow(() => ratePool({ name: 'y', vdevs: [{ name: 'mirror-0', type: 'mirror' }] }, new Date()));
});
