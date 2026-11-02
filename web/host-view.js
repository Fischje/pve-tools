// Host-Seite: links ein gruppiertes Menü (Host > Pools, Platten), rechts Überblick, Platten, ZFS (Pools und vdevs), Tests und Statistik des gewählten Hosts.
import { h, HOURS_HINT, fmtCount, KIND, LABEL, ICON, fmtSize, fmtAge, fmtUp, fmtDT, fmtDate, pill, meter, fact, ctx, topFinding } from './dom.js';
import { runningPanel, hostTestsPanel, allTestsPanel } from './tests-view.js';
import { hostBody } from './stats-view.js';

const ORDER = ['ok', 'watch', 'replace', 'critical'];
const worst = (levels) => levels.reduce((a, l) => (ORDER.indexOf(l) > ORDER.indexOf(a) ? l : a), 'ok');
const hostLevel = (host) => (host.reachable || host.disks.length ? worst([...host.disks.map((d) => d.level).filter((l) => ORDER.includes(l)), ...host.pools.map((p) => p.level)]) : 'unknown');
const dot = (level) => h('span', { class: `dot ${level}`, 'aria-hidden': 'true' });

const sel = { hostId: null, tab: 'overview', focus: null, pending: null };
const TABS = [['overview', 'Überblick'], ['disks', 'Platten'], ['zfs', 'ZFS-Pools'], ['tests', 'Tests'], ['stats', 'Statistik']];

const SECTION = { data: 'Daten', logs: 'Log (SLOG, schnelle Schreib-Zwischenablage)', cache: 'Lese-Cache (L2ARC)', spares: 'Ersatzplatten (Spare)', special: 'Special (Metadaten)', dedup: 'Deduplizierung' };
function vdevText(v) {
  const n = v.devices.length;
  switch (v.type) {
    case 'mirror': return `Spiegel aus ${n} Platten, bis zu ${n - 1} dürfen ausfallen`;
    case 'raidz1': return `RAID-Z1 aus ${n} Platten, 1 darf ausfallen`;
    case 'raidz2': return `RAID-Z2 aus ${n} Platten, 2 dürfen ausfallen`;
    case 'raidz3': return `RAID-Z3 aus ${n} Platten, 3 dürfen ausfallen`;
    case 'draid': return `dRAID aus ${n} Platten`;
    case 'disk': return v.section === 'data' ? 'Einzelplatte, keine Redundanz (fällt sie aus, ist der Pool verloren)' : 'Einzelplatte';
    default: return v.type;
  }
}
const stateClass = (s) => (['ONLINE', 'AVAIL', 'INUSE'].includes(s) ? 'ok' : ['DEGRADED', 'FAULTED', 'UNAVAIL', 'OFFLINE', 'REMOVED', 'SUSPENDED'].includes(s) ? 'critical' : 'watch');
const statePill = (s) => h('span', { class: `pill ${stateClass(s)}` }, s ?? '–');
const cnt = (n) => h('td', { class: n > 0 ? 'bad' : '' }, n);

