// Backups und Snapshots: Zustand von proxmox-autosnap, Snapshot-Stand je Gast, Backup-Läufe mit Ergebnis je Gast.
// Aufgeteilt in Unterreiter: Überblick, Backup-Lauf (Steuerung durch das Tool), Snapshots (je Host), Gäste und Backup-Läufe (je Host).
import { h, fmtDT, fmtMin, pill, fact, ctx, ui, fold, subTabs, hostSwitch, kpiBox } from './dom.js';

const WD = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
const RES = { ok: ['ok', 'in Ordnung'], failed: ['critical', 'fehlgeschlagen'], interrupted: ['watch', 'unterbrochen'] };
const LEVEL_PILL = { ok: 'ok', info: 'unknown', watch: 'watch', replace: 'replace' };

export function ago(iso, now) {
  if (!iso) return '–';
  const m = Math.round((Date.parse(now) - Date.parse(iso)) / 60000);
  if (m < 2) return 'gerade eben';
  if (m < 120) return `vor ${m} min`;
  if (m < 48 * 60) return `vor ${Math.round(m / 60)} h`;
  return `vor ${Math.round(m / 1440)} Tagen`;
}
const kpi = kpiBox;
const resultPill = (r) => { const [c, t] = RES[r] ?? ['unknown', r]; return h('span', { class: `pill ${c}` }, t); };

function snapCell(s, now, keep) {
  if (!s.count) return h('span', { class: 'sub' }, '–');
  return h('span', {}, `${s.count}${keep ? ` / ${keep}` : ''}`, h('span', { class: 'sub' }, ` · neuester ${ago(new Date(s.newest).toISOString(), now)}`));
}


// ---------- Bausteine je Host ----------
function unsupported(host, data) {
  const hostObj = data.hosts.find((x) => x.id === host.id);
  return h('section', { class: 'panel' }, h('p', {}, host.gate.version == null ? 'Von diesem Host liegen noch keine Daten vor.' : `Das Prüfskript auf ${host.label} hat Version ${host.gate.version}. Für Backups und Snapshots wird Version ${host.gate.expected} gebraucht.`),
    host.reachable && hostObj ? h('button', { class: 'primary', onclick: () => ctx.openUpdate(hostObj) }, 'Prüfskript aktualisieren') : null);
}

function runBoxes(host, now) {
  const run = host.runningJob;
  const runBox = run ? h('div', { class: 'finding ok' }, h('b', {}, `Ein Backup-Lauf läuft gerade (gestartet ${fmtDT(run.start)}, ${ago(run.start, now)}).`), h('div', { class: 'sub' }, 'Die Ergebnisse erscheinen, sobald er beendet ist. Rote Hinweise stammen aus dem davor beendeten Lauf.')) : null;
  const lr = host.lastRun;
  const lrBox = lr && lr.summary.failed > 0 ? h('div', { class: 'finding critical' },
    h('b', {}, `Der letzte beendete Backup-Lauf (${fmtDT(lr.start)}, ${lr.minutes != null ? fmtMin(lr.minutes) : '–'}) hat ${lr.summary.failed} von ${lr.summary.total} Gästen nicht gesichert.`),
    lr.summary.cause === 'verbindung'
      ? h('div', {}, 'Ursache laut Protokoll: Die Verbindung zum PBS fehlte oder brach ab („connect“, „broken pipe“). Das passiert, wenn der PBS aus ist, während des Laufs ausgeht oder der Datenträger dort Probleme hat. ',
        lr.minutes != null && lr.summary.total > 0 && lr.minutes < lr.summary.total * 0.5 ? `Der Lauf dauerte nur ${fmtMin(lr.minutes)} für ${lr.summary.total} Gäste, das ist auffällig kurz.` : '')
      : h('div', {}, 'Die Gründe stehen im Reiter „Backup-Läufe“ beim Lauf.')) : null;
  return [runBox, lrBox];
}

function autosnapBox(host) {
  const as = host.autosnap;
  if (!as) return null;
  return h('div', { class: 'finding ' + (as.enabled ? 'ok' : 'watch') },
    h('b', {}, `Snapshots: ${as.known ? (as.enabled ? 'eingeschaltet' : 'AUSGESCHALTET') : 'autosnap-run nicht gefunden'}`),
    as.known ? h('div', {}, [
      as.keep && Object.keys(as.keep).length ? `Aufbewahrung: stündlich ${as.keep.hourly ?? '?'}, wöchentlich ${as.keep.weekly ?? '?'}, monatlich ${as.keep.monthly ?? '?'}. ` : '',
      as.pauseDay != null ? `Pausentag: ${WD[as.pauseDay % 7]}${as.pauseToday ? ' (heute, es werden keine Snapshots angelegt)' : ''}. ` : 'Kein Pausentag. ', `Auswahl: Gäste mit dem Tag „${as.tag}“${as.onlyRunning ? ', nur laufende' : ''}. `,
      as.cron.length ? `Zeitplan des Crons: ${as.cron.map((c) => c.text).join('; ')}.` : ''].join('')) : h('div', { class: 'sub' }, 'Auf diesem Host wurde /usr/local/sbin/autosnap-run nicht gefunden.'));
}

