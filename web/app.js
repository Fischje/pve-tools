// Oberfläche von pve-disk-tool. Reines JavaScript ohne Abhängigkeiten.
// Alle Texte werden per textContent eingesetzt, nie als HTML (kein XSS durch Gerätenamen o. Ä.).

const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const KIND = { hdd: 'HDD', ssd: 'SATA-SSD', nvme: 'NVMe' };
const ICON = { ok: '✔', watch: '!', replace: '▲', critical: '✖', unknown: '?', info: 'i' };
const LABEL = { ok: 'Gesund', watch: 'Beobachten', replace: 'Bald tauschen', critical: 'Kritisch', unknown: 'Unbekannt' };
const RUN_LABEL = { short: 'Kurztest', long: 'Langtest', select: 'Langtest-Abschnitt', extern: 'Test (extern gestartet)' };
const RESULT = { ok: 'ohne Fehler', failed: 'FEHLER', interrupted: 'unterbrochen', running: 'läuft' };

const root = document.getElementById('app');
let data = null, view = 'uebersicht', authState = { passwordSet: false, loggedIn: true }, timer = null, dialogOpen = false, flash = {};

function h(tag, props = {}, ...kids) {
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

async function api(method, path, body) {
  const r = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'disktool' }, body: body ? JSON.stringify(body) : undefined });
  let json = {}; try { json = await r.json(); } catch { /* leer */ }
  if (r.status === 401 && path !== '/api/auth/login') { authState.loggedIn = false; render(); throw new Error('Bitte anmelden'); }
  if (!r.ok) throw new Error(json.error ?? `Fehler ${r.status}`);
  return json;
}

