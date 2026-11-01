// Steuerung: fragt die Hosts ab, speichert Messwerte, wertet Testergebnisse aus und startet/bricht Tests nach Zeitplan.
import { DEFAULT_SETTINGS, decide, canStartManual, advanceProgress, dayKey } from './schedule.js';
import { rate } from './rating.js';
import { ratePool } from './zfs.js';

const MIN = 60000;
// Nach einem unterbrochenen Test wird dieselbe Platte erst nach dieser Zeit erneut gestartet (Schutz vor Endlosschleifen).
const COOLDOWN_MS = 12 * 60 * MIN;

/** Voreinstellungen je Host-Art aus hosts.json: 'fest' (Standard), 'dauer' (immer an), 'manuell'. */
export function defaultsForHost(host) {
  const s = { ...DEFAULT_SETTINGS };
  if (host.kind === 'dauer') { s.mode = 'fest'; s.window = { from: '00:00', to: '24:00' }; }
  else if (host.kind === 'manuell') { s.mode = 'manuell'; s.dayEnd = host.dayEnd ?? '19:00'; }
  else if (host.window) s.window = host.window;
  return s;
}

export class Engine {
  constructor({ db, hosts, makeClient, now = () => new Date(), log = () => {} }) {
    this.db = db; this.hosts = hosts; this.makeClient = makeClient; this.now = now; this.log = log;
    this.clients = new Map(); this.lastDecision = new Map(); this.busy = new Set();
  }

  host(id) { const h = this.hosts.find((x) => x.id === id); if (!h) throw new Error(`Unbekannter Host: ${id}`); return h; }
  client(id) { if (!this.clients.has(id)) this.clients.set(id, this.makeClient(this.host(id))); return this.clients.get(id); }
  settings(id) { return { ...defaultsForHost(this.host(id)), ...(this.db.getHostSettings(id) ?? {}) }; }
  event(hostId, serial, text) { this.db.addEvent(this.now(), hostId, serial, text); this.log(`[${hostId}] ${text}`); }

  /** Eine Abfrage eines Hosts: Laufzeit, Platten, SMART, Testergebnisse, ZFS. */
  async pollHost(hostId) {
    const now = this.now();
    const client = this.client(hostId);
    const prev = this.db.getHostState(hostId);
    let uptime;
    try { uptime = await client.uptime(); } catch (e) {
      this.db.setHostState(hostId, { lastPoll: now, reachable: false, uptimeSec: null, uptimeAt: null, pools: prev?.pools ?? [], error: e.message });
      if (prev?.reachable) this.event(hostId, null, `Host nicht mehr erreichbar (${e.message})`);
      return;
    }
    if (prev && !prev.reachable) this.event(hostId, null, 'Host ist wieder erreichbar');
    let pools = prev?.pools ?? [];
    try { pools = (await client.zpool()).map(ratePool); } catch { /* ohne ZFS */ }

    let devices = [];
    try { devices = await client.listDisks(); } catch (e) { this.event(hostId, null, `Plattenliste fehlgeschlagen: ${e.message}`); }
    for (const dev of devices) {
      try {
        const disk = await client.smart(dev.device, { standby: true });
        if (disk.standby) { this.db.markStandby(dev.device, hostId); continue; }
        if (disk.unreadable || !disk.serial) { this.event(hostId, null, `${dev.device}: SMART nicht lesbar`); continue; }
        this.db.upsertDisk(hostId, disk, now, true);
        await this.reconcile(hostId, disk, now);
        const last = this.db.lastSampleTs(disk.serial);
        if (!last || now - last >= 50 * MIN) {
          const base = this.db.baseline(disk.serial, now);
          const r = rate(disk, { baseline: base, longHintDays: this.settings(hostId).longHintDays });
          this.db.addSample(disk.serial, now, {
            hours: disk.hours, temp: disk.temperature, wearUsed: disk.wearUsed, reallocated: disk.ata?.reallocated, crc: disk.ata?.crc,
            reportedUncorrect: disk.ata?.reportedUncorrect, mediaErrors: disk.nvme?.mediaErrors, level: r.level,
          });
        }
      } catch (e) { this.event(hostId, null, `${dev.device}: ${e.message}`); }
    }
    this.db.setHostState(hostId, { lastPoll: now, reachable: true, uptimeSec: uptime, uptimeAt: now, pools, error: null });
  }