function snapControlBox(host, data) {
  const as = host.autosnap, sc = host.snapControl;
  if (!as?.known || !sc) return null;
  const LBL = { hourly: 'Stündlich', weekly: 'Wöchentlich', monthly: 'Monatlich' };
  const post = (body, okText) => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/snapshots`, body), okText);
  const hostObj = data.hosts.find((x) => x.id === host.id);
  if (!sc.allowed) return h('div', { class: 'finding info' }, h('b', {}, 'Auslösen durch das Tool: noch nicht freigegeben'),
    h('div', { class: 'sub' }, 'Heute löst der Cron auf dem Host die Snapshots aus. Soll das Tool das übernehmen, gib im Reiter „Hosts einrichten“ bei „Skript aktualisieren“ das Recht „Snapshots auslösen“ frei (mit dem root-Passwort).'),
    hostObj ? h('div', { class: 'actions' }, h('button', { onclick: () => ctx.openUpdate(hostObj) }, 'Recht freigeben')) : null);
  const failed = Object.values(sc.last).find((x) => !x.ok);
  return h('div', { class: `finding ${sc.mode === 'tool' ? 'ok' : 'info'}` },
    h('b', {}, sc.mode === 'tool' ? 'Das Tool löst die Snapshots aus (der Cron auf dem Host ist aus)' : 'Die Snapshots löst der Cron auf dem Host aus'),
    sc.cronStillActive ? h('div', { class: 'sub bad' }, 'Achtung: Laut letzter Abfrage ist auf dem Host noch ein Cron-Eintrag aktiv, es können doppelte Snapshots entstehen.') : null,
    sc.mode === 'tool'
      ? h('table', { class: 'mini' }, h('tbody', {}, ['hourly', 'weekly', 'monthly'].filter((k) => sc.plan[k]).map((k) => h('tr', {}, h('td', {}, LBL[k]),
          h('td', {}, `zuletzt ${sc.last[k] ? `${fmtDT(sc.last[k].ts)}${sc.last[k].ok ? '' : ' (Fehler)'}` : '– (noch nicht durch das Tool)'}`), h('td', {}, `nächster ${fmtDT(sc.next[k])}`)))))
      : h('div', { class: 'sub' }, 'Übernimmt das Tool, wird der Cron auf dem Host ausgeschaltet (umbenannt, nicht gelöscht). Verpasste wöchentliche und monatliche Läufe holt das Tool nach, sobald der Host läuft.'),
    failed ? h('div', { class: 'sub bad' }, `Letzter Fehler: ${failed.text}`) : null,
    h('div', { class: 'actions' },
      sc.cronStillActive ? h('button', { class: 'primary', onclick: () => post({ action: 'mode', mode: 'tool' }, 'Cron ausgeschaltet.') }, 'Cron jetzt ausschalten') : null,
      sc.mode === 'tool' ? h('button', { onclick: () => { if (confirm('Wieder den Cron auf dem Host verwenden?')) post({ action: 'mode', mode: 'cron' }, 'Cron auf dem Host ist wieder aktiv.'); } }, 'Zurück zum Cron')
        : h('button', { class: 'primary', onclick: () => { if (confirm('Das Tool löst die Snapshots künftig aus und schaltet den Cron auf dem Host aus. Fortfahren?')) post({ action: 'mode', mode: 'tool' }, 'Das Tool löst die Snapshots jetzt aus.'); } }, 'Das Tool übernimmt'),
      h('button', { onclick: () => post({ action: 'switch', on: !as.enabled }, as.enabled ? 'Snapshots ausgeschaltet.' : 'Snapshots eingeschaltet.') }, as.enabled ? 'Snapshots ausschalten' : 'Snapshots einschalten'),
      h('button', { onclick: () => { if (confirm('Jetzt einen stündlichen Snapshot-Lauf auslösen?')) post({ action: 'run', label: 'hourly' }, 'Lauf ausgelöst.'); } }, 'Jetzt stündlichen Lauf auslösen')));
}

/** Planung: Zeitpunkte (gelten, wenn das Tool auslöst) und Aufbewahrung/Pausentag (stehen auf dem Host im verwalteten Wrapper). */
function planCard(host, data) {
  const as = host.autosnap, sc = host.snapControl;
  if (!sc?.allowed || !as?.known) return null;
  const post = (body, okText) => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/snapshots`, body), okText);
  const hostObj = data.hosts.find((x) => x.id === host.id);
  const p = sc.plan, k = as.keep ?? {};
  const num = (v, lo, hi, w = 5) => h('input', { type: 'number', min: lo, max: hi, value: v, style: `width:${w}em` });
  const sel = (opts, v) => h('select', {}, opts.map(([val, t]) => h('option', { value: val, selected: String(val) === String(v) }, t)));
  const chk = (v) => h('input', { type: 'checkbox', checked: v });
  const f = {
    hourly: chk(p.hourly), hourlyMinute: num(p.hourlyMinute, 0, 59),
    weekly: chk(p.weekly), weeklyDay: sel(WD.map((t, i) => [i, t]), p.weeklyDay), weeklyTime: h('input', { type: 'time', value: p.weeklyTime }),
    monthly: chk(p.monthly), monthlyDay: num(p.monthlyDay, 1, 28), monthlyTime: h('input', { type: 'time', value: p.monthlyTime }),
    kh: num(k.hourly ?? 8, 1, 99), kw: num(k.weekly ?? 1, 1, 52), km: num(k.monthly ?? 1, 1, 36),
    pause: sel([['', 'kein Pausentag'], ...WD.map((t, i) => [i, t])], as.pauseDay ?? ''),
    label: sel([['hourly', 'stündlich'], ['weekly', 'wöchentlich'], ['monthly', 'monatlich']], 'hourly'),
  };
  const out = h('pre', { class: 'log', hidden: true });
  const save = () => {
    const body = { action: 'plan', plan: { hourly: f.hourly.checked, hourlyMinute: Number(f.hourlyMinute.value), weekly: f.weekly.checked, weeklyDay: Number(f.weeklyDay.value), weeklyTime: f.weeklyTime.value,
      monthly: f.monthly.checked, monthlyDay: Number(f.monthlyDay.value), monthlyTime: f.monthlyTime.value } };
    if (sc.managed) Object.assign(body, { keep: { hourly: Number(f.kh.value), weekly: Number(f.kw.value), monthly: Number(f.km.value) }, pauseDay: f.pause.value === '' ? null : Number(f.pause.value) });
    return post(body, 'Planung gespeichert.');
  };
  const dry = async () => { out.hidden = false; out.textContent = 'Läuft …'; try { out.textContent = (await ctx.api('POST', `/api/hosts/${host.id}/snapshots`, { action: 'dryrun', label: f.label.value })).text || '(keine Ausgabe)'; } catch (e) { out.textContent = e.message; } };
  return h('section', { class: 'panel' }, h('h2', {}, 'Planung'),
    h('div', { class: 'form-sec' }, h('h3', {}, 'Wann?'),
      h('p', { class: 'sub' }, sc.mode === 'tool' ? 'Gilt für die Läufe, die das Tool auslöst.' : 'Wirkt erst, wenn das Tool übernimmt. Solange der Cron auslöst, gelten dessen Zeiten.'),
      h('div', { class: 'row' }, h('label', {}, f.hourly, ' stündlich, jeweils zur Minute '), f.hourlyMinute),
      h('div', { class: 'row' }, h('label', {}, f.weekly, ' wöchentlich, am '), f.weeklyDay, ' um ', f.weeklyTime),
      h('div', { class: 'row' }, h('label', {}, f.monthly, ' monatlich, am Tag '), f.monthlyDay, ' um ', f.monthlyTime, h('span', { class: 'sub' }, ' (fällt er auf den Pausentag, am Folgetag)'))),
    h('div', { class: 'form-sec' }, h('h3', {}, 'Wie viele bleiben? (je Gast)'),
      sc.managed
        ? [h('div', { class: 'row' }, h('label', { class: 'f inline' }, 'stündlich', f.kh), h('label', { class: 'f inline' }, 'wöchentlich', f.kw), h('label', { class: 'f inline' }, 'monatlich', f.km)),
          h('div', { class: 'row' }, h('label', { class: 'f inline' }, 'Pausentag (keine Snapshots)', f.pause))]
        : h('div', { class: 'finding info' }, h('div', { class: 'sub' }, 'Aufbewahrung und Pausentag stehen bei diesem Host noch fest im alten Wrapper. „Skript aktualisieren“ mit dem Recht „Snapshots auslösen“ installiert den verwalteten Wrapper (der alte bleibt als Sicherung, seine Werte werden übernommen).'),
            hostObj ? h('div', { class: 'actions' }, h('button', { onclick: () => ctx.openUpdate(hostObj) }, 'Wrapper installieren')) : null)),
    h('div', { class: 'form-sec' }, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Planung speichern'),
      sc.managed ? [h('span', { class: 'spacer' }), h('span', { class: 'sub' }, 'Probelauf ohne Wirkung:'), h('span', { class: 'no-dirty' }, f.label), h('button', { onclick: dry }, 'Probelauf')] : null), out));
}

