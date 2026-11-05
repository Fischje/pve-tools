// Statistiken: Gesamtübersicht und je Host. Die Zahlen kommen fertig berechnet von /api/stats.
import { h, KIND, LABEL, fmtSize, fmtAge, fmtMin, pill, meter } from './dom.js';
import { barStack, heatmap, donut, hbars, timeline, lineChart, figure } from './charts.js';

const kpi = (label, value, sub, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
const hourBlocked = (hr, times) => times.some((t) => { const f = Number(t.from.slice(0, 2)), e = Number(t.to.slice(0, 2)) % 24; return f < e ? hr >= f && hr < e : hr >= f || hr < e; });
const rateClass = (r) => (r == null ? '' : r >= 98 ? 'ok' : r >= 85 ? 'watch' : 'bad');

/** Einstellungen, die für Diagramme wichtig sind (gesperrte Tage/Zeiten, Soll-Intervalle). */
function planOf(data, hostId) {
  const host = data.hosts.find((x) => x.id === hostId) ?? data.hosts[0];
  const s = host?.settings ?? { blockedWeekdays: [1], blockedTimes: [], shortIntervalMonths: 1, longIntervalMonths: 3 };
  return { s, shortDays: s.shortIntervalMonths * 30, longDays: s.longIntervalMonths * 30, blocked: (d, hr) => s.blockedWeekdays.includes(d) || hourBlocked(hr, s.blockedTimes) };
}

function coverageRows(st, data, type) {
  const hostOf = (id) => data.hosts.find((x) => x.id === id);
  return st.coverage.map((c) => ({ label: `${st.multiHost ? `${hostOf(c.hostId)?.label ?? c.hostId}: ` : ''}${c.model} (${c.device})`, days: type === 'short' ? c.daysShort : c.daysLong, serial: c.serial,
    interval: (hostOf(c.hostId)?.settings?.[type === 'short' ? 'shortIntervalMonths' : 'longIntervalMonths'] ?? (type === 'short' ? 1 : 3)) * 30 }));
}

/** KPIs und Diagramme für eine Statistik-Zusammenfassung (global oder ein Host). */
function testWidgets(st, data, { hostId = null, labels = {} } = {}) {
  const plan = planOf(data, hostId);
  const overdue = st.coverage.filter((c) => c.daysShort == null || c.daysShort > plan.shortDays * 1.1 || c.daysLong == null || c.daysLong > plan.longDays * 1.1).length;
  const t = st.totals;
  const runningNames = data.hosts.flatMap((x) => (hostId && x.id !== hostId ? [] : x.disks.filter((d) => d.running).map((d) => `${d.device}`)));
  const kpis = h('div', { class: 'kpis' },
    kpi('Tests in 30 Tagen', t.last30, `${t.last365} in den letzten 12 Monaten`),
    kpi('Erfolgsquote', t.successRate == null ? '–' : `${t.successRate} %`, t.failed ? `${t.failed} fehlgeschlagen` : 'keine Fehlschläge', rateClass(t.successRate)),
    kpi('Läuft gerade', h('span', {}, t.running ? h('span', { class: 'run-dot', 'aria-hidden': 'true' }) : null, t.running), t.running ? runningNames.slice(0, 3).join(', ') : 'kein Test aktiv'),
    kpi('Langtests komplett', t.longCompleted, 'in den letzten 12 Monaten'),
    kpi('Überfällige Platten', overdue, overdue ? 'Test nach Plan nicht aktuell' : 'alle Platten im Plan', overdue ? 'watch' : 'ok'),
    kpi('Testzeit insgesamt', `${t.hoursTested} h`, 'Summe aller beendeten Tests'));

  const months = st.byMonth;
  const sum = (k) => st.byKind[k];
  const dur = st.duration;
  const durRow = (name, d) => h('tr', {}, h('td', {}, name), h('td', {}, d.n), h('td', {}, fmtMin(d.avgMin)), h('td', {}, fmtMin(d.maxMin)));
  const kindRow = (name, k) => h('tr', {}, h('td', {}, name), h('td', {}, k.n), h('td', {}, k.ok), h('td', {}, k.failed), h('td', {}, k.interrupted));

  const charts = h('div', { class: 'statgrid' },
    figure('Tests pro Monat', barStack(months, 'Tests pro Monat der letzten zwölf Monate, nach Ergebnis'), { legend: [['fill-ok', 'in Ordnung'], ['fill-int', 'unterbrochen'], ['fill-failed', 'fehlgeschlagen']], note: 'Langtests großer Platten zählen je Abschnitt einzeln.' }),
    figure('Wann laufen Tests?', heatmap(st.heatmap, { blocked: plan.blocked }, 'Anzahl der Teststarts nach Wochentag und Uhrzeit'), { legend: [['fill-short', 'mehr Tests = dunkler'], ['fill-muted', 'gesperrt laut Zeitplan (gestrichelt)']], note: 'Zeigt, ob die Sperrzeiten (z. B. Montag, 19–01 Uhr) eingehalten werden.' }),
    figure('Ergebnisse', h('div', { class: 'donut-row' }, donut([{ label: 'in Ordnung', value: t.ok, cls: 'stroke-ok' }, { label: 'unterbrochen', value: t.interrupted, cls: 'stroke-int' }, { label: 'fehlgeschlagen', value: t.failed, cls: 'stroke-failed' }], t.ok + t.interrupted + t.failed, 'Ergebnisse aller beendeten Tests'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Art', 'Tests', 'in Ordnung', 'Fehler', 'unterbr.'].map((x) => h('th', {}, x)))), h('tbody', {}, kindRow('Kurztest', sum('short')), kindRow('Langtest/Abschnitt', sum('long'))))),
      { legend: [['fill-ok', 'in Ordnung'], ['fill-int', 'unterbrochen (z. B. Fensterende)'], ['fill-failed', 'fehlgeschlagen']], note: 'Unterbrochene Tests sind kein Fehler der Platte. Sie werden im nächsten Fenster wiederholt.' }),
    figure('Wie lange dauern Tests?', h('table', {}, h('thead', {}, h('tr', {}, ['Art', 'Anzahl', 'Ø Dauer', 'Längste'].map((x) => h('th', {}, x)))), h('tbody', {}, durRow('Kurztest', dur.short), durRow('Langtest am Stück', dur.long), durRow('Langtest-Abschnitt', dur.segment))), { note: 'Die Dauer ist auf wenige Minuten genau (Abfrageintervall).' }),
    figure('Zustand der Platten', h('div', { class: 'donut-row' }, donut([{ label: 'Gesund', value: st.levels.ok, cls: 'stroke-ok' }, { label: 'Beobachten', value: st.levels.watch, cls: 'stroke-watch' }, { label: 'Bald tauschen', value: st.levels.replace, cls: 'stroke-replace' }, { label: 'Kritisch', value: st.levels.critical, cls: 'stroke-failed' }, { label: 'Unbekannt', value: st.levels.unknown, cls: 'stroke-muted' }], st.disks.count, 'Zustand der Platten'),
      h('ul', { class: 'plain' }, ['ok', 'watch', 'replace', 'critical'].filter((l) => st.levels[l]).map((l) => h('li', {}, pill(l), ` ${st.levels[l]}`)))), { note: `${st.disks.byKind.hdd} HDD, ${st.disks.byKind.ssd} SATA-SSD, ${st.disks.byKind.nvme} NVMe` }),
    // Die beiden Balken „Tage seit dem letzten Test“ nur in der Statistik eines Hosts, nicht auf der Startseite (zu lang und wenig aussagekräftig).
    hostId ? figure('Kurztest: Tage seit dem letzten Test', hbars(coverageRows({ ...st, multiHost: !hostId }, data, 'short'), { intervalDays: plan.shortDays, maxDays: plan.shortDays * 2, label: 'Tage seit dem letzten Kurztest je Platte' }), { wide: true, legend: [['fill-ok', 'im Plan'], ['fill-int', 'bald fällig'], ['fill-failed', 'überfällig oder noch nie']] }) : null,
    hostId ? figure('Langtest: Tage seit dem letzten Test', hbars(coverageRows({ ...st, multiHost: !hostId }, data, 'long'), { intervalDays: plan.longDays, maxDays: plan.longDays * 2, label: 'Tage seit dem letzten Langtest je Platte' }), { wide: true, legend: [['fill-ok', 'im Plan'], ['fill-int', 'bald fällig'], ['fill-failed', 'überfällig oder noch nie']] }) : null,
    figure('Testverlauf der letzten 14 Tage', timeline(st.coverage.map((c) => ({ serial: c.serial, label: `${hostId ? '' : `${labels[c.hostId] ?? c.hostId}: `}${c.model} (${c.device})` })), st.timeline, Date.parse(data.now), 14, { blockedWeekdays: plan.s.blockedWeekdays }, 'Zeitleiste der Tests der letzten 14 Tage'), { wide: true, legend: [['fill-ok', 'in Ordnung'], ['fill-int', 'unterbrochen'], ['fill-failed', 'fehlgeschlagen'], ['fill-run', 'läuft'], ['fill-muted', 'gesperrter Wochentag']], note: 'Mit der Maus über einen Balken fahren zeigt Start, Ende und Ergebnis.' }));
  return [kpis, charts];
}

/** Gesamtübersicht über alle Hosts. */
export function globalStats(stats, data) {
  const labels = stats.hostLabels;
  const d = stats.global.disks;
  return h('section', {}, h('div', { class: 'sec-title' }, h('h2', {}, 'Tests und Platten im Überblick')),
    testWidgets(stats.global, data, { labels }),
    h('div', { class: 'kpis' }, kpi('Platten gesamt', d.count, `${d.byKind.hdd} HDD · ${d.byKind.ssd} SSD · ${d.byKind.nvme} NVMe`), kpi('Speicher gesamt', fmtSize(d.capacityBytes), 'Rohkapazität aller Platten'), kpi('Ø Betriebszeit', fmtAge(d.avgAgeHours), `längste: ${fmtAge(d.maxAgeHours)}`), kpi('Temperatur', d.avgTemp == null ? '–' : `${d.avgTemp} °C`, `Maximum ${d.maxTemp ?? '–'} °C`)));
}

let selected = null;
/** Statistik je Host mit Auswahl. */
export function hostStatsSection(stats, data, { onSelect } = {}) {
  const ids = data.hosts.map((x) => x.id);
  if (!ids.includes(selected)) selected = (() => { try { return localStorage.getItem('statHost'); } catch { return null; } })();
  if (!ids.includes(selected)) selected = ids[0] ?? null;
  const box = h('div', {});
  const draw = () => {
    box.replaceChildren(...(selected ? [hostBody(stats, data, selected)] : [h('p', { class: 'empty' }, 'Noch keine Hosts.')]));
    sel.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.id === selected)));
  };
  const sel = h('div', { class: 'seg', role: 'group', 'aria-label': 'Host für die Statistik wählen' },
    data.hosts.map((x) => h('button', { 'data-id': x.id, 'aria-pressed': String(x.id === selected), onclick: () => { selected = x.id; try { localStorage.setItem('statHost', x.id); } catch { /* egal */ } draw(); onSelect?.(x.id); } }, x.label)));
  draw();
  return h('section', {}, h('div', { class: 'sec-title' }, h('h2', {}, 'Statistiken je Host'), sel), box);
}

