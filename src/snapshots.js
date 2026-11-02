// Zeitplan für Snapshots, die das Tool auslöst (statt Cron auf dem Host).
// Der Host erstellt die Snapshots weiter mit dem vorhandenen autosnap-Skript. Das Tool entscheidet nur, WANN.
// Zeiten wie im bisherigen Cron: stündlich um :05, wöchentlich sonntags 00:25, monatlich am 1. um 00:45 (ist der 1. der Pausentag, am 2.).
// Ist der Host zur Zeit nicht erreichbar, wird wöchentlich/monatlich nachgeholt, sobald er läuft. Stündliche Läufe werden nicht nachgeholt.

export const LABELS = ['hourly', 'weekly', 'monthly'];
export const LABEL_DE = { hourly: 'stündlich', weekly: 'wöchentlich', monthly: 'monatlich' };
const MIN = 60000;
export const SNAP_DEFAULTS = { mode: 'cron' }; // 'cron' = Host macht es selbst, 'tool' = das Tool löst aus

/** Letzter geplanter Zeitpunkt (≤ now) je Bezeichnung. pauseDay: 0–6 (So–Sa) oder null. */
export function lastSlots(now, pauseDay = null) {
  const hourly = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 5, 0);
  if (hourly > now) hourly.setHours(hourly.getHours() - 1);
  const weekly = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay(), 0, 25, 0);
  if (weekly > now) weekly.setDate(weekly.getDate() - 7);
  const monthDay = (y, m) => { const d = new Date(y, m, 1, 0, 45, 0); return pauseDay != null && d.getDay() === pauseDay ? new Date(y, m, 2, 0, 45, 0) : d; };
  let monthly = monthDay(now.getFullYear(), now.getMonth());
  if (monthly > now) monthly = monthDay(now.getFullYear(), now.getMonth() - 1);
  return { hourly, weekly, monthly };
}

/**
 * Welche Läufe sind jetzt fällig?
 * @param {Date} now
 * @param {{pauseDay:number|null, enabled:boolean, uptimeSec:number|null, last:Record<string,{ts:number, ok:boolean}>}} o
 * @returns {{label:string, force:boolean}[]}
 */
export function dueSnapshots(now, { pauseDay = null, enabled = true, uptimeSec = null, last = {} } = {}) {
  if (!enabled) return [];
  if (pauseDay != null && now.getDay() === pauseDay) return [];
  if (uptimeSec != null && uptimeSec < 10 * 60) return []; // Container müssen nach dem Hochfahren erst laufen
  const slots = lastSlots(now, pauseDay);
  const out = [];
  for (const label of LABELS) {
    const slot = slots[label].getTime(), l = last[label];
    if (l && l.ts >= slot) {
      continue; // für diesen Zeitpunkt schon gelaufen (auch wenn es fehlschlug: dann erst wieder nach 15 min)
    }
    if (l && !l.ok && now.getTime() - l.ts < 15 * MIN) continue;
    if (label === 'hourly' && now.getTime() - slot > 55 * MIN) continue; // stündlich nur im laufenden Slot
    out.push({ label, force: label === 'monthly' });
  }
  return out;
}

/** Nächste geplante Zeitpunkte für die Anzeige. */
export function nextSlots(now, pauseDay = null) {
  const s = lastSlots(now, pauseDay);
  const hourly = new Date(s.hourly.getTime() + 60 * MIN);
  const weekly = new Date(s.weekly); weekly.setDate(weekly.getDate() + 7);
  let monthly = new Date(s.monthly.getFullYear(), s.monthly.getMonth() + 1, 1, 0, 45, 0);
  if (pauseDay != null && monthly.getDay() === pauseDay) monthly = new Date(monthly.getFullYear(), monthly.getMonth(), 2, 0, 45, 0);
  return { hourly, weekly, monthly };
}
