// Backups und Snapshots: Zustand von proxmox-autosnap, Snapshot-Stand je Gast, Backup-Läufe mit Ergebnis je Gast.
// Diese Stufe beobachtet nur. Gesichert und gesnapshottet wird weiterhin von deinen Skripten.
import { h, fmtDT, fmtMin, pill, ctx } from './dom.js';

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
const kpi = (label, value, sub, cls = '') => h('div', { class: `kpi ${cls}` }, h('div', { class: 'k' }, label), h('div', { class: 'v' }, value), sub ? h('div', { class: 's' }, sub) : null);
const resultPill = (r) => { const [c, t] = RES[r] ?? ['unknown', r]; return h('span', { class: `pill ${c}` }, t); };

function snapCell(s, now, keep) {
  if (!s.count) return h('span', { class: 'sub' }, '–');
  return h('span', {}, `${s.count}${keep ? ` / ${keep}` : ''}`, h('span', { class: 'sub' }, ` · neuester ${ago(new Date(s.newest).toISOString(), now)}`));
}

function hostPanel(b, host, data) {
  const as = host.autosnap, now = b.now;
  const head = h('div', { class: 'host-head' }, h('h2', {}, host.label), h('span', { class: 'state' }, host.reachable ? 'erreichbar' : 'nicht erreichbar'), h('span', { class: 'spacer' }));
  if (!host.supported) {
    const hostObj = data.hosts.find((x) => x.id === host.id);
    return h('section', { class: 'panel' }, head, h('p', { class: 'sub' }, host.gate.version == null ? 'Noch keine Daten.' : `Das Prüfskript auf diesem Host hat Version ${host.gate.version}. Für Backups und Snapshots wird Version ${host.gate.expected} gebraucht.`),
      host.reachable && hostObj ? h('button', { class: 'primary', onclick: () => ctx.openUpdate(hostObj) }, 'Prüfskript aktualisieren') : null);
  }
  const asBox = as ? h('div', { class: 'finding ' + (as.enabled ? 'ok' : 'watch') },
    h('b', {}, `Snapshots (proxmox-autosnap): ${as.known ? (as.enabled ? 'AN' : 'AUS') : 'nicht gefunden'}`),
    as.known ? h('div', {}, [
      as.keep && Object.keys(as.keep).length ? `Aufbewahrung: stündlich ${as.keep.hourly ?? '?'}, wöchentlich ${as.keep.weekly ?? '?'}, monatlich ${as.keep.monthly ?? '?'}. ` : '',
      as.pauseDay != null ? `Pause: ${WD[as.pauseDay % 7]}${as.pauseToday ? ' (heute, es werden keine Snapshots angelegt)' : ''}. ` : '', `Auswahl: Gäste mit dem Tag „${as.tag}“. `,
      as.cron.length ? `Zeitplan: ${as.cron.map((c) => c.text).join('; ')}.` : ''].join('')) : h('div', { class: 'sub' }, 'Auf diesem Host wurde /usr/local/sbin/autosnap-run nicht gefunden.'),
    as.log?.length ? h('details', {}, h('summary', {}, `Letzte Meldungen (${as.log.length})`), h('pre', { class: 'log' }, as.log.join('\n'))) : null) : null;

  const sc = host.snapControl;
  const LBL = { hourly: 'stündlich', weekly: 'wöchentlich', monthly: 'monatlich' };
  const post = (body, okText) => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/snapshots`, body), okText);
  const hostObj = data.hosts.find((x) => x.id === host.id);
  const ctlBox = !as?.known || !sc ? null : !sc.allowed
    ? h('div', { class: 'finding info' }, h('b', {}, 'Snapshot-Auslösung durch das Tool: noch nicht freigegeben'),
        h('div', { class: 'sub' }, 'Heute löst der Cron auf dem Host die Snapshots aus. Wenn das Tool das übernehmen soll, braucht es ein zusätzliches Recht auf diesem Host. Das gibst du mit dem root-Passwort frei (Reiter „Hosts einrichten“, „Skript aktualisieren“, Haken „Snapshots auslösen erlauben“). Das Prüfskript muss dafür Version 6 haben.'),
        hostObj ? h('div', { class: 'actions' }, h('button', { onclick: () => ctx.openUpdate(hostObj) }, 'Recht freigeben')) : null)
    : h('div', { class: `finding ${sc.mode === 'tool' ? 'ok' : 'info'}` },
        h('b', {}, sc.mode === 'tool' ? 'Das Tool löst die Snapshots aus (Cron auf dem Host ist aus)' : 'Die Snapshots löst der Cron auf dem Host aus'),
        sc.cronStillActive ? h('div', { class: 'sub bad' }, 'Achtung: Auf dem Host ist laut letzter Abfrage noch ein Cron-Eintrag aktiv, es können doppelte Snapshots entstehen. „Cron jetzt ausschalten“ versucht es erneut. Hilft das nicht, steht der Eintrag woanders (z. B. im crontab von root).') : null,
        sc.mode === 'tool' ? h('div', { class: 'sub' }, ['hourly', 'weekly', 'monthly'].map((k) => `${LBL[k]}: zuletzt ${sc.last[k] ? `${fmtDT(sc.last[k].ts)}${sc.last[k].ok ? '' : ' (Fehler)'}` : 'noch nie durch das Tool'}, nächster ${fmtDT(sc.next[k])}`).join(' · ')) : h('div', { class: 'sub' }, 'Wenn das Tool übernimmt, wird der Cron auf dem Host ausgeschaltet (umbenannt, nicht gelöscht). Verpasste wöchentliche und monatliche Läufe holt das Tool nach, sobald der Host läuft. Aufbewahrung, Auswahl der Gäste und das Löschen alter Snapshots regelt weiter das autosnap-Skript.'),
        Object.values(sc.last).some((x) => !x.ok) ? h('div', { class: 'sub bad' }, `Letzter Fehler: ${Object.values(sc.last).find((x) => !x.ok).text}`) : null,
        h('div', { class: 'actions' },
          sc.cronStillActive ? h('button', { class: 'primary', onclick: () => post({ action: 'mode', mode: 'tool' }, 'Cron ausgeschaltet.') }, 'Cron jetzt ausschalten') : null,
          sc.mode === 'tool' ? h('button', { onclick: () => { if (confirm('Wieder den Cron auf dem Host verwenden?')) post({ action: 'mode', mode: 'cron' }, 'Cron auf dem Host ist wieder aktiv.'); } }, 'Zurück zum Cron')
            : h('button', { class: 'primary', onclick: () => { if (confirm('Das Tool löst die Snapshots künftig aus und schaltet den Cron auf dem Host aus. Fortfahren?')) post({ action: 'mode', mode: 'tool' }, 'Das Tool löst die Snapshots jetzt aus.'); } }, 'Das Tool übernimmt'),
          h('button', { onclick: () => post({ action: 'switch', on: !as.enabled }, as.enabled ? 'Snapshots ausgeschaltet.' : 'Snapshots eingeschaltet.') }, as.enabled ? 'Snapshots ausschalten' : 'Snapshots einschalten'),
          h('button', { onclick: () => { if (confirm('Jetzt einen stündlichen Snapshot-Lauf auslösen?')) post({ action: 'run', label: 'hourly' }, 'Lauf ausgelöst.'); } }, 'Jetzt stündlichen Lauf auslösen')));

  const run = host.runningJob;
  const runBox = run ? h('div', { class: 'finding ok' }, h('b', {}, `Ein Backup-Lauf läuft gerade (gestartet ${fmtDT(run.start)}, ${ago(run.start, now)}).`), h('div', { class: 'sub' }, 'Die Ergebnisse dieses Laufs erscheinen hier, sobald er beendet ist. Die roten Hinweise unten stammen aus dem davor beendeten Lauf.')) : null;
  const lr = host.lastRun;
  const lrBox = lr && lr.summary.failed > 0 ? h('div', { class: 'finding critical' },
    h('b', {}, `Der letzte beendete Backup-Lauf (${fmtDT(lr.start)}, ${lr.minutes != null ? fmtMin(lr.minutes) : '–'}) hat ${lr.summary.failed} von ${lr.summary.total} Gästen nicht gesichert.`),
    lr.summary.cause === 'verbindung'
      ? h('div', {}, 'Ursache laut Protokoll: Die Verbindung zum PBS fehlte oder brach ab („connect“, „broken pipe“). Das passiert, wenn der PBS aus ist oder während des Laufs heruntergefahren wird. ',
        lr.minutes != null && lr.summary.total > 0 && lr.minutes < lr.summary.total * 0.5 ? `Der Lauf dauerte nur ${fmtMin(lr.minutes)} für ${lr.summary.total} Gäste, das ist auffällig kurz. ` : '', 'Prüfe, wann der PBS in dieser Zeit an- und ausgegangen ist.')
      : h('div', {}, 'Die Gründe stehen unten bei den einzelnen Gästen und im Protokoll des Laufs.')) : null;

  const keep = as?.keep ?? {};
  const rows = [...host.guests].sort((a, c) => ['replace', 'watch', 'info', 'ok'].indexOf(a.level) - ['replace', 'watch', 'info', 'ok'].indexOf(c.level) || a.vmid - c.vmid).map((g) => h('tr', {},
    h('td', {}, g.vmid), h('td', {}, h('div', { class: 'model' }, g.name), h('div', { class: 'sub' }, `${g.type === 'lxc' ? 'LXC' : 'VM'} · ${g.status === 'running' ? 'läuft' : g.status === 'stopped' ? 'gestoppt' : g.status}`)),
    h('td', {}, g.tagged ? [h('div', {}, 'Std. ', snapCell(g.snapshots.hourly, now, keep.hourly)), h('div', {}, 'Woche ', snapCell(g.snapshots.weekly, now, keep.weekly)), h('div', {}, 'Monat ', snapCell(g.snapshots.monthly, now, keep.monthly))] : h('span', { class: 'sub' }, 'kein Snapshot-Tag')),
    h('td', {}, g.backup ? h('div', {}, resultPill(g.backup.result), h('div', { class: 'sub' }, `${ago(g.backup.at, now)}${g.backup.seconds ? ` · ${fmtMin(Math.max(1, Math.round(g.backup.seconds / 60)))}` : ''}`)) : h('span', { class: 'sub' }, '–')),
    h('td', {}, g.findings.length ? g.findings.map((f) => h('div', { class: `sub ${f.level === 'replace' ? 'bad' : ''}` }, f.text)) : h('span', { class: 'okmsg' }, '✔'))));

  const runs = host.tasks.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Start', 'Dauer', 'Ergebnis', 'Gäste', 'Einzelheiten'].map((t) => h('th', {}, t)))),
    h('tbody', {}, host.tasks.map((t) => h('tr', {}, h('td', {}, fmtDT(t.start)), h('td', {}, t.minutes != null ? fmtMin(t.minutes) : (t.running ? 'läuft' : '–')),
      h('td', {}, t.status ? h('span', { class: `pill ${t.status === 'OK' ? 'ok' : /warn/i.test(t.status) ? 'watch' : 'critical'}` }, t.status === 'OK' ? 'in Ordnung' : t.status) : h('span', { class: 'pill unknown' }, 'läuft')),
      h('td', {}, t.parsed ? [`${t.ok} gesichert${t.failed ? `, ${t.failed} fehlgeschlagen` : ''}${t.interrupted ? `, ${t.interrupted} unterbrochen` : ''}`, t.summary.cause === 'verbindung' ? h('div', { class: 'sub bad' }, 'Verbindung zum PBS') : null] : h('span', { class: 'sub' }, t.running ? 'läuft …' : 'Protokoll wird gelesen …')),
      h('td', {}, t.guests.length ? h('details', {}, h('summary', {}, `${t.guests.length} Gäste`), h('ul', { class: 'plain' }, t.guests.map((x) => h('li', {}, resultPill(x.result), ` ${x.vmid} ${x.name ?? ''}`, x.seconds ? h('span', { class: 'sub' }, ` · ${fmtMin(Math.max(1, Math.round(x.seconds / 60)))}`) : '', x.note ? h('div', { class: 'sub bad' }, x.note) : null, x.detail ? h('details', {}, h('summary', {}, 'Protokollzeilen'), h('pre', { class: 'log' }, x.detail.replace(/ \| /g, '\n'))) : null)))) : '')))))) : h('p', { class: 'sub' }, 'Noch keine Backup-Läufe auf diesem Host gelesen. Die Aufgabenliste von Proxmox reicht einige Wochen zurück.');

  return h('section', { class: 'panel' }, head, runBox, lrBox, asBox, ctlBox,
    h('h3', {}, `Gäste (${host.guests.length})`), host.guests.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Gast', 'Snapshots (vorhanden / vorgesehen)', 'Letztes Backup', 'Hinweise'].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('p', { class: 'sub' }, 'Keine Gäste gelesen.'),
    h('h3', {}, 'Backup-Läufe'), runs);
}

export function backupsView(b, data) {
  if (!b) return h('p', { class: 'empty' }, 'Keine Daten. Bitte neu laden.');
  const k = b.kpi, last = b.lastRun;
  const outdated = b.hosts.filter((x) => x.reachable && !x.supported && x.gate.version != null);
  const kpis = h('div', { class: 'kpis' },
    kpi('Letzter Backup-Lauf', last ? ago(last.start, b.now) : '–', last ? `${last.hostLabel}: ${last.status === 'OK' ? 'in Ordnung' : last.status ?? 'läuft'}` : 'noch keiner gelesen', last && last.status !== 'OK' && last.status ? 'bad' : last ? 'ok' : ''),
    kpi('Backup-Läufe (30 Tage)', k.runs30, 'auf allen Hosts'), kpi('Fehlgeschlagene Backups', k.failedBackups, k.failedBackups ? (k.failedCause === 'verbindung' ? 'meist: Verbindung zum PBS (siehe Lauf)' : 'beim letzten Lauf des Gastes') : 'keine', k.failedBackups ? 'bad' : 'ok'),
    kpi('Snapshots', k.snapshotsOff ? `${k.snapshotsOn} an, ${k.snapshotsOff} aus` : `${k.snapshotsOn} Hosts an`, 'Schalter von proxmox-autosnap', k.snapshotsOff ? 'watch' : 'ok'),
    kpi('Gäste mit Hinweis', k.problems, `von ${k.guests} Gästen`, k.problems ? 'watch' : 'ok'));
  return [
    h('section', { class: 'panel' }, h('h2', {}, 'Backups und Snapshots'), h('p', { class: 'sub' }, 'Diese Ansicht beobachtet nur. Gesichert und gesnapshottet wird weiterhin von deinen Skripten (Orchestrator auf dem PBS, proxmox-autosnap auf den Hosts). Die Steuerung kommt in späteren Stufen.')),
    outdated.map((x) => h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, `Das Prüfskript auf ${x.label} ist veraltet (Version ${x.gate.version}).`), h('div', { class: 'sub' }, `Für die Anzeige von Backups und Snapshots wird Version ${x.gate.expected} gebraucht.`)),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => ctx.openUpdate(data.hosts.find((y) => y.id === x.id)) }, 'Jetzt aktualisieren')))),
    kpis, b.hosts.map((x) => hostPanel(b, x, data)),
  ];
}