function poolCard(host, p) {
  const scan = p.scan ?? {};
  const scanLine = scan.state === 'running' ? h('div', {}, meter(`${scan.kind === 'resilver' ? 'Resilver' : 'Scrub'} läuft`, Math.round(scan.percent ?? 0), 'ok', `${scan.percent ?? '?'} %${scan.toGo ? ` · noch ${scan.toGo}` : ''}`))
    : scan.state === 'finished' ? h('p', { class: 'sub' }, `Letzter ${scan.kind === 'resilver' ? 'Resilver' : 'Scrub'}: ${scan.finishedAt ? fmtDT(scan.finishedAt) : '–'} · Dauer ${scan.duration} · ${scan.errors} Fehler · repariert ${scan.repaired}`)
    : scan.state === 'canceled' ? h('p', { class: 'sub' }, `Letzter Scrub wurde abgebrochen.`) : h('p', { class: 'sub' }, 'Noch nie ein Scrub.');
  const groups = {};
  for (const v of p.vdevs) (groups[v.section] ??= []).push(v);
  const vdevEls = Object.entries(groups).map(([sec, list]) => h('div', {}, h('h4', {}, SECTION[sec] ?? sec),
    list.map((v) => {
      const bad = [v, ...v.devices].some((d) => (d.read || 0) + (d.write || 0) + (d.cksum || 0) > 0 || (d.state && stateClass(d.state) === 'critical'));
      return h('div', { class: `vdev${bad ? ' vbad' : ''}` },
        h('div', { class: 'vdev-head' }, h('b', {}, v.type === 'disk' ? 'Einzelgerät' : v.name), ' ', statePill(v.state), h('span', { class: 'sub' }, ` ${vdevText(v)}`)),
        h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Gerät', 'Platte', 'Zustand', 'Lesen', 'Schreiben', 'Prüfsumme', 'Hinweis'].map((t) => h('th', {}, t)))),
          h('tbody', {}, v.devices.map((d) => {
            const disk = d.serial ? host.disks.find((x) => x.serial === d.serial) : null;
            return h('tr', {}, h('td', {}, h('code', { class: 'devname' }, d.name)),
              h('td', {}, disk ? h('span', {}, disk.model, ' ', h('span', { class: 'sub' }, disk.device), ' ', pill(disk.level), ' ', h('button', { class: 'linkish', onclick: () => ctx.openDetail(host, disk) }, 'Details')) : h('span', { class: 'sub' }, 'nicht zugeordnet')),
              h('td', {}, statePill(d.state)), cnt(d.read), cnt(d.write), cnt(d.cksum), h('td', { class: 'sub' }, d.note || ''));
          })))));
    })));
  return h('article', { class: `card ${p.level}`, id: `pool-${host.id}-${p.name}` },
    h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'model' }, `Pool ${p.name}`, h('span', { class: 'badge' }, `${p.vdevs.filter((v) => v.section === 'data').length} vdev${p.vdevs.filter((v) => v.section === 'data').length === 1 ? '' : 's'}`)), h('div', { class: 'sub' }, `Zustand laut ZFS: ${p.state}`)), pill(p.level)),
    p.size != null ? h('div', {}, meter(`Belegt: ${fmtSize(p.alloc)} von ${fmtSize(p.size)} (frei ${fmtSize(p.free ?? p.size - p.alloc)})`, p.cap ?? 0, p.cap >= 90 ? 'critical' : p.cap >= 80 ? 'watch' : 'ok', `${p.cap ?? '?'} %`),
      p.frag != null ? h('p', { class: 'sub' }, `Fragmentierung ${p.frag} %`) : null) : h('p', { class: 'sub' }, 'Füllstand unbekannt: Der Host kennt den neuen Befehl noch nicht. Unter „Hosts“ → „Neu einrichten“ aktualisieren.'),
    scanLine,
    p.findings.filter((f) => f.level !== 'ok' || p.findings.length === 1).map((f) => h('div', { class: `finding ${f.level}` }, h('b', {}, `${ICON[f.level] ?? ''} ${f.title}`), f.text, f.advice ? h('div', { class: 'advice' }, `Was tun? ${f.advice}`) : null)),
    vdevEls);
}

function memberships(host) {
  const m = new Map();
  for (const p of host.pools) for (const v of p.vdevs) for (const d of v.devices) if (d.serial) { (m.get(d.serial) ?? m.set(d.serial, []).get(d.serial)).push(`${p.name} › ${v.type === 'disk' ? 'Einzelgerät' : v.name}${v.section !== 'data' ? ` (${v.section})` : ''}`); }
  return m;
}

