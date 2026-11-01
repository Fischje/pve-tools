// Bereitet die Daten für die Oberfläche auf (Bewertung, nächste Termine, Banner, Zusammenfassung).
import { rate, LEVEL_LABEL, LEVEL_ORDER } from './rating.js';
import { testWindow, nextPlanned, blockedIntervals, dayAllowed, dayKey, DEFAULT_SETTINGS } from './schedule.js';

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
      const rating = raw ? rate(raw, { baseline: db.baseline(row.serial, now), longHintDays: s.longHintDays }) : { level: 'unknown', findings: [], score: null, healthText: 'Unbekannt' };
      const d = stById.get(row.serial);
      const planned = nextPlanned(now, s, d);
      const prog = d.longProgress;
      const runs = db.runsOfDisk(row.serial, 6).map((r) => ({ kind: r.kind, started: iso(r.started), ended: iso(r.ended), result: r.result, note: r.note, origin: r.origin }));
      levels.push(rating.level);
      return {
        serial: row.serial, device: row.device, model: row.model, kind: row.kind, capacityBytes: row.capacity_bytes, hours: raw?.hours ?? null, temperature: raw?.temperature ?? null,
        standby: !!row.standby, paused: !!row.paused, lastSeen: iso(row.last_seen), selective: !!row.selective,
        level: rating.level, levelLabel: LEVEL_LABEL[rating.level], score: rating.score, healthText: rating.healthText, wearUsed: rating.wearUsed, remainingLife: rating.remainingLife,
        findings: rating.findings, pollingShort: row.polling_short, pollingExtended: row.polling_extended,
        running: d.running ? { type: d.running.type, remainingPercent: row.selftest_remaining } : null,
        lastShortOk: iso(d.lastShortOk), lastLongOk: iso(d.lastLongOk), nextShort: iso(planned.short), nextLong: iso(planned.long),
        progress: prog ? { percent: Math.round((prog.nextLba / prog.totalLba) * 100), segments: prog.segments } : null,
        runs, attrs: raw?.attrs ? Object.values(raw.attrs) : [], nvme: raw?.nvme ?? null,
      };
    });
    const pools = (hs?.pools ?? []);
    pools.forEach((p) => levels.push(p.level));
    const dec = engine.lastDecision.get(host.id);
    return {
      id: host.id, label: host.label ?? host.id, mode: s.mode, settings: s, reachable: !!hs?.reachable, error: hs?.error ?? null,
      lastPoll: iso(hs?.lastPoll), uptimeSec: st.uptimeSec, pools,
      window: { open: win.open, reason: win.reason, softEnd: iso(win.softEnd), minutesLeft: win.minutesLeft },
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
  };
}

export function diskDetail(engine, serial, days = 365) {
  const now = engine.now();
  const row = engine.db.getDisk(serial);
  if (!row) return null;
  const hist = engine.db.history(serial, now.getTime() - days * 864e5);
  return { serial, history: hist.map((h) => ({ ts: iso(h.ts), hours: h.hours, temp: h.temp, wearUsed: h.wear_used, reallocated: h.reallocated, crc: h.crc, mediaErrors: h.media_errors, level: h.level })), runs: engine.db.runsOfDisk(serial, 50).map((r) => ({ kind: r.kind, started: iso(r.started), ended: iso(r.ended), result: r.result, note: r.note, origin: r.origin, from: r.lba_from, to: r.lba_to })) };
}
