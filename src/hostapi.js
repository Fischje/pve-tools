// Spricht über einen Transport mit dem Gate-Skript des Hosts und liefert normalisierte Daten.
import { normalize } from './smart.js';
import { parseZpoolStatus } from './zfs.js';

export class HostClient {
  constructor(transport) { this.t = transport; }

  async uptime() {
    const r = await this.t.run('uptime', 15000);
    const v = parseFloat(r.stdout);
    if (r.code !== 0 || !Number.isFinite(v)) throw new Error(r.stderr.trim() || 'Host nicht erreichbar');
    return v;
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