function overviewTab(host, data, stats, tests) {
  const lv = hostLevel(host), m = memberships(host);
  const counts = ORDER.map((l) => [l, host.disks.filter((d) => d.level === l).length]).filter(([, n]) => n);
  const w = host.window;
  const head = h('div', { class: 'kpis' },
    h('div', { class: `kpi ${lv === 'ok' ? 'ok' : lv === 'unknown' ? '' : lv === 'watch' ? 'watch' : 'bad'}` }, h('div', { class: 'k' }, 'Gesamtzustand'), h('div', { class: 'v' }, LABEL[lv] ?? 'Unbekannt'), h('div', { class: 's' }, counts.map(([l, n]) => `${n}× ${LABEL[l]}`).join(' · ') || 'keine Platten')),
    h('div', { class: 'kpi' }, h('div', { class: 'k' }, 'Erreichbarkeit'), h('div', { class: 'v' }, host.reachable ? 'Online' : 'Offline'), h('div', { class: 's' }, host.reachable ? `läuft seit ${fmtUp(host.uptimeSec)}` : (host.error ?? 'keine Antwort'))),
    h('div', { class: 'kpi' }, h('div', { class: 'k' }, 'Testfenster'), h('div', { class: 'v' }, w.open ? 'offen' : 'zu'), h('div', { class: 's' }, w.open ? `noch ${Math.floor(w.minutesLeft / 60)} h ${w.minutesLeft % 60} min` : w.reason)),
    h('div', { class: 'kpi' }, h('div', { class: 'k' }, 'Letzte Abfrage'), h('div', { class: 'v' }, fmtDT(host.lastPoll)), h('div', { class: 's' }, host.address ? `${host.address}${host.port && host.port !== 22 ? `:${host.port}` : ''}` : host.id)));
  const poolRows = host.pools.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Pool', 'Zustand', 'Aufbau', 'Belegt', 'Letzter Scrub'].map((t) => h('th', {}, t)))),
    h('tbody', {}, host.pools.map((p) => h('tr', {}, h('td', {}, h('button', { class: 'linkish', onclick: () => go(host.id, 'zfs', p.name) }, p.name)), h('td', {}, pill(p.level)), h('td', {}, p.vdevs.filter((v) => v.section === 'data').map((v) => v.type === 'disk' ? 'Einzelplatte' : v.name).join(', ')), h('td', {}, p.cap != null ? `${p.cap} % von ${fmtSize(p.size)}` : '–'),
      h('td', {}, p.scan?.state === 'finished' ? `${fmtDate(p.scan.finishedAt)} (${p.scan.errors} Fehler)` : p.scan?.state === 'running' ? `läuft, ${p.scan.percent ?? '?'} %` : 'nie')))))) : h('p', { class: 'sub' }, 'Kein ZFS auf diesem Host.');
  const diskRows = h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Platte', 'Zustand', 'Temp.', 'Betriebszeit', 'Einschaltungen', 'Verschleiß', 'ZFS', 'Letzter Kurz-/Langtest'].map((t) => h('th', {}, t)))),
    h('tbody', {}, host.disks.map((d) => h('tr', {}, h('td', {}, h('button', { class: 'linkish', onclick: () => go(host.id, 'disks', d.serial) }, d.model), h('div', { class: 'sub' }, `${d.device} · ${KIND[d.kind]} · ${fmtSize(d.capacityBytes)}`)),
      h('td', {}, pill(d.level), d.running ? h('div', { class: 'sub' }, '⏳ Test läuft') : null), h('td', {}, d.temperature != null ? `${d.temperature} °C` : '–'), h('td', { title: HOURS_HINT }, fmtAge(d.hours)), h('td', {}, fmtCount(d.powerCycles)), h('td', {}, d.wearUsed != null ? `${d.wearUsed} %` : '–'),
      h('td', { class: 'sub' }, (m.get(d.serial) ?? ['–']).join(', ')), h('td', {}, `${fmtDate(d.lastShortOk)} / ${fmtDate(d.lastLongOk)}`))))));
  return [head, host.banner ? h('div', { class: 'banner' }, h('b', {}, `${host.label} ist erreichbar.`), host.banner.autoStart ? ` Ein fälliger Test startet automatisch${host.banner.startsInMin ? ` in ${host.banner.startsInMin} min` : ''}.` : ' Der Test startet erst nach deiner Freigabe (siehe Übersicht).') : null,
    ...(host.linkFindings ?? []).map((f) => h('div', { class: `banner ${f.level === 'replace' ? 'bad' : 'watch'}` }, h('b', {}, f.title), h('div', {}, f.text), h('div', { class: 'sub' }, `Was tun? ${f.advice}`))),
    runningPanel(tests, data, { hostId: host.id }), h('section', { class: 'panel' }, h('h2', {}, 'ZFS-Pools'), poolRows), h('section', { class: 'panel' }, h('h2', {}, 'Platten'), diskRows)];
}

function disksTab(host) {
  const m = memberships(host);
  if (!host.disks.length) return h('p', { class: 'empty' }, host.reachable ? 'Noch keine Platten gelesen.' : 'Keine Daten, solange der Host nicht erreichbar ist.');
  return h('div', { class: 'grid' }, host.disks.map((d) => {
    const c = ctx.diskCard(host, d); c.id = `disk-${d.serial}`;
    const z = m.get(d.serial);
    if (z) c.insertBefore(h('p', { class: 'sub' }, `ZFS: ${z.join(', ')}`), c.lastElementChild);
    return c;
  }));
}

function zfsTab(host) {
  if (!host.pools.length) return h('p', { class: 'empty' }, host.reachable ? 'Kein ZFS auf diesem Host.' : 'Keine Daten, solange der Host nicht erreichbar ist.');
  return h('div', { class: 'stack' }, host.pools.map((p) => poolCard(host, p)));
}

function go(hostId, tab = 'overview', focus = null) { sel.hostId = hostId; sel.tab = tab; sel.focus = focus; sel.pending = focus; ctx.render(); if (!focus) window.scrollTo(0, 0); }

