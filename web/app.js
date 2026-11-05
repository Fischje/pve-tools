// Oberfläche von PVE-Tools. Reines JavaScript ohne Abhängigkeiten.
// Alle Texte werden per textContent eingesetzt, nie als HTML (kein XSS durch Gerätenamen o. Ä.).

import { ui, fold, subTabs, hostSwitch } from './dom.js';
import { HOURS_HINT, fmtCount, WD, KIND, ICON, LABEL, RUN_LABEL, RESULT, h, put, d2, fmtDate, fmtDT, fmtSize, fmtAge, fmtUp, pill, fact, meter, topFinding, wearLevel, ctx, fmtDay, fmtMin, dur } from './dom.js';

import { globalStats, hostStatsSection } from './stats-view.js';
import { runningPanel, hostTestsPanel, allTestsPanel } from './tests-view.js';
import { hostPage, hostViewGo } from './host-view.js';
import { backupsView } from './backups-view.js';

const BRAND = "Fischje's PVE-Tools";
document.title = BRAND;
const root = document.getElementById('app');
let data = null, stats = null, tests = null, backups = null, view = 'uebersicht', authState = { passwordSet: false, loggedIn: true }, timer = null, dialogOpen = false, flash = {};

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'disktool' }, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await r.json(); } catch { /* leer */ }
  if (r.status === 401 && path !== '/api/auth/login') { authState.loggedIn = false; render(); throw new Error('Bitte anmelden'); }
  if (!r.ok) throw new Error(json.error ?? `Fehler ${r.status}`);
  return json;
}


// ---------- Aktionen ----------
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) flash = { ok: okMsg }; } catch (e) {
    // Bei einem Fehler bleibt die Seite stehen, damit eingegebene Werte nicht verloren gehen: nur die Meldung anzeigen.
    if (ui.dirty) { showFlash({ err: e.message }); return; }
    flash = { err: e.message };
  }
  ui.dirty = false;
  await load();
}

// ---------- Bearbeiten: automatische Aktualisierung pausieren ----------
// Sobald in einem Formular etwas geändert wird, zeichnet die Seite sich nicht mehr selbst neu, bis gespeichert oder verworfen wird.
const flashBox = h('div', {});
const pausedBar = h('div', { class: 'paused', role: 'status', hidden: true }, h('span', {}, 'Automatische Aktualisierung ist pausiert, solange du hier etwas änderst.'),
  h('button', { type: 'button', onclick: () => { ui.dirty = false; pausedBar.hidden = true; load(); } }, 'Änderungen verwerfen'));
function showFlash(f) {
  flashBox.replaceChildren(...[f.err ? h('div', { class: 'banner warn', role: 'alert' }, h('b', {}, f.err)) : f.ok ? h('div', { class: 'banner', role: 'status' }, f.ok) : null].filter(Boolean));
}
const markDirty = (e) => { if (e.target.matches?.('input, select, textarea') && !e.target.closest('.no-dirty, .login')) { ui.dirty = true; pausedBar.hidden = false; } };
root.addEventListener('input', markDirty);
root.addEventListener('change', markDirty);
function startTest(host, d, type) {
  const est = type === 'long' && d.pollingExtended ? `ca. ${Math.round(d.pollingExtended / 60)} Stunden, wird bei Bedarf auf mehrere Tage aufgeteilt` : 'wenige Minuten';
  if (!confirm(`${type === 'long' ? 'Langtest' : 'Kurztest'} auf ${d.model} (${d.device}) starten?\nDauer: ${est}.\nDie Platte ist währenddessen etwas langsamer.`)) return;
  act(() => api('POST', `/api/disks/${encodeURIComponent(d.serial)}/test`, { type }), `${type === 'long' ? 'Langtest' : 'Kurztest'} gestartet.`);
}
const abortTest = (d) => confirm(`Laufenden Test auf ${d.device} abbrechen?`) && act(() => api('POST', `/api/disks/${encodeURIComponent(d.serial)}/abort`, {}), 'Test abgebrochen.');

// ---------- Ansicht: Übersicht ----------
function diskCard(host, d) {
  const tf = topFinding(d);
  const facts = [fact('Betriebszeit', fmtAge(d.hours), HOURS_HINT), fact('Temperatur', d.temperature != null ? `${d.temperature} °C` : '–'), fact('Größe', fmtSize(d.capacityBytes)), fact('Wert', d.score != null ? `${d.score} / 100` : '–'),
    fact('Einschaltvorgänge', fmtCount(d.powerCycles), 'Wie oft die Platte eingeschaltet wurde. Bei einem Server, der täglich an- und ausgeht, entspricht das grob den Betriebstagen.'), fact('Geschrieben', d.bytesWritten != null ? fmtSize(d.bytesWritten) : '–', 'Insgesamt auf die Platte geschriebene Datenmenge. Zusammen mit dem Verschleiß zeigt das, wie stark sie genutzt wurde.')];
  const kids = [
    h('div', { class: 'card-head' },
      h('div', {}, h('div', { class: 'model' }, d.model, h('span', { class: 'badge' }, KIND[d.kind] ?? d.kind)), h('div', { class: 'sub' }, `${d.device} · ${d.serial}`)),
      pill(d.level)),
  ];
  if (d.standby) kids.push(h('p', { class: 'sub' }, 'Die Platte schläft, letzter bekannter Stand.'));
  kids.push(h('p', { class: 'what' }, h('b', {}, tf?.title ?? ''), tf ? ` – ${tf.text}` : ''));
  if (tf?.advice) kids.push(h('p', { class: 'advice' }, `Was tun? ${tf.advice}`));
  if (d.wearUsed != null) kids.push(meter('Verschleiß (Restlebensdauer ' + (100 - d.wearUsed) + ' %)', d.wearUsed, wearLevel(d.wearUsed)));
  kids.push(h('div', { class: 'facts' }, facts));
  if (d.running) {
    kids.push(h('p', { class: 'sub' }, `⏳ ${RUN_LABEL[d.running.type] ?? 'Test'} läuft${d.running.remainingPercent != null ? `, noch ca. ${d.running.remainingPercent} %` : ''}`));
  } else {
    kids.push(h('p', { class: 'sub' }, `Letzter Kurztest: ${fmtDate(d.lastShortOk)} · Letzter Langtest: ${fmtDate(d.lastLongOk)}`));
  }
  kids.push(h('div', { class: 'row' },
    h('button', { onclick: () => openDetail(host, d) }, 'Details'), h('span', { class: 'spacer' }),
    d.running ? h('button', { class: 'danger', onclick: () => abortTest(d) }, 'Abbrechen') : [h('button', { onclick: () => startTest(host, d, 'short') }, 'Kurztest'), h('button', { onclick: () => startTest(host, d, 'long') }, 'Langtest')]));
  return h('article', { class: `card ${d.level}` }, kids);
}

