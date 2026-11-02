// SQLite-Datenbank (eingebautes node:sqlite). Zeiten als Epoch-Millisekunden.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { normalizePool } from './zfs.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_settings (host_id TEXT PRIMARY KEY, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS host_state (host_id TEXT PRIMARY KEY, last_poll INTEGER, reachable INTEGER, uptime_sec REAL, uptime_at INTEGER, pools TEXT, error TEXT);
CREATE TABLE IF NOT EXISTS disk (
  serial TEXT PRIMARY KEY, host_id TEXT NOT NULL, device TEXT, model TEXT, kind TEXT, capacity_bytes INTEGER, total_lba INTEGER,
  polling_short INTEGER, polling_extended INTEGER, selective INTEGER, standby INTEGER DEFAULT 0, selftest_running INTEGER DEFAULT 0,
  selftest_remaining INTEGER, last_seen INTEGER, last_raw TEXT, paused INTEGER DEFAULT 0, last_short_ok INTEGER, last_long_ok INTEGER, lba_per_min REAL);
CREATE TABLE IF NOT EXISTS sample (id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, ts INTEGER NOT NULL, hours INTEGER, temp INTEGER,
  wear_used INTEGER, reallocated INTEGER, crc INTEGER, reported_uncorrect INTEGER, media_errors INTEGER, level TEXT);
CREATE INDEX IF NOT EXISTS sample_serial_ts ON sample (serial, ts);
CREATE TABLE IF NOT EXISTS testrun (id INTEGER PRIMARY KEY AUTOINCREMENT, serial TEXT NOT NULL, host_id TEXT NOT NULL, kind TEXT NOT NULL,
  started INTEGER NOT NULL, ended INTEGER, lba_from INTEGER, lba_to INTEGER, hours_at_start INTEGER, result TEXT NOT NULL DEFAULT 'running', note TEXT, origin TEXT);