/** Gruppiertes Menü: Baum (breit) und Auswahlliste mit Gruppen (schmal). */
function menu(data) {
  const tree = h('nav', { class: 'hostnav', 'aria-label': 'Hosts, Pools und Platten' }, data.hosts.map((host) => {
    const active = host.id === sel.hostId;
    const item = (label, tab, focus, level, subtitle) => h('button', { class: `navitem${active && sel.tab === tab && (sel.focus ?? null) === (focus ?? null) ? ' on' : ''}`, onclick: () => go(host.id, tab, focus), 'aria-current': active && sel.tab === tab && (sel.focus ?? null) === (focus ?? null) ? 'true' : null },
      level ? dot(level) : null, h('span', { class: 'nl' }, label), subtitle ? h('span', { class: 'sub' }, subtitle) : null);
    return h('details', { open: active || data.hosts.length <= 3 }, h('summary', {}, dot(hostLevel(host)), h('b', {}, host.label), h('span', { class: 'sub' }, host.reachable ? 'online' : 'offline')),
      item('Überblick', 'overview', null),
      host.pools.length ? [h('div', { class: 'navgroup' }, 'ZFS-Pools'), host.pools.map((p) => item(p.name, 'zfs', p.name, p.level, p.cap != null ? `${p.cap} %` : ''))] : null,
      host.disks.length ? [h('div', { class: 'navgroup' }, `Platten (${host.disks.length})`), host.disks.map((d) => item(d.model, 'disks', d.serial, d.level, d.device.replace('/dev/', '')))] : null,
      item('Tests', 'tests', null), item('Statistik', 'stats', null));
  }));
  const select = h('select', { class: 'navselect', 'aria-label': 'Host und Platte wählen', onchange: (e) => { const [hid, tab, ...rest] = e.target.value.split('|'); go(hid, tab, rest.join('|') || null); } },
    data.hosts.map((host) => h('optgroup', { label: host.label },
      h('option', { value: `${host.id}|overview`, selected: host.id === sel.hostId && sel.tab === 'overview' }, `${host.label}: Überblick`),
      host.pools.map((p) => h('option', { value: `${host.id}|zfs|${p.name}`, selected: host.id === sel.hostId && sel.tab === 'zfs' && sel.focus === p.name }, `ZFS-Pool ${p.name} (${LABEL[p.level]})`)),
      host.disks.map((d) => h('option', { value: `${host.id}|disks|${d.serial}`, selected: host.id === sel.hostId && sel.tab === 'disks' && sel.focus === d.serial }, `${d.model} ${d.device} (${LABEL[d.level]})`)),
      h('option', { value: `${host.id}|tests`, selected: host.id === sel.hostId && sel.tab === 'tests' }, 'Tests'), h('option', { value: `${host.id}|stats`, selected: host.id === sel.hostId && sel.tab === 'stats' }, 'Statistik'))));
  return [tree, select];
}

export function hostPage({ data, stats, tests }) {
  if (!data.hosts.length) return h('p', { class: 'empty' }, 'Noch keine Hosts eingerichtet. Siehe Reiter „Hosts einrichten“.');
  if (!data.hosts.some((x) => x.id === sel.hostId)) { sel.hostId = data.hosts[0].id; sel.tab = 'overview'; sel.focus = null; }
  const host = data.hosts.find((x) => x.id === sel.hostId);
  const tabs = h('div', { class: 'tabs2', role: 'tablist', 'aria-label': `Bereiche von ${host.label}` }, TABS.map(([id, t]) => h('button', { role: 'tab', 'aria-selected': String(sel.tab === id), onclick: () => go(host.id, id, null) }, t,
    id === 'disks' ? h('span', { class: 'badge' }, host.disks.length) : id === 'zfs' ? h('span', { class: 'badge' }, host.pools.length) : id === 'tests' && tests.running.some((r) => r.hostId === host.id) ? h('span', { class: 'run-dot', 'aria-label': 'Test läuft' }) : null)));
  let body;
  if (sel.tab === 'disks') body = disksTab(host);
  else if (sel.tab === 'zfs') body = zfsTab(host);
  else if (sel.tab === 'tests') body = [runningPanel(tests, data, { hostId: host.id }), hostTestsPanel(host, { showTitle: false }), allTestsPanel(tests, data, { hostId: host.id })];
  else if (sel.tab === 'stats') body = hostBody(stats, data, host.id);
  else body = overviewTab(host, data, stats, tests);
  const page = h('div', { class: 'hostpage' }, h('aside', {}, menu(data)),
    h('div', { class: 'hostmain' }, h('div', { class: 'host-head' }, dot(hostLevel(host)), h('h2', {}, host.label), h('span', { class: 'state' }, host.reachable ? `erreichbar · ${host.disks.length} ${host.disks.length === 1 ? 'Platte' : 'Platten'} · ${host.pools.length} ${host.pools.length === 1 ? 'Pool' : 'Pools'}` : 'nicht erreichbar'), h('span', { class: 'spacer' }), h('button', { onclick: () => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/poll`, {}), 'Aktualisiert.') }, 'Jetzt abfragen')), tabs, body));
  const pend = sel.pending; sel.pending = null;
  if (sel.focus) queueMicrotask(() => {
    const el = document.getElementById(sel.tab === 'zfs' ? `pool-${host.id}-${sel.focus}` : `disk-${sel.focus}`);
    if (el) { el.classList.add('focused'); if (pend) el.scrollIntoView({ block: 'start', behavior: 'smooth' }); }
  });
  return page;
}

export const hostViewGo = go;