  /** Läuft ein von uns gestarteter Test nicht mehr? Dann Ergebnis aus dem Testprotokoll lesen und verbuchen. */
  async reconcile(hostId, disk, now) {
    for (const run of this.db.runningRuns(hostId).filter((r) => r.serial === disk.serial)) {
      if (disk.selftest.running) continue;
      const want = { short: 'short', long: 'extended', select: 'selective' }[run.kind];
      const entry = disk.selftest.log.find((e) => e.kind === want && e.hours != null && e.hours >= (run.hours_at_start ?? 0));
      let result = entry?.result;
      let note = entry?.text ?? null;
      if (!entry) {
        if (now - run.started < 5 * MIN) continue; // Eintrag erscheint evtl. erst gleich
        result = 'interrupted'; note = 'Kein Ergebnis im Testprotokoll (Neustart?)';
      }
      this.db.finishRun(run.id, result, now, note);
      const label = { short: 'Kurztest', long: 'Langtest', select: 'Langtest-Abschnitt' }[run.kind];
      const name = `${disk.model} (${disk.device})`;
      if (result === 'interrupted') { this.event(hostId, disk.serial, `${label} ${name} wurde unterbrochen und wird wiederholt.`); continue; }
      this.event(hostId, disk.serial, `${label} ${name}: ${result === 'ok' ? 'ohne Fehler beendet' : `FEHLER – ${note}`}`);
      if (run.kind === 'short') this.db.setLastOk(disk.serial, 'short', now);
      else if (run.kind === 'long' || result === 'failed') { this.db.setLastOk(disk.serial, 'long', now); this.db.clearProgress(disk.serial); }
      else {
        const minutes = (now - run.started) / MIN;
        const adv = advanceProgress(this.db.getProgress(disk.serial), { from: run.lba_from, to: run.lba_to }, disk.totalLba, minutes);
        if (adv.done) { this.db.setLastOk(disk.serial, 'long', now); this.db.clearProgress(disk.serial); this.event(hostId, disk.serial, `Langtest ${name} ist komplett abgeschlossen.`); }
        else this.db.setProgress(disk.serial, { ...adv.progress, started: this.db.getProgress(disk.serial)?.started ?? new Date(run.started) });
        if (adv.progress?.lbaPerMin) this.db.setLbaPerMin(disk.serial, adv.progress.lbaPerMin);
      }
    }
  }

  buildState(hostId, now = this.now()) {
    const hs = this.db.getHostState(hostId);
    const reachable = !!hs?.reachable;
    const uptimeSec = reachable && hs.uptimeSec != null ? hs.uptimeSec + (now - hs.uptimeAt) / 1000 : null;
    const running = new Map(this.db.runningRuns(hostId).map((r) => [r.serial, r]));
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const runs = this.db.runsSince(hostId, today);
    const ap = this.db.getApproval(hostId);
    const disks = this.db.disksOfHost(hostId).map((d) => {
      const run = running.get(d.serial);
      const lastRun = this.db.runsOfDisk(d.serial, 1)[0];
      const cooldown = !!lastRun && lastRun.result === 'interrupted' && lastRun.ended != null && now - lastRun.ended < COOLDOWN_MS;
      return {
        serial: d.serial, device: d.device, kind: d.kind, paused: !!d.paused, cooldown,
        pollingShort: d.polling_short, pollingExtended: d.polling_extended, selective: !!d.selective, totalLba: d.total_lba,
        lastShortOk: d.last_short_ok ? new Date(d.last_short_ok) : null, lastLongOk: d.last_long_ok ? new Date(d.last_long_ok) : null,
        longProgress: this.db.getProgress(d.serial), lbaPerMin: d.lba_per_min,
        running: run ? { type: run.kind } : (d.selftest_running ? { type: 'extern' } : null),
      };
    });
    return {
      reachable, uptimeSec, zfsBusy: (hs?.pools ?? []).some((p) => p.busy), disks,
      todayRuns: { short: runs.some((r) => r.kind === 'short'), long: runs.some((r) => r.kind === 'long' || r.kind === 'select') },
      approval: { skipDate: ap.skipDate ?? null, snoozeUntil: ap.snoozeUntil ?? null, goNow: !!ap.goAt && dayKey(ap.goAt) === dayKey(now) },
    };
  }

