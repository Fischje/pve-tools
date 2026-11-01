// Tests: was läuft gerade, Zeitplan je Platte und die Liste aller Tests. Wird in „Tests“ (alle Hosts) und auf der Host-Seite (ein Host) benutzt.
import { h, KIND, RUN_LABEL, RESULT, fmtDate, fmtDT, fmtMin, dur, pill, meter, ctx } from './dom.js';

const RESULT_CLASS = { ok: 'ok', failed: 'critical', interrupted: 'watch', running: 'unknown' };
const resultPill = (r) => h('span', { class: `pill ${RESULT_CLASS[r] ?? 'unknown'}` }, RESULT[r] ?? r);

/** Laufende Tests. hostId = nur dieser Host. */
export function runningPanel(tests, data, { hostId = null } = {}) {
  const running = tests.running.filter((r) => !hostId || r.hostId === hostId);
  const now = Date.parse(tests.now);
  const rows = running.map((r) => {
    const host = data.hosts.find((x) => x.id === r.hostId);
    const disk = host?.disks.find((d) => d.serial === r.serial);
    const elapsed = r.started ? Math.max(0, Math.round((now - Date.parse(r.started)) / 60000)) : null;
    const progress = r.remainingPercent != null ? 100 - r.remainingPercent : null;
    return h('div', { class: 'run-card' },
      h('div', { class: 'run-head' }, h('span', { class: 'run-dot', 'aria-hidden': 'true' }), h('b', {}, RUN_LABEL[r.kind] ?? r.kind), ' auf ', h('b', {}, r.model ?? r.serial), h('span', { class: 'sub' }, ` · ${r.device ?? ''}${hostId ? '' : ` · ${r.hostLabel}`}`), h('span', { class: 'spacer' }),
        disk ? h('button', { class: 'danger', onclick: () => ctx.abortTest(disk) }, 'Abbrechen') : null),
      progress != null ? meter('Fortschritt dieses Tests', progress, 'ok', `${progress} %`) : h('p', { class: 'sub' }, 'Fortschritt wird bei der nächsten Abfrage angezeigt.'),
      h('p', { class: 'sub' }, r.started ? `Gestartet ${fmtDT(r.started)} · läuft seit ${fmtMin(elapsed)}${r.plannedMinutes ? ` · geplant ca. ${fmtMin(r.plannedMinutes)}` : ''}` : 'Direkt auf dem Host gestartet (nicht von diesem Tool).',
        r.origin === 'manual' ? ' · von Hand gestartet' : ''),
      disk?.progress ? h('p', { class: 'sub' }, `Langtest insgesamt: ${disk.progress.percent} % gelesen, Abschnitt ${disk.progress.segments + 1}`) : null);
  });
  const reasons = data.hosts.filter((x) => (!hostId || x.id === hostId) && x.decision?.reason && !running.some((r) => r.hostId === x.id)).map((x) => h('li', {}, h('b', {}, `${x.label}: `), x.decision.reason));
  return h('section', { class: 'panel' }, h('h2', {}, running.length ? `Laufende Tests (${running.length})` : 'Laufende Tests'),
    rows.length ? rows : h('p', { class: 'sub' }, 'Gerade läuft kein Test.'),
    !rows.length && reasons.length ? h('ul', { class: 'plain sub' }, reasons) : null);
}