function guestsTable(host, now) {
  const as = host.autosnap, keep = as?.keep ?? {};
  if (!host.guests.length) return h('p', { class: 'sub' }, 'Keine Gäste gelesen.');
  const rows = [...host.guests].sort((a, c) => ['replace', 'watch', 'info', 'ok'].indexOf(a.level) - ['replace', 'watch', 'info', 'ok'].indexOf(c.level) || a.vmid - c.vmid).map((g) => h('tr', {},
    h('td', {}, g.vmid), h('td', {}, h('div', { class: 'model' }, g.name), h('div', { class: 'sub' }, `${g.type === 'lxc' ? 'LXC' : 'VM'} · ${g.status === 'running' ? 'läuft' : g.status === 'stopped' ? 'gestoppt' : g.status}`)),
    h('td', {}, g.tagged ? [h('div', {}, 'Std. ', snapCell(g.snapshots.hourly, now, keep.hourly)), h('div', {}, 'Woche ', snapCell(g.snapshots.weekly, now, keep.weekly)), h('div', {}, 'Monat ', snapCell(g.snapshots.monthly, now, keep.monthly))] : h('span', { class: 'sub' }, 'kein Snapshot-Tag')),
    h('td', {}, g.backup ? h('div', {}, resultPill(g.backup.result), h('div', { class: 'sub' }, `${ago(g.backup.at, now)}${g.backup.seconds ? ` · ${fmtMin(Math.max(1, Math.round(g.backup.seconds / 60)))}` : ''}`)) : h('span', { class: 'sub' }, '–')),
    h('td', {}, g.findings.length ? g.findings.map((f) => h('div', { class: `sub ${f.level === 'replace' ? 'bad' : ''}` }, f.text)) : h('span', { class: 'okmsg' }, '✔'))));
  return h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Gast', 'Snapshots (vorhanden / vorgesehen)', 'Letztes Backup', 'Hinweise'].map((t) => h('th', {}, t)))), h('tbody', {}, rows)));
}