function bannerEl(host) {
  const b = host.banner; if (!b) return null;
  const msg = b.snoozed ? `${host.label} ist erreichbar. Test ist zurückgestellt.`
    : b.autoStart ? (b.startsInMin > 0 ? `${host.label} ist erreichbar. Ein fälliger Test startet automatisch in ${b.startsInMin} min.` : `${host.label} ist erreichbar. Ein fälliger Test startet automatisch.`)
    : `${host.label} ist erreichbar. Der Test startet erst nach deiner Freigabe.`;
  const post = (action) => act(() => api('POST', `/api/hosts/${host.id}/approval`, { action }), action === 'now' ? 'Freigegeben.' : 'Gespeichert.');
  return h('div', { class: 'banner' }, h('div', {}, h('b', {}, msg), h('div', { class: 'sub' }, 'Wenn du den Host nur für etwas anderes gestartet hast, wähle „Heute nicht“. Er schaltet sich um 19:00 selbst ab.')),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => post('now') }, 'Jetzt testen'), h('button', { onclick: () => post('snooze') }, 'Später (1 h)'), h('button', { onclick: () => post('skip') }, 'Heute nicht')));
}

function hostSection(host) {
  const state = host.reachable ? `erreichbar · läuft seit ${fmtUp(host.uptimeSec)} · Stand ${fmtDT(host.lastPoll)}` : `nicht erreichbar${host.error ? ` (${host.error})` : ''}`;
  return h('section', { class: 'host' },
    h('div', { class: 'host-head' }, h('h2', {}, host.label), h('span', { class: 'state' }, state),
      host.pools.map((p) => h('span', { class: `pool ${p.level === 'critical' ? 'critical' : ''}`, title: p.scanText }, `ZFS ${p.name}: ${p.state}`)),
      h('span', { class: 'spacer' }), h('button', { onclick: () => act(() => api('POST', `/api/hosts/${host.id}/poll`, {}), 'Aktualisiert.') }, 'Jetzt abfragen')),
    host.pools.flatMap((p) => p.findings.map((f) => h('div', { class: 'finding critical' }, h('b', {}, f.title), f.text, ' ', f.advice))),
    host.disks.length ? h('div', { class: 'grid' }, host.disks.map((d) => diskCard(host, d))) : h('p', { class: 'empty' }, host.reachable ? 'Noch keine Platten gelesen.' : 'Keine Daten, solange der Host nicht erreichbar ist. Das ist normal, wenn er ausgeschaltet ist.'));
}

function outdatedBanner(host) {
  const g = host.gate;
  return h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, `Das Prüfskript auf ${host.label} ist veraltet (Version ${g.version}, aktuell ${g.expected}).`), h('div', { class: 'sub' }, 'Neuere Funktionen, zum Beispiel der Füllstand der ZFS-Pools, fehlen dort noch. Das Aktualisieren dauert wenige Sekunden.')),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => { view = 'hosts'; wizard = { mode: 'update', host, step: 1 }; render(); window.scrollTo(0, 0); } }, 'Jetzt aktualisieren')));
}

/** Füllstand der ZFS-Pools je Host (Übersicht). */
function poolsOverview() {
  const hosts = data.hosts.filter((x) => x.pools.length);
  if (!hosts.length) return null;
  const capLevel = (c) => (c == null ? 'unknown' : c >= 90 ? 'critical' : c >= 80 ? 'replace' : c >= 70 ? 'watch' : 'ok');
  const layout = (p) => p.vdevs.filter((v) => v.section === 'data').map((v) => (v.type === 'disk' ? 'Einzelplatte' : v.name.replace(/-\d+$/, ''))).filter((x, i, a) => a.indexOf(x) === i).join(', ');
  return [h('div', { class: 'sec-title' }, h('h2', {}, 'Speicherplatz (ZFS)')),
    h('div', { class: 'pools' }, hosts.map((host) => h('article', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', { class: 'model' }, host.label), h('span', { class: 'sub' }, `${host.pools.length} ${host.pools.length === 1 ? 'Pool' : 'Pools'}${host.reachable ? '' : ' · nicht erreichbar, letzter Stand'}`)),
      host.pools.map((p) => h('div', { class: 'pool-meter' },
        meter(h('span', {}, h('b', {}, p.name), ` · ${layout(p) || '–'}${p.level !== 'ok' ? ` · ${LABEL[p.level] ?? p.level}` : ''}`), p.cap ?? 0, capLevel(p.cap),
          p.cap != null ? `${p.cap} % belegt` : 'Füllstand unbekannt'),
        h('div', { class: 'sub' }, p.size != null ? `${fmtSize(p.alloc)} von ${fmtSize(p.size)} belegt, ${fmtSize(p.free)} frei${p.frag != null ? ` · Fragmentierung ${p.frag} %` : ''}` : 'Größe erscheint nach der nächsten Abfrage.'))),
      h('div', { class: 'row' }, h('button', { onclick: () => { view = 'host'; hostViewGo(host.id, 'zfs', null); } }, 'Pools im Detail')))))];
}

function viewOverview() {
  if (!data.hosts.length) return h('p', { class: 'empty' }, 'Keine Hosts eingerichtet. Öffne den Reiter „Hosts einrichten“.');
  return [data.hosts.filter((x) => x.gate?.outdated).map(outdatedBanner), data.hosts.map(bannerEl),
    stats ? globalStats(stats, data) : null, poolsOverview(), stats ? hostStatsSection(stats, data) : null,
    h('div', { class: 'sec-title' }, h('h2', {}, 'Alle Platten')), data.hosts.map(hostSection)];
}

// ---------- Ansicht: Tests ----------
function viewTests() {
  const ev = h('section', { class: 'panel' }, h('h2', {}, 'Ereignisse'), data.events.length ? h('ul', { class: 'plain log' }, data.events.map((e) => h('li', {}, h('span', { class: 'sub' }, `${fmtDT(e.ts)} `), e.hostId ? h('b', {}, `${e.hostId}: `) : '', e.text))) : h('p', { class: 'sub' }, 'Noch nichts passiert.'));
  return [tests ? runningPanel(tests, data) : null, data.hosts.map((host) => hostTestsPanel(host)), tests ? allTestsPanel(tests, data) : null, ev];
}