export function hostBody(stats, data, hostId) {
  const st = stats.hosts[hostId], host = data.hosts.find((x) => x.id === hostId);
  if (!st || !host) return h('p', { class: 'empty' }, 'Keine Daten.');
  const d = st.disks;
  const worstPool = host.pools.reduce((a, p) => (['ok', 'watch', 'replace', 'critical'].indexOf(p.level) > ['ok', 'watch', 'replace', 'critical'].indexOf(a) ? p.level : a), 'ok');
  const extra = h('div', { class: 'kpis' },
    kpi('Platten', d.count, `${d.byKind.hdd} HDD · ${d.byKind.ssd} SSD · ${d.byKind.nvme} NVMe`), kpi('Speicher (roh)', fmtSize(d.capacityBytes), `Ø Betriebszeit ${fmtAge(d.avgAgeHours)}`),
    kpi('Temperatur', d.avgTemp == null ? '–' : `${d.avgTemp} °C`, `Maximum ${d.maxTemp ?? '–'} °C`, d.maxTemp >= 55 ? 'watch' : ''),
    kpi('Verschleiß SSD/NVMe', d.avgWearUsed == null ? '–' : `Ø ${d.avgWearUsed} %`, d.maxWearUsed == null ? 'keine SSD/NVMe' : `höchster Wert ${d.maxWearUsed} %`, d.maxWearUsed >= 70 ? 'watch' : ''),
    kpi('ZFS-Pools', host.pools.length, host.pools.length ? host.pools.map((p) => `${p.name}${p.cap != null ? ` ${p.cap} %` : ''}`).join(' · ') : 'kein ZFS', worstPool === 'ok' ? 'ok' : worstPool === 'watch' ? 'watch' : 'bad'));
  const temp = figure('Temperaturverlauf (60 Tage)', lineChart(st.tempDaily, { label: `Tagesmittel der Plattentemperaturen von ${host.label}` }), { wide: true, legend: [['fill-short', 'Tagesmittel'], ['fill-muted', 'Minimum bis Maximum']] });
  const [kpis, charts] = testWidgets(st, data, { hostId });
  charts.insertBefore(temp, charts.children[2] ?? null);
  return h('div', {}, extra, kpis, charts);
}
