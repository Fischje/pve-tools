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

  // Planung: Zeitpunkte (gelten, wenn das Tool auslöst) und Aufbewahrung/Pausentag (stehen auf dem Host im verwalteten Wrapper)
  const planBox = !sc?.allowed || !as?.known ? null : (() => {
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
    return h('details', { class: 'panel2' }, h('summary', {}, 'Planung ändern'),
      h('p', { class: 'sub' }, sc.mode === 'tool' ? 'Die Zeitpunkte gelten für die Läufe, die das Tool auslöst.' : 'Achtung: Solange der Cron auf dem Host auslöst, gelten dessen Zeiten. Die Zeitpunkte hier wirken erst, wenn das Tool übernimmt. Aufbewahrung und Pausentag gelten immer.'),
      h('div', { class: 'f' }, h('span', {}, 'Zeitpunkte'),
        h('div', { class: 'row' }, h('label', {}, f.hourly, ' stündlich, jeweils zur Minute '), f.hourlyMinute),
        h('div', { class: 'row' }, h('label', {}, f.weekly, ' wöchentlich, '), f.weeklyDay, ' um ', f.weeklyTime),
        h('div', { class: 'row' }, h('label', {}, f.monthly, ' monatlich, am Tag '), f.monthlyDay, ' um ', f.monthlyTime, h('span', { class: 'sub' }, ' (fällt er auf den Pausentag, am Folgetag)'))),
      sc.managed
        ? h('div', { class: 'f' }, h('span', {}, 'Aufbewahrung (so viele Snapshots bleiben je Gast) und Pausentag'),
            h('div', { class: 'row' }, 'stündlich ', f.kh, ' wöchentlich ', f.kw, ' monatlich ', f.km), h('div', { class: 'row' }, 'Pausentag ', f.pause))
        : h('div', { class: 'finding info' }, h('div', { class: 'sub' }, 'Aufbewahrung und Pausentag stehen bei diesem Host noch fest im Wrapper. Zum Ändern: „Skript aktualisieren“ mit Haken „Snapshots auslösen erlauben“. Das installiert den verwalteten Wrapper (der alte bleibt als Sicherung erhalten, seine Werte werden übernommen).'),
            hostObj ? h('div', { class: 'actions' }, h('button', { onclick: () => ctx.openUpdate(hostObj) }, 'Wrapper installieren')) : null),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Speichern'), sc.managed ? [h('span', { class: 'spacer' }), 'Probelauf ohne Wirkung: ', f.label, h('button', { onclick: dry }, 'Probelauf')] : null), out);
  })();

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

  return h('section', { class: 'panel' }, head, runBox, lrBox, asBox, ctlBox, planBox,
    h('h3', {}, `Gäste (${host.guests.length})`), host.guests.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['ID', 'Gast', 'Snapshots (vorhanden / vorgesehen)', 'Letztes Backup', 'Hinweise'].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('p', { class: 'sub' }, 'Keine Gäste gelesen.'),
    h('h3', {}, 'Backup-Läufe'), runs);
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

function controlPanel(b, data) {
  const c = b.control; if (!c) return null;
  const s = c.settings, act = (body, okText) => ctx.act(() => ctx.api('POST', '/api/backups/control', body), okText);
  const field = (type, v, extra = {}) => h('input', { type, value: v, ...extra });
  const f = { pbs: h('select', {}, c.hostChoices.map((x) => h('option', { value: x.id, selected: x.id === s.pbsHostId }, x.label))), storage: field('text', s.storage, { size: 10 }),
    wait: field('number', s.waitAfterBootMin, { min: 0, max: 240, style: 'width:5em' }), hostWait: field('number', s.hostWaitMin, { min: 1, max: 240, style: 'width:5em' }),
    shutdown: h('input', { type: 'checkbox', checked: s.shutdown }) };
  // Gäste je Host: Haken = wird gesichert. Gespeichert wird die Ausschlussliste, damit neue Gäste automatisch mitgesichert werden (wie --all).
  const picks = new Map(c.hosts.map((x) => [x.id, {
    enabled: h('input', { type: 'checkbox', checked: x.enabled }),
    boxes: x.guests.sort((p, q) => p.vmid - q.vmid).map((g) => ({ g, box: h('input', { type: 'checkbox', checked: x.select === 'all' ? true : x.select === 'exclude' ? !x.ids.includes(g.vmid) : x.ids.includes(g.vmid) }) })),
    unknown: x.select === 'exclude' ? x.ids.filter((id) => !x.guests.some((g) => g.vmid === id)) : [],
  }]));
  const collect = () => ({
    storage: f.storage.value.trim(), pbsHostId: f.pbs.value, waitAfterBootMin: Number(f.wait.value), hostWaitMin: Number(f.hostWait.value), shutdown: f.shutdown.checked,
    hosts: Object.fromEntries(c.hosts.map((x) => { const p = picks.get(x.id); const off = [...p.boxes.filter((y) => !y.box.checked).map((y) => y.g.vmid), ...p.unknown]; return [x.id, { enabled: p.enabled.checked, select: 'exclude', ids: off }]; })),
  });
  const out = h('div', { hidden: true });
  const dry = async () => {
    out.hidden = false; out.replaceChildren(h('p', { class: 'sub' }, 'Prüfe …'));
    try {
      await ctx.api('POST', '/api/backups/control', { action: 'settings', settings: collect() });
      const { plan } = await ctx.api('POST', '/api/backups/control', { action: 'dryrun' });
      out.replaceChildren(h('div', { class: 'finding info' }, h('b', {}, `Trockenlauf: so würde gesichert (Speicher „${plan.storage}“)`),
        plan.problems.length ? h('ul', { class: 'plain bad' }, plan.problems.map((p) => h('li', {}, `✖ ${p}`))) : h('div', { class: 'sub' }, '✔ Keine Probleme gefunden.'),
        plan.hosts.map((x) => h('details', {}, h('summary', {}, `${x.label}: ${x.enabled ? `${x.guests.length} Gäste${x.excluded ? `, ${x.excluded} ausgenommen` : ''}` : 'ausgeschaltet'}${x.reachable ? '' : ' (nicht erreichbar)'}`),
          h('div', { class: 'sub' }, h('code', {}, x.command)), h('div', {}, x.guests.map((g) => `${g.vmid} ${g.name}`).join(', ') || '–'))),
        h('div', { class: 'sub' }, plan.shutdown ? 'Nach vollständigem Erfolg wird der PBS heruntergefahren.' : 'Der PBS bleibt nach dem Lauf an.')));
    } catch (e) { out.replaceChildren(h('p', { class: 'error' }, e.message)); }
  };
  const save = () => act({ action: 'settings', settings: collect() }, 'Einstellungen gespeichert.');
  const steuern = s.mode === 'steuern';
  const hostBlocks = c.hosts.map((x) => { const p = picks.get(x.id); return h('details', {}, h('summary', {}, h('label', {}, p.enabled, ` ${x.label}`), h('span', { class: 'sub' }, ` – ${p.boxes.filter((y) => y.box.checked).length} von ${p.boxes.length} Gästen werden gesichert${x.right ? '' : ' · Recht „Backups starten“ fehlt'}`)),
    h('div', { class: 'checks' }, p.boxes.map(({ g, box }) => h('label', { class: g.status === 'running' ? '' : 'sub' }, box, ` ${g.vmid} ${g.name}${g.status === 'running' ? '' : ' (aus)'}`)))); });
  return h('section', { class: 'panel' }, h('h2', {}, 'Backup-Lauf'),
    h('div', { class: `finding ${steuern ? 'ok' : 'info'}` },
      h('b', {}, steuern ? 'Das Tool steuert die Backup-Läufe' : 'Das Tool beobachtet nur (der bisherige Orchestrator auf dem PBS läuft)'),
      h('div', { class: 'sub' }, steuern ? `Nach dem Hochfahren des PBS (${c.pbs.label}) wartet das Tool ${s.waitAfterBootMin} min und sichert dann host für host. Der PBS wird nur nach vollständigem Erfolg heruntergefahren${s.shutdown ? '' : ' (ausgeschaltet: er bleibt immer an)'}. Den alten Orchestrator bitte auf dem PBS abschalten (Cron @reboot), sonst laufen zwei Steuerungen.` : 'Zuerst Einstellungen und Trockenlauf prüfen. Dann die Betriebsart auf „Das Tool steuert“ stellen und auf dem PBS den alten Orchestrator abschalten (Cron @reboot auskommentieren).'),
      h('div', { class: 'actions' },
        steuern ? h('button', { onclick: () => act({ action: 'settings', settings: { mode: 'beobachten' } }, 'Das Tool beobachtet nur.') }, 'Zurück auf „nur beobachten“')
          : h('button', { class: 'primary', onclick: () => { if (confirm('Das Tool steuert ab jetzt die Backups. Hast du den alten Orchestrator auf dem PBS abgeschaltet?')) act({ action: 'settings', settings: { mode: 'steuern' } }, 'Das Tool steuert die Backups.'); } }, 'Das Tool steuert'),
        h('button', { onclick: () => { if (confirm('Jetzt einen Backup-Lauf starten? Der PBS muss laufen.')) act({ action: 'start' }, 'Backup-Lauf gestartet.'); } }, 'Jetzt Backup starten'),
        b.control.job?.phase === 'läuft' ? h('button', { onclick: () => act({ action: 'abort' }, 'Im Tool abgebrochen.') }, 'Im Tool abbrechen') : null)),
    jobBox(c.job?.phase === 'läuft' ? c.job : null, 'Aktueller Lauf', b.now), jobBox(c.job?.phase === 'läuft' ? c.last : (c.job ?? c.last), 'Letzter Lauf des Tools', b.now),
    h('details', {}, h('summary', {}, 'Einstellungen und Auswahl der Gäste'),
      h('div', { class: 'form-grid panel2' }, h('label', { class: 'f' }, 'PBS-Host (wird heruntergefahren)', f.pbs), h('label', { class: 'f' }, 'Speicher auf den Hosts', f.storage),
        h('label', { class: 'f' }, 'Wartezeit nach dem Hochfahren (Minuten)', f.wait), h('label', { class: 'f' }, 'Höchstens so lange auf einen Host/Speicher warten (Minuten)', f.hostWait)),
      h('label', {}, f.shutdown, ' PBS nach vollständigem Erfolg herunterfahren'),
      !c.pbs.rightShutdown ? h('p', { class: 'sub bad' }, `Auf ${c.pbs.label} ist das Recht „Herunterfahren“ nicht freigegeben (Reiter Hosts einrichten).`) : null,
      h('h3', {}, 'Was wird gesichert? (Reihenfolge von oben nach unten)'),
      h('p', { class: 'sub' }, 'Haken = wird gesichert. Neue Gäste werden automatisch mitgesichert, es sei denn, du nimmst den Haken heraus.'), hostBlocks,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Speichern'), h('button', { onclick: dry }, 'Speichern und Trockenlauf'))), out);
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
    h('section', { class: 'panel' }, h('h2', {}, 'Backups und Snapshots'), h('p', { class: 'sub' }, 'Gäste, Snapshot-Stand und Backup-Läufe der Hosts. Snapshots und Backup-Läufe kann das Tool auch selbst steuern (siehe unten und „Planung ändern“ je Host).')),
    outdated.map((x) => h('div', { class: 'banner warn' }, h('div', {}, h('b', {}, `Das Prüfskript auf ${x.label} ist veraltet (Version ${x.gate.version}).`), h('div', { class: 'sub' }, `Für die Anzeige von Backups und Snapshots wird Version ${x.gate.expected} gebraucht.`)),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => ctx.openUpdate(data.hosts.find((y) => y.id === x.id)) }, 'Jetzt aktualisieren')))),
    kpis, controlPanel(b, data), b.hosts.map((x) => hostPanel(b, x, data)),
  ];
}