// ---------- Ansicht: Zeitplan ----------
function hostSettingsForm(host) {
  const s = host.settings;
  const ctl = {};
  const num = (key, label, min, max, suffix) => { ctl[key] = h('input', { type: 'number', min, max, value: s[key] }); return h('label', { class: 'f' }, `${label}${suffix ? ` (${suffix})` : ''}`, ctl[key]); };
  ctl.enabled = h('input', { type: 'checkbox', checked: s.enabled });
  ctl.autoStart = h('input', { type: 'checkbox', checked: s.autoStart });
  ctl.wd = WD.map((n, i) => ({ i, el: h('input', { type: 'checkbox', checked: s.blockedWeekdays.includes(i) }), n }));
  ctl.from = h('input', { type: 'time', value: s.window.from === '24:00' ? '00:00' : s.window.from });
  ctl.to = h('input', { type: 'text', value: s.window.to, pattern: '\\d{1,2}:\\d{2}', size: 6, 'aria-label': 'Ende des Betriebsfensters' });
  ctl.dayEnd = h('input', { type: 'text', value: s.dayEnd, pattern: '\\d{1,2}:\\d{2}', size: 6 });
  let times = s.blockedTimes.map((t) => ({ ...t }));
  const timesBox = h('div', {});
  const drawTimes = () => { timesBox.replaceChildren(...times.map((t, i) => h('div', { class: 'row', style: null },
    h('input', { type: 'time', value: t.from, onchange: (e) => { t.from = e.target.value; } }), '–', h('input', { type: 'time', value: t.to, onchange: (e) => { t.to = e.target.value; } }),
    h('button', { type: 'button', onclick: () => { times.splice(i, 1); drawTimes(); } }, 'Entfernen'))), h('button', { type: 'button', onclick: () => { times.push({ from: '12:00', to: '13:00' }); drawTimes(); } }, 'Sperrzeit hinzufügen')); };
  drawTimes();
  const msg = h('span', {});
  const save = async () => {
    try {
      const body = {
        enabled: ctl.enabled.checked, blockedWeekdays: ctl.wd.filter((x) => x.el.checked).map((x) => x.i), blockedTimes: times,
        shortIntervalMonths: ctl.shortIntervalMonths.value, longIntervalMonths: ctl.longIntervalMonths.value, startupMinutes: ctl.startupMinutes.value, marginMinutes: ctl.marginMinutes.value,
      };
      if (host.mode === 'manuell') { body.dayEnd = ctl.dayEnd.value; body.autoStart = ctl.autoStart.checked; } else body.window = { from: ctl.from.value, to: ctl.to.value };
      await api('PUT', `/api/hosts/${host.id}/settings`, body);
      msg.className = 'okmsg'; msg.textContent = 'Gespeichert.'; await load(false);
    } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
  };
  return h('section', { class: 'panel' },
    h('div', { class: 'host-head' }, h('h2', {}, host.label), h('span', { class: 'state' }, host.mode === 'manuell' ? 'Start von Hand, festes Tagesende' : 'fester Rhythmus')),
    h('div', { class: 'form-grid' },
      h('label', { class: 'f' }, 'Zeitplan', h('span', {}, ctl.enabled, ' aktiv (ausschalten pausiert alle automatischen Tests)')),
      num('shortIntervalMonths', 'Kurztest alle', 1, 12, 'Monate'), num('longIntervalMonths', 'Langtest alle', 1, 12, 'Monate, empfohlen 3–4'),
      h('div', { class: 'f' }, h('span', {}, 'Gesperrte Wochentage (nie testen)'), h('div', { class: 'checks' }, ctl.wd.map((x) => h('label', {}, x.el, x.n.slice(0, 2))))),
      h('div', { class: 'f' }, h('span', {}, 'Sperrzeiten täglich (nie testen)'), timesBox),
      host.mode === 'manuell'
        ? [h('label', { class: 'f' }, 'Tagesende (Host schaltet sich selbst ab)', ctl.dayEnd), h('label', { class: 'f' }, 'Test nach dem Hochfahren', h('span', {}, ctl.autoStart, ' automatisch starten (sonst erst nach Klick im Banner)'))]
        : h('div', { class: 'f' }, h('span', {}, 'Betriebsfenster des Hosts (von – bis)'), h('div', { class: 'row' }, ctl.from, '–', ctl.to)),
      num('startupMinutes', 'Anlaufzeit nach dem Hochfahren', 0, 180, 'Minuten'), num('marginMinutes', 'Sicherheitsabstand vor Ende/Sperrzeit', 0, 240, 'Minuten')),
    h('div', { class: 'row', style: null }, h('button', { class: 'primary', onclick: save }, 'Speichern'),
      h('button', { onclick: () => confirm('Auf Standardwerte zurücksetzen?') && act(() => api('DELETE', `/api/hosts/${host.id}/settings`), 'Zurückgesetzt.') }, 'Standard'), msg),
    h('p', { class: 'sub' }, 'Tests laufen immer einzeln, eine Platte nach der anderen pro Host. Ein Langtest, der nicht in ein Fenster passt, wird auf mehrere Tage aufgeteilt.'));
}

function accountPanel() {
  const cur = h('input', { type: 'password', autocomplete: 'current-password' }), nw = h('input', { type: 'password', autocomplete: 'new-password' });
  const msg = h('span', {});
  const set = async (remove) => {
    try {
      await api('POST', '/api/auth/password', { current: cur.value, password: nw.value, remove: remove || undefined });
      authState = { passwordSet: !remove, loggedIn: true }; cur.value = nw.value = '';
      msg.className = 'okmsg'; msg.textContent = remove ? 'Passwortschutz entfernt.' : 'Passwort gespeichert.';
    } catch (e) { msg.className = 'error'; msg.textContent = e.message; }
  };
  return h('section', { class: 'panel' }, h('h2', {}, 'Passwort'),
    h('p', { class: 'sub' }, authState.passwordSet ? 'Die Oberfläche ist durch ein Passwort geschützt.' : 'Noch kein Passwort gesetzt: Jeder im lokalen Netz kann die Seite sehen und Tests starten.'),
    h('div', { class: 'form-grid' }, authState.passwordSet ? h('label', { class: 'f' }, 'Aktuelles Passwort', cur) : null, h('label', { class: 'f' }, 'Neues Passwort (mindestens 8 Zeichen)', nw)),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: () => set(false) }, authState.passwordSet ? 'Passwort ändern' : 'Passwort setzen'), authState.passwordSet ? h('button', { class: 'danger', onclick: () => confirm('Passwortschutz wirklich entfernen?') && set(true) }, 'Schutz entfernen') : null,
      authState.passwordSet ? h('button', { onclick: async () => { await api('POST', '/api/auth/logout', {}); authState.loggedIn = false; render(); } }, 'Abmelden') : null, msg));
}
function pollingPanel() {
  const p = data.polling ?? { idleMinutes: 30, offlineMinutes: 30, runningMinutes: 5 };
  const f = {};
  const num = (key, label, lo, hi, hint) => { f[key] = h('input', { type: 'number', min: lo, max: hi, value: p[key] }); return h('label', { class: 'f' }, `${label} (Minuten, ${lo}–${hi})`, f[key], h('span', { class: 'sub' }, hint)); };
  const msg = h('span', {});
  return h('section', { class: 'panel' }, h('h2', {}, 'Abfragerhythmus'),
    h('p', { class: 'sub' }, 'Wie oft das Tool die Hosts nach dem Zustand der Platten fragt. Das SMART-Lesen weckt schlafende Platten nicht. Eine seltene Abfrage entlastet die Hosts, dafür fallen Probleme und gestartete Hosts später auf.'),
    h('div', { class: 'form-grid' }, num('idleMinutes', 'Normalbetrieb', 5, 240, 'Host läuft, kein Test aktiv'), num('offlineMinutes', 'Host aus oder nicht erreichbar', 5, 240, 'Ein später gestarteter Host wird erst bei der nächsten Abfrage bemerkt'), num('runningMinutes', 'Während ein Test läuft', 2, 30, 'Damit das Ende zeitnah verbucht wird')),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: async () => { try { await api('PUT', '/api/settings/polling', { idleMinutes: f.idleMinutes.value, offlineMinutes: f.offlineMinutes.value, runningMinutes: f.runningMinutes.value }); msg.className = 'okmsg'; msg.textContent = 'Gespeichert.'; await load(false); } catch (e) { msg.className = 'error'; msg.textContent = e.message; } } }, 'Speichern'), msg));
}

