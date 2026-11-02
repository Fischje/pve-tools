// Backup-Lauf durch das Tool (ersetzt das Orchestrator-Skript auf dem PBS).
//
// Ablauf: Der PBS (Host-Art „manuell“) fährt hoch. Nach der eingestellten Wartezeit startet das Tool die Backups host für host
// (vzdump als eigener Dienst auf dem Host, über das Prüfskript) und wartet über die Aufgabenliste des Hosts, bis jede Aufgabe fertig ist.
// Der PBS wird nur heruntergefahren, wenn ALLE Backups erfolgreich waren (einstellbar). Sonst bleibt er an, und es kommt eine Mail.
// Zustand und Einstellungen stehen in der Datenbank (Tabelle setting), damit ein Neustart des Tools den Lauf nicht verliert.
import { summarizeRun } from './backups.js';

const MIN = 60000;
const SETTINGS_KEY = 'backupctl', JOB_KEY = 'backupjob', LAST_KEY = 'backupjob_last', BOOT_KEY = 'backup_lastboot';
// Voreinstellung aus dem bisherigen Orchestrator (pbs-run-backups.sh): router alle, pve alle außer dieser Gäste.
const SEEDED_EXCLUDES = { pve: [109, 112, 113, 114, 116, 119, 117, 159, 161, 171] };
export const DEFAULTS = { mode: 'beobachten', pbsHostId: '', storage: 'pbs', waitAfterBootMin: 20, shutdown: true, hostWaitMin: 30, order: null, hosts: {} };

const FINAL = new Set(['ok', 'fehler', 'fehlt', 'übersprungen']);

