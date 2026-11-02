// Spricht über einen Transport mit dem Gate-Skript des Hosts und liefert normalisierte Daten.
import { normalize } from './smart.js';
import { parseZpoolStatus, parseZpoolList } from './zfs.js';
import { parseKernelLog } from './kernel.js';
import { parseGuests, parseSnapshots, parseTasks, parseVzdumpLog, parseAutosnap } from './backups.js';

export class HostClient {
  constructor(transport) { this.t = transport; }

  async uptime() {
    const r = await this.t.run('uptime', 15000);
    const v = parseFloat(r.stdout);
    if (r.code !== 0 || !Number.isFinite(v)) throw new Error(r.stderr.trim() || 'Host nicht erreichbar');
    return v;
  }

  /** Version des Prüfskripts auf dem Host. Ältere Skripte kennen den Befehl nicht: dann Version 1. */
  async gateVersion() {
    const r = await this.t.run('version', 15000);
    const v = Number.parseInt(r.stdout, 10);
    return r.code === 0 && Number.isInteger(v) ? v : 1;
  }

  async listDisks() {
    const r = await this.t.run('list', 15000);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'lsblk fehlgeschlagen');
    const j = JSON.parse(r.stdout);
    return (j.blockdevices ?? []).filter((d) => d.type === 'disk' && /^(sd[a-z]+|nvme\d+n\d+)$/.test(d.name))
      .map((d) => ({ device: `/dev/${d.name}`, model: d.model, serial: d.serial, size: Number(d.size), rota: d.rota === true || d.rota === '1' || d.rota === 1, tran: d.tran }));
  }

  /** Liest SMART. `standby: true` weckt schlafende Platten nicht. */
  async smart(device, { standby = true } = {}) {
    const r = await this.t.run(`smart ${device}${standby ? ' standby' : ''}`, 90000);
    let json;
    try { json = JSON.parse(r.stdout); } catch { throw new Error(r.stderr.trim() || `smartctl lieferte kein JSON für ${device}`); }
    return normalize(json, { device });
  }

  async zpool() {
    const r = await this.t.run('zpool', 30000);
    return r.code === 0 ? parseZpoolStatus(r.stdout) : [];
  }

  /** Größe/Füllstand der Pools. Ältere Hosts kennen den Befehl nicht: dann leer (Hosts über „Neu einrichten“ aktualisieren). */
  async zpoolList() {
    const r = await this.t.run('zpoollist', 30000);
    return r.code === 0 ? parseZpoolList(r.stdout) : {};
  }

  // ---- Backups und Snapshots (nur lesend, braucht Prüfskript ab Version 4)
  async guests() { const r = await this.t.run('guests', 60000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Gäste nicht lesbar'); return parseGuests(r.stdout); }
  async snapshots() { const r = await this.t.run('snapshots', 240000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Snapshots nicht lesbar'); return parseSnapshots(r.stdout); }
  async backupTasks() { const r = await this.t.run('tasks', 60000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Aufgaben nicht lesbar'); return parseTasks(r.stdout); }
  async backupTaskLog(upid) { const r = await this.t.run(`tasklog ${upid}`, 120000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Protokoll nicht lesbar'); return parseVzdumpLog(r.stdout); }
  async autosnap() { const r = await this.t.run('autosnap', 30000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Snapshot-Zustand nicht lesbar'); return parseAutosnap(r.stdout); }

  /** Freigegebene Rechtegruppen dieses Hosts (Prüfskript ab Version 6). */
  async rights() { const r = await this.t.run('rechte', 15000); return r.code === 0 ? r.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : []; }
  /** Snapshot-Lauf mit dem vorhandenen autosnap-Skript. Gibt Ausgabe und Rückgabecode zurück, wirft nicht bei Fehlercode. */
  async snapRun(label, { force = false } = {}) {
    const r = await this.t.run(`snap-run ${label}${force ? ' force' : ''}`, 15 * 60000);
    return { ok: r.code === 0, code: r.code, text: `${r.stdout}${r.stderr}`.trim().slice(-600) };
  }
  async snapSwitch(on) { const r = await this.t.run(`snap-switch ${on ? 'on' : 'off'}`, 20000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Schalter nicht gesetzt'); }
  async snapCron(action) { const r = await this.t.run(`snap-cron ${action}`, 20000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Cron nicht geändert'); return r.stdout.trim(); }

  /** Kernel-Meldungen zu Verbindungsfehlern der letzten 48 h (braucht Prüfskript ab Version 5). */
  async kernelLog() { const r = await this.t.run('kernel', 30000); if (r.code !== 0) throw new Error(r.stderr.trim() || 'Kernel-Meldungen nicht lesbar'); return parseKernelLog(r.stdout); }

  /** Test starten. plan: {test:'short'|'long'} oder {test:'select', from, to}. */
  async startTest(device, plan) {
    const cmd = plan.test === 'select' ? `select ${device} ${plan.from} ${plan.to}` : `test ${device} ${plan.test}`;
    const r = await this.t.run(cmd, 60000);
    let ok = r.code === 0;
    try { const j = JSON.parse(r.stdout); ok = ok && (j.smartctl?.exit_status ?? 0) === 0; } catch { /* keine JSON-Ausgabe */ }
    if (!ok) throw new Error(r.stderr.trim() || r.stdout.trim().slice(0, 300) || 'Test konnte nicht gestartet werden');
  }

  async abortTest(device) {
    const r = await this.t.run(`test ${device} abort`, 30000);
    if (r.code !== 0) throw new Error(r.stderr.trim() || 'Abbruch fehlgeschlagen');
  }
}