function mailPanel() {
  const m = data.mail ?? { config: { notify: {} }, passwordSet: false };
  const c = m.config, n = c.notify ?? {};
  const f = {
    enabled: h('input', { type: 'checkbox', checked: c.enabled }), host: h('input', { type: 'text', value: c.host, placeholder: 'mail.example.org' }), port: h('input', { type: 'number', min: 1, max: 65535, value: c.port }),
    security: h('select', {}, [['starttls', 'STARTTLS (meist Port 587)'], ['ssl', 'SSL/TLS (meist Port 465)'], ['none', 'keine (nur ohne Anmeldung, nicht empfohlen)']].map(([v, t]) => h('option', { value: v, selected: c.security === v }, t))),
    user: h('input', { type: 'text', value: c.user, autocomplete: 'off' }), pw: h('input', { type: 'password', autocomplete: 'new-password', placeholder: m.passwordSet ? 'gespeichert (leer lassen = unverändert)' : '' }),
    from: h('input', { type: 'text', value: c.from, placeholder: 'platten@example.org' }), to: h('input', { type: 'text', value: c.to, placeholder: 'du@example.org' }), baseUrl: h('input', { type: 'text', value: c.baseUrl, placeholder: `http://${location.host}` }),
    cert: h('input', { type: 'checkbox', checked: c.rejectUnauthorized === false }),
    disk: h('input', { type: 'checkbox', checked: n.disk !== false }), pool: h('input', { type: 'checkbox', checked: n.pool !== false }), test: h('input', { type: 'checkbox', checked: n.test !== false }), recovery: h('input', { type: 'checkbox', checked: n.recovery !== false }), link: h('input', { type: 'checkbox', checked: n.link !== false }), backup: h('input', { type: 'checkbox', checked: n.backup !== false }),
  };
  const msg = h('p', { role: 'status' });
  const say = (ok, t) => { msg.className = ok ? 'okmsg' : 'error'; msg.textContent = t; };
  const body = () => ({ enabled: f.enabled.checked, host: f.host.value.trim(), port: Number(f.port.value), security: f.security.value, user: f.user.value.trim(), password: f.pw.value || undefined, from: f.from.value.trim(), to: f.to.value.trim(), baseUrl: f.baseUrl.value.trim(),
    rejectUnauthorized: !f.cert.checked, notify: { disk: f.disk.checked, pool: f.pool.checked, test: f.test.checked, recovery: f.recovery.checked, link: f.link.checked, backup: f.backup.checked } });
  const save = async () => { await api('PUT', '/api/mail', body()); f.pw.value = ''; await load(false); };
  const run = (fn, okText) => async () => { try { await save(); await fn(); say(true, okText); } catch (e) { say(false, e.message); } };
  return h('section', { class: 'panel' }, h('h2', {}, 'E-Mail-Benachrichtigung'),
    !authState.passwordSet ? h('p', { class: 'error' }, 'Setze zuerst im Unterreiter „Konto“ ein Passwort für diese Oberfläche. Das Mail-Passwort wird auf dem LXC gespeichert und soll nicht für jeden im Netz zugänglich sein.') : null,
    h('p', { class: 'sub' }, 'Es kommt eine Mail pro Änderung, keine Wiederholung bei jeder Abfrage. Beim Einschalten werden bereits bekannte Probleme still übernommen, gemeldet wird nur, was danach neu passiert. Mit „Zusammenfassung jetzt senden“ bekommst du den aktuellen Stand per Mail.'),
    h('label', {}, f.enabled, ' Benachrichtigung per E-Mail einschalten'),
    h('div', { class: 'form-grid panel2' }, h('label', { class: 'f' }, 'Mailserver', f.host), h('label', { class: 'f' }, 'Port', f.port), h('label', { class: 'f' }, 'Verschlüsselung', f.security),
      h('label', { class: 'f' }, 'Benutzer (leer = ohne Anmeldung)', f.user), h('label', { class: 'f' }, 'Passwort', f.pw), h('label', { class: 'f' }, 'Absender', f.from),
      h('label', { class: 'f' }, 'Empfänger (mehrere mit Komma, höchstens 5)', f.to), h('label', { class: 'f' }, 'Adresse dieser Oberfläche (für den Link in der Mail, optional)', f.baseUrl)),
    h('label', {}, f.cert, ' Zertifikat des Mailservers nicht prüfen (nur bei selbstsigniertem Zertifikat im eigenen Netz)'),
    h('div', { class: 'f' }, h('span', {}, 'Wann soll eine Mail kommen?'), h('div', { class: 'checks' },
      h('label', {}, f.disk, ' Platte wird „Bald tauschen“ oder „Kritisch“'), h('label', {}, f.pool, ' ZFS-Pool-Fehler'), h('label', {}, f.test, ' Selbsttest fehlgeschlagen'), h('label', {}, f.link, ' Verbindungsfehler (Kabel, Port): CRC-Zähler steigt oder Kernel meldet SATA-Fehler'), h('label', {}, f.backup, ' Ergebnis des Backup-Laufs (Erfolg kurz, Fehler mit Ursache)'), h('label', {}, f.recovery, ' Entwarnung, wenn wieder alles in Ordnung ist'))),
    msg,
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: run(async () => {}, 'Gespeichert.') }, 'Speichern'),
      h('button', { onclick: run(() => api('POST', '/api/mail/test', {}), 'Testmail wurde gesendet. Bitte Posteingang prüfen.') }, 'Speichern und Testmail senden'),
      h('button', { onclick: run(() => api('POST', '/api/mail/digest', {}), 'Zusammenfassung wurde gesendet.') }, 'Zusammenfassung jetzt senden'),
      m.passwordSet ? h('button', { class: 'danger', onclick: async () => { try { await api('PUT', '/api/mail', { clearPassword: true }); await load(false); say(true, 'Mail-Passwort gelöscht.'); } catch (e) { say(false, e.message); } } }, 'Gespeichertes Passwort löschen') : null));
}

function viewSettings() {
  const { nav, cur } = subTabs('settings', [['zeitplan', 'Zeitplan der Tests'], ['mail', 'E-Mail'], ['abfrage', 'Abfragerhythmus'], ['konto', 'Konto']]);
  const body = { zeitplan: () => hostSwitch('settings-host', data.hosts.map((x) => ({ id: x.id, label: x.label })), (id) => hostSettingsForm(data.hosts.find((x) => x.id === id))),
    mail: mailPanel, abfrage: pollingPanel, konto: accountPanel }[cur]();
  return [h('div', { style: 'margin-top:14px' }, nav), body];
}


// ---------- Ansicht: Hosts einrichten ----------
let wizard = null; // {mode:'new'|'redo'|'remove', host?, step:1|2|3, fp?, result?}

