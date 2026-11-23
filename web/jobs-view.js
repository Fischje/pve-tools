// Übersicht „Läuft gerade“: alle laufenden Jobs kompakt in einer Liste (Backup-Lauf, Backups auf den Hosts, Snapshots, Plattentests).
// Jede Zeile ist anklickbar und führt zu den Einzelheiten. Läuft nichts, steht dort, was als Nächstes geplant ist.
import { h, ctx, fmtDT, fmtMin, RUN_LABEL, WD } from './dom.js';

const SNAP_DE = { hourly: 'stündlich', daily: 'täglich', weekly: 'wöchentlich', monthly: 'monatlich' };
const JOB_DE = { wartet: 'wartet', läuft: 'läuft', ok: 'fertig', fehler: 'Fehler', fehlt: 'nicht erreicht', übersprungen: 'übersprungen' };

const minutesSince = (iso, now) => (iso ? Math.max(0, Math.round((now - Date.parse(iso)) / 60000)) : null);
const hhmm = (d) => d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

/** Ein Eintrag: Punkt, Titel, Einzelheiten, optional Fortschritt; Klick führt zum Ziel. */
function row({ kind, title, detail, progress = null, go }) {
  return h('button', { type: 'button', class: `job-row job-${kind}`, title: 'Einzelheiten anzeigen', onclick: () => ctx.nav?.(go) },
    h('span', { class: 'run-dot', 'aria-hidden': 'true' }),
    h('span', { class: 'job-t' }, h('b', {}, title), detail ? h('span', { class: 'sub' }, detail) : null),
    progress != null ? h('span', { class: 'job-p', 'aria-label': `${progress} %` }, h('span', { class: 'meter' }, h('span', { class: 'job-bar', 'data-p': progress })), h('span', { class: 'sub' }, `${progress} %`)) : null,
    h('span', { class: 'go', 'aria-hidden': 'true' }, '›'));
}

/** Nächster geplanter Backup-Tag (Weckzeit) als Date, sonst null. */
export function nextBackupAt(settings, now) {
  const days = settings?.backupDays ?? [];
  if (!days.length) return null;
  const [hh, mm] = String(settings.wakeTime ?? '08:00').split(':').map(Number);
  for (let i = 0; i < 8; i++) {
    const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(hh, mm, 0, 0);
    if (days.includes(d.getDay()) && d > now) return d;
  }
  return null;
}