/** Zeitplan und Fortschritt je Platte eines Hosts (mit Knöpfen). */
export function hostTestsPanel(host, { showTitle = true } = {}) {
  const w = host.window;
  const status = w.open ? `Testfenster offen, noch ${Math.floor(w.minutesLeft / 60)} h ${w.minutesLeft % 60} min` : `Gerade kein Test: ${w.reason}`;
  const rows = host.disks.map((d) => h('tr', {},
    h('td', {}, h('div', { class: 'model' }, d.model), h('div', { class: 'sub' }, `${d.device} · ${KIND[d.kind]}`)),
    h('td', {}, d.running ? `⏳ ${RUN_LABEL[d.running.type]}${d.running.remainingPercent != null ? ` (noch ${d.running.remainingPercent} %)` : ''}` : pill(d.level)),
    h('td', {}, fmtDate(d.lastShortOk), h('div', { class: 'sub' }, `nächster: ${fmtDate(d.nextShort)}`)),
    h('td', {}, fmtDate(d.lastLongOk), h('div', { class: 'sub' }, `nächster: ${d.progress ? 'läuft in Abschnitten' : fmtDate(d.nextLong)}`)),
    h('td', {}, d.progress ? meter('Langtest', d.progress.percent, 'ok', `${d.progress.percent} % · Abschnitt ${d.progress.segments + 1}`) : (d.selective || d.kind !== 'hdd' ? '–' : h('span', { class: 'sub' }, 'keine selektiven Tests'))),
    h('td', {}, h('div', { class: 'row' },
      d.running ? h('button', { class: 'danger', onclick: () => ctx.abortTest(d) }, 'Abbrechen') : [h('button', { onclick: () => ctx.startTest(host, d, 'short') }, 'Kurz'), h('button', { onclick: () => ctx.startTest(host, d, 'long') }, 'Lang')],
      h('button', { onclick: () => ctx.act(() => ctx.api('POST', `/api/disks/${encodeURIComponent(d.serial)}/pause`, { paused: !d.paused }), d.paused ? 'Fortgesetzt.' : 'Pausiert.') }, d.paused ? 'Fortsetzen' : 'Pausieren')))));
  return h('section', { class: 'panel' },
    h('div', { class: 'host-head' }, h('h2', {}, showTitle ? host.label : 'Zeitplan und Fortschritt'), h('span', { class: 'state' }, status)),
    host.decision && host.decision.reason ? h('p', { class: 'sub' }, `Zeitplan: ${host.decision.reason}`) : null,
    host.disks.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Platte', 'Zustand', 'Kurztest', 'Langtest', 'Langtest-Fortschritt', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('p', { class: 'sub' }, 'Keine Platten bekannt.'));
}

const filters = { host: '', result: '', kind: '' };
let shown = 25;
/** Alle bisherigen Tests mit Filtern. hostId = fest auf einen Host. */
export function allTestsPanel(tests, data, { hostId = null } = {}) {
  const box = h('div', {});
  const draw = () => {
    const rows = tests.runs.filter((r) => (!hostId || r.hostId === hostId) && (!filters.host || r.hostId === filters.host)
      && (!filters.result || r.result === filters.result) && (!filters.kind || (filters.kind === 'long' ? r.kind !== 'short' : r.kind === 'short')));
    const list = rows.slice(0, shown);
    box.replaceChildren(
      rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Start', hostId ? null : 'Host', 'Platte', 'Art', 'Dauer', 'Ergebnis', 'Hinweis'].filter(Boolean).map((t) => h('th', {}, t)))),
        h('tbody', {}, list.map((r) => h('tr', {}, h('td', {}, fmtDT(r.started)), hostId ? null : h('td', {}, r.hostLabel), h('td', {}, h('div', {}, r.model ?? r.serial), h('div', { class: 'sub' }, r.device ?? '')),
          h('td', {}, RUN_LABEL[r.kind] ?? r.kind, r.origin === 'manual' ? h('div', { class: 'sub' }, 'von Hand') : null), h('td', {}, fmtMin(dur(r.started, r.ended))), h('td', {}, resultPill(r.result)), h('td', { class: 'sub' }, r.note ?? '')))))) : h('p', { class: 'sub' }, 'Keine Tests mit diesen Filtern.'),
      rows.length > shown ? h('div', { class: 'row' }, h('button', { onclick: () => { shown += 50; draw(); } }, `Mehr anzeigen (${rows.length - shown} weitere)`)) : null,
      h('p', { class: 'sub' }, `${rows.length} Tests${rows.length !== tests.runs.length ? ' mit diesem Filter' : ''}.`));
  };
  const sel = (key, label, opts) => h('label', { class: 'f inline' }, label, h('select', { onchange: (e) => { filters[key] = e.target.value; shown = 25; draw(); } }, opts.map(([v, t]) => h('option', { value: v, selected: filters[key] === v }, t))));
  draw();
  return h('section', { class: 'panel' }, h('div', { class: 'host-head' }, h('h2', {}, hostId ? 'Alle Tests dieses Hosts' : 'Alle Tests'), h('span', { class: 'spacer' }),
    hostId ? null : sel('host', 'Host', [['', 'alle'], ...data.hosts.map((x) => [x.id, x.label])]),
    sel('kind', 'Art', [['', 'alle'], ['short', 'Kurztest'], ['long', 'Langtest/Abschnitt']]), sel('result', 'Ergebnis', [['', 'alle'], ['ok', 'in Ordnung'], ['failed', 'fehlgeschlagen'], ['interrupted', 'unterbrochen'], ['running', 'läuft']])), box);
}