function hostsTable() {
  const rows = data.hosts.map((host) => h('tr', {},
    h('td', {}, h('div', { class: 'model' }, host.label), h('div', { class: 'sub' }, host.id)),
    h('td', {}, `${host.address ?? '–'}${host.port && host.port !== 22 ? `:${host.port}` : ''}`),
    h('td', {}, { dauer: 'immer an', fest: 'fester Rhythmus', manuell: 'Start von Hand' }[host.kind] ?? host.kind),
    h('td', {}, host.reachable ? '✔ erreichbar' : '✖ nicht erreichbar'),
    h('td', {}, host.gate?.version == null ? h('span', { class: 'sub' }, host.reachable ? 'unbekannt' : '–') : h('span', {}, `v${host.gate.version}`, ' ', h('span', { class: `pill ${host.gate.outdated ? 'watch' : 'ok'}` }, host.gate.outdated ? `veraltet (aktuell v${host.gate.expected})` : 'aktuell'))),
    h('td', {}, h('div', { class: 'row' },
      h('button', { class: host.gate?.outdated ? 'primary' : '', disabled: !host.reachable, title: host.reachable ? '' : 'Der Host ist nicht erreichbar', onclick: () => { wizard = { mode: 'update', host, step: 1 }; render(); } }, 'Skript aktualisieren'),
      h('button', { onclick: () => { wizard = { mode: 'redo', host, step: 1 }; render(); } }, 'Neu einrichten'),
      h('button', { onclick: () => { wizard = { mode: 'remove', host, step: 1 }; render(); } }, 'Zugang entfernen'),
      h('button', { class: 'danger', onclick: () => confirm(`„${host.label}“ aus der Liste löschen?\nDer Zugang auf dem Host bleibt bestehen (vorher „Zugang entfernen“ wählen).`) && act(() => api('DELETE', `/api/hosts/${encodeURIComponent(host.id)}`), 'Host gelöscht.') }, 'Aus Liste löschen')))));
  return data.hosts.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Host', 'Adresse', 'Art', 'Status', 'Prüfskript', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('p', { class: 'sub' }, 'Noch kein Host eingerichtet.');
}


const RIGHT_DEFS = [
  ['snapshots', 'Snapshots auslösen erlauben', 'nur Proxmox-Hosts wie router und pve: das Tool darf das autosnap-Skript starten, den Snapshot-Schalter setzen, den Cron von proxmox-autosnap aus- und einschalten und installiert den verwalteten Wrapper autosnap-run.'],
  ['backup-starten', 'Backups starten erlauben', 'nur Proxmox-Hosts (router, pve): das Tool darf vzdump mit festen Parametern als eigenen Dienst starten.'],
  ['herunterfahren', 'Herunterfahren erlauben', 'nur der PBS: das Tool darf den Host nach einem erfolgreichen Backup-Lauf herunterfahren.'],
];
/** Haken für die Rechtegruppen. @returns {{nodes:Node[], get:()=>string[]}} */
function rightsPicker(current = []) {
  const boxes = RIGHT_DEFS.map(([id, title, hint]) => [id, h('input', { type: 'checkbox', checked: current.includes(id) }), title, hint]);
  return { nodes: boxes.map(([, box, title, hint]) => h('div', {}, h('label', {}, box, ' ', title, ' '), h('span', { class: 'sub' }, `(${hint})`))), get: () => boxes.filter(([, box]) => box.checked).map(([id]) => id) };
}

function updatePanel(w) {
  const pw = h('input', { type: 'password', autocomplete: 'off' }); const msg = h('p', { class: 'error', role: 'alert' });
  const g = w.host.gate ?? {};
  const rp = rightsPicker(w.host.rights ?? []);
  const btn = h('button', { class: 'primary', onclick: async () => {
    msg.textContent = '';
    if (!pw.value) { msg.textContent = 'Bitte das root-Passwort des Hosts eingeben.'; return; }
    btn.disabled = true; btn.textContent = 'Läuft …';
    const body = { action: 'update', hostId: w.host.id, password: pw.value, rights: rp.get() }; pw.value = '';
    try { w.result = await api('POST', '/api/setup/run', body); } catch (e) { w.result = { ok: false, error: e.message, log: '' }; }
    w.step = 3; await load(false); render();
  } }, 'Jetzt aktualisieren');
  const box = h('section', { class: 'panel' });
  put(box, h('div', { class: 'host-head' }, h('h2', {}, `Prüfskript auf „${w.host.label}“ aktualisieren`), h('span', { class: 'spacer' }), h('button', { onclick: () => { wizard = null; render(); } }, 'Abbrechen')),
    h('p', {}, g.version != null ? `Auf dem Host läuft Version ${g.version}, aktuell ist Version ${g.expected}.` : 'Die Version auf dem Host ist unbekannt.'),
    h('p', { class: 'sub' }, 'Es wird dasselbe Prüfskript wie bei der Einrichtung neu aufgespielt. Der Fingerabdruck des Hosts wurde damals bestätigt und wird wieder verwendet. Das root-Passwort wird nur für diesen Vorgang benutzt und nicht gespeichert. Auf dem Host werden nur das Prüfskript unter /etc/diskmon, die zugehörige sudo-Regel und der Schlüsseleintrag des Benutzers diskmon erneuert, am Proxmox selbst ändert sich nichts.'),
    h('div', { class: 'form-grid panel2' }, h('label', { class: 'f' }, 'root-Passwort des Hosts', pw)),
    h('div', { class: 'f' }, h('span', {}, 'Rechte für das Tool auf diesem Host (nur, was du ankreuzt, wird erlaubt)'), rp.nodes),
    msg, h('div', { class: 'row' }, btn));
  return box;
}

