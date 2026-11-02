// Zeitplan für Snapshots, die das Tool auslöst (statt Cron auf dem Host).
// Der Host erstellt die Snapshots weiter mit dem Wrapper autosnap-run. Das Tool entscheidet nur, WANN.
// Voreinstellung wie im bisherigen Cron: stündlich um :05, wöchentlich sonntags 00:25, monatlich am 1. um 00:45
// (fällt der Monatstag auf den Pausentag, am Folgetag). Ist der Host zur Zeit nicht erreichbar, wird wöchentlich/monatlich
// nachgeholt, sobald er läuft. Stündliche Läufe werden nicht nachgeholt.

export const LABELS = ['hourly', 'weekly', 'monthly'];
export const LABEL_DE = { hourly: 'stündlich', weekly: 'wöchentlich', monthly: 'monatlich' };
const MIN = 60000;
export const SNAP_DEFAULTS = { mode: 'cron' }; // 'cron' = Host macht es selbst, 'tool' = das Tool löst aus
export const PLAN_DEFAULTS = { hourly: true, hourlyMinute: 5, weekly: true, weeklyDay: 0, weeklyTime: '00:25', monthly: true, monthlyDay: 1, monthlyTime: '00:45' };

const hm = (t) => { const [h, m] = String(t).split(':').map(Number); return [h, m]; };
export const planOf = (p) => ({ ...PLAN_DEFAULTS, ...(p ?? {}) });

/** Prüft eine Planung aus der Oberfläche. Wirft bei ungültigen Werten. */
export function cleanPlan(input) {
  const i = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name}: erlaubt sind ${lo} bis ${hi}`); return n; };
  const t = (v, name) => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new Error(`${name}: Uhrzeit im Format HH:MM`); return String(v); };
  return {
    hourly: !!input.hourly, hourlyMinute: i(input.hourlyMinute, 0, 59, 'Minute (stündlich)'),
    weekly: !!input.weekly, weeklyDay: i(input.weeklyDay, 0, 6, 'Wochentag'), weeklyTime: t(input.weeklyTime, 'Uhrzeit (wöchentlich)'),
    monthly: !!input.monthly, monthlyDay: i(input.monthlyDay, 1, 28, 'Tag im Monat'), monthlyTime: t(input.monthlyTime, 'Uhrzeit (monatlich)'),
  };
}

/** Letzter geplanter Zeitpunkt (≤ now) je Bezeichnung. pauseDay: 0–6 (So–Sa) oder null. */
export function lastSlots(now, pauseDay = null, plan = null) {
  const p = planOf(plan);
  const hourly = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), p.hourlyMinute, 0);
  if (hourly > now) hourly.setHours(hourly.getHours() - 1);
  const [wh, wm] = hm(p.weeklyTime), [mh, mm] = hm(p.monthlyTime);
  const weekly = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() - p.weeklyDay + 7) % 7), wh, wm, 0);
  if (weekly > now) weekly.setDate(weekly.getDate() - 7);
  const monthDay = (y, m) => { const d = new Date(y, m, p.monthlyDay, mh, mm, 0); return pauseDay != null && d.getDay() === pauseDay ? new Date(y, m, p.monthlyDay + 1, mh, mm, 0) : d; };
  let monthly = monthDay(now.getFullYear(), now.getMonth());
  if (monthly > now) monthly = monthDay(now.getFullYear(), now.getMonth() - 1);
  return { hourly, weekly, monthly };
}

/**
 * Welche Läufe sind jetzt fällig?
 * @param {Date} now
 * @param {{pauseDay:number|null, enabled:boolean, uptimeSec:number|null, last:Record<string,{ts:number, ok:boolean}>, plan?:object}} o
 * @returns {{label:string, force:boolean}[]}
 */
export function dueSnapshots(now, { pauseDay = null, enabled = true, uptimeSec = null, last = {}, plan = null } = {}) {
  if (!enabled) return [];
  if (pauseDay != null && now.getDay() === pauseDay) return [];
  if (uptimeSec != null && uptimeSec < 10 * 60) return []; // Container müssen nach dem Hochfahren erst laufen
  const p = planOf(plan);
  const slots = lastSlots(now, pauseDay, p);
  const out = [];
  for (const label of LABELS) {
    if (!p[label]) continue;
    const slot = slots[label].getTime(), l = last[label];
    if (l && l.ts >= slot) continue; // für diesen Zeitpunkt schon gelaufen
    if (l && !l.ok && now.getTime() - l.ts < 15 * MIN) continue; // Fehlschlag: erst nach 15 min erneut
    if (label === 'hourly' && now.getTime() - slot > 55 * MIN) continue; // stündlich nur im laufenden Slot
    out.push({ label, force: label === 'monthly' });
  }
  return out;
}

/** Nächste geplante Zeitpunkte für die Anzeige. */
export function nextSlots(now, pauseDay = null, plan = null) {
  const p = planOf(plan), s = lastSlots(now, pauseDay, p);
  const [mh, mm] = hm(p.monthlyTime);
  const hourly = new Date(s.hourly.getTime() + 60 * MIN);
  const weekly = new Date(s.weekly); weekly.setDate(weekly.getDate() + 7);
  let monthly = new Date(s.monthly.getFullYear(), s.monthly.getMonth() + 1, p.monthlyDay, mh, mm, 0);
  if (pauseDay != null && monthly.getDay() === pauseDay) monthly = new Date(monthly.getFullYear(), monthly.getMonth(), p.monthlyDay + 1, mh, mm, 0);
  return { hourly, weekly, monthly };
}