// ---------- Formatierung ----------
const d2 = (iso) => (iso ? new Date(iso) : null);
const fmtDate = (iso) => (iso ? d2(iso).toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' }) : '–');
const fmtDT = (iso) => (iso ? d2(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '–');
const fmtSize = (b) => (b == null ? '–' : b >= 1e12 ? `${(b / 1e12).toFixed(b >= 1e13 ? 0 : 1)} TB`.replace('.', ',') : `${Math.round(b / 1e9)} GB`);
const fmtAge = (hrs) => (hrs == null ? '–' : hrs >= 8766 ? `${(hrs / 8766).toFixed(1).replace('.', ',')} Jahre` : `${Math.round(hrs / 24)} Tage`);
const fmtUp = (s) => (s == null ? '–' : s >= 86400 ? `${Math.floor(s / 86400)} Tage` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);
const pill = (level, text) => h('span', { class: `pill ${level}` }, h('span', { 'aria-hidden': 'true' }, ICON[level] ?? '?'), text ?? LABEL[level]);
const fact = (k, v) => h('div', { class: 'fact' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
function meter(label, pct, level, right) {
  const bar = h('span'); bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  return h('div', {}, h('div', { class: 'meter-label' }, h('span', {}, label), h('span', {}, right ?? `${pct} %`)), h('div', { class: `meter ${level}`, role: 'img', 'aria-label': `${label}: ${pct} Prozent` }, bar));
}
function topFinding(d) {
  return d.findings.find((f) => ['critical', 'replace', 'watch'].includes(f.level)) ?? d.findings.find((f) => f.level === 'ok') ?? d.findings[0];
}
const wearLevel = (used) => (used >= 90 ? 'critical' : used >= 70 ? 'replace' : used >= 50 ? 'watch' : 'ok');

// ---------- Aktionen ----------
async function act(fn, okMsg) {
  try { await fn(); if (okMsg) flash = { ok: okMsg }; } catch (e) { flash = { err: e.message }; }
  await load();
}
function startTest(host, d, type) {
  const est = type === 'long' && d.pollingExtended ? `ca. ${Math.round(d.pollingExtended / 60)} Stunden, wird bei Bedarf auf mehrere Tage aufgeteilt` : 'wenige Minuten';
  if (!confirm(`${type === 'long' ? 'Langtest' : 'Kurztest'} auf ${d.model} (${d.device}) starten?\nDauer: ${est}.\nDie Platte ist währenddessen etwas langsamer.`)) return;
  act(() => api('POST', `/api/disks/${encodeURIComponent(d.serial)}/test`, { type }), `${type === 'long' ? 'Langtest' : 'Kurztest'} gestartet.`);
}
const abortTest = (d) => confirm(`Laufenden Test auf ${d.device} abbrechen?`) && act(() => api('POST', `/api/disks/${encodeURIComponent(d.serial)}/abort`, {}), 'Test abgebrochen.');

// ---------- Ansicht: Übersicht ----------
function diskCard(host, d) {
  const tf = topFinding(d);
  const facts = [fact('Alter', fmtAge(d.hours)), fact('Temperatur', d.temperature != null ? `${d.temperature} °C` : '–'), fact('Größe', fmtSize(d.capacityBytes)), fact('Wert', d.score != null ? `${d.score} / 100` : '–')];
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
      host.pools.map((p) => h('span', { class: `pool ${p.level === 'critical' ? 'critical' : ''}`, title: p.scan }, `ZFS ${p.name}: ${p.state}`)),
      h('span', { class: 'spacer' }), h('button', { onclick: () => act(() => api('POST', `/api/hosts/${host.id}/poll`, {}), 'Aktualisiert.') }, 'Jetzt abfragen')),
    host.pools.flatMap((p) => p.findings.map((f) => h('div', { class: 'finding critical' }, h('b', {}, f.title), f.text, ' ', f.advice))),
    host.disks.length ? h('div', { class: 'grid' }, host.disks.map((d) => diskCard(host, d))) : h('p', { class: 'empty' }, host.reachable ? 'Noch keine Platten gelesen.' : 'Keine Daten, solange der Host nicht erreichbar ist. Das ist normal, wenn er ausgeschaltet ist.'));
}

function viewOverview() {
  return [data.hosts.map(bannerEl), data.hosts.length ? data.hosts.map(hostSection) : h('p', { class: 'empty' }, 'Keine Hosts eingerichtet. Siehe docs/INSTALLATION.md.')];
}

// ---------- Ansicht: Tests ----------
function viewTests() {
  const sections = data.hosts.map((host) => {
    const w = host.window;
    const status = w.open ? `Testfenster offen, noch ${Math.floor(w.minutesLeft / 60)} h ${w.minutesLeft % 60} min` : `Gerade kein Test: ${w.reason}`;
    const rows = host.disks.map((d) => h('tr', {},
      h('td', {}, h('div', { class: 'model' }, d.model), h('div', { class: 'sub' }, `${d.device} · ${KIND[d.kind]}`)),
      h('td', {}, d.running ? `⏳ ${RUN_LABEL[d.running.type]}${d.running.remainingPercent != null ? ` (noch ${d.running.remainingPercent} %)` : ''}` : pill(d.level)),
      h('td', {}, fmtDate(d.lastShortOk), h('div', { class: 'sub' }, `nächster: ${fmtDate(d.nextShort)}`)),
      h('td', {}, fmtDate(d.lastLongOk), h('div', { class: 'sub' }, `nächster: ${d.progress ? 'läuft in Abschnitten' : fmtDate(d.nextLong)}`)),
      h('td', {}, d.progress ? meter('Langtest', d.progress.percent, 'ok', `${d.progress.percent} % · Abschnitt ${d.progress.segments + 1}`) : (d.selective || d.kind !== 'hdd' ? '–' : h('span', { class: 'sub' }, 'keine selektiven Tests'))),
      h('td', {}, h('div', { class: 'row' },
        d.running ? h('button', { class: 'danger', onclick: () => abortTest(d) }, 'Abbrechen') : [h('button', { onclick: () => startTest(host, d, 'short') }, 'Kurz'), h('button', { onclick: () => startTest(host, d, 'long') }, 'Lang')],
        h('button', { onclick: () => act(() => api('POST', `/api/disks/${encodeURIComponent(d.serial)}/pause`, { paused: !d.paused }), d.paused ? 'Fortgesetzt.' : 'Pausiert.') }, d.paused ? 'Fortsetzen' : 'Pausieren')))));
    return h('section', { class: 'panel' },
      h('div', { class: 'host-head' }, h('h2', {}, host.label), h('span', { class: 'state' }, status)),
      host.decision && host.decision.reason ? h('p', { class: 'sub' }, `Zeitplan: ${host.decision.reason}`) : null,
      host.disks.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Platte', 'Zustand', 'Kurztest', 'Langtest', 'Langtest-Fortschritt', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('p', { class: 'sub' }, 'Keine Platten bekannt.'));
  });
  const ev = h('section', { class: 'panel' }, h('h2', {}, 'Ereignisse'), data.events.length ? h('ul', { class: 'plain log' }, data.events.map((e) => h('li', {}, h('span', { class: 'sub' }, `${fmtDT(e.ts)} `), e.hostId ? h('b', {}, `${e.hostId}: `) : '', e.text))) : h('p', { class: 'sub' }, 'Noch nichts passiert.'));
  return [sections, ev];
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
const viewSettings = () => [data.hosts.map(hostSettingsForm), accountPanel()];

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
  const attrTable = d.attrs.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Attribut', 'Wert', 'Schlechtester', 'Grenze', 'Rohwert'].map((t) => h('th', {}, t)))), h('tbody', {}, d.attrs.map((a) => h('tr', {}, h('td', {}, a.id), h('td', {}, a.name), h('td', {}, a.value), h('td', {}, a.worst), h('td', {}, a.thresh), h('td', {}, a.raw)))))) : null;
  const nvmeTable = d.nvme ? h('table', {}, h('tbody', {}, [['Kritische Warnung', d.nvme.criticalWarning], ['Verfügbare Reserve', `${d.nvme.availableSpare} % (Grenze ${d.nvme.spareThreshold} %)`], ['Verschleiß', `${d.nvme.percentageUsed} %`], ['Medienfehler', d.nvme.mediaErrors], ['Unsaubere Abschaltungen', d.nvme.unsafeShutdowns], ['Einschaltvorgänge', d.nvme.powerCycles]].map(([k, v]) => h('tr', {}, h('td', {}, k), h('td', {}, v))))) : null;
  dlg.append(
    h('div', { class: 'dlg-head' }, h('div', {}, h('h2', {}, d.model), h('div', { class: 'sub' }, `${host.label} · ${d.device} · ${d.serial} · ${fmtSize(d.capacityBytes)} · ${KIND[d.kind]}`)), pill(d.level), h('button', { onclick: () => dlg.close() }, 'Schließen')),
    h('div', { class: 'dlg-body' },
      h('div', {}, h('h3', {}, 'Befunde'), d.findings.map((f) => h('div', { class: `finding ${f.level}` }, h('b', {}, `${ICON[f.level] ?? ''} ${f.title}`), f.text, f.advice ? h('div', { class: 'advice' }, `Was tun? ${f.advice}`) : null))),
      series.length ? h('div', {}, h('h3', {}, 'Verlauf'), series) : h('p', { class: 'sub' }, 'Der Verlauf erscheint, sobald mehrere Messungen vorliegen.'),
      h('div', {}, h('h3', {}, 'Tests'), d.runs.length ? h('table', {}, h('thead', {}, h('tr', {}, ['Start', 'Art', 'Ergebnis', 'Hinweis'].map((t) => h('th', {}, t)))), h('tbody', {}, d.runs.map((r) => h('tr', {}, h('td', {}, fmtDT(r.started)), h('td', {}, RUN_LABEL[r.kind] ?? r.kind), h('td', {}, RESULT[r.result] ?? r.result), h('td', {}, r.note ?? ''))))) : h('p', { class: 'sub' }, 'Vom Tool wurden noch keine Tests gestartet.')),
      nvmeTable ? h('div', {}, h('h3', {}, 'NVMe-Werte'), nvmeTable) : null,
      attrTable ? h('div', {}, h('h3', {}, 'SMART-Attribute (Rohdaten)'), attrTable) : null));
  document.body.append(dlg); dlg.showModal();
}

// ---------- Rahmen ----------
function loginView() {
  const pw = h('input', { type: 'password', autocomplete: 'current-password', autofocus: true }); const msg = h('p', { class: 'error' });
  const go = async () => { try { await api('POST', '/api/auth/login', { password: pw.value }); authState.loggedIn = true; await load(); } catch (e) { msg.textContent = e.message; } };
  pw.addEventListener('keydown', (e) => e.key === 'Enter' && go());
  return h('div', { class: 'panel login' }, h('h2', {}, 'Platten-Gesundheit'), h('p', { class: 'sub' }, 'Bitte Passwort eingeben.'), h('label', { class: 'f' }, 'Passwort', pw), msg, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: go }, 'Anmelden')));
}