function wizardPanel() {
  const w = wizard;
  if (w.mode === 'update' && w.step !== 3) return updatePanel(w);
  const box = h('section', { class: 'panel' });
  const title = { new: 'Host hinzufügen', redo: `„${w.host?.label}“ neu einrichten`, remove: `Zugang auf „${w.host?.label}“ entfernen`, update: `Prüfskript auf „${w.host?.label}“ aktualisieren` }[w.mode];
  const close = () => { wizard = null; render(); };
  const msg = h('p', { class: 'error', role: 'alert' });
  const head = h('div', { class: 'host-head' }, h('h2', {}, title), h('span', { class: 'state' }, `Schritt ${w.step} von 3`), h('span', { class: 'spacer' }), w.step < 3 ? h('button', { onclick: close }, 'Abbrechen') : null);

  if (w.step === 1) {
    const f = {
      id: h('input', { type: 'text', placeholder: 'z. B. pve', pattern: '[a-z0-9-]+', maxlength: 32 }), label: h('input', { type: 'text', placeholder: 'z. B. pve (Hauptserver)' }),
      address: h('input', { type: 'text', placeholder: '192.168.1.11', value: w.host?.address ?? '' }), port: h('input', { type: 'number', min: 1, max: 65535, value: w.host?.port ?? 22 }),
      kind: h('select', {}, [['fest', 'Läuft zu festen Zeiten'], ['dauer', 'Läuft immer'], ['manuell', 'Wird von Hand gestartet, schaltet sich selbst ab']].map(([v, t]) => h('option', { value: v }, t))),
      from: h('input', { type: 'time', value: '08:00' }), to: h('input', { type: 'text', value: '22:00', size: 6 }), dayEnd: h('input', { type: 'text', value: '19:00', size: 6 }),
    };
    const extra = h('div', {});
    const drawExtra = () => extra.replaceChildren(f.kind.value === 'fest' ? h('div', { class: 'f' }, h('span', {}, 'Betriebsfenster des Hosts (von – bis)'), h('div', { class: 'row' }, f.from, '–', f.to)) : f.kind.value === 'manuell' ? h('label', { class: 'f' }, 'Tagesende (der Host schaltet sich selbst ab)', f.dayEnd) : '');
    f.kind.addEventListener('change', drawExtra); drawExtra();
    const go = async (btn) => {
      msg.textContent = ''; btn.disabled = true;
      try {
        const r = await api('POST', '/api/setup/fingerprint', { address: f.address.value.trim(), port: Number(f.port.value) });
        Object.assign(w, { step: 2, fp: r, form: w.mode === 'new' ? { id: f.id.value, label: f.label.value, kind: f.kind.value, window: { from: f.from.value, to: f.to.value }, dayEnd: f.dayEnd.value } : null });
        render();
      } catch (e) { msg.textContent = e.message; btn.disabled = false; }
    };
    const btn = h('button', { class: 'primary', onclick: () => go(btn) }, 'Fingerabdruck des Hosts holen');
    put(box, head,
      w.mode === 'new'
        ? h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'Kennung (Kleinbuchstaben, Ziffern, Bindestrich)', f.id), h('label', { class: 'f' }, 'Anzeigename', f.label), h('label', { class: 'f' }, 'Adresse im lokalen Netz', f.address), h('label', { class: 'f' }, 'SSH-Port', f.port), h('label', { class: 'f' }, 'Art des Hosts', f.kind), extra)
        : h('p', {}, `Host: ${w.host.address ? w.host.address + (w.host.port !== 22 ? ':' + w.host.port : '') : 'Adresse unbekannt'}`),
      h('p', { class: 'sub' }, 'Als Nächstes wird nur der Fingerabdruck des Hosts abgefragt. Es wird noch nichts geändert und kein Passwort gesendet.'), msg, h('div', { class: 'row' }, btn));
  } else if (w.step === 2) {
    const keys = w.fp.keys;
    let chosen = (keys.find((k) => k.type === 'ED25519') ?? keys[0]).sha256;
    const pw = h('input', { type: 'password', autocomplete: 'off' });
    const ok = h('input', { type: 'checkbox' });
    const bind = h('input', { type: 'checkbox', checked: true });
    const pkgs = h('input', { type: 'checkbox' });
    const rem = h('input', { type: 'checkbox' });
    const rp = rightsPicker(w.host?.rights ?? []);
    const btn = h('button', { class: 'primary', onclick: async () => {
      msg.textContent = '';
      if (!ok.checked) { msg.textContent = 'Bitte bestätige zuerst den Fingerabdruck.'; return; }
      if (!pw.value) { msg.textContent = 'Bitte das root-Passwort des Hosts eingeben.'; return; }
      btn.disabled = true; btn.textContent = 'Läuft …';
      const body = { action: w.mode === 'remove' ? 'remove' : 'install', fingerprint: chosen, password: pw.value, bindIp: bind.checked, installPackages: pkgs.checked, removeFromList: rem.checked, rights: w.mode === 'remove' ? undefined : rp.get() };
      if (w.mode === 'new') Object.assign(body, w.form, { address: w.fp.address, port: w.fp.port }); else body.hostId = w.host.id;
      pw.value = '';
      try { w.result = await api('POST', '/api/setup/run', body); } catch (e) { w.result = { ok: false, error: e.message, log: '' }; }
      w.step = 3; await load(false); render();
    } }, w.mode === 'remove' ? 'Zugang entfernen' : 'Einrichten');
    put(box, head,
      h('p', {}, `Der Host unter ${w.fp.address}${w.fp.port !== 22 ? `:${w.fp.port}` : ''} meldet diesen Fingerabdruck:`),
      h('div', { class: 'scroll' }, h('table', {}, h('tbody', {}, keys.map((k) => h('tr', {}, h('td', {}, h('input', { type: 'radio', name: 'fp', checked: k.sha256 === chosen, onchange: () => { chosen = k.sha256; }, 'aria-label': `Fingerabdruck ${k.type}` })), h('td', {}, k.type), h('td', {}, h('code', {}, k.sha256))))))),
      h('p', { class: 'sub' }, 'Ob das wirklich dein Host ist, siehst du in der Proxmox-Oberfläche des Hosts unter „Shell“ mit:  ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub  (nur zum Vergleichen). Im eigenen lokalen Netz reicht es meist, den Fingerabdruck zu bestätigen.'),
      h('label', {}, ok, ' Der Fingerabdruck gehört zu meinem Host.'),
      h('div', { class: 'form-grid panel2' }, h('label', { class: 'f' }, 'root-Passwort des Hosts (wird nur für diese Einrichtung verwendet und nicht gespeichert)', pw)),
      w.mode === 'remove' ? h('label', {}, rem, ' Den Host danach auch aus dieser Liste löschen') : [
        h('label', {}, bind, ' Schlüssel an die IP dieses Tools binden (empfohlen: der Zugang gilt dann nur von hier)'),
        h('br'), h('label', {}, pkgs, ' Fehlende Pakete (sudo, smartmontools) auf dem Host installieren'),
        h('br'), h('div', { class: 'f' }, h('span', {}, 'Rechte für das Tool auf diesem Host (nur, was du ankreuzt, wird erlaubt)'), rp.nodes)],
      h('p', { class: 'sub' }, w.mode === 'remove' ? 'Entfernt den Benutzer diskmon, das Prüfskript und die sudo-Regel vom Host.' : 'Legt auf dem Host den Benutzer „diskmon“, das Prüfskript unter /etc/diskmon und eine sudo-Regel nur für dieses Skript an. Am Proxmox-Kern ändert sich nichts.'),
      msg, h('div', { class: 'row' }, btn, h('button', { onclick: () => { w.step = 1; render(); } }, 'Zurück')));
  } else {
    const r = w.result;
    put(box, head,
      r.ok ? h('div', { class: 'finding ok' }, h('b', {}, w.mode === 'remove' ? '✔ Zugang entfernt' : w.mode === 'update' ? `✔ Aktualisiert auf Version ${r.version ?? ''}` : `✔ Eingerichtet${r.disks != null ? `, ${r.disks} Platten gefunden` : ''}`), w.mode === 'remove' ? 'Der Host ist wieder im Ausgangszustand.' : w.mode === 'update' ? 'Das Prüfskript auf dem Host ist jetzt aktuell.' : 'Der Host steht jetzt in der Übersicht. Die Zeitplan-Einstellungen findest du unter „Zeitplan & Konto“.')
        : h('div', { class: 'finding critical' }, h('b', {}, '✖ Nicht erfolgreich'), r.error ?? ''),
      r.log ? fold('setup-log', 'Ausgabe vom Host', null, () => h('pre', { class: 'log' }, r.log), { open: !r.ok }) : null,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: close }, 'Fertig'), r.ok ? null : h('button', { onclick: () => { w.step = w.mode === 'update' ? 1 : 2; render(); } }, 'Erneut versuchen')));
  }
  return box;
}