function runsList(host) {
  if (!host.tasks.length) return h('p', { class: 'sub' }, 'Noch keine Backup-Läufe auf diesem Host gelesen. Die Aufgabenliste von Proxmox reicht einige Wochen zurück.');
  return host.tasks.map((t) => {
    const okRun = t.status === 'OK' && !t.failed;
    const status = t.status ? h('span', { class: `pill ${t.status === 'OK' ? 'ok' : /warn/i.test(t.status) ? 'watch' : 'critical'}` }, t.status === 'OK' ? 'in Ordnung' : t.status) : h('span', { class: 'pill unknown' }, 'läuft');
    const sum = t.parsed ? `${t.ok} gesichert${t.failed ? `, ${t.failed} fehlgeschlagen` : ''}${t.interrupted ? `, ${t.interrupted} unterbrochen` : ''} · ${t.minutes != null ? fmtMin(t.minutes) : 'läuft'}` : (t.running ? 'läuft …' : 'Protokoll wird gelesen …');
    return fold(`run-${t.upid}`, h('span', {}, `${fmtDT(t.start)} `, status), sum, () => [
      t.summary?.cause === 'verbindung' ? h('div', { class: 'finding critical' }, 'Die Verbindung zum PBS fehlte oder brach ab.') : null,
      t.guests.length ? h('ul', { class: 'plain' }, t.guests.map((x) => h('li', {}, resultPill(x.result), ` ${x.vmid} ${x.name ?? ''}`, x.seconds ? h('span', { class: 'sub' }, ` · ${fmtMin(Math.max(1, Math.round(x.seconds / 60)))}`) : '',
        x.note ? h('div', { class: 'sub bad' }, x.note) : null, x.detail ? h('pre', { class: 'log' }, x.detail.replace(/ \| /g, '\n')) : null))) : h('p', { class: 'sub' }, 'Keine Gäste im Protokoll.')],
    { level: okRun ? '' : t.status ? 'critical' : '' });
  });
}

const JOB_STATE = { wartet: ['unknown', 'wartet'], läuft: ['watch', 'läuft'], ok: ['ok', 'in Ordnung'], fehler: ['critical', 'nicht erfolgreich'], fehlt: ['critical', 'nicht erreicht'], übersprungen: ['unknown', 'übersprungen'] };
const SHUTDOWN = { angefordert: 'Der PBS wurde heruntergefahren.', aus: 'Der PBS bleibt an (Herunterfahren ist ausgeschaltet).', 'fehlt-recht': 'Der PBS bleibt an: das Recht „Herunterfahren“ fehlt.', fehler: 'Der PBS konnte nicht heruntergefahren werden.', nein: 'Der PBS bleibt an, damit nichts verloren geht.' };

function jobBox(job, title, now) {
  if (!job) return null;
  const cls = job.phase === 'läuft' ? 'ok' : job.phase === 'fertig' ? 'ok' : 'critical';
  return h('div', { class: `finding ${cls}` },
    h('b', {}, `${title}: ${fmtDT(job.startedAt)}${job.manual ? ' (von Hand)' : ''}${job.phase === 'läuft' ? ` – läuft seit ${ago(job.startedAt, now)}` : job.phase === 'abgebrochen' ? ' – im Tool abgebrochen' : job.phase === 'fertig' ? ' – alles gesichert' : ' – nicht vollständig erfolgreich'}`),
    h('ul', { class: 'plain' }, job.hosts.map((x) => h('li', {}, h('b', {}, x.id), ' ', pill(JOB_STATE[x.state]?.[0] ?? 'unknown', JOB_STATE[x.state]?.[1] ?? x.state),
      x.total != null ? ` ${x.total - (x.failed ?? 0)} von ${x.total} Gästen, ${x.minutes ?? '?'} min` : '', x.note ? h('div', { class: 'sub' }, x.note) : null,
      x.failedGuests?.length ? h('div', { class: 'sub bad' }, `Fehlgeschlagen: ${x.failedGuests.map((g) => g.vmid).join(', ')}`) : null))),
    job.phase !== 'läuft' && job.shutdown ? h('div', { class: 'sub' }, SHUTDOWN[job.shutdown] ?? '') : null);
}


