// Bereitet die Daten für die Oberfläche auf (Bewertung, nächste Termine, Banner, Zusammenfassung).
import { nextSlots } from './snapshots.js';
import { rate, LEVEL_LABEL, LEVEL_ORDER } from './rating.js';
import { testWindow, nextPlanned, blockedIntervals, dayAllowed, dayKey, DEFAULT_SETTINGS } from './schedule.js';
import { ratePool } from './zfs.js';
import { summarize } from './stats.js';
import { summarizeRun } from './backups.js';
import { EXPECTED_GATE_VERSION } from './gate-version.js';

const iso = (d) => (d ? new Date(d).toISOString() : null);

/** Prüft und bereinigt Einstellungen aus der Oberfläche. Wirft bei ungültigen Werten. */
export function cleanSettings(input) {
  const hm = (v, allow24 = false) => {
    if (!/^\d{1,2}:\d{2}$/.test(String(v))) throw new Error(`Ungültige Uhrzeit: ${v}`);
    const [h, m] = String(v).split(':').map(Number);
    if (m > 59 || h > 24 || (h === 24 && (m !== 0 || !allow24))) throw new Error(`Ungültige Uhrzeit: ${v}`);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  };
  const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name}: erlaubt sind ${lo} bis ${hi}`); return n; };
  const out = {};
  if ('enabled' in input) out.enabled = !!input.enabled;
  if ('autoStart' in input) out.autoStart = !!input.autoStart;
  if ('mode' in input) { if (!['fest', 'manuell'].includes(input.mode)) throw new Error('Ungültige Host-Art'); out.mode = input.mode; }
  if ('window' in input) out.window = { from: hm(input.window.from), to: hm(input.window.to, true) };
  if ('dayEnd' in input) out.dayEnd = hm(input.dayEnd, true);
  if ('blockedWeekdays' in input) {
    if (!Array.isArray(input.blockedWeekdays)) throw new Error('Gesperrte Wochentage: Liste erwartet');
    out.blockedWeekdays = [...new Set(input.blockedWeekdays.map((d) => int(d, 0, 6, 'Wochentag')))];
    if (out.blockedWeekdays.length >= 7) throw new Error('Es dürfen nicht alle Wochentage gesperrt sein.');
  }
  if ('blockedTimes' in input) {
    if (!Array.isArray(input.blockedTimes) || input.blockedTimes.length > 6) throw new Error('Sperrzeiten: höchstens 6');
    out.blockedTimes = input.blockedTimes.map((b) => ({ from: hm(b.from), to: hm(b.to, true) }));
  }
  if ('shortIntervalMonths' in input) out.shortIntervalMonths = int(input.shortIntervalMonths, 1, 12, 'Kurztest-Intervall');
  if ('longIntervalMonths' in input) out.longIntervalMonths = int(input.longIntervalMonths, 1, 12, 'Langtest-Intervall');
  if ('startupMinutes' in input) out.startupMinutes = int(input.startupMinutes, 0, 180, 'Anlaufzeit');
  if ('marginMinutes' in input) out.marginMinutes = int(input.marginMinutes, 0, 240, 'Sicherheitsabstand');
  if ('reservePercent' in input) out.reservePercent = int(input.reservePercent, 0, 50, 'Reserve');
  if ('longHintDays' in input) out.longHintDays = int(input.longHintDays, 30, 730, 'Hinweis Langtest');
  return out;
}


/** Ordnet die Geräte eines Pools den bekannten Platten zu (über die Seriennummer im Namen oder den Gerätenamen). */
export function annotatePool(pool, disks) {
  const bySerial = disks.filter((d) => d.serial && String(d.serial).length >= 5);
  const find = (name) => {
    const n = String(name);
    const hit = bySerial.find((d) => n.toLowerCase().includes(String(d.serial).toLowerCase()));
    if (hit) return hit;
    const base = n.replace(/^\/dev\//, '').replace(/-part\d+$/, '').replace(/^(sd[a-z]+)\d+$/, '$1').replace(/^(nvme\d+n\d+)p\d+$/, '$1');
    return disks.find((d) => d.device === `/dev/${base}`) ?? null;
  };
  const tag = (dev) => { const d = find(dev.name); return d ? { ...dev, serial: d.serial, diskLabel: `${d.model} (${d.device})`, diskLevel: d.level } : dev; };
  return { ...pool, vdevs: (pool.vdevs ?? []).map((v) => ({ ...tag(v), devices: (v.devices ?? []).map(tag) })) };
}

function bannerFor(host, s, st, hs, now) {
  if (s.mode !== 'manuell' || !hs?.reachable || !s.enabled) return null;
  if (!dayAllowed(now, s)) return null;
  if (blockedIntervals(now, s.blockedTimes).some((i) => now >= i.start && now < i.end)) return null;
  const ap = st.approval;
  if (ap.skipDate === dayKey(now) || st.disks.some((d) => d.running)) return null;
  const upMin = (st.uptimeSec ?? 0) / 60;
  return { autoStart: s.autoStart, startsInMin: s.autoStart ? Math.max(0, Math.ceil(s.startupMinutes - upMin)) : null, snoozed: !!(ap.snoozeUntil && ap.snoozeUntil > now), approved: st.approval.goNow };
}

export function overview(engine) {
  const now = engine.now();
  const { db } = engine;
  const levels = [];
  const hosts = engine.hosts.map((host) => {
    const s = engine.settings(host.id);
    const hs = db.getHostState(host.id);
    const st = engine.buildState(host.id, now);
    const win = testWindow(now, s, st.uptimeSec);
    const stById = new Map(st.disks.map((d) => [d.serial, d]));
    const disks = db.disksOfHost(host.id).map((row) => {
      const raw = row.last_raw ? JSON.parse(row.last_raw) : null;
      const rating = raw ? rate(raw, { baseline: db.baseline(row.serial, now), crcBaseline: db.crcBaseline(row.serial, now), longHintDays: s.longHintDays }) : { level: 'unknown', findings: [], score: null, healthText: 'Unbekannt' };
      const d = stById.get(row.serial);
      const planned = nextPlanned(now, s, d);
      const prog = d.longProgress;
      const runs = db.runsOfDisk(row.serial, 6).map((r) => ({ kind: r.kind, started: iso(r.started), ended: iso(r.ended), result: r.result, note: r.note, origin: r.origin }));
      levels.push(rating.level);
      return {
        serial: row.serial, hostId: host.id, device: row.device, model: row.model, kind: row.kind, capacityBytes: row.capacity_bytes, hours: raw?.hours ?? null, powerCycles: raw?.powerCycles ?? null, bytesWritten: raw?.bytesWritten ?? null, unsafeShutdowns: raw?.unsafeShutdowns ?? null, temperature: raw?.temperature ?? null,
        standby: !!row.standby, paused: !!row.paused, lastSeen: iso(row.last_seen), selective: !!row.selective,
        level: rating.level, levelLabel: LEVEL_LABEL[rating.level], score: rating.score, healthText: rating.healthText, wearUsed: rating.wearUsed, remainingLife: rating.remainingLife,
        findings: rating.findings, pollingShort: row.polling_short, pollingExtended: row.polling_extended,
        running: d.running ? { type: d.running.type, remainingPercent: row.selftest_remaining } : null,
        lastShortOk: iso(d.lastShortOk), lastLongOk: iso(d.lastLongOk), nextShort: iso(planned.short), nextLong: iso(planned.long),
        progress: prog ? { percent: Math.round((prog.nextLba / prog.totalLba) * 100), segments: prog.segments } : null,
        runs, attrs: raw?.attrs ? Object.values(raw.attrs) : [], nvme: raw?.nvme ?? null,
      };
    });
    const pools = (hs?.pools ?? []).map((p) => annotatePool(ratePool(p, now), disks));
    pools.forEach((p) => levels.push(p.level));
    const dec = engine.lastDecision.get(host.id);
    return {
      id: host.id, label: host.label ?? host.id, address: host.address ?? null, port: host.port ?? 22, kind: host.kind ?? 'fest', mode: s.mode, settings: s, reachable: !!hs?.reachable, error: hs?.error ?? null,
      lastPoll: iso(hs?.lastPoll), uptimeSec: st.uptimeSec, pools, linkFindings: engine.linkFindings(host.id),
      window: { open: win.open, reason: win.reason, softEnd: iso(win.softEnd), minutesLeft: win.minutesLeft },
      hostSummary: { reachable: !!hs?.reachable },
      rights: engine.hostRights(host.id), gate: { version: hs?.gateVersion ?? null, expected: EXPECTED_GATE_VERSION, outdated: !!hs?.reachable && hs?.gateVersion != null && hs.gateVersion < EXPECTED_GATE_VERSION },
      decision: dec ? { action: dec.action, reason: dec.reason } : null,
      banner: bannerFor(host, s, st, hs, now),
      disks,
    };
  });
  const bad = levels.filter((l) => l === 'replace' || l === 'critical').length;
  const watch = levels.filter((l) => l === 'watch').length;
  const worst = levels.reduce((a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a), 'ok');
  const summary = bad ? `${bad} ${bad === 1 ? 'Platte braucht' : 'Platten brauchen'} Aufmerksamkeit` : watch ? `Alles läuft, ${watch} ${watch === 1 ? 'Platte wird' : 'Platten werden'} beobachtet` : 'Alles in Ordnung';
  return {
    now: iso(now), summary: { text: summary, level: worst }, hosts,
    events: db.events(50).map((e) => ({ ts: iso(e.ts), hostId: e.host_id, serial: e.serial, text: e.text })),
    defaults: DEFAULT_SETTINGS,
    polling: engine.pollingSettings(),
    mail: engine.notifier?.publicConfig() ?? null,
  };
}

export function diskDetail(engine, serial, days = 365) {
  const now = engine.now();
  const row = engine.db.getDisk(serial);
  if (!row) return null;
  const hist = engine.db.history(serial, now.getTime() - days * 864e5);
  return { serial, history: hist.map((h) => ({ ts: iso(h.ts), hours: h.hours, temp: h.temp, wearUsed: h.wear_used, reallocated: h.reallocated, crc: h.crc, mediaErrors: h.media_errors, level: h.level })), runs: engine.db.runsOfDisk(serial, 50).map((r) => ({ kind: r.kind, started: iso(r.started), ended: iso(r.ended), result: r.result, note: r.note, origin: r.origin, from: r.lba_from, to: r.lba_to })) };
}

const toRun = (r) => ({ ...r, started: r.started, ended: r.ended });

/** Statistik für die Startseite: gesamt und je Host. */
export function statsOverview(engine) {
  const now = engine.now();
  const ov = overview(engine);
  const runs = engine.db.allRuns(now.getTime() - 400 * 864e5).map(toRun);
  const diskOf = (d) => ({ ...d, hostId: d.hostId });
  const all = ov.hosts.flatMap((h) => h.disks.map(diskOf));
  const global = summarize({ runs, disks: all, now, pools: ov.hosts.flatMap((h) => h.pools) });
  const hosts = {};
  for (const h of ov.hosts) {
    hosts[h.id] = summarize({
      runs: runs.filter((r) => r.hostId === h.id), disks: h.disks.map(diskOf), now,
      tempDaily: engine.db.tempDaily(h.id, now.getTime() - 60 * 864e5), pools: h.pools,
    });
  }
  return { generatedAt: now.toISOString(), global, hosts, hostLabels: Object.fromEntries(ov.hosts.map((h) => [h.id, h.label])) };
}

/** Laufende Tests und Verlauf aller Tests (optional nur ein Host). */
export function testsList(engine, { limit = 300, hostId = null } = {}) {
  const now = engine.now();
  const label = Object.fromEntries(engine.hosts.map((h) => [h.id, h.label ?? h.id]));
  const rows = engine.db.allRuns(now.getTime() - 800 * 864e5, 5000).filter((r) => label[r.hostId] && (!hostId || r.hostId === hostId));
  const shape = (r) => ({
    id: r.id, hostId: r.hostId, hostLabel: label[r.hostId], serial: r.serial, device: r.device, model: r.model, kind: r.kind,
    started: iso(r.started), ended: iso(r.ended), result: r.result, note: r.note, origin: r.origin, plannedMinutes: r.plannedMinutes,
    remainingPercent: r.result === 'running' ? r.remaining : null,
  });
  const running = rows.filter((r) => r.result === 'running').map(shape);
  // Tests, die nicht von diesem Tool gestartet wurden (direkt am Host), aber auf der Platte laufen.
  for (const host of engine.hosts) {
    if (hostId && host.id !== hostId) continue;
    for (const d of engine.db.disksOfHost(host.id)) {
      if (d.selftest_running && !running.some((r) => r.serial === d.serial)) {
        running.push({ id: null, hostId: host.id, hostLabel: label[host.id], serial: d.serial, device: d.device, model: d.model, kind: 'extern', started: null, ended: null, result: 'running', note: null, origin: 'extern', plannedMinutes: null, remainingPercent: d.selftest_remaining });
      }
    }
  }
  return { now: iso(now), running, runs: rows.slice(0, limit).map(shape) };
}

const DAY_MS = 864e5;
const lv = (l) => ['ok', 'info', 'watch', 'replace'].indexOf(l);

/**
 * Backups und Snapshots je Host: Gäste mit Snapshot-Stand und letztem Backup, Zustand der Snapshot-Skripte, letzte Backup-Läufe.
 * Es wird nur beobachtet. Ob ein Gast ein Backup bekommen soll, weiß das Tool in dieser Stufe nicht (die Ausschlussliste steht im Orchestrator),
 * deshalb gibt es nur dann einen Hinweis, wenn ein Gast früher gesichert wurde und jetzt zu lange nicht mehr.
 */
/** Zustand der Snapshot-Auslösung durch das Tool für die Oberfläche. */
function snapControl(engine, hostId, as, now) {
  const ctl = engine.snapCtl(hostId), rights = engine.hostRights(hostId), last = engine.snapLast(hostId);
  const next = nextSlots(new Date(now), as?.pauseDay ?? null);
  return {
    mode: ctl.mode, allowed: rights.includes('snapshots'), rights,
    last: Object.fromEntries(Object.entries(last).map(([k, v]) => [k, { ts: iso(v.ts), ok: v.ok, text: v.text }])),
    next: Object.fromEntries(Object.entries(next).map(([k, v]) => [k, iso(v)])),
    cronStillActive: ctl.mode === 'tool' && !!as?.cron?.length,
  };
}

export function backupOverview(engine) {
  const now = engine.now(), t = now.getTime(), db = engine.db;
  const hosts = engine.hosts.map((host) => {
    const hs = db.getHostState(host.id);
    const supported = (hs?.gateVersion ?? 1) >= 4;
    const as = db.getAutosnap(host.id);
    const tag = as?.tag ?? 'autosnap';
    const uptimeMin = hs?.reachable && hs.uptimeSec != null ? (hs.uptimeSec + (now - hs.uptimeAt) / 1000) / 60 : 0;
    const snaps = db.snapsOf(host.id);
    const lastBk = new Map(db.lastBackups(host.id).map((r) => [r.vmid, r]));
    const lastOk = new Map(db.lastOkBackups(host.id).map((r) => [r.vmid, r.start]));
    const pauseToday = as?.pauseDay != null && now.getDay() === (as.pauseDay % 7);
    const guests = db.guestsOf(host.id).filter((g) => !g.template).map((g) => {
      const mine = snaps.filter((x) => x.vmid === g.vmid);
      const by = (label) => { const l = mine.filter((x) => x.label === label); return { count: l.length, newest: l[0]?.ts ?? null, oldest: l.at(-1)?.ts ?? null }; };
      const snapshots = { hourly: by('hourly'), weekly: by('weekly'), monthly: by('monthly'), other: mine.filter((x) => !x.label).length };
      const tagged = g.tags.includes(tag);
      const findings = [];
      const add = (level, text) => findings.push({ level, text });
      if (tagged && g.status === 'running' && as?.known) {
        if (!as.enabled) add('info', 'Snapshots sind auf dem Host ausgeschaltet');
        else {
          const hAge = snapshots.hourly.newest ? (t - snapshots.hourly.newest) / 60000 : null;
          if (hAge == null && uptimeMin > 90 && !pauseToday) add('watch', 'Noch kein Stunden-Snapshot vorhanden');
          else if (hAge != null && hAge > 90 && uptimeMin > hAge && !pauseToday) add('watch', `Letzter Stunden-Snapshot vor ${Math.round(hAge / 60)} h, obwohl der Host läuft`);
          if (as.keep?.hourly && snapshots.hourly.count > as.keep.hourly) add('info', `${snapshots.hourly.count} Stunden-Snapshots, vorgesehen sind ${as.keep.hourly}`);
          const wAge = snapshots.weekly.newest ? (t - snapshots.weekly.newest) / DAY_MS : null;
          if (wAge == null || wAge > 9) add('info', wAge == null ? 'Noch kein wöchentlicher Snapshot' : `Letzter wöchentlicher Snapshot vor ${Math.round(wAge)} Tagen (Sonntag 00:25, läuft nur, wenn der Host dann an ist)`);
          const mAge = snapshots.monthly.newest ? (t - snapshots.monthly.newest) / DAY_MS : null;
          if (mAge == null || mAge > 35) add('info', mAge == null ? 'Noch kein monatlicher Snapshot' : `Letzter monatlicher Snapshot vor ${Math.round(mAge)} Tagen (am 1. oder 2. um 00:45, läuft nur, wenn der Host dann an ist)`);
        }
      }
      const bk = lastBk.get(g.vmid);
      const okAt = lastOk.get(g.vmid) ?? null;
      const backup = bk ? { result: bk.result, at: iso(bk.start), seconds: bk.seconds, note: bk.note, cause: bk.cause ?? null, lastOkAt: iso(okAt) } : null;
      if (bk?.result === 'failed') {
        add('replace', bk.cause === 'verbindung' ? 'Letztes Backup fehlgeschlagen: Verbindung zum PBS fehlte oder brach ab (Einzelheiten beim Backup-Lauf)' : `Letztes Backup fehlgeschlagen${bk.note ? `: ${bk.note.slice(0, 120)}` : ''}`);
      }
      else if (okAt && (t - okAt) / DAY_MS > 9) add('watch', `Kein Backup seit ${Math.round((t - okAt) / DAY_MS)} Tagen (üblich: wöchentlich montags)`);
      const level = findings.reduce((a, f) => (lv(f.level) > lv(a) ? f.level : a), 'ok');
      return { vmid: g.vmid, type: g.type, name: g.name, status: g.status, tags: g.tags, tagged, snapshots, backup, findings, level };
    });
    const tasks = db.tasksOf(host.id, 12).map((tk) => {
      const gs = tk.parsed ? db.taskGuests(tk.upid) : [];
      const sum = summarizeRun(gs);
      return { upid: tk.upid, start: iso(tk.start), end: iso(tk.end), running: !tk.end && tk.start != null && (t - tk.start) < 12 * 3600e3, minutes: tk.start && tk.end ? Math.round((tk.end - tk.start) / 60000) : null, status: tk.status, job: tk.job,
        summary: sum, parsed: !!tk.parsed, ok: gs.filter((x) => x.result === 'ok').length, failed: gs.filter((x) => x.result === 'failed').length, interrupted: gs.filter((x) => x.result === 'interrupted').length,
        guests: gs.map((x) => ({ vmid: x.vmid, type: x.type, result: x.result, seconds: x.seconds, note: x.note, cause: x.cause ?? null, detail: x.detail ?? null, name: guests.find((g) => g.vmid === x.vmid)?.name ?? null })) };
    });
    return {
      id: host.id, label: host.label ?? host.id, reachable: !!hs?.reachable, supported, gate: { version: hs?.gateVersion ?? null, expected: EXPECTED_GATE_VERSION },
      autosnap: as ? { ...as, ts: iso(as.ts), pauseToday } : null, snapControl: snapControl(engine, host.id, as, t), guests, tasks, runningJob: tasks.find((x) => x.running) ?? null,
      lastRun: tasks.find((x) => !x.running && x.parsed) ?? null, polledAt: iso(Number(db.getSetting(`backups_poll:${host.id}`) ?? 0) || null),
    };
  });
  // Kennzahlen
  const allTasks = hosts.flatMap((h) => h.tasks.map((x) => ({ ...x, hostId: h.id, hostLabel: h.label }))).filter((x) => x.start).sort((a, b) => b.start.localeCompare(a.start));
  const guestsAll = hosts.flatMap((h) => h.guests.map((g) => ({ ...g, hostId: h.id })));
  return {
    now: iso(now), hosts, lastRun: allTasks[0] ?? null,
    kpi: {
      failedCause: hosts.some((h) => h.lastRun?.summary?.cause === 'verbindung') ? 'verbindung' : null, guests: guestsAll.length, snapshotsOn: hosts.filter((h) => h.autosnap?.enabled).length, snapshotsOff: hosts.filter((h) => h.autosnap?.known && !h.autosnap.enabled).length,
      problems: guestsAll.filter((g) => lv(g.level) >= lv('watch')).length, failedBackups: guestsAll.filter((g) => g.backup?.result === 'failed').length,
      runs30: allTasks.filter((x) => (t - Date.parse(x.start)) / DAY_MS <= 30).length,
    },
  };
}
