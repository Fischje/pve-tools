// Statistiken über Testverläufe, Abdeckung und Platten. Reine Funktionen, damit sie sich mit erfundenen Daten testen lassen.

const DAY = 864e5;
const MONTHS = ['Jan', 'Feb', 'Mär', 'Apr', 'Mai', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dez'];
const group = (kind) => (kind === 'short' ? 'short' : 'long'); // „long“ umfasst Langtests und Langtest-Abschnitte

/**
 * @param {{runs:object[], disks:object[], now:Date, tempDaily?:object[], pools?:object[]}} o
 *   runs: {serial, hostId, kind, started(ms), ended(ms|null), result, completesLong, plannedMinutes}
 *   disks: {serial, hostId, device, model, kind, level, lastShortOk, lastLongOk, temperature, hours, capacityBytes, wearUsed}
 */
export function summarize({ runs, disks, now, tempDaily = [], pools = [] }) {
  const t = now.getTime();
  const done = runs.filter((r) => r.result !== 'running');
  const count = (list, res) => list.filter((r) => r.result === res).length;
  const ok = count(done, 'ok'), failed = count(done, 'failed'), interrupted = count(done, 'interrupted');
  const completed = ok + failed;

  const kindStats = (k) => {
    const l = done.filter((r) => group(r.kind) === k);
    return { n: l.length, ok: count(l, 'ok'), failed: count(l, 'failed'), interrupted: count(l, 'interrupted') };
  };

  // Monate (die letzten 12, ältester zuerst)
  const byMonth = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    byMonth.push({ key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: MONTHS[d.getMonth()], year: d.getFullYear(), ok: 0, failed: 0, interrupted: 0, short: 0, long: 0 });
  }
  const monthIdx = new Map(byMonth.map((m, i) => [m.key, i]));
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0)); // [Wochentag 0=So][Stunde]
  for (const r of done) {
    const s = new Date(r.started);
    const mi = monthIdx.get(`${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, '0')}`);
    if (mi != null) { byMonth[mi][r.result] = (byMonth[mi][r.result] ?? 0) + 1; byMonth[mi][group(r.kind)] += 1; }
    if (t - r.started <= 365 * DAY) heatmap[s.getDay()][s.getHours()] += 1;
  }

  // Dauer (nur beendete, bewertbare Läufe)
  const dur = (list) => {
    const m = list.filter((r) => r.ended != null && r.result !== 'interrupted').map((r) => (r.ended - r.started) / 60000);
    return m.length ? { n: m.length, avgMin: Math.round(m.reduce((a, b) => a + b, 0) / m.length), maxMin: Math.round(Math.max(...m)) } : { n: 0, avgMin: null, maxMin: null };
  };
  const minutesTotal = Math.round(done.filter((r) => r.ended != null).reduce((a, r) => a + (r.ended - r.started) / 60000, 0));

  // Abdeckung: wie lange liegt der letzte Test zurück?
  const days = (iso) => (iso ? Math.max(0, Math.floor((t - new Date(iso).getTime()) / DAY)) : null);
  const coverage = disks.map((d) => ({
    serial: d.serial, hostId: d.hostId, label: `${d.model} (${d.device})`, device: d.device, model: d.model, kind: d.kind, level: d.level,
    daysShort: days(d.lastShortOk), daysLong: days(d.lastLongOk),
  }));

  const levels = { ok: 0, watch: 0, replace: 0, critical: 0, unknown: 0 };
  for (const d of disks) levels[d.level] = (levels[d.level] ?? 0) + 1;

  const timeline = runs.filter((r) => t - r.started <= 14 * DAY).map((r) => ({ serial: r.serial, hostId: r.hostId, kind: r.kind, start: r.started, end: r.ended, result: r.result }))
    .sort((a, b) => a.start - b.start);

  // Plattenwerte
  const temps = disks.map((d) => d.temperature).filter((x) => x != null);
  const hours = disks.map((d) => d.hours).filter((x) => x != null);
  const wear = disks.map((d) => d.wearUsed).filter((x) => x != null);
  const avg = (a) => (a.length ? Math.round((a.reduce((x, y) => x + y, 0) / a.length) * 10) / 10 : null);
  const byKind = { hdd: 0, ssd: 0, nvme: 0 };
  for (const d of disks) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;

  return {
    totals: {
      runs: runs.length, ok, failed, interrupted, running: runs.length - done.length, successRate: completed ? Math.floor((ok / completed) * 1000) / 10 : null, // abgerundet: 100 heißt wirklich keine Fehlschläge
      last30: runs.filter((r) => t - r.started <= 30 * DAY).length, last365: runs.filter((r) => t - r.started <= 365 * DAY).length,
      longCompleted: runs.filter((r) => r.completesLong).length, hoursTested: Math.round(minutesTotal / 6) / 10,
    },
    byKind: { short: kindStats('short'), long: kindStats('long') },
    byMonth, heatmap,
    duration: { short: dur(done.filter((r) => r.kind === 'short')), long: dur(done.filter((r) => r.kind === 'long')), segment: dur(done.filter((r) => r.kind === 'select')) },
    coverage, levels, timeline,
    disks: {
      count: disks.length, byKind, capacityBytes: disks.reduce((a, d) => a + (d.capacityBytes ?? 0), 0),
      avgTemp: avg(temps), maxTemp: temps.length ? Math.max(...temps) : null, avgAgeHours: avg(hours), maxAgeHours: hours.length ? Math.max(...hours) : null,
      avgWearUsed: avg(wear), maxWearUsed: wear.length ? Math.max(...wear) : null,
    },
    tempDaily,
    pools: pools.map((p) => ({ name: p.name, level: p.level, state: p.state, cap: p.cap ?? null, size: p.size ?? null, alloc: p.alloc ?? null, vdevs: p.vdevs?.length ?? 0 })),
  };
}