function viewHosts() {
  const out = [];
  if (!authState.passwordSet) out.push(h('div', { class: 'banner warn' }, h('span', {}, 'Die Einrichtung aus der Oberfläche nutzt das root-Passwort deines Hosts. Bitte setze dafür zuerst ein Passwort für diese Seite.'), h('button', { onclick: () => { ui.tabs.settings = 'konto'; view = 'zeitplan'; render(); } }, 'Passwort setzen')));
  out.push(h('section', { class: 'panel' }, h('div', { class: 'host-head' }, h('h2', {}, 'Hosts'), h('span', { class: 'spacer' }), h('button', { class: 'primary', disabled: !authState.passwordSet || !!wizard, onclick: () => { wizard = { mode: 'new', step: 1 }; render(); } }, 'Host hinzufügen')), hostsTable(),
    h('p', { class: 'sub' }, 'Die Einrichtung ersetzt das manuelle Ausführen von setup-host.sh auf dem Host: einmalig mit dem root-Passwort verbinden, Zugang einrichten, Passwort vergessen. Nur Hosts im lokalen Netz.')));
  if (wizard) out.push(wizardPanel());
  return out;
}

// ---------- Ansicht: Hilfe ----------
function viewHelp() {
  const D = (t, text) => [h('dt', {}, t), h('dd', {}, text)];
  return h('section', { class: 'panel help' }, h('h2', {}, 'Was bedeuten die Anzeigen?'), h('dl', {},
    D('✔ Gesund', 'Nichts Auffälliges. Keine Maßnahme nötig.'),
    D('! Beobachten', 'Auffälligkeit, aber stabil. Weiter im Auge behalten, zum Beispiel einen Wert, der nicht weiter steigt.'),
    D('▲ Bald tauschen', 'Zeichen von Verschleiß oder Defekt. Ersatz einplanen und prüfen, dass ein aktuelles Backup existiert. Meist kein Notfall, die Platte läuft noch.'),
    D('✖ Kritisch', 'Sofort handeln: Daten sichern, Platte ersetzen.'),
    D('Verschleiß (SSD/NVMe)', 'Wie viel der vom Hersteller vorgesehenen Schreibmenge verbraucht ist. 3 % heißt fast neu, nicht „3 % kaputt“. Die Restlebensdauer ist der Rest auf 100 %.'),
    D('Umgelagerte Sektoren (HDD)', 'Defekte Stellen, die die Platte durch Reserve ersetzt hat. Ein kleiner, gleichbleibender Wert ist verkraftbar. Steigt er, ist die Platte am Ende.'),
    D('Übertragungsfehler (CRC)', 'Fehler zwischen Platte und Controller. Liegt meist an Kabel, Stecker oder Backplane, nicht an der Platte selbst.'),
    D('Kurztest / Langtest', 'Selbsttests der Platte. Der Kurztest dauert wenige Minuten. Der Langtest liest die ganze Platte und dauert bei großen HDDs viele Stunden, wird dann auf mehrere Tage aufgeteilt. Tests laufen nie in den Sperrzeiten und nie auf mehreren Platten eines Hosts gleichzeitig.'),
    D('ZFS-Pool und vdev', 'Ein Pool besteht aus einem oder mehreren vdevs, und ein vdev aus Platten. Fällt ein ganzes vdev aus, ist der Pool verloren. Innerhalb eines Spiegels oder RAID-Z dürfen so viele Platten ausfallen, wie dort angegeben ist.'),
    D('Lese-, Schreib- und Prüfsummenfehler', 'ZFS zählt je Gerät Fehler mit. Prüfsummenfehler bedeuten, dass Daten beim Lesen nicht stimmten. Ein Scrub korrigiert sie meist. Steigen sie weiter, liegt es oft an Kabel, Backplane oder der Platte.'),
    D('Scrub', 'ZFS liest dabei alle Daten und prüft sie gegen die Prüfsummen. Proxmox startet das normalerweise monatlich.'),
    D('Betriebszeit', 'Die Platte zählt selbst mit, wie lange sie in Betrieb war. Das ist nicht ihr Alter seit dem Kauf: Zeiten, in denen der Rechner aus ist (bei dir nachts), zählen nicht, und bei NVMe können auch Zeiten im Energiesparmodus fehlen. Einschaltvorgänge und die geschriebene Datenmenge helfen bei der Einordnung.'),
    D('Prüfskript auf dem Host', 'Ein kleines Skript unter /etc/diskmon, das dem Tool nur wenige, fest vorgegebene Befehle erlaubt. Es hat eine Versionsnummer. Ist die Version auf einem Host älter als im Tool, steht „veraltet“, und ein Klick unter „Hosts einrichten“ aktualisiert es.'),
    D('Statistiken', 'Auf der Startseite siehst du Tests pro Monat, wann Tests laufen, Ergebnisse, Abdeckung und Testverlauf, darunter dieselben Zahlen je Host. Der Verlauf beginnt mit dem Tag, ab dem das Tool läuft.'),
    D('Wert (0–100)', 'Grobe Kennzahl aus der Bewertung: 100 gesund, darunter schlechter. Bei SSD/NVMe höchstens die Restlebensdauer.')));
}

