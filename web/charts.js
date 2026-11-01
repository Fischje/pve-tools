// Diagramme als SVG, ohne Bibliothek. Farben und Schrift kommen aus style.css (Klassen fill-*, stroke-*), damit Hell/Dunkel stimmt.
// Jedes Diagramm hat einen <title> je Element (Tooltip) und eine Textbeschreibung für Screenreader.
import { h } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null && v !== false) el.setAttribute(k, v);
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(typeof kid === 'object' ? kid : document.createTextNode(String(kid)));
  return el;
}
const title = (text) => s('title', {}, text);
const svgRoot = (w, hgt, label) => s('svg', { class: 'chart', viewBox: `0 0 ${w} ${hgt}`, role: 'img', 'aria-label': label, preserveAspectRatio: 'xMidYMid meet' });
const short = (t, n) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
const nice = (max) => { if (max <= 4) return 4; const p = 10 ** Math.floor(Math.log10(max)); return [1, 1.2, 1.6, 2, 2.4, 3, 4, 5, 6, 8, 10].map((x) => x * p).find((m) => m >= max); };

/** Gestapelte Säulen je Monat. months: [{label, year, ok, interrupted, failed}] */
export function barStack(months, label) {
  const W = 620, H = 230, L = 34, B = 30, T = 14, R = 8;
  const total = (m) => m.ok + m.interrupted + m.failed;
  const max = nice(Math.max(1, ...months.map(total)));
  const svg = svgRoot(W, H, label);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i;
    svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, Math.round(v)));
  }
  const bw = (W - L - R) / months.length;
  months.forEach((m, i) => {
    const x = L + i * bw + bw * 0.16, w = bw * 0.68;
    let acc = 0;
    const g = s('g', {}, title(`${m.label} ${m.year}: ${total(m)} Tests (${m.ok} in Ordnung, ${m.interrupted} unterbrochen, ${m.failed} fehlgeschlagen; ${m.short} kurz, ${m.long} lang/Abschnitte)`));
    for (const [key, cls] of [['ok', 'fill-ok'], ['interrupted', 'fill-int'], ['failed', 'fill-failed']]) {
      const v = m[key]; if (!v) continue;
      g.append(s('rect', { x, y: y(acc + v), width: w, height: y(acc) - y(acc + v), class: cls, rx: 2 }));
      acc += v;
    }
    if (acc) g.append(s('text', { x: x + w / 2, y: y(acc) - 4, 'text-anchor': 'middle', class: 'strong' }, acc));
    g.append(s('text', { x: x + w / 2, y: H - 12, 'text-anchor': 'middle' }, m.label));
    if (m.label === 'Jan' || i === 0) g.append(s('text', { x: x + w / 2, y: H - 1, 'text-anchor': 'middle', class: 'dim' }, m.year));
    svg.append(g);
  });
  return svg;
}

/** Wann starten Tests? matrix[Wochentag 0=So][Stunde]; blocked(dayIdx, hour) markiert gesperrte Zeiten. */
export function heatmap(matrix, { blocked = () => false } = {}, label = 'Wochentag und Uhrzeit der Teststarts') {
  const order = [1, 2, 3, 4, 5, 6, 0], names = { 0: 'So', 1: 'Mo', 2: 'Di', 3: 'Mi', 4: 'Do', 5: 'Fr', 6: 'Sa' };
  const cw = 22, ch = 22, L = 28, T = 4, W = L + 24 * cw + 4, H = T + 7 * ch + 22;
  const max = Math.max(1, ...matrix.flat());
  const svg = svgRoot(W, H, label);
  order.forEach((d, r) => {
    svg.append(s('text', { x: L - 6, y: T + r * ch + 15, 'text-anchor': 'end' }, names[d]));
    for (let hr = 0; hr < 24; hr++) {
      const v = matrix[d][hr], blockedCell = blocked(d, hr);
      const g = s('g', {}, title(`${names[d]} ${String(hr).padStart(2, '0')}:00 Uhr: ${v} ${v === 1 ? 'Test' : 'Tests'}${blockedCell ? ' (laut Zeitplan gesperrt)' : ''}`));
      g.append(s('rect', { x: L + hr * cw + 1, y: T + r * ch + 1, width: cw - 2, height: ch - 2, rx: 3, class: blockedCell ? 'cell-blocked' : 'cell-empty' }));
      if (v) {
        g.append(s('rect', { x: L + hr * cw + 1, y: T + r * ch + 1, width: cw - 2, height: ch - 2, rx: 3, class: 'fill-short', 'fill-opacity': (0.2 + 0.8 * v / max).toFixed(2) }));
        g.append(s('text', { x: L + hr * cw + cw / 2, y: T + r * ch + 15, 'text-anchor': 'middle', class: 'cell-num' }, v));
      }
      svg.append(g);
    }
  });
  for (let hr = 0; hr < 24; hr += 3) svg.append(s('text', { x: L + hr * cw + cw / 2, y: H - 6, 'text-anchor': 'middle' }, String(hr).padStart(2, '0')));
  return svg;
}

