// Backup-Lauf durch das Tool (ersetzt das Orchestrator-Skript auf dem PBS).
//
// Ablauf: Der PBS (Host-Art „manuell“) fährt hoch. Nach der eingestellten Wartezeit startet das Tool die Backups host für host
// (vzdump als eigener Dienst auf dem Host, über das Prüfskript) und wartet über die Aufgabenliste des Hosts, bis jede Aufgabe fertig ist.
// Der PBS wird nur heruntergefahren, wenn ALLE Backups erfolgreich waren (einstellbar). Sonst bleibt er an, und es kommt eine Mail.
// Zustand und Einstellungen stehen in der Datenbank (Tabelle setting), damit ein Neustart des Tools den Lauf nicht verliert.
import { summarizeRun } from './backups.js';
import { sendWol, macFromArp, normMac, MAC_RE } from './wol.js';

const MIN = 60000;
const SETTINGS_KEY = 'backupctl', JOB_KEY = 'backupjob', LAST_KEY = 'backupjob_last', BOOT_KEY = 'backup_lastboot', SKIP_KEY = 'backup_lastskip', SINCE_KEY = 'backup_steuert_seit', WAKE_KEY = 'backup_wake';
// Voreinstellung aus dem bisherigen Orchestrator (pbs-run-backups.sh): router alle, pve alle außer dieser Gäste.
const SEEDED_EXCLUDES = { pve: [109, 112, 113, 114, 116, 119, 117, 159, 161, 171] };
// Backup-Tage: 0 = Sonntag … 6 = Samstag. Voreinstellung Montag, wie bisher (der PBS geht montags automatisch an).
export const WEEKDAYS = ['Sonntag', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag'];
export const DEFAULTS = { pbsHostId: '', storage: 'pbs', backupDays: [1], autoWake: true, wakeTime: '08:00', wolMac: '', wolBroadcast: '255.255.255.255', waitAfterBootMin: 20, shutdown: true, hostWaitMin: 30, order: null, hosts: {} };

const FINAL = new Set(['ok', 'fehler', 'fehlt', 'übersprungen']);

/** Prüft Einstellungen aus der Oberfläche. Wirft bei ungültigen Werten. */
export function cleanBackupSettings(input, hostIds = []) {
  const out = {};
  const int = (v, lo, hi, name) => { const n = Number(v); if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`${name}: erlaubt sind ${lo} bis ${hi}`); return n; };
  if ('autoWake' in input) out.autoWake = !!input.autoWake;
  if ('wakeTime' in input) { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.wakeTime))) throw new Error('Uhrzeit zum Einschalten: Format HH:MM'); out.wakeTime = String(input.wakeTime); }
  if ('pbsHostId' in input) { const v = String(input.pbsHostId ?? ''); if (v && !hostIds.includes(v)) throw new Error('PBS-Host unbekannt'); out.pbsHostId = v; }
  if ('storage' in input) { const v = String(input.storage ?? '').trim(); if (!/^[A-Za-z0-9_-]{1,32}$/.test(v)) throw new Error('Speicher: nur Buchstaben, Ziffern, - und _ (höchstens 32 Zeichen)'); out.storage = v; }
  if ('waitAfterBootMin' in input) out.waitAfterBootMin = int(input.waitAfterBootMin, 0, 240, 'Wartezeit nach dem Hochfahren (Minuten)');
  if ('hostWaitMin' in input) out.hostWaitMin = int(input.hostWaitMin, 1, 240, 'Wartezeit auf einen Host (Minuten)');
  if ('shutdown' in input) out.shutdown = !!input.shutdown;
  if ('wolMac' in input) { const m = normMac(input.wolMac); if (m && !MAC_RE.test(m)) throw new Error('MAC-Adresse des PBS: Format aa:bb:cc:dd:ee:ff'); out.wolMac = m; }
  if ('wolBroadcast' in input) {
    const v = String(input.wolBroadcast ?? '').trim() || '255.255.255.255';
    if (!v.split(/[,\s]+/).every((x) => /^(\d{1,3}\.){3}\d{1,3}$/.test(x) && x.split('.').every((n) => Number(n) <= 255))) throw new Error('Broadcast-Adresse: z. B. 255.255.255.255 oder 192.168.1.255');
    out.wolBroadcast = v;
  }
  if ('backupDays' in input) {
    if (!Array.isArray(input.backupDays) || input.backupDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw new Error('Backup-Tage: ungültig');
    out.backupDays = [...new Set(input.backupDays)].sort((a, b) => a - b);
  }
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
  constructor(engine) { this.engine = engine; this.running = false; this.sendWol = sendWol; this.readArp = (ip) => macFromArp(ip); }
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
  isBusy(hostId) { const j = this.job(); return !!j && j.phase === 'läuft' && j.hosts.some((h) => h.id === hostId && h.state === 'läuft'); }

  /** Läuft jede Minute (aus dem Takt der Engine). */
  async tick() {
    const s = this.settings();
    if (this.running) return;
    this.running = true;
    try {
      await this.learnNet(s);
      // Beim ersten Start dieser Version gilt ein gerade laufender Boot des PBS als erledigt: nach einem Update startet nicht sofort ein Lauf.
      if (!this.db.getSetting(SINCE_KEY)) { this.markCurrentBoot(s); this.db.setSetting(SINCE_KEY, String(this.now().getTime())); }
      const job = this.job();
      if (job?.phase === 'läuft') { await this.advance(job, s); return; }
      if (!s.pbsHostId) return;
      const boot = this.bootAt(s);
      if (boot == null) { await this.autoWake(s); await this.wakeFailedCheck(s); return; }
      const hs = this.db.getHostState(s.pbsHostId);
      const up = (hs.uptimeSec + (this.now() - hs.uptimeAt) / 1000) / 60;
      if (up < s.waitAfterBootMin) return;
      const last = Number(this.db.getSetting(BOOT_KEY) ?? 0);
      if (Math.abs(boot - last) < 10 * MIN) return; // dieser Boot wurde schon behandelt
      // Kein Backup-Tag (maßgeblich ist der Tag, an dem der PBS hochgefahren ist): diesen Boot merken, nichts sichern, PBS bleibt an.
      const day = new Date(boot).getDay();
      if (!s.backupDays.includes(day)) {
        this.db.setSetting(BOOT_KEY, String(Math.round(boot)));
        this.db.setSetting(SKIP_KEY, String(Math.round(boot)));
        this.engine.event(s.pbsHostId, null, `PBS hochgefahren an einem ${WEEKDAYS[day]}: kein Backup-Tag, es wird nicht automatisch gesichert. Der PBS bleibt an („Jetzt Backup starten“ geht weiter von Hand).`);
        return;
      }
      await this.advance(this.begin(s, { bootAt: Math.round(boot), manual: false }), s);
    } catch (e) { this.engine.log(`Backup-Steuerung: ${e.stack ?? e.message}`); } finally { this.running = false; }
  }

  /**
   * @param {{bootAt:number|null, manual:boolean, pick?:Record<string, number[]>|null}} o pick: Auswahl von Hand (Host -> Gast-IDs), sonst die Einstellungen
   */
  begin(s, { bootAt, manual, pick = null }) {
    const now = this.now().getTime();
    const hosts = pick
      ? this.order(s).filter((id) => pick[id]?.length).map((id) => ({ id, state: 'wartet', since: now, note: '', sel: { select: 'only', ids: pick[id] } }))
      : this.order(s).filter((id) => this.selection(id, s).enabled).map((id) => ({ id, state: 'wartet', since: now, note: '' }));
    const job = { id: `bk${now}`, startedAt: now, bootAt, manual: !!manual, phase: 'läuft', hosts, shutdown: null, endedAt: null, storage: s.storage };
    // Nur der geplante Lauf zählt als „dieser Boot ist erledigt“. Ein Lauf von Hand verhindert den geplanten nicht.
    if (bootAt != null && !manual) this.db.setSetting(BOOT_KEY, String(bootAt));
    this.saveJob(job);
    this.engine.event(null, null, `Backup-Lauf gestartet${manual ? ' (von Hand)' : ''}: ${hosts.map((h) => h.id).join(' → ') || 'keine Hosts'}`);
    return job;
  }

  /** Von Hand starten (Knopf in der Oberfläche). Der PBS muss laufen. */
  /**
   * Von Hand starten (Dialog in der Oberfläche): nur die ausgewählten Gäste. Danach wird der PBS nie heruntergefahren.
   * @param {Record<string, number[]>} pick Host-ID -> Gast-IDs
   */
  async startNow(pick) {
    const s = this.settings();
    const order = this.order(s);
    if (!pick || typeof pick !== 'object' || Array.isArray(pick)) throw new Error('Bitte mindestens einen Gast auswählen.');
    const clean = {};
    for (const [id, ids] of Object.entries(pick)) {
      if (!order.includes(id)) throw new Error(`Host unbekannt oder nicht sicherbar: ${id}`);
      if (!Array.isArray(ids) || ids.length > 64 || ids.some((n) => !Number.isInteger(n) || n < 100 || n > 999999999)) throw new Error('Gast-IDs: nur Zahlen ab 100, höchstens 64 je Host');
      if (ids.length) clean[id] = [...new Set(ids)].sort((a, b) => a - b);
    }
    if (!Object.keys(clean).length) throw new Error('Bitte mindestens einen Gast auswählen.');
    if (this.job()?.phase === 'läuft') throw new Error('Es läuft schon ein Backup-Lauf.');
    if (!s.pbsHostId) throw new Error('Kein PBS-Host festgelegt.');
    const hs = this.db.getHostState(s.pbsHostId);
    if (!hs?.reachable) throw new Error('Der PBS ist nicht erreichbar. Bitte erst einschalten.');
    const job = this.begin(s, { bootAt: this.bootAt(s), manual: true, pick: clean });
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
    const sel = cur.sel ?? this.selection(cur.id, s);
    try {
      if (cur.state === 'wartet') {
        if (!cur.activeAt) { cur.activeAt = now; cur.since = now; } // die Wartezeit zählt ab dem Moment, in dem der Host an der Reihe ist
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
    // Heruntergefahren wird nur, wenn der PBS an einem Backup-Tag hochgefahren ist. Sonst bleibt er an, bis du ihn ausschaltest
    // (Knopf „PBS herunterfahren“). Das gilt auch für einen von Hand gestarteten Lauf.
    // Automatisch heruntergefahren wird nur nach dem geplanten Lauf an einem Backup-Tag. Nach einem Lauf von Hand nie.
    const bootDay = new Date(job.bootAt ?? job.startedAt).getDay();
    if (allOk && job.manual) job.shutdown = 'von-hand';
    else if (allOk && s.shutdown && !s.backupDays.includes(bootDay)) job.shutdown = 'kein-backup-tag';
    else if (allOk && s.shutdown && s.pbsHostId) {
      try {
        if (!this.engine.hostRights(s.pbsHostId).includes('herunterfahren')) job.shutdown = 'fehlt-recht';
        else { await this.engine.client(s.pbsHostId).poweroff(); job.shutdown = 'angefordert'; }
      } catch (e) { job.shutdown = 'fehler'; job.shutdownNote = e.message; }
    } else if (allOk) job.shutdown = 'aus';
    this.saveJob(job); this.db.setSetting(LAST_KEY, JSON.stringify(job));
    this.engine.event(null, null, allOk ? `Backup-Lauf fertig${job.shutdown === 'angefordert' ? ', PBS wird heruntergefahren' : ', PBS bleibt an'}` : 'Backup-Lauf nicht vollständig erfolgreich: der PBS bleibt an');
    try { await this.engine.notifier?.backupJob(job, s); } catch (e) { this.engine.log(`Mail zum Backup-Lauf: ${e.message}`); }
  }

  /**
   * MAC-Adresse und Wake-on-Zustand des PBS lernen, solange er läuft (höchstens stündlich): aus dem Prüfskript (ab Version 9),
   * sonst aus der ARP-Tabelle des LXC. Eine von Hand eingetragene MAC-Adresse bleibt unangetastet.
   */
  async learnNet(s) {
    if (!s.pbsHostId) return;
    const hs = this.db.getHostState(s.pbsHostId);
    if (!hs?.reachable) return;
    const last = this.parse('pbs_netinfo', null);
    if (last && this.now().getTime() - last.ts < 3600e3) return;
    const host = this.engine.hosts.find((h) => h.id === s.pbsHostId);
    let info = {};
    if ((hs.gateVersion ?? 0) >= 9) { try { info = await this.engine.client(s.pbsHostId).netinfo(); } catch { /* egal */ } }
    if (!info.mac && host?.address) { const m = this.readArp(host.address); if (m) info = { ...info, mac: m, source: 'arp' }; }
    this.db.setSetting('pbs_netinfo', JSON.stringify({ ...info, ts: this.now().getTime() }));
  }
  /**
   * Automatisch einschalten: an einem Backup-Tag ab der eingestellten Uhrzeit, wenn der PBS aus ist und heute noch nicht lief.
   * Bis zu drei Versuche im Abstand von 10 Minuten; klappt es nicht, Ereignis und Mail.
   */
  async autoWake(s) {
    if (!s.autoWake || !s.pbsHostId) return;
    const now = this.now(), day = now.getDay();
    if (!s.backupDays.includes(day)) return;
    const [hh, mm] = s.wakeTime.split(':').map(Number);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0).getTime();
    if (now.getTime() < at || now.getTime() > at + 6 * 3600e3) return; // nur in den 6 Stunden nach der Uhrzeit
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    // Lief der PBS heute schon (Boot heute oder ein Lauf heute)? Dann nicht wieder einschalten, z. B. nach dem Herunterfahren am Mittag.
    const lastBoot = Number(this.db.getSetting(BOOT_KEY) ?? 0), last = this.lastJob();
    if (lastBoot >= today || (last && last.startedAt >= today && !last.manual)) return;
    const st = this.parse(WAKE_KEY, null);
    const tries = st?.day === today ? st.tries : 0;
    if (tries >= 3) return;
    if (st?.day === today && now.getTime() - st.ts < 10 * MIN) return;
    const target = this.wolTarget(s);
    if (!target.mac) { if (tries === 0) { this.db.setSetting(WAKE_KEY, JSON.stringify({ day: today, tries: 3, ts: now.getTime() })); this.engine.event(s.pbsHostId, null, 'Automatisches Einschalten nicht möglich: MAC-Adresse des PBS unbekannt.'); } return; }
    try { await this.sendWol(target.mac, { broadcast: target.broadcast }); } catch (e) { this.engine.log(`Wake-on-LAN: ${e.message}`); }
    this.db.setSetting(WAKE_KEY, JSON.stringify({ day: today, tries: tries + 1, ts: now.getTime() }));
    this.engine.event(s.pbsHostId, null, `Backup-Tag: PBS per Wake-on-LAN eingeschaltet (Versuch ${tries + 1} von 3)`);
    if (tries + 1 === 3) this.wakeCheckAt = now.getTime() + 10 * MIN;
  }
  /** Nach dem dritten Versuch: läuft er immer noch nicht, Meldung (einmal). */
  async wakeFailedCheck(s) {
    if (!this.wakeCheckAt || this.now().getTime() < this.wakeCheckAt) return;
    this.wakeCheckAt = null;
    if (this.db.getHostState(s.pbsHostId)?.reachable) return;
    this.engine.event(s.pbsHostId, null, 'PBS ist nach drei Wake-on-LAN-Versuchen nicht hochgefahren. Heute läuft kein Backup.');
    try { await this.engine.notifier?.backupNotice(`wake:${new Date().toDateString()}`, '[Backup] PBS ließ sich nicht einschalten', 'Der PBS ist an einem Backup-Tag nach drei Wake-on-LAN-Versuchen nicht hochgefahren. Heute läuft kein Backup.\nBitte Wake-on-LAN im BIOS und an der Netzwerkkarte prüfen oder den PBS von Hand einschalten.'); } catch { /* egal */ }
  }

  /** MAC-Adresse für Wake-on-LAN: von Hand eingetragen oder gelernt. */
  wolTarget(s = this.settings()) {
    const learned = this.parse('pbs_netinfo', null);
    return { mac: s.wolMac || learned?.mac || '', manual: !!s.wolMac, learned, broadcast: s.wolBroadcast };
  }
  /** PBS einschalten (Magic Packet). */
  async wake() {
    const s = this.settings(), t = this.wolTarget(s);
    if (!t.mac) throw new Error('Die MAC-Adresse des PBS ist noch nicht bekannt. Sie wird gelernt, sobald der PBS einmal läuft, oder du trägst sie in den Einstellungen ein.');
    if (this.db.getHostState(s.pbsHostId)?.reachable) throw new Error('Der PBS läuft schon.');
    const r = await this.sendWol(t.mac, { broadcast: t.broadcast });
    this.engine.event(s.pbsHostId, null, `Einschalten per Wake-on-LAN angefordert (${t.mac}, ${r.packets} Pakete an ${r.targets.join(', ')})`);
    return r;
  }
  /** PBS von Hand herunterfahren. Nicht, solange das Tool gerade ein Backup steuert. */
  async powerOff() {
    const s = this.settings();
    if (!s.pbsHostId) throw new Error('Kein PBS-Host festgelegt.');
    if (this.job()?.phase === 'läuft') throw new Error('Es läuft gerade ein Backup-Lauf. Erst abwarten oder „Im Tool abbrechen“.');
    if (!this.db.getHostState(s.pbsHostId)?.reachable) throw new Error('Der PBS ist nicht erreichbar (schon aus?).');
    if (!this.engine.hostRights(s.pbsHostId).includes('herunterfahren')) throw new Error('Auf dem PBS ist das Recht „Herunterfahren“ nicht freigegeben (Reiter Hosts einrichten, Skript aktualisieren).');
    await this.engine.client(s.pbsHostId).poweroff();
    this.engine.event(s.pbsHostId, null, 'PBS wird von Hand heruntergefahren (in 20 Sekunden)');
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
    const today = this.now().getDay();
    const notes = s.backupDays.includes(today) ? [] : [`Heute (${WEEKDAYS[today]}) ist kein Backup-Tag: Wird der PBS heute eingeschaltet, sichert das Tool nicht automatisch.`];
    return { storage: s.storage, shutdown: s.shutdown, backupDays: s.backupDays, hosts: rows, problems, notes };
  }
}