/** Prüft Einstellungen aus der Oberfläche. Wirft bei ungültigen Werten. */
export function cleanBackupSettings(input, hostIds = []) {
  const out = {};
  const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name}: erlaubt sind ${lo} bis ${hi}`); return n; };
  if ('mode' in input) { if (!['beobachten', 'steuern'].includes(input.mode)) throw new Error('Betriebsart: ungültig'); out.mode = input.mode; }
  if ('pbsHostId' in input) { const v = String(input.pbsHostId ?? ''); if (v && !hostIds.includes(v)) throw new Error('PBS-Host unbekannt'); out.pbsHostId = v; }
  if ('storage' in input) { const v = String(input.storage ?? '').trim(); if (!/^[A-Za-z0-9_-]{1,32}$/.test(v)) throw new Error('Speicher: nur Buchstaben, Ziffern, - und _ (höchstens 32 Zeichen)'); out.storage = v; }
  if ('waitAfterBootMin' in input) out.waitAfterBootMin = int(input.waitAfterBootMin, 0, 240, 'Wartezeit nach dem Hochfahren (Minuten)');
  if ('hostWaitMin' in input) out.hostWaitMin = int(input.hostWaitMin, 1, 240, 'Wartezeit auf einen Host (Minuten)');
  if ('shutdown' in input) out.shutdown = !!input.shutdown;
  if ('order' in input) {
    if (!Array.isArray(input.order) || input.order.some((x) => !hostIds.includes(x)) || new Set(input.order).size !== input.order.length) throw new Error('Reihenfolge: ungültig');
    out.order = input.order;
  }
  if ('hosts' in input) {
    if (typeof input.hosts !== 'object' || input.hosts === null) throw new Error('Hosts: ungültig');
    out.hosts = {};
    for (const [id, c] of Object.entries(input.hosts)) {
      if (!hostIds.includes(id)) throw new Error(`Host unbekannt: ${id}`);
      const select = c?.select ?? 'exclude';
      if (!['all', 'exclude', 'only'].includes(select)) throw new Error('Auswahl: ungültig');
      const ids = (c?.ids ?? []).map(Number);
      if (ids.some((n) => !Number.isInteger(n) || n < 100 || n > 999999999) || ids.length > 64) throw new Error('Gast-IDs: nur Zahlen ab 100, höchstens 64');
      if (select === 'only' && !ids.length) throw new Error('Auswahl „nur diese“ braucht mindestens einen Gast');
      out.hosts[id] = { enabled: c?.enabled !== false, select: select === 'all' || (select === 'exclude' && !ids.length) ? 'all' : select, ids: [...new Set(ids)].sort((a, b) => a - b) };
    }
  }
  return out;
}

export class Orchestrator {
  constructor(engine) { this.engine = engine; this.busy = false; }
  get db() { return this.engine.db; }
  now() { return this.engine.now(); }
  parse(key, d) { try { return JSON.parse(this.db.getSetting(key) ?? 'null') ?? d; } catch { return d; } }

  settings() {
    const s = { ...DEFAULTS, ...this.parse(SETTINGS_KEY, {}) };
    if (!s.pbsHostId) s.pbsHostId = this.engine.hosts.find((h) => h.kind === 'manuell')?.id ?? '';
    return s;
  }
  /** Reihenfolge der zu sichernden Hosts (ohne den PBS). */
  order(s = this.settings()) {
    const ids = this.engine.hosts.map((h) => h.id).filter((id) => id !== s.pbsHostId);
    return s.order ? [...s.order.filter((id) => ids.includes(id)), ...ids.filter((id) => !s.order.includes(id))] : ids;
  }
  /** Auswahl eines Hosts: gespeichert, sonst Voreinstellung (alle bzw. die Ausschlussliste des alten Orchestrators). */
  selection(id, s = this.settings()) {
    const c = s.hosts?.[id];
    if (c) return { enabled: c.enabled !== false, select: c.select ?? 'all', ids: c.ids ?? [] };
    const ex = SEEDED_EXCLUDES[id];
    return ex ? { enabled: true, select: 'exclude', ids: ex } : { enabled: true, select: 'all', ids: [] };
  }
  save(patch) {
    const hostIds = this.engine.hosts.map((h) => h.id);
    const clean = cleanBackupSettings(patch, hostIds);
    const prev = this.settings();
    const next = { ...prev, ...clean, hosts: { ...(prev.hosts ?? {}), ...(clean.hosts ?? {}) } };
    this.db.setSetting(SETTINGS_KEY, JSON.stringify(next));
    // Beim Einschalten von „steuern“ gilt der aktuell laufende Boot des PBS als erledigt: Es startet nicht sofort ein Lauf.
    if (clean.mode === 'steuern' && prev.mode !== 'steuern') this.markCurrentBoot(next);
    if (clean.mode && clean.mode !== prev.mode) this.engine.event(null, null, clean.mode === 'steuern' ? 'Backups: das Tool steuert die Backup-Läufe' : 'Backups: das Tool beobachtet nur');
    return this.settings();
  }
  bootAt(s) {
    const hs = this.db.getHostState(s.pbsHostId);
    if (!hs?.reachable || hs.uptimeSec == null || !hs.uptimeAt) return null;
    return this.now().getTime() - (hs.uptimeSec + (this.now() - hs.uptimeAt) / 1000) * 1000;
  }
  markCurrentBoot(s) { const b = this.bootAt(s); if (b != null) this.db.setSetting(BOOT_KEY, String(Math.round(b))); }

  job() { return this.parse(JOB_KEY, null); }
  lastJob() { return this.parse(LAST_KEY, null); }
  saveJob(job) { this.db.setSetting(JOB_KEY, JSON.stringify(job)); }
  /** Läuft auf diesem Host gerade ein vom Tool gestartetes oder übernommenes Backup? (Dann keine Platten-Tests.) */
  busy(hostId) { const j = this.job(); return !!j && j.phase === 'läuft' && j.hosts.some((h) => h.id === hostId && h.state === 'läuft'); }

  /** Läuft jede Minute (aus dem Takt der Engine). */
  async tick() {
    const s = this.settings();
    if (s.mode !== 'steuern' || this.running) return;
    this.running = true;
    try {
      const job = this.job();
      if (job?.phase === 'läuft') { await this.advance(job, s); return; }
      if (!s.pbsHostId) return;
      const boot = this.bootAt(s);
      if (boot == null) return;
      const hs = this.db.getHostState(s.pbsHostId);
      const up = (hs.uptimeSec + (this.now() - hs.uptimeAt) / 1000) / 60;
      if (up < s.waitAfterBootMin) return;
      const last = Number(this.db.getSetting(BOOT_KEY) ?? 0);
      if (Math.abs(boot - last) < 10 * MIN) return; // dieser Boot wurde schon behandelt
      this.begin(s, { bootAt: Math.round(boot), manual: false });
    } catch (e) { this.engine.log(`Backup-Steuerung: ${e.stack ?? e.message}`); } finally { this.running = false; }
  }

  begin(s, { bootAt, manual }) {
    const now = this.now().getTime();
    const hosts = this.order(s).filter((id) => this.selection(id, s).enabled).map((id) => ({ id, state: 'wartet', since: now, note: '' }));
    const job = { id: `bk${now}`, startedAt: now, bootAt, manual: !!manual, phase: 'läuft', hosts, shutdown: null, endedAt: null, storage: s.storage };
    if (bootAt != null) this.db.setSetting(BOOT_KEY, String(bootAt));
    this.saveJob(job);
    this.engine.event(null, null, `Backup-Lauf gestartet${manual ? ' (von Hand)' : ''}: ${hosts.map((h) => h.id).join(' → ') || 'keine Hosts'}`);
    return job;
  }

  /** Von Hand starten (Knopf in der Oberfläche). Der PBS muss laufen. */
  async startNow() {
    const s = this.settings();
    if (this.job()?.phase === 'läuft') throw new Error('Es läuft schon ein Backup-Lauf.');
    if (!s.pbsHostId) throw new Error('Kein PBS-Host festgelegt.');
    const hs = this.db.getHostState(s.pbsHostId);
    if (!hs?.reachable) throw new Error('Der PBS ist nicht erreichbar. Bitte erst einschalten.');
    const job = this.begin(s, { bootAt: this.bootAt(s), manual: true });
    await this.advance(job, { ...s });
    return this.job();
  }
  abort() {
    const job = this.job(); if (!job || job.phase !== 'läuft') throw new Error('Es läuft kein Backup-Lauf.');
    job.phase = 'abgebrochen'; job.endedAt = this.now().getTime(); job.shutdown = 'nein';
    this.saveJob(job); this.db.setSetting(LAST_KEY, JSON.stringify(job));
    this.engine.event(null, null, 'Backup-Lauf im Tool abgebrochen. Ein schon laufendes Backup auf dem Host läuft weiter, der PBS wird nicht heruntergefahren.');
  }

  /** Einen Schritt weiter: der erste noch nicht erledigte Host. */
  async advance(job, s) {
    const now = this.now().getTime();
    const cur = job.hosts.find((h) => !FINAL.has(h.state));
    if (!cur) return this.finish(job, s);
    const host = this.engine.hosts.find((h) => h.id === cur.id);
    if (!host) { cur.state = 'fehler'; cur.note = 'Host nicht mehr in der Liste'; this.saveJob(job); return; }
    const client = this.engine.client(cur.id);
    const sel = this.selection(cur.id, s);
    try {
      if (cur.state === 'wartet') {
        const hs = this.db.getHostState(cur.id);
        const problem = !hs?.reachable ? 'Host nicht erreichbar' : !this.engine.hostRights(cur.id).includes('backup-starten') ? 'Recht „Backups starten“ fehlt' : null;
        let storageOk = false;
        if (!problem) { const st = await client.storageActive(s.storage); storageOk = st.active; if (!st.active) cur.note = `Speicher „${s.storage}“ ist nicht aktiv (PBS erreichbar?)`; }
        if (problem === 'Recht „Backups starten“ fehlt') { cur.state = 'fehler'; cur.note = problem; this.saveJob(job); return this.advance(job, s); }
        if (problem || !storageOk) {
          if (problem) cur.note = problem;
          if (now - cur.since > s.hostWaitMin * MIN) { cur.state = 'fehlt'; cur.note = `${cur.note || 'nicht bereit'} (nach ${s.hostWaitMin} min aufgegeben)`; this.engine.event(cur.id, null, `Backup übersprungen: ${cur.note}`); this.saveJob(job); return this.advance(job, s); }
          this.saveJob(job); return;
        }
        // Läuft schon ein vzdump (z. B. vom alten Orchestrator)? Dann übernehmen, nicht doppelt starten.
        const tasks = await client.backupTasks();
        const running = tasks.find((t) => t.start && !t.end && now - t.start < 36 * 3600e3);
        if (running) { Object.assign(cur, { state: 'läuft', startedAt: now, upid: running.upid, note: 'bereits laufendes Backup übernommen' }); }
        else { await client.backupStart(s.storage, sel); Object.assign(cur, { state: 'läuft', startedAt: now, note: '' }); }
        this.engine.event(cur.id, null, `Backup gestartet${running ? ' (übernommen)' : ''}`);
        this.saveJob(job); return;
      }
      if (cur.state === 'läuft') {
        const tasks = await client.backupTasks();
        const used = new Set(job.hosts.filter((h) => h !== cur && h.upid).map((h) => h.upid));
        const task = cur.upid ? tasks.find((t) => t.upid === cur.upid) : tasks.filter((t) => t.start >= cur.startedAt - 2 * MIN && !used.has(t.upid)).sort((a, b) => a.start - b.start)[0];
        if (!task) {
          if (now - cur.startedAt > 10 * MIN) { cur.state = 'fehler'; cur.note = 'Auf dem Host erschien keine Backup-Aufgabe (nach 10 min).'; this.saveJob(job); return this.advance(job, s); }
          this.saveJob(job); return;
        }
        cur.upid = task.upid;
        if (!task.end) {
          if (now - cur.startedAt > 36 * 3600e3) { cur.state = 'fehler'; cur.note = 'Läuft seit über 36 Stunden, aufgegeben.'; this.saveJob(job); return this.advance(job, s); }
          this.saveJob(job); return;
        }
        let guests = [];
        try { guests = (await client.backupTaskLog(task.upid)).guests; } catch { /* Ergebnis dann nur aus dem Status */ }
        const sum = summarizeRun(guests);
        const okStatus = task.status === 'OK' || /^WARNINGS/i.test(task.status ?? '');
        Object.assign(cur, { total: sum.total, failed: sum.failed, status: task.status, cause: sum.cause, minutes: Math.round((task.end - task.start) / MIN),
          failedGuests: guests.filter((g) => g.result === 'failed').map((g) => ({ vmid: g.vmid, note: g.note })).slice(0, 20) });
        cur.state = okStatus && sum.failed === 0 ? 'ok' : 'fehler';
        cur.note = cur.state === 'ok' ? '' : `Status „${task.status ?? '?'}“${sum.failed ? `, ${sum.failed} von ${sum.total} Gästen fehlgeschlagen` : ''}${sum.cause === 'verbindung' ? ' (Verbindung zum PBS fehlte oder brach ab)' : ''}`;
        this.engine.event(cur.id, null, cur.state === 'ok' ? `Backup fertig (${cur.minutes} min, ${sum.total} Gäste)` : `Backup nicht erfolgreich: ${cur.note}`);
        this.engine.pollBackups(cur.id, client, this.now(), true).catch(() => {});
        this.saveJob(job);
        return this.advance(job, s);
      }
    } catch (e) {
      cur.note = e.message;
      if (now - cur.since > s.hostWaitMin * MIN) { cur.state = 'fehler'; this.engine.event(cur.id, null, `Backup-Steuerung: ${e.message}`); }
      this.saveJob(job);
    }
  }

  async finish(job, s) {
    const allOk = job.hosts.length > 0 && job.hosts.every((h) => h.state === 'ok' || h.state === 'übersprungen');
    job.phase = allOk ? 'fertig' : 'fehler';
    job.endedAt = this.now().getTime();
    job.shutdown = 'nein';
    if (allOk && s.shutdown && s.pbsHostId) {
      try {
        if (!this.engine.hostRights(s.pbsHostId).includes('herunterfahren')) job.shutdown = 'fehlt-recht';
        else { await this.engine.client(s.pbsHostId).poweroff(); job.shutdown = 'angefordert'; }
      } catch (e) { job.shutdown = 'fehler'; job.shutdownNote = e.message; }
    } else if (allOk) job.shutdown = 'aus';
    this.saveJob(job); this.db.setSetting(LAST_KEY, JSON.stringify(job));
    this.engine.event(null, null, allOk ? `Backup-Lauf fertig${job.shutdown === 'angefordert' ? ', PBS wird heruntergefahren' : ', PBS bleibt an'}` : 'Backup-Lauf nicht vollständig erfolgreich: der PBS bleibt an');
    try { await this.engine.notifier?.backupJob(job, s); } catch (e) { this.engine.log(`Mail zum Backup-Lauf: ${e.message}`); }
  }

  /** Trockenlauf: was würde gestartet? Startet nichts. */
  async dryRun() {
    const s = this.settings();
    const problems = [], rows = [];
    const pbs = s.pbsHostId ? this.engine.hosts.find((h) => h.id === s.pbsHostId) : null;
    if (!pbs) problems.push('Kein PBS-Host festgelegt.');
    for (const id of this.order(s)) {
      const host = this.engine.hosts.find((h) => h.id === id), sel = this.selection(id, s), hs = this.db.getHostState(id);
      const guests = this.db.guestsOf(id).filter((g) => !g.template);
      const included = guests.filter((g) => sel.select === 'all' || (sel.select === 'exclude' ? !sel.ids.includes(g.vmid) : sel.ids.includes(g.vmid)));
      let storage = null;
      if (hs?.reachable && this.engine.hostRights(id).includes('backup-starten')) { try { storage = await this.engine.client(id).storageActive(s.storage); } catch (e) { storage = { known: false, active: false, raw: e.message }; } }
      const row = { id, label: host?.label ?? id, enabled: sel.enabled, reachable: !!hs?.reachable, right: this.engine.hostRights(id).includes('backup-starten'), storageActive: storage?.active ?? null,
        select: sel.select, ids: sel.ids, guests: included.map((g) => ({ vmid: g.vmid, name: g.name, type: g.type, status: g.status })), excluded: guests.length - included.length,
        command: `vzdump ${sel.select === 'all' ? '--all 1' : sel.select === 'exclude' ? `--all 1 --exclude ${sel.ids.join(',')}` : sel.ids.join(' ')} --storage ${s.storage} --mode snapshot --compress zstd` };
      if (sel.enabled) {
        if (!row.right) problems.push(`${row.label}: Recht „Backups starten“ ist nicht freigegeben.`);
        else if (!row.reachable) problems.push(`${row.label}: nicht erreichbar (jetzt).`);
        else if (row.storageActive === false) problems.push(`${row.label}: Speicher „${s.storage}“ ist nicht aktiv (PBS aus?).`);
      }
      rows.push(row);
    }
    if (s.shutdown && pbs && !this.engine.hostRights(pbs.id).includes('herunterfahren')) problems.push(`${pbs.label ?? pbs.id}: Recht „Herunterfahren“ fehlt. Der PBS würde nach dem Lauf anbleiben.`);
    return { storage: s.storage, shutdown: s.shutdown, hosts: rows, problems };
  }
}