  /** Einmal pro Minute: Abfragen, wenn nötig, und nach Zeitplan handeln. */
  async tick() {
    for (const host of this.hosts) {
      if (this.busy.has(host.id)) continue;
      this.busy.add(host.id);
      try { await this.tickHost(host.id); } catch (e) { this.log(`Fehler bei ${host.id}: ${e.stack ?? e.message}`); } finally { this.busy.delete(host.id); }
    }
  }

  async tickHost(hostId) {
    const now = this.now();
    const s = this.settings(hostId);
    let hs = this.db.getHostState(hostId);
    let state = this.buildState(hostId, now);
    const interval = (state.disks.some((d) => d.running) || !hs?.reachable) ? 5 : 30;
    if (!hs?.lastPoll || now - hs.lastPoll >= interval * MIN) { await this.pollHost(hostId); hs = this.db.getHostState(hostId); state = this.buildState(hostId, now); }
    let dec = decide(now, s, state);
    if (dec.action !== 'none' && now - hs.lastPoll > 3 * MIN) { await this.pollHost(hostId); state = this.buildState(hostId, now); dec = decide(now, s, state); }
    this.lastDecision.set(hostId, dec);
    if (dec.action === 'start') await this.startNow(hostId, dec.serial, dec.test, 'plan');
    else if (dec.action === 'abort') await this.abortNow(hostId, dec.serial, dec.reason);
  }

  async startNow(hostId, serial, plan, origin) {
    const now = this.now();
    const d = this.db.getDisk(serial);
    await this.client(hostId).startTest(d.device, plan);
    const kind = plan.test;
    const hours = (JSON.parse(d.last_raw ?? '{}').hours) ?? null;
    this.db.addRun({ serial, hostId, kind, started: now, from: plan.from, to: plan.to, hoursAtStart: hours, origin });
    if (kind === 'select' && !this.db.getProgress(serial)) this.db.setProgress(serial, { nextLba: plan.from, totalLba: d.total_lba, lbaPerMin: null, segments: 0, started: now });
    const label = { short: 'Kurztest', long: 'Langtest', select: 'Langtest-Abschnitt' }[kind];
    this.event(hostId, serial, `${label} gestartet auf ${d.model} (${d.device})${origin === 'manual' ? ' – von Hand' : ''}${plan.minutes ? `, geplant ca. ${plan.minutes} min` : ''}`);
  }

  async abortNow(hostId, serial, reason) {
    const now = this.now();
    const d = this.db.getDisk(serial);
    await this.client(hostId).abortTest(d.device);
    for (const r of this.db.runningRuns(hostId).filter((x) => x.serial === serial)) this.db.finishRun(r.id, 'interrupted', now, `Abgebrochen: ${reason}`);
    this.event(hostId, serial, `Test auf ${d.model} (${d.device}) abgebrochen: ${reason}. Wird im nächsten Fenster wiederholt.`);
  }

  // ---- Aktionen aus der Oberfläche ----
  async startManual(hostId, serial, type) {
    await this.pollHost(hostId);
    const state = this.buildState(hostId);
    const chk = canStartManual(this.now(), this.settings(hostId), state, serial, type);
    if (!chk.ok) return chk;
    await this.startNow(hostId, serial, chk.test, 'manual');
    return { ok: true };
  }
  async abortManual(hostId, serial) { await this.abortNow(hostId, serial, 'von Hand'); return { ok: true }; }

  setApproval(hostId, action) {
    const now = this.now();
    const cur = this.db.getApproval(hostId);
    if (action === 'now') this.db.setApproval(hostId, { ...cur, goAt: now, skipDate: null, snoozeUntil: null });
    else if (action === 'skip') this.db.setApproval(hostId, { ...cur, skipDate: dayKey(now), goAt: null });
    else if (action === 'snooze') this.db.setApproval(hostId, { ...cur, snoozeUntil: new Date(now.getTime() + 60 * MIN) });
    else if (action === 'clear') this.db.setApproval(hostId, {});
    else throw new Error('Unbekannte Aktion');
  }
}