const hostLevelOf = (host) => (!host.supported ? 'unknown' : host.lastRun?.summary?.failed ? 'critical' : host.guests.some((g) => g.level === 'replace') ? 'replace' : host.guests.some((g) => g.level === 'watch') ? 'watch' : 'ok');

function overviewTab(b, data) {
  const k = b.kpi, last = b.lastRun, now = b.now;
  const bk = (tab, hostId) => ({ view: 'backups', tabs: { bk: tab, ...(hostId ? { 'bk-host': hostId } : {}) } });
  const failHost = b.hosts.find((x) => x.guests.some((g) => g.backup?.result === 'failed'))?.id;
  const problemHost = b.hosts.find((x) => x.guests.some((g) => g.level === 'replace' || g.level === 'watch'))?.id;
  const kpis = h('div', { class: 'kpis' },
    kpi('Letzter Backup-Lauf', last ? ago(last.start, now) : '–', last ? `${last.hostLabel}: ${last.status === 'OK' ? 'in Ordnung' : last.status ?? 'läuft'}` : 'noch keiner gelesen', last && last.status !== 'OK' && last.status ? 'bad' : last ? 'ok' : '', bk('laeufe', last?.hostId)),
    kpi('Backup-Läufe (30 Tage)', k.runs30, 'auf allen Hosts', '', bk('laeufe')),
    kpi('Fehlgeschlagene Backups', k.failedBackups, k.failedBackups ? (k.failedCause === 'verbindung' ? 'meist: Verbindung zum PBS' : 'beim letzten Lauf des Gastes') : 'keine', k.failedBackups ? 'bad' : 'ok', bk('gaeste', failHost)),
    kpi('Snapshots', k.snapshotsOff ? `${k.snapshotsOn} an, ${k.snapshotsOff} aus` : `${k.snapshotsOn} Hosts an`, 'Schalter von autosnap', k.snapshotsOff ? 'watch' : 'ok', bk('snapshots')),
    kpi('Gäste mit Hinweis', k.problems, `von ${k.guests} Gästen`, k.problems ? 'watch' : 'ok', bk('gaeste', problemHost)));
  const c = b.control;
  const goTab = (tab, hostId) => { ui.tabs.bk = tab; if (hostId) { ui.tabs['bk-host'] = hostId; } ctx.render(); window.scrollTo(0, 0); };
  const cards = b.hosts.filter((x) => x.supported || x.gate.version != null).map((host) => {
    const sc = host.snapControl, as = host.autosnap, bad = host.guests.filter((g) => g.level === 'replace' || g.level === 'watch').length;
    return h('article', { class: `card ${hostLevelOf(host)}` },
      h('div', { class: 'card-head' }, h('div', { class: 'model' }, host.label), h('span', { class: 'sub' }, host.reachable ? 'erreichbar' : 'nicht erreichbar')),
      !host.supported ? h('p', { class: 'sub' }, `Prüfskript zu alt (Version ${host.gate.version}).`) : [
        runBoxes(host, now),
        h('div', { class: 'facts' },
          fact('Letzter Lauf', host.lastRun ? `${fmtDT(host.lastRun.start)}` : '–'),
          fact('Ergebnis', host.lastRun ? (host.lastRun.summary.failed ? `${host.lastRun.summary.failed} von ${host.lastRun.summary.total} fehlgeschlagen` : `${host.lastRun.summary.total} gesichert`) : '–'),
          fact('Snapshots', as?.known ? (as.enabled ? (sc?.mode === 'tool' ? 'an, vom Tool' : 'an, per Cron') : 'AUS') : '–'),
          fact('Gäste', `${host.guests.length}${bad ? `, ${bad} mit Hinweis` : ''}`)),
        h('div', { class: 'row' }, h('button', { onclick: () => goTab('gaeste', host.id) }, 'Gäste'), h('button', { onclick: () => goTab('laeufe', host.id) }, 'Backup-Läufe'), as?.known ? h('button', { onclick: () => goTab('snapshots', host.id) }, 'Snapshots') : null)]);
  });
  return [kpis,
    c ? h('section', { class: 'panel' }, h('div', { class: 'card-title' }, h('h2', {}, 'Backup-Lauf'), h('span', { class: `pill ${c.settings.mode === 'steuern' ? 'ok' : 'unknown'}` }, c.settings.mode === 'steuern' ? 'Das Tool steuert' : 'Das Tool beobachtet nur'), h('span', { class: 'spacer' }), h('button', { onclick: () => goTab('lauf') }, 'Öffnen')),
      jobBox(c.job?.phase === 'läuft' ? c.job : null, 'Aktueller Lauf', now) ?? jobBox(c.last, 'Letzter Lauf des Tools', now) ?? h('p', { class: 'sub' }, 'Das Tool hat noch keinen Backup-Lauf gesteuert.')) : null,
    h('div', { class: 'grid' }, cards)];
}