CREATE INDEX IF NOT EXISTS testrun_serial ON testrun (serial, started);
CREATE TABLE IF NOT EXISTS long_progress (serial TEXT PRIMARY KEY, next_lba INTEGER, total_lba INTEGER, lba_per_min REAL, segments INTEGER, started INTEGER);
CREATE TABLE IF NOT EXISTS approval (host_id TEXT PRIMARY KEY, skip_date TEXT, snooze_until INTEGER, go_at INTEGER);
CREATE TABLE IF NOT EXISTS alert_state (key TEXT PRIMARY KEY, level TEXT, alerted TEXT, updated INTEGER);
CREATE TABLE IF NOT EXISTS guest (host_id TEXT NOT NULL, vmid INTEGER NOT NULL, type TEXT, name TEXT, status TEXT, tags TEXT, template INTEGER DEFAULT 0, seen INTEGER, PRIMARY KEY (host_id, vmid));
CREATE TABLE IF NOT EXISTS snap (host_id TEXT NOT NULL, vmid INTEGER NOT NULL, name TEXT NOT NULL, label TEXT, ts INTEGER, description TEXT, PRIMARY KEY (host_id, vmid, name));
CREATE TABLE IF NOT EXISTS backup_task (upid TEXT PRIMARY KEY, host_id TEXT NOT NULL, start INTEGER, end INTEGER, status TEXT, user TEXT, job TEXT, parsed INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS backup_guest (upid TEXT NOT NULL, vmid INTEGER NOT NULL, type TEXT, result TEXT, seconds INTEGER, note TEXT, PRIMARY KEY (upid, vmid));
CREATE TABLE IF NOT EXISTS autosnap_state (host_id TEXT PRIMARY KEY, json TEXT, ts INTEGER);
CREATE TABLE IF NOT EXISTS event (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, host_id TEXT, serial TEXT, text TEXT NOT NULL);
`;

export function openDb(dir) {
  let file = ':memory:';
  if (dir) { mkdirSync(dir, { recursive: true }); file = path.join(dir, 'disktool.sqlite'); }
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  // Migrationen für bestehende Datenbanken (Spalten, die in späteren Versionen dazukamen).
  const cols = db.prepare('PRAGMA table_info(testrun)').all().map((c) => c.name);
  const hostCols = db.prepare('PRAGMA table_info(host_state)').all().map((c) => c.name);
  if (!hostCols.includes('gate_version')) db.exec('ALTER TABLE host_state ADD COLUMN gate_version INTEGER');
  const bgCols = db.prepare('PRAGMA table_info(backup_guest)').all().map((c) => c.name);
  if (!bgCols.includes('cause')) {
    db.exec('ALTER TABLE backup_guest ADD COLUMN cause TEXT');
    db.exec('ALTER TABLE backup_guest ADD COLUMN detail TEXT');
    db.exec('UPDATE backup_task SET parsed=0'); // ältere Auswertungen kannten den Fehlergrund nicht: Protokolle neu lesen
  }
  if (!cols.includes('planned_minutes')) db.exec('ALTER TABLE testrun ADD COLUMN planned_minutes INTEGER');
  if (!cols.includes('completes_long')) db.exec('ALTER TABLE testrun ADD COLUMN completes_long INTEGER DEFAULT 0');
  const q = (sql) => db.prepare(sql);
  const d = (ms) => (ms == null ? null : new Date(ms));
  const ms = (date) => (date == null ? null : date.getTime());

  return {
    raw: db,
    getSetting: (k) => q('SELECT value FROM settings WHERE key=?').get(k)?.value ?? null,
    setSetting: (k, v) => q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(k, String(v)),
    delSetting: (k) => q('DELETE FROM settings WHERE key=?').run(k),

    getHostSettings: (id) => { const r = q('SELECT json FROM host_settings WHERE host_id=?').get(id); return r ? JSON.parse(r.json) : null; },
    setHostSettings: (id, obj) => q('INSERT INTO host_settings(host_id,json) VALUES(?,?) ON CONFLICT(host_id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(obj)),

    getHostState: (id) => {
      const r = q('SELECT * FROM host_state WHERE host_id=?').get(id);
      return r ? { lastPoll: d(r.last_poll), reachable: !!r.reachable, uptimeSec: r.uptime_sec, uptimeAt: d(r.uptime_at), pools: r.pools ? JSON.parse(r.pools).map(normalizePool) : [], error: r.error, gateVersion: r.gate_version } : null;
    },
    setHostState: (id, s) => q(`INSERT INTO host_state(host_id,last_poll,reachable,uptime_sec,uptime_at,pools,error,gate_version) VALUES(?,?,?,?,?,?,?,?)
      ON CONFLICT(host_id) DO UPDATE SET last_poll=excluded.last_poll,reachable=excluded.reachable,uptime_sec=excluded.uptime_sec,uptime_at=excluded.uptime_at,pools=excluded.pools,error=excluded.error,gate_version=excluded.gate_version`)
      .run(id, ms(s.lastPoll), s.reachable ? 1 : 0, s.uptimeSec ?? null, ms(s.uptimeAt), JSON.stringify(s.pools ?? []), s.error ?? null, s.gateVersion ?? null),

    upsertDisk(hostId, disk, now, raw) {
      const st = disk.selftest;
      q(`INSERT INTO disk(serial,host_id,device,model,kind,capacity_bytes,total_lba,polling_short,polling_extended,selective,standby,selftest_running,selftest_remaining,last_seen,last_raw)
         VALUES(?,?,?,?,?,?,?,?,?,?,0,?,?,?,?)
         ON CONFLICT(serial) DO UPDATE SET host_id=excluded.host_id,device=excluded.device,model=excluded.model,kind=excluded.kind,capacity_bytes=excluded.capacity_bytes,
         total_lba=excluded.total_lba,polling_short=excluded.polling_short,polling_extended=excluded.polling_extended,selective=excluded.selective,standby=0,
         selftest_running=excluded.selftest_running,selftest_remaining=excluded.selftest_remaining,last_seen=excluded.last_seen,last_raw=excluded.last_raw`)
        .run(disk.serial, hostId, disk.device, disk.model, disk.kind, disk.capacityBytes, disk.totalLba, st.pollingShort, st.pollingExtended, st.selective ? 1 : 0,
          st.running ? 1 : 0, st.remainingPercent, ms(now), raw ? JSON.stringify(disk) : null);
    },
    markStandby: (serialOrDevice, hostId) => q('UPDATE disk SET standby=1 WHERE host_id=? AND (serial=? OR device=?)').run(hostId, serialOrDevice, serialOrDevice),
    disksOfHost: (hostId) => q('SELECT * FROM disk WHERE host_id=? ORDER BY device').all(hostId),
    getDisk: (serial) => q('SELECT * FROM disk WHERE serial=?').get(serial),
    setPaused: (serial, p) => q('UPDATE disk SET paused=? WHERE serial=?').run(p ? 1 : 0, serial),
    setLastOk: (serial, kind, date) => q(`UPDATE disk SET ${kind === 'short' ? 'last_short_ok' : 'last_long_ok'}=? WHERE serial=?`).run(ms(date), serial),
    setLbaPerMin: (serial, v) => q('UPDATE disk SET lba_per_min=? WHERE serial=?').run(v, serial),

    addSample: (serial, ts, m) => q('INSERT INTO sample(serial,ts,hours,temp,wear_used,reallocated,crc,reported_uncorrect,media_errors,level) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(serial, ms(ts), m.hours ?? null, m.temp ?? null, m.wearUsed ?? null, m.reallocated ?? null, m.crc ?? null, m.reportedUncorrect ?? null, m.mediaErrors ?? null, m.level ?? null),
    lastSampleTs: (serial) => d(q('SELECT MAX(ts) AS t FROM sample WHERE serial=?').get(serial)?.t),
    /** Ältester Messpunkt der letzten 90 Tage, der mindestens 3 Tage alt ist (Vergleichswert für „steigt“). */
    baseline(serial, now) {
      const r = q('SELECT * FROM sample WHERE serial=? AND ts>=? ORDER BY ts ASC LIMIT 1').get(serial, ms(now) - 90 * 864e5);
      if (!r || ms(now) - r.ts < 3 * 864e5) return null;
      return { reallocated: r.reallocated, crc: r.crc, reportedUncorrect: r.reported_uncorrect, mediaErrors: r.media_errors, ts: d(r.ts) };
    },
    history: (serial, sinceMs) => q('SELECT ts,hours,temp,wear_used,reallocated,crc,media_errors,level FROM sample WHERE serial=? AND ts>=? ORDER BY ts').all(serial, sinceMs),
    prune(now) { q('DELETE FROM sample WHERE ts<?').run(ms(now) - 800 * 864e5); q('DELETE FROM event WHERE ts<?').run(ms(now) - 365 * 864e5); },

    addRun: (r) => Number(q('INSERT INTO testrun(serial,host_id,kind,started,ended,lba_from,lba_to,hours_at_start,origin,planned_minutes,result,note,completes_long) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(r.serial, r.hostId, r.kind, ms(r.started), ms(r.ended), r.from ?? null, r.to ?? null, r.hoursAtStart ?? null, r.origin ?? 'plan', r.plannedMinutes ?? null, r.result ?? 'running', r.note ?? null, r.completesLong ? 1 : 0).lastInsertRowid),
    markCompletesLong: (id) => q('UPDATE testrun SET completes_long=1 WHERE id=?').run(id),
    /** Alle Testläufe seit einem Zeitpunkt, mit Angaben zur Platte (für Statistik und Testliste). */
    allRuns: (sinceMs, limit = 5000) => q(`SELECT r.id, r.serial, r.host_id AS hostId, r.kind, r.started, r.ended, r.result, r.note, r.origin, r.planned_minutes AS plannedMinutes, r.completes_long AS completesLong,
        d.model, d.device, d.kind AS diskKind, d.selftest_remaining AS remaining
        FROM testrun r LEFT JOIN disk d ON d.serial = r.serial WHERE r.started >= ? ORDER BY r.started DESC LIMIT ?`).all(sinceMs, limit),
    /** Tagesmittel der Temperatur je Host (Mittel, Minimum, Maximum über alle Platten und Messungen des Tages). */
    tempDaily: (hostId, sinceMs) => q(`SELECT date(s.ts/1000,'unixepoch','localtime') AS day, ROUND(AVG(s.temp),1) AS avg, MIN(s.temp) AS min, MAX(s.temp) AS max
        FROM sample s JOIN disk d ON d.serial = s.serial WHERE d.host_id = ? AND s.ts >= ? AND s.temp IS NOT NULL GROUP BY day ORDER BY day`).all(hostId, sinceMs),
    runningRuns: (hostId) => q("SELECT * FROM testrun WHERE host_id=? AND result='running'").all(hostId),
    finishRun: (id, result, ended, note) => q('UPDATE testrun SET result=?, ended=?, note=? WHERE id=?').run(result, ms(ended), note ?? null, id),
    runsOfDisk: (serial, limit = 20) => q('SELECT * FROM testrun WHERE serial=? ORDER BY started DESC LIMIT ?').all(serial, limit),
    runsSince: (hostId, sinceMs) => q('SELECT kind, started FROM testrun WHERE host_id=? AND started>=?').all(hostId, sinceMs),

    getProgress: (serial) => { const r = q('SELECT * FROM long_progress WHERE serial=?').get(serial); return r ? { nextLba: r.next_lba, totalLba: r.total_lba, lbaPerMin: r.lba_per_min, segments: r.segments, started: d(r.started) } : null; },
    setProgress: (serial, p) => q('INSERT INTO long_progress(serial,next_lba,total_lba,lba_per_min,segments,started) VALUES(?,?,?,?,?,?) ON CONFLICT(serial) DO UPDATE SET next_lba=excluded.next_lba,total_lba=excluded.total_lba,lba_per_min=excluded.lba_per_min,segments=excluded.segments')
      .run(serial, p.nextLba, p.totalLba, p.lbaPerMin ?? null, p.segments ?? 0, ms(p.started ?? new Date())),
    clearProgress: (serial) => q('DELETE FROM long_progress WHERE serial=?').run(serial),

    getApproval: (hostId) => { const r = q('SELECT * FROM approval WHERE host_id=?').get(hostId); return r ? { skipDate: r.skip_date, snoozeUntil: d(r.snooze_until), goAt: d(r.go_at) } : {}; },
    setApproval: (hostId, a) => q('INSERT INTO approval(host_id,skip_date,snooze_until,go_at) VALUES(?,?,?,?) ON CONFLICT(host_id) DO UPDATE SET skip_date=excluded.skip_date,snooze_until=excluded.snooze_until,go_at=excluded.go_at')
      .run(hostId, a.skipDate ?? null, ms(a.snoozeUntil), ms(a.goAt)),

    // ---- Backups und Snapshots (nur Beobachtung)
    replaceGuests(hostId, guests, now) {
      db.exec('BEGIN');
      try {
        q('DELETE FROM guest WHERE host_id=?').run(hostId);
        const ins = q('INSERT INTO guest(host_id,vmid,type,name,status,tags,template,seen) VALUES(?,?,?,?,?,?,?,?)');
        for (const g of guests) ins.run(hostId, g.vmid, g.type, g.name, g.status, g.tags.join(';'), g.template ? 1 : 0, ms(now));
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    guestsOf: (hostId) => q('SELECT vmid,type,name,status,tags,template,seen FROM guest WHERE host_id=? ORDER BY vmid').all(hostId).map((g) => ({ ...g, tags: g.tags ? g.tags.split(';') : [], template: !!g.template })),
    replaceSnaps(hostId, snaps) {
      db.exec('BEGIN');
      try {
        q('DELETE FROM snap WHERE host_id=?').run(hostId);
        const ins = q('INSERT OR REPLACE INTO snap(host_id,vmid,name,label,ts,description) VALUES(?,?,?,?,?,?)');
        for (const x of snaps) ins.run(hostId, x.vmid, x.name, x.label, x.ts, x.description ?? '');
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    snapsOf: (hostId) => q('SELECT vmid,name,label,ts,description FROM snap WHERE host_id=? ORDER BY ts DESC').all(hostId),
    upsertTask: (hostId, t) => q(`INSERT INTO backup_task(upid,host_id,start,end,status,user) VALUES(?,?,?,?,?,?)
      ON CONFLICT(upid) DO UPDATE SET start=excluded.start,end=excluded.end,status=excluded.status,user=excluded.user`).run(t.upid, hostId, t.start, t.end, t.status, t.user),
    unparsedTasks: (hostId, limit = 10) => q('SELECT upid FROM backup_task WHERE host_id=? AND parsed=0 AND end IS NOT NULL ORDER BY start DESC LIMIT ?').all(hostId, limit),
    setTaskResult(upid, job, guests) {
      db.exec('BEGIN');
      try {
        q('DELETE FROM backup_guest WHERE upid=?').run(upid);
        const ins = q('INSERT OR REPLACE INTO backup_guest(upid,vmid,type,result,seconds,note,cause,detail) VALUES(?,?,?,?,?,?,?,?)');
        for (const g of guests) ins.run(upid, g.vmid, g.type, g.result, g.seconds, g.note ?? '', g.cause ?? null, g.detail ?? null);
        q('UPDATE backup_task SET parsed=1, job=? WHERE upid=?').run(job, upid);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); throw e; }
    },
    tasksOf: (hostId, limit = 20) => q('SELECT upid,start,end,status,user,job,parsed FROM backup_task WHERE host_id=? ORDER BY start DESC LIMIT ?').all(hostId, limit),
    taskGuests: (upid) => q('SELECT vmid,type,result,seconds,note,cause,detail FROM backup_guest WHERE upid=? ORDER BY vmid').all(upid),
    /** Letztes Backup je Gast: neuester Lauf, in dem der Gast vorkam. */
    lastBackups: (hostId) => q(`SELECT g.vmid, g.result, g.seconds, g.note, g.cause, t.start, t.end, t.upid FROM backup_guest g JOIN backup_task t ON t.upid = g.upid
      WHERE t.host_id=? AND g.result IN ('ok','failed') AND t.start = (SELECT MAX(t2.start) FROM backup_task t2 JOIN backup_guest g2 ON g2.upid = t2.upid WHERE t2.host_id=t.host_id AND g2.vmid=g.vmid AND g2.result IN ('ok','failed'))`).all(hostId),
    lastOkBackups: (hostId) => q(`SELECT g.vmid, MAX(t.start) AS start FROM backup_guest g JOIN backup_task t ON t.upid = g.upid WHERE t.host_id=? AND g.result='ok' GROUP BY g.vmid`).all(hostId),
    setAutosnap: (hostId, obj, ts) => q('INSERT INTO autosnap_state(host_id,json,ts) VALUES(?,?,?) ON CONFLICT(host_id) DO UPDATE SET json=excluded.json,ts=excluded.ts').run(hostId, JSON.stringify(obj), ms(ts)),
    getAutosnap: (hostId) => { const r = q('SELECT json,ts FROM autosnap_state WHERE host_id=?').get(hostId); return r ? { ...JSON.parse(r.json), ts: r.ts } : null; },

    getAlert: (key) => q('SELECT level, alerted, updated FROM alert_state WHERE key=?').get(key) ?? null,
    setAlert: (key, level, alerted, ts) => q('INSERT INTO alert_state(key,level,alerted,updated) VALUES(?,?,?,?) ON CONFLICT(key) DO UPDATE SET level=excluded.level,alerted=excluded.alerted,updated=excluded.updated').run(key, level, alerted, ms(ts)),
    clearAlerts: () => q('DELETE FROM alert_state').run(),
    addEvent: (ts, hostId, serial, text) => q('INSERT INTO event(ts,host_id,serial,text) VALUES(?,?,?,?)').run(ms(ts), hostId ?? null, serial ?? null, text),
    events: (limit = 100) => q('SELECT * FROM event ORDER BY id DESC LIMIT ?').all(limit),
    close: () => db.close(),
  };
}