/** Alle laufenden Jobs aus den geladenen Daten zusammenstellen (ohne DOM, damit testbar). */
export function collectJobs({ data, tests, backups }) {
  const now = Date.parse(backups?.now ?? data?.now ?? new Date().toISOString());
  const label = (id) => data?.hosts.find((x) => x.id === id)?.label ?? backups?.hosts.find((x) => x.id === id)?.label ?? id;
  const jobs = [];
  const job = backups?.control?.job;
  const inJob = new Set();
  if (job?.phase === 'läuft') {
    const active = job.hosts.find((x) => x.state === 'läuft');
    job.hosts.forEach((x) => inJob.add(x.id));
    const done = job.hosts.filter((x) => !['wartet', 'läuft'].includes(x.state)).length;
    jobs.push({ kind: 'backup', title: `Backup-Lauf${job.manual ? ' (von Hand)' : ' (geplant)'}`,
      detail: [active ? `${label(active.id)} sichert gerade` : 'wartet auf den PBS bzw. die Hosts', job.hosts.map((x) => `${label(x.id)}: ${JOB_DE[x.state] ?? x.state}`).join(' · '), `seit ${fmtMin(minutesSince(job.startedAt, now))}`].join(' · '),
      progress: job.hosts.length > 1 ? Math.round((done / job.hosts.length) * 100) : null, go: { view: 'backups', tabs: { bk: 'lauf' } } });
  }
  for (const host of backups?.hosts ?? []) {
    const r = host.runningJob;
    if (r && !(inJob.has(host.id) && job?.hosts.find((x) => x.id === host.id)?.state === 'läuft')) {
      jobs.push({ kind: 'backup', title: `Backup auf ${host.label}`, detail: `gestartet ${fmtDT(r.start)} · läuft seit ${fmtMin(minutesSince(r.start, now))}${r.job ? ' · Proxmox-Job' : ''}`,
        go: { view: 'backups', tabs: { bk: 'laeufe', 'bk-host': host.id } } });
    }
    if (host.snapRunning) {
      jobs.push({ kind: 'snap', title: `Snapshots auf ${host.label}`, detail: `${SNAP_DE[host.snapRunning.label] ?? host.snapRunning.label}${host.snapRunning.manual ? ', von Hand' : ''} · seit ${hhmm(new Date(host.snapRunning.since))}`,
        go: { view: 'backups', tabs: { bk: 'snapshots', 'bk-host': host.id } } });
    }
  }
  for (const t of tests?.running ?? []) {
    const progress = t.remainingPercent != null ? 100 - t.remainingPercent : null;
    jobs.push({ kind: 'test', title: `${RUN_LABEL[t.kind] ?? 'Test'} auf ${t.model ?? t.serial}`,
      detail: `${label(t.hostId)} · ${String(t.device ?? '').replace('/dev/', '')}${t.started ? ` · seit ${fmtMin(minutesSince(t.started, now))}` : ' · direkt auf dem Host gestartet'}`,
      progress, go: { view: 'host', hostId: t.hostId, hostTab: 'disks', focus: t.serial } });
  }
  // Als Nächstes geplant (nur, was das Tool selbst auslöst)
  const next = [];
  const bk = backups?.control?.job?.phase === 'läuft' ? null : nextBackupAt(backups?.control?.settings, new Date(now));
  if (bk) next.push({ text: `Backup-Lauf ${WD[bk.getDay()].slice(0, 2)}, ${bk.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })} ${hhmm(bk)}`, go: { view: 'backups', tabs: { bk: 'lauf' } } });
  for (const host of backups?.hosts ?? []) {
    const sc = host.snapControl;
    if (sc?.mode !== 'tool' || host.snapRunning) continue;
    const ts = Object.values(sc.next ?? {}).filter(Boolean).map((x) => Date.parse(x)).filter((x) => x > now).sort((a, b) => a - b)[0];
    if (ts) next.push({ text: `Snapshots ${host.label} ${new Date(ts).toDateString() === new Date(now).toDateString() ? hhmm(new Date(ts)) : fmtDT(new Date(ts).toISOString())}`, go: { view: 'backups', tabs: { bk: 'snapshots', 'bk-host': host.id } } });
  }
  return { jobs, next };
}

export function jobsPanel(src) {
  const { jobs, next } = collectJobs(src);
  const nextEl = next.length ? h('p', { class: 'sub job-next' }, jobs.length ? 'Danach geplant: ' : 'Gerade läuft nichts. Als Nächstes: ',
    next.map((n, i) => [i ? ' · ' : '', h('button', { type: 'button', class: 'linkish', onclick: () => ctx.nav?.(n.go) }, n.text)])) : jobs.length ? null : h('p', { class: 'sub job-next' }, 'Gerade läuft nichts.');
  const list = jobs.length ? h('div', { class: 'job-list' }, jobs.map(row)) : null;
  // Fortschrittsbalken ohne style-Attribut setzen (CSP)
  if (list) list.querySelectorAll('.job-bar').forEach((el) => { el.style.width = `${Math.max(0, Math.min(100, Number(el.dataset.p)))}%`; });
  return h('section', { class: `panel jobs${jobs.length ? ' busy' : ''}`, id: 'jobs' },
    h('div', { class: 'card-title' }, h('h2', {}, 'Läuft gerade'), jobs.length ? h('span', { class: 'badge' }, jobs.length) : null), list, nextEl);
}