function laufTab(b) {
  const c = b.control; if (!c) return h('p', { class: 'empty' }, 'Keine Daten.');
  const s = c.settings, act = (body, okText) => ctx.act(() => ctx.api('POST', '/api/backups/control', body), okText);
  const field = (type, v, extra = {}) => h('input', { type, value: v, ...extra });
  const f = { pbs: h('select', {}, c.hostChoices.map((x) => h('option', { value: x.id, selected: x.id === s.pbsHostId }, x.label))), storage: field('text', s.storage, { size: 10 }),
    wait: field('number', s.waitAfterBootMin, { min: 0, max: 240, style: 'width:6em' }), hostWait: field('number', s.hostWaitMin, { min: 1, max: 240, style: 'width:6em' }),
    shutdown: h('input', { type: 'checkbox', checked: s.shutdown }),
    days: [1, 2, 3, 4, 5, 6, 0].map((d) => ({ d, box: h('input', { type: 'checkbox', checked: s.backupDays.includes(d) }) })) };
  const dayNames = (list) => [1, 2, 3, 4, 5, 6, 0].filter((d) => list.includes(d)).map((d) => WD[d]).join(', ');
  // Gäste je Host: Haken = wird gesichert. Gespeichert wird die Ausschlussliste, damit neue Gäste automatisch mitgesichert werden (wie --all).
  const picks = new Map(c.hosts.map((x) => [x.id, {
    enabled: h('input', { type: 'checkbox', checked: x.enabled }),
    boxes: [...x.guests].sort((p, q) => p.vmid - q.vmid).map((g) => ({ g, box: h('input', { type: 'checkbox', checked: x.select === 'all' ? true : x.select === 'exclude' ? !x.ids.includes(g.vmid) : x.ids.includes(g.vmid) }) })),
    unknown: x.select === 'exclude' ? x.ids.filter((id) => !x.guests.some((g) => g.vmid === id)) : [],
  }]));
  const collect = () => ({
    storage: f.storage.value.trim(), pbsHostId: f.pbs.value, backupDays: f.days.filter((x) => x.box.checked).map((x) => x.d), waitAfterBootMin: Number(f.wait.value), hostWaitMin: Number(f.hostWait.value), shutdown: f.shutdown.checked,
    hosts: Object.fromEntries(c.hosts.map((x) => { const p = picks.get(x.id); const off = [...p.boxes.filter((y) => !y.box.checked).map((y) => y.g.vmid), ...p.unknown]; return [x.id, { enabled: p.enabled.checked, select: 'exclude', ids: off }]; })),
  });
  const out = h('div', {});
  const dry = async () => {
    out.replaceChildren(h('p', { class: 'sub' }, 'Prüfe …'));
    try {
      await ctx.api('POST', '/api/backups/control', { action: 'settings', settings: collect() });
      const { plan } = await ctx.api('POST', '/api/backups/control', { action: 'dryrun' });
      out.replaceChildren(h('section', { class: 'panel' }, h('h2', {}, `Trockenlauf: so würde gesichert (Speicher „${plan.storage}“)`),
        (plan.notes ?? []).map((n) => h('div', { class: 'finding info' }, n)),
        plan.problems.length ? h('div', { class: 'finding critical' }, h('ul', { class: 'plain' }, plan.problems.map((p) => h('li', {}, p)))) : h('div', { class: 'finding ok' }, 'Keine Probleme gefunden.'),
        plan.hosts.map((x) => h('div', { class: 'form-sec' }, h('h3', {}, `${x.label}: ${x.enabled ? `${x.guests.length} Gäste${x.excluded ? `, ${x.excluded} ausgenommen` : ''}` : 'ausgeschaltet'}${x.reachable ? '' : ' (gerade nicht erreichbar)'}`),
          h('div', { class: 'sub' }, h('code', {}, x.command)), h('p', {}, x.guests.map((g) => `${g.vmid} ${g.name}`).join(', ') || '–'))),
        h('p', { class: 'sub' }, plan.shutdown ? 'Nach vollständigem Erfolg wird der PBS heruntergefahren.' : 'Der PBS bleibt nach dem Lauf an.')));
    } catch (e) { out.replaceChildren(h('div', { class: 'banner warn' }, e.message)); }
  };
  const save = () => act({ action: 'settings', settings: collect() }, 'Einstellungen gespeichert.');
  const steuern = s.mode === 'steuern';

  const status = h('section', { class: 'panel' }, h('h2', {}, 'Status'),
    h('div', { class: `finding ${steuern ? 'ok' : 'info'}` },
      h('b', {}, steuern ? 'Das Tool steuert die Backup-Läufe' : 'Das Tool beobachtet nur (der bisherige Orchestrator auf dem PBS läuft)'),
      h('div', { class: 'sub' }, steuern ? `${s.backupDays.length ? `Backup-Tage: ${dayNames(s.backupDays)}.` : 'Keine Backup-Tage gewählt: es wird nur von Hand gesichert.'} Fährt der PBS an einem Backup-Tag hoch, wartet das Tool ${s.waitAfterBootMin} min und sichert dann Host für Host. An anderen Tagen bleibt er an, ohne zu sichern. Nach dem Lauf wird der PBS nur nach vollständigem Erfolg heruntergefahren${s.shutdown ? '' : ' (ausgeschaltet: er bleibt immer an)'}.` : 'Zuerst Einstellungen und Trockenlauf prüfen. Dann auf „Das Tool steuert“ umstellen und auf dem PBS den alten Orchestrator abschalten (Cron @reboot auskommentieren).'),
      h('div', { class: 'actions' },
        steuern ? h('button', { onclick: () => act({ action: 'settings', settings: { mode: 'beobachten' } }, 'Das Tool beobachtet nur.') }, 'Zurück auf „nur beobachten“')
          : h('button', { class: 'primary', onclick: () => { if (confirm('Das Tool steuert ab jetzt die Backups. Hast du den alten Orchestrator auf dem PBS abgeschaltet?')) act({ action: 'settings', settings: { mode: 'steuern' } }, 'Das Tool steuert die Backups.'); } }, 'Das Tool steuert'),
        h('button', { onclick: () => { if (confirm('Jetzt einen Backup-Lauf starten? Der PBS muss laufen.')) act({ action: 'start' }, 'Backup-Lauf gestartet.'); } }, 'Jetzt Backup starten'),
        c.job?.phase === 'läuft' ? h('button', { onclick: () => act({ action: 'abort' }, 'Im Tool abgebrochen.') }, 'Im Tool abbrechen') : null)),
    jobBox(c.job?.phase === 'läuft' ? c.job : null, 'Aktueller Lauf', b.now), jobBox(c.job?.phase === 'läuft' ? c.last : (c.job ?? c.last), 'Letzter Lauf des Tools', b.now));

  const settings = h('section', { class: 'panel' }, h('h2', {}, 'Einstellungen'),
    h('div', { class: 'form-grid' }, h('label', { class: 'f' }, 'PBS-Host (wird heruntergefahren)', f.pbs), h('label', { class: 'f' }, 'Speicher auf den Hosts', f.storage),
      h('label', { class: 'f' }, 'Wartezeit nach dem Hochfahren des PBS (Minuten)', f.wait), h('label', { class: 'f' }, 'Höchstens so lange auf einen Host oder Speicher warten (Minuten)', f.hostWait)),
    h('p', {}, h('label', {}, f.shutdown, ' PBS nach vollständigem Erfolg herunterfahren')),
    h('div', { class: 'f' }, h('span', {}, 'Backup-Tage: An diesen Tagen sichert das Tool automatisch, wenn der PBS hochfährt. An anderen Tagen bleibt der PBS an, ohne zu sichern.'),
      h('div', { class: 'checks big' }, f.days.map(({ d, box }) => h('label', {}, box, ` ${WD[d]}`)))),
    c.lastSkip ? h('p', { class: 'sub' }, `Zuletzt ohne Backup hochgefahren (kein Backup-Tag): ${fmtDT(c.lastSkip)}.`) : null,
    !c.pbs.rightShutdown ? h('p', { class: 'sub bad' }, `Auf ${c.pbs.label} ist das Recht „Herunterfahren“ nicht freigegeben (Reiter Hosts einrichten).`) : null);

  // Auswahl der Gäste: ein Host nach dem anderen, ohne die Haken der anderen zu verlieren
  let curHost = c.hosts.some((x) => x.id === ui.tabs['bk-lauf-host']) ? ui.tabs['bk-lauf-host'] : c.hosts[0]?.id;
  const pickArea = h('div', {});
  const count = (id) => { const p = picks.get(id); return p.enabled.checked ? `${p.boxes.filter((y) => y.box.checked).length}/${p.boxes.length}` : 'aus'; };
  const segBtns = c.hosts.map((x) => h('button', { type: 'button', onclick: () => { curHost = x.id; ui.tabs['bk-lauf-host'] = x.id; drawPicks(); } }));
  const drawPicks = () => {
    c.hosts.forEach((x, i) => { segBtns[i].setAttribute('aria-pressed', String(x.id === curHost)); segBtns[i].replaceChildren(`${c.hosts.indexOf(x) + 1}. ${x.label} (${count(x.id)})`); });
    const x = c.hosts.find((y) => y.id === curHost); if (!x) { pickArea.replaceChildren(h('p', { class: 'sub' }, 'Keine Hosts.')); return; }
    const p = picks.get(x.id);
    const all = (on) => { p.boxes.forEach((y) => { y.box.checked = on; }); markEdit(); drawPicks(); };
    pickArea.replaceChildren(...[
      h('p', {}, h('label', {}, p.enabled, ` ${x.label} beim Backup-Lauf sichern`), x.right ? '' : h('span', { class: 'sub bad' }, ' · Recht „Backups starten“ fehlt auf diesem Host')),
      p.boxes.length ? h('div', { class: 'checks big' }, p.boxes.map(({ g, box }) => h('label', { class: g.status === 'running' ? '' : 'sub' }, box, ` ${g.vmid} ${g.name}${g.status === 'running' ? '' : ' (aus)'}`))) : h('p', { class: 'sub' }, 'Noch keine Gäste gelesen.'),
      p.unknown.length ? h('p', { class: 'sub' }, `Außerdem ausgeschlossen (zurzeit nicht vorhanden): ${p.unknown.join(', ')}`) : null,
      h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => all(true) }, 'Alle auswählen'), h('button', { type: 'button', onclick: () => all(false) }, 'Keine'))].filter(Boolean));
  };
  const markEdit = () => { ui.dirty = true; document.querySelector('.paused')?.removeAttribute('hidden'); };
  for (const p of picks.values()) { p.enabled.addEventListener('change', drawPicks); p.boxes.forEach((y) => y.box.addEventListener('change', () => segBtns.forEach((bt, i) => bt.replaceChildren(`${i + 1}. ${c.hosts[i].label} (${count(c.hosts[i].id)})`)))); }
  drawPicks();
  const guests = h('section', { class: 'panel' }, h('h2', {}, 'Was wird gesichert?'),
    h('p', { class: 'sub' }, 'Die Hosts werden in dieser Reihenfolge gesichert. Haken = wird gesichert. Neue Gäste werden automatisch mitgesichert, es sei denn, du nimmst den Haken heraus.'),
    c.hosts.length > 1 ? h('div', { class: 'seg hostseg', role: 'group', 'aria-label': 'Host wählen' }, segBtns) : null, pickArea);
  const actions = h('section', { class: 'panel' }, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Einstellungen und Auswahl speichern'), h('button', { onclick: dry }, 'Speichern und Trockenlauf')));
  return [status, settings, guests, actions, out];
}