// ---------- Details ----------
async function openDetail(host, d) {
  let detail = { history: [], runs: [] };
  try { detail = await api('GET', `/api/disks/${encodeURIComponent(d.serial)}`); } catch { /* ohne Verlauf */ }
  dialogOpen = true;
  const dlg = h('dialog', { 'aria-label': `Details ${d.model}`, onclose: () => { dialogOpen = false; dlg.remove(); } });
  const spark = (label, vals, unit) => {
    const pts = vals.filter((p) => p.v != null); if (pts.length < 2) return null;
    const min = Math.min(...pts.map((p) => p.v)), max = Math.max(...pts.map((p) => p.v)), span = max - min || 1;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'spark'); svg.setAttribute('viewBox', '0 0 300 70'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', label);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    line.setAttribute('points', pts.map((p, i) => `${(i / (pts.length - 1)) * 300},${max === min ? 35 : 62 - ((p.v - min) / span) * 54}`).join(' ')); svg.append(line);
    return h('div', {}, h('div', { class: 'meter-label' }, h('span', {}, label), h('span', {}, `${pts.at(-1).v}${unit} (min ${min}, max ${max})`)), svg);
  };
  const hist = detail.history;
  const series = [spark('Temperatur', hist.map((x) => ({ v: x.temp })), ' °C'), d.kind !== 'hdd' ? spark('Verschleiß', hist.map((x) => ({ v: x.wearUsed })), ' %') : spark('Umgelagerte Sektoren', hist.map((x) => ({ v: x.reallocated })), ''), d.kind === 'hdd' ? spark('Übertragungsfehler (CRC)', hist.map((x) => ({ v: x.crc })), '') : null].filter(Boolean);
  const counters = h('div', {}, h('h3', {}, 'Zähler der Platte'), h('table', {}, h('tbody', {}, [
    ['Betriebszeit', d.hours != null ? `${fmtCount(d.hours)} Stunden (${fmtAge(d.hours)})` : '–'], ['Einschaltvorgänge', fmtCount(d.powerCycles)],
    ['Unsaubere Abschaltungen', d.unsafeShutdowns != null ? fmtCount(d.unsafeShutdowns) : '–'], ['Insgesamt geschrieben', d.bytesWritten != null ? fmtSize(d.bytesWritten) : '–']].map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))),
    h('p', { class: 'sub' }, `${HOURS_HINT} Unsaubere Abschaltungen: Die Platte wurde vom Strom getrennt, ohne vorher abgemeldet zu werden.`));
  const attrTable = d.attrs.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Attribut', 'Wert', 'Schlechtester', 'Grenze', 'Rohwert'].map((t) => h('th', {}, t)))), h('tbody', {}, d.attrs.map((a) => h('tr', {}, h('td', {}, a.id), h('td', {}, a.name), h('td', {}, a.value), h('td', {}, a.worst), h('td', {}, a.thresh), h('td', {}, a.raw)))))) : null;
  const nvmeTable = d.nvme ? h('table', {}, h('tbody', {}, [['Kritische Warnung', d.nvme.criticalWarning], ['Verfügbare Reserve', `${d.nvme.availableSpare} % (Grenze ${d.nvme.spareThreshold} %)`], ['Verschleiß', `${d.nvme.percentageUsed} %`], ['Medienfehler', d.nvme.mediaErrors], ['Unsaubere Abschaltungen', d.nvme.unsafeShutdowns], ['Einschaltvorgänge', d.nvme.powerCycles]].map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))) : null;
  dlg.append(
    h('div', { class: 'dlg-head' }, h('div', {}, h('h2', {}, d.model), h('div', { class: 'sub' }, `${host.label} · ${d.device} · ${d.serial} · ${fmtSize(d.capacityBytes)} · ${KIND[d.kind]}`)), pill(d.level), h('button', { onclick: () => dlg.close() }, 'Schließen')),
    h('div', { class: 'dlg-body' },
      h('div', {}, h('h3', {}, 'Befunde'), d.findings.map((f) => h('div', { class: `finding ${f.level}` }, h('b', {}, `${ICON[f.level] ?? ''} ${f.title}`), f.text, f.advice ? h('div', { class: 'advice' }, `Was tun? ${f.advice}`) : null))),
      counters,
      series.length ? h('div', {}, h('h3', {}, 'Verlauf'), series) : h('p', { class: 'sub' }, 'Der Verlauf erscheint, sobald mehrere Messungen vorliegen.'),
      h('div', {}, h('h3', {}, 'Tests'), d.runs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Start', 'Art', 'Ergebnis', 'Hinweis'].map((t) => h('th', {}, t)))), h('tbody', {}, d.runs.map((r) => h('tr', {}, h('td', {}, fmtDT(r.started)), h('td', {}, RUN_LABEL[r.kind] ?? r.kind), h('td', {}, RESULT[r.result] ?? r.result), h('td', {}, r.note ?? ''))))) : h('p', { class: 'sub' }, 'Vom Tool wurden noch keine Tests gestartet.')),
      nvmeTable ? h('div', {}, h('h3', {}, 'NVMe-Werte'), nvmeTable) : null,
      attrTable ? h('div', {}, h('h3', {}, 'SMART-Attribute (Rohdaten)'), attrTable) : null));
  document.body.append(dlg); dlg.showModal();
}

const viewHostPage = () => (stats && tests ? hostPage({ data, stats, tests }) : h('p', { class: 'empty' }, 'Lade …'));

// ---------- Rahmen ----------
function loginView() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', autofocus: true }); const msg = h('p', { class: 'error' });
  const go = async () => { try { await api('POST', '/api/auth/login', { password: pw.value }); authState.loggedIn = true; await load(); } catch (e) { msg.textContent = e.message; } };
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return h('div', { class: 'panel login' }, h('h2', {}, BRAND), h('p', { class: 'sub' }, 'Bitte Passwort eingeben.'), h('label', { class: 'f' }, 'Passwort', pw), msg, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Anmelden')));
}

function render() {
  if (dialogOpen) return;
  if (!authState.loggedIn) { root.replaceChildren(loginView()); return; }
  if (!data) { root.replaceChildren(h('p', { class: 'empty' }, 'Lade …')); return; }
  const tabs = [['uebersicht', 'Übersicht'], ['host', 'Hosts im Detail'], ['backups', 'Backups & Snapshots'], ['tests', 'Tests'], ['zeitplan', 'Zeitplan & Konto'], ['hosts', 'Hosts einrichten'], ['hilfe', 'Hilfe']];
  const body = { uebersicht: viewOverview, host: viewHostPage, backups: () => backupsView(backups, data), tests: viewTests, zeitplan: viewSettings, hosts: viewHosts, hilfe: viewHelp }[view]();
  showFlash(flash); flash = {};
  pausedBar.hidden = !ui.dirty;
  const scrollY = window.scrollY;
  root.replaceChildren(...[
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, h('b', {}, BRAND), h('span', { class: 'sub' }, 'Platten, ZFS und Tests')),
      h('div', { class: 'title-row' }, h('div', { class: 'summary' }, h('span', { class: `dot ${data.summary.level}`, 'aria-hidden': 'true' }), h('span', { role: 'status' }, data.summary.text)), h('span', { class: 'sub' }, `Stand ${fmtDT(data.now)}`)),
      h('nav', { class: 'tabs', 'aria-label': 'Bereiche' }, tabs.map(([id, t]) => h('button', { 'aria-current': view === id ? 'page' : null, onclick: () => { view = id; ui.dirty = false; render(); window.scrollTo(0, 0); } }, t))), pausedBar),
    !authState.passwordSet ? h('div', { class: 'banner warn' }, h('span', {}, 'Es ist noch kein Passwort gesetzt. Die Seite ist nur im lokalen Netz erreichbar, aber jeder dort kann Tests starten.'), h('button', { onclick: () => { ui.tabs.settings = 'konto'; view = 'zeitplan'; render(); } }, 'Passwort setzen')) : null,
    flashBox, body].flat(Infinity).filter(Boolean));
  window.scrollTo(0, scrollY);
}

async function load(redraw = true, auto = false) {
  if (!auto) ui.dirty = false; // jedes gewollte Neuladen (Speichern, Knopf) beendet die Bearbeitungs-Pause
  try {
    const st = await fetch('/api/auth/status').then((r) => r.json());
    authState = st;
    if (!st.loggedIn) { render(); return; }
    [data, stats, tests, backups] = await Promise.all([api('GET', '/api/overview'), api('GET', '/api/stats'), api('GET', '/api/tests?limit=400'), api('GET', '/api/backups').catch(() => null)]);
    if (redraw) render();
  } catch (e) { if (!data) root.replaceChildren(h('p', { class: 'empty error' }, `Keine Verbindung: ${e.message}`)); }
}

Object.assign(ctx, { act, api, startTest, abortTest, openDetail, diskCard, render: () => render(), openUpdate: (host) => { view = 'hosts'; wizard = { mode: 'update', host, step: 1 }; render(); window.scrollTo(0, 0); } });

load();
timer = setInterval(() => { if (view !== 'zeitplan' && view !== 'hosts' && !dialogOpen && !ui.dirty) load(true, true); }, 20000);