/** Ring mit Beschriftung in der Mitte. parts: [{label, value, cls}] */
export function donut(parts, centerText, label) {
  const R = 52, C = 2 * Math.PI * R, W = 140;
  const total = parts.reduce((a, p) => a + p.value, 0);
  const svg = svgRoot(W, W, label);
  svg.append(s('circle', { cx: W / 2, cy: W / 2, r: R, class: 'ring-bg', fill: 'none', 'stroke-width': 20 }));
  let off = 0;
  if (total) for (const p of parts) {
    if (!p.value) continue;
    const len = (p.value / total) * C;
    svg.append(s('circle', { cx: W / 2, cy: W / 2, r: R, fill: 'none', 'stroke-width': 20, class: p.cls, 'stroke-dasharray': `${len} ${C - len}`, 'stroke-dashoffset': -off, transform: `rotate(-90 ${W / 2} ${W / 2})` }, title(`${p.label}: ${p.value}`)));
    off += len;
  }
  svg.append(s('text', { x: W / 2, y: W / 2 + 6, 'text-anchor': 'middle', class: 'big' }, centerText));
  return svg;
}

/** Waagerechte Balken: Tage seit dem letzten Test, mit Marke beim Soll-Intervall. rows: [{label, days, cls?}] */
export function hbars(rows, { intervalDays, maxDays, label }) {
  const RH = 20, L = 360, R = 70, W = 1100, T = 6, H = T + rows.length * RH + 22;
  const svg = svgRoot(W, H, label);
  const bw = W - L - R;
  const mx = maxDays ?? Math.max(intervalDays * 2, ...rows.map((r) => r.days ?? 0), 1);
  rows.forEach((r, i) => {
    const y = T + i * RH;
    const days = r.days;
    const iv = r.interval ?? intervalDays;
    const cls = days == null ? 'fill-failed' : days <= iv ? 'fill-ok' : days <= iv * 1.5 ? 'fill-int' : 'fill-failed';
    const g = s('g', {}, title(`${r.label}: ${days == null ? 'noch nie getestet' : `${days} Tage seit dem letzten Test`} (Soll: alle ${iv} Tage)`));
    g.append(s('text', { x: L - 8, y: y + 14, 'text-anchor': 'end' }, short(r.label, 52)), s('rect', { x: L, y: y + 3, width: bw, height: RH - 8, rx: 3, class: 'cell-empty' }));
    if (days != null) g.append(s('rect', { x: L, y: y + 3, width: Math.max(2, Math.min(1, days / mx) * bw), height: RH - 8, rx: 3, class: cls }));
    g.append(s('text', { x: L + bw + 6, y: y + 14, class: days == null || days > iv * 1.5 ? 'strong bad' : '' }, days == null ? 'nie' : `${days} d`));
    svg.append(g);
  });
  const mxp = L + (intervalDays / mx) * bw;
  svg.append(s('line', { x1: mxp, x2: mxp, y1: T, y2: T + rows.length * RH, class: 'mark' }), s('text', { x: mxp, y: H - 6, 'text-anchor': 'middle' }, `Soll: ${intervalDays} Tage`));
  return svg;
}