function snapshotsTab(b, data) {
  const hosts = b.hosts.filter((x) => x.supported && x.autosnap?.known);
  if (!hosts.length) return h('p', { class: 'empty' }, 'Auf keinem Host wurde proxmox-autosnap gefunden.');
  return hostSwitch('bk-host', hosts.map((x) => ({ id: x.id, label: x.label, level: x.supported ? (x.autosnap?.enabled ? 'ok' : 'watch') : 'unknown' })), (id) => {
    const host = b.hosts.find((x) => x.id === id);
    if (!host.supported) return unsupported(host, data);
    return [h('section', { class: 'panel' }, h('h2', {}, `Zustand auf ${host.label}`), autosnapBox(host), snapControlBox(host, data)), planCard(host, data),
      host.autosnap?.log?.length ? fold(`snaplog-${host.id}`, 'Letzte Meldungen von autosnap', `${host.autosnap.log.length} ${host.autosnap.log.length === 1 ? 'Zeile' : 'Zeilen'}`, () => h('pre', { class: 'log' }, host.autosnap.log.join('\n'))) : null];
  });
}

// Nur Hosts mit Gästen oder Backup-Läufen (der PBS selbst hat keine). Veraltete Hosts stehen oben im Hinweis.
const withGuests = (b) => b.hosts.filter((x) => x.supported && (x.guests.length || x.tasks.length));

