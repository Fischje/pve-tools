// Gemeinsame Hilfen der Oberfläche: Elemente bauen (ohne innerHTML), Formatierung, kleine Bausteine.
// Alle Texte werden per textContent eingesetzt, nie als HTML (kein XSS durch Gerätenamen o. Ä.).

export const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
export const KIND = { hdd: 'HDD', ssd: 'SATA-SSD', nvme: 'NVMe' };
export const ICON = { ok: '✔', watch: '!', replace: '▲', critical: '✖', unknown: '?', info: 'i' };
export const LABEL = { ok: 'Gesund', watch: 'Beobachten', replace: 'Bald tauschen', critical: 'Kritisch', unknown: 'Unbekannt' };
export const RUN_LABEL = { short: 'Kurztest', long: 'Langtest', select: 'Langtest-Abschnitt', extern: 'Test (extern gestartet)' };
export const RESULT = { ok: 'ohne Fehler', failed: 'FEHLER', interrupted: 'unterbrochen', running: 'läuft' };


export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (['value', 'checked', 'disabled', 'selected'].includes(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}


// ---------- Formatierung ----------
export const d2 = (iso) => (iso ? new Date(iso) : null);
export const fmtDate = (iso) => (iso ? d2(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
export const fmtDT = (iso) => (iso ? d2(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
export const fmtSize = (b) => (b == null ? '–' : b >= 1e12 ? `${(b / 1e12).toFixed(b >= 1e13 ? 0 : 1)} TB`.replace('.', ',') : `${Math.round(b / 1e9)} GB`);
export const fmtAge = (hrs) => (hrs == null ? '–' : hrs >= 8766 ? `${(hrs / 8766).toFixed(1).replace('.', ',')} Jahre` : `${Math.round(hrs / 24)} Tage`);
export const fmtUp = (s) => (s == null ? '–' : s >= 86400 ? `${Math.floor(s / 86400)} Tage` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
export const pill = (level, text) => h('span', { class: `pill ${level}` }, h('span', { 'aria-hidden': 'true' }, ICON[level] ?? '?'), text ?? LABEL[level]);
export const fact = (k, v, title) => h('div', { class: 'fact', title }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
export const HOURS_HINT = 'Betriebsstunden, die die Platte selbst zählt. Das ist nicht das Alter seit dem Kauf: Zeiten, in denen der Rechner aus ist, zählen nicht (bei NVMe können auch Zeiten im Energiesparmodus fehlen).';
export const fmtCount = (n) => (n == null ? '–' : n.toLocaleString('de-DE'));
export function meter(label, pct, level, right) {
  const bar = h('span'); bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return h('div', {}, h('div', { class: 'meter-label' }, h('span', {}, label), h('span', {}, right ?? `${pct} %`)), h('div', { class: `meter ${level}`, role: 'img', 'aria-label': `${label}: ${pct} Prozent` }, bar));
}
export function topFinding(d) {
  return d.findings.find((f) => ['critical', 'replace', 'watch'].includes(f.level)) ?? d.findings.find((f) => f.level === 'ok') ?? d.findings[0];
}
export const wearLevel = (used) => (used >= 90 ? 'critical' : used >= 70 ? 'replace' : used >= 50 ? 'watch' : 'ok');

export const put = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x != null && x !== false));

/** Wird von app.js gefüllt: Aktionen, die mehrere Ansichten brauchen (Test starten, Details öffnen, neu laden …). */
export const ctx = {};

export const fmtDay = (iso) => (iso ? d2(iso).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' }) : '–');
export const fmtMin = (m) => (m == null ? '–' : m >= 120 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`);
export const dur = (a, b) => (a && b ? Math.round((new Date(b) - new Date(a)) / 60000) : null);