function render() {
  if (dialogOpen) return;
  if (!authState.loggedIn) { root.replaceChildren(loginView()); return; }
  if (!data) { root.replaceChildren(h('p', { class: 'empty' }, 'Lade …')); return; }
  const tabs = [['uebersicht', 'Übersicht'], ['tests', 'Tests'], ['zeitplan', 'Zeitplan & Konto'], ['hilfe', 'Hilfe']];
  const body = { uebersicht: viewOverview, tests: viewTests, zeitplan: viewSettings, hilfe: viewHelp }[view]();
  const f = flash.err ? h('div', { class: 'banner warn', role: 'alert' }, h('b', {}, flash.err)) : flash.ok ? h('div', { class: 'banner', role: 'status' }, flash.ok) : null; flash = {};
  root.replaceChildren(...[
    h('header', { class: 'top' },
      h('div', { class: 'title-row' }, h('div', { class: 'summary' }, h('span', { class: `dot ${data.summary.level}`, 'aria-hidden': 'true' }), h('span', { role: 'status' }, data.summary.text)), h('span', { class: 'sub' }, `Stand ${fmtDT(data.now)}`)),
      h('nav', { class: 'tabs', 'aria-label': 'Bereiche' }, tabs.map(([id, t]) => h('button', { 'aria-current': view === id ? 'page' : null, onclick: () => { view = id; render(); } }, t)))),
    !authState.passwordSet ? h('div', { class: 'banner warn' }, h('span', {}, 'Es ist noch kein Passwort gesetzt. Die Seite ist nur im lokalen Netz erreichbar, aber jeder dort kann Tests starten.'), h('button', { onclick: () => { view = 'zeitplan'; render(); } }, 'Passwort setzen')) : null,
    f, body].flat(Infinity).filter(Boolean));
}

async function load(redraw = true) {
  try {
    const st = await fetch('/api/auth/status').then((r) => r.json());
    authState = st;
    if (!st.loggedIn) { render(); return; }
    data = await api('GET', '/api/overview');
    if (redraw) render();
  } catch (e) { if (!data) root.replaceChildren(h('p', { class: 'empty error' }, `Keine Verbindung: ${e.message}`)); }
}

load();
timer = setInterval(() => { if (view !== 'zeitplan' && !dialogOpen) load(); }, 20000);