function guestsTab(b, data) {
  if (!withGuests(b).length) return h('p', { class: 'empty' }, 'Noch keine Gäste gelesen.');
  return hostSwitch('bk-host', withGuests(b).map((x) => ({ id: x.id, label: x.label, level: hostLevelOf(x) })), (id) => {
    const host = b.hosts.find((x) => x.id === id);
    if (!host.supported) return unsupported(host, data);
    return [runBoxes(host, b.now), h('section', { class: 'panel' }, h('h2', {}, `Gäste auf ${host.label} (${host.guests.length})`), guestsTable(host, b.now))];
  });
}

function runsTab(b, data) {
  if (!withGuests(b).length) return h('p', { class: 'empty' }, 'Noch keine Backup-Läufe gelesen.');
  return hostSwitch('bk-host', withGuests(b).map((x) => ({ id: x.id, label: x.label, level: hostLevelOf(x) })), (id) => {
    const host = b.hosts.find((x) => x.id === id);
    if (!host.supported) return unsupported(host, data);
    return [runBoxes(host, b.now), h('p', { class: 'sub' }, `Backup-Läufe auf ${host.label}, neueste zuerst. Auf eine Zeile klicken für die Gäste und das Protokoll.`), runsList(host)];
  });
}

export function backupsView(b, data) {
  if (!b) return h('p', { class: 'empty' }, 'Keine Daten. Bitte neu laden.');
  const outdated = b.hosts.filter((x) => x.reachable && !x.supported && x.gate.version != null);
  const running = b.control?.job?.phase === 'läuft';
  const { nav, cur } = subTabs('bk', [['ueberblick', 'Überblick'], ['lauf', 'Backup-Lauf', running ? 'läuft' : null], ['snapshots', 'Snapshots'], ['gaeste', 'Gäste', b.kpi.problems || null], ['laeufe', 'Backup-Läufe']]);
  const body = { ueberblick: () => overviewTab(b, data), lauf: () => laufTab(b), snapshots: () => snapshotsTab(b, data), gaeste: () => guestsTab(b, data), laeufe: () => runsTab(b, data) }[cur]();
  return [
    outdated.map((x) => h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, `Das Prüfskript auf ${x.label} ist veraltet (Version ${x.gate.version}).`), h('div', { class: 'sub' }, `Für Backups und Snapshots wird Version ${x.gate.expected} gebraucht.`)),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => ctx.openUpdate(data.hosts.find((y) => y.id === x.id)) }, 'Jetzt aktualisieren')))),
    h('div', { style: 'margin-top:14px' }, nav), body,
  ];
}