/** Zeitleiste der letzten Tage: eine Zeile je Platte, Balken je Test. */
export function timeline(rows, runs, nowMs, days = 14, { blockedWeekdays = [1] } = {}, label = 'Tests der letzten Tage') {
  const RH = 18, L = 360, R = 10, W = 1100, T = 22, H = T + rows.length * RH + 6;
  const svg = svgRoot(W, H, label);
  const bw = W - L - R, t0 = nowMs - days * 864e5, x = (ms) => L + ((Math.max(t0, Math.min(nowMs, ms)) - t0) / (nowMs - t0)) * bw;
  const day0 = new Date(nowMs - days * 864e5); day0.setHours(0, 0, 0, 0);
  const wd = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
  for (let d = new Date(day0.getTime() + 864e5); d.getTime() <= nowMs + 864e5; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const x0 = x(d.getTime() - 864e5), x1 = x(d.getTime());
    const prev = new Date(d.getTime() - 864e5);
    if (blockedWeekdays.includes(prev.getDay()) && x1 > x0) svg.append(s('rect', { x: x0, y: T, width: x1 - x0, height: rows.length * RH, class: 'cell-blocked' }, title('Gesperrter Wochentag')));
    if (x1 > L && x1 <= L + bw + 1) svg.append(s('line', { x1, x2: x1, y1: T, y2: T + rows.length * RH, class: 'grid' }));
    if (x1 - x0 > 20 && x0 >= L - 1) svg.append(s('text', { x: (x0 + x1) / 2, y: 14, 'text-anchor': 'middle' }, `${wd[prev.getDay()]} ${prev.getDate()}.`));
  }
  const idx = new Map(rows.map((r, i) => [r.serial, i]));
  rows.forEach((r, i) => svg.append(s('text', { x: L - 8, y: T + i * RH + 13, 'text-anchor': 'end' }, short(r.label, 52)), s('line', { x1: L, x2: L + bw, y1: T + (i + 1) * RH, y2: T + (i + 1) * RH, class: 'grid' })));
  for (const r of runs) {
    const i = idx.get(r.serial); if (i == null) continue;
    const end = r.end ?? nowMs, x0 = x(r.start), x1 = Math.max(x0 + 3, x(end));
    const cls = { ok: 'fill-ok', failed: 'fill-failed', interrupted: 'fill-int', running: 'fill-run' }[r.result] ?? 'fill-muted';
    const kindTxt = r.kind === 'short' ? 'Kurztest' : r.kind === 'select' ? 'Langtest-Abschnitt' : 'Langtest';
    svg.append(s('rect', { x: x0, y: T + i * RH + 3, width: x1 - x0, height: RH - 7, rx: 2, class: cls }, title(`${kindTxt}: ${new Date(r.start).toLocaleString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}${r.end ? ` bis ${new Date(r.end).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : ' (läuft)'}, ${r.result === 'ok' ? 'ohne Fehler' : r.result === 'failed' ? 'FEHLER' : r.result === 'interrupted' ? 'unterbrochen' : 'läuft'}`)));
  }
  return svg;
}

/** Linie mit Band: Tagesmittel, Minimum und Maximum. points: [{day:'2026-11-01', avg, min, max}] */
export function lineChart(points, { unit = '°C', label }) {
  const W = 620, H = 200, L = 40, R = 10, T = 14, B = 26;
  const svg = svgRoot(W, H, label);
  if (points.length < 2) { svg.append(s('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle' }, 'Noch zu wenige Messungen')); return svg; }
  const lo = Math.floor(Math.min(...points.map((p) => p.min)) - 1), hi = Math.ceil(Math.max(...points.map((p) => p.max)) + 1);
  const x = (i) => L + (i / (points.length - 1)) * (W - L - R), y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
  for (let i = 0; i <= 4; i++) { const v = lo + ((hi - lo) / 4) * i; svg.append(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: 'grid' }), s('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, `${Math.round(v)}${unit}`)); }
  svg.append(s('polygon', { points: [...points.map((p, i) => `${x(i)},${y(p.max)}`), ...points.map((p, i) => `${x(points.length - 1 - i)},${y(points[points.length - 1 - i].min)}`)].join(' '), class: 'band' }));
  svg.append(s('polyline', { points: points.map((p, i) => `${x(i)},${y(p.avg)}`).join(' '), class: 'line', fill: 'none' }));
  points.forEach((p, i) => svg.append(s('rect', { x: x(i) - (W - L - R) / points.length / 2, y: T, width: (W - L - R) / points.length, height: H - T - B, class: 'hit' }, title(`${p.day.slice(8)}.${p.day.slice(5, 7)}.: Ø ${p.avg}${unit} (${p.min}–${p.max}${unit})`))));
  for (const i of [0, Math.floor(points.length / 2), points.length - 1]) svg.append(s('text', { x: x(i), y: H - 8, 'text-anchor': i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle' }, `${points[i].day.slice(8)}.${points[i].day.slice(5, 7)}.`));
  return svg;
}

/** Rahmen: Überschrift, Diagramm, Legende, kurzer Text. */
export function figure(heading, chart, { legend = [], note = null, wide = false } = {}) {
  return h('figure', { class: `fig${wide ? ' wide' : ''}` }, h('figcaption', {}, heading), chart,
    legend.length ? h('div', { class: 'legend' }, legend.map(([cls, t]) => h('span', {}, h('i', { class: `sw ${cls}` }), t))) : null,
    note ? h('p', { class: 'sub' }, note) : null);
}
