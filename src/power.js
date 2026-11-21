// Strommessung mit Tasmota-Steckdosen: Liste der Messpunkte, Abfrage jede Minute, Verlauf in der Datenbank (alle 5 Minuten ein Mittelwert).
// Passwörter der Steckdosen liegen getrennt in der Tabelle settings und gehen nie an die Oberfläche.
import dns from 'node:dns/promises';
import net from 'node:net';
import { readTasmota, ADDR_RE } from './tasmota.js';
import { isPrivateIp } from './net.js';

const MIN = 60000;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export class PowerMeters {
  constructor(engine, { read = readTasmota, resolve = async (a) => (net.isIP(a) ? [a] : (await dns.lookup(a, { all: true })).map((r) => r.address)) } = {}) {
    this.engine = engine; this.read = read; this.resolve = resolve;
    this.latest = new Map(); // id -> { ts, power, today, yesterday, total, error }
    this.buf = new Map(); // id -> Leistungswerte seit dem letzten gespeicherten Mittelwert
    this.lastSave = 0; this.running = false;
  }
  get db() { return this.engine.db; }
  meters() { try { return JSON.parse(this.db.getSetting('power_meters') ?? '[]'); } catch { return []; } }
  price() { const p = Number(this.db.getSetting('power_price')); return Number.isFinite(p) && p > 0 ? p : 0.35; }

  /** Liste speichern. Einträge: {id, label, address, hostId|null, password? (nur beim Setzen), clearPassword?} */
  async save(list, price) {
    if (!Array.isArray(list) || list.length > 20) throw new Error('Höchstens 20 Steckdosen');
    const hostIds = this.engine.hosts.map((h) => h.id), seen = new Set(), out = [];
    for (const m of list) {
      const id = String(m.id ?? '').trim().toLowerCase();
      if (!ID_RE.test(id) || seen.has(id)) throw new Error(`Ungültige oder doppelte Kennung: ${m.id}`);
      seen.add(id);
      const address = String(m.address ?? '').trim();
      if (!ADDR_RE.test(address)) throw new Error(`${id}: ungültige Adresse`);
      let ips; try { ips = await this.resolve(address); } catch { throw new Error(`${id}: Adresse nicht auflösbar`); }
      if (!ips.length || !ips.every(isPrivateIp)) throw new Error(`${id}: nur Geräte im lokalen Netz`);
      const hostId = m.hostId ? String(m.hostId) : null;
      if (hostId && !hostIds.includes(hostId)) throw new Error(`${id}: Host unbekannt`);
      const label = String(m.label ?? id).trim().slice(0, 60) || id;
      out.push({ id, label, address, hostId });
      if (m.clearPassword) this.db.delSetting(`power_pw:${id}`);
      else if (m.password) { if (String(m.password).length > 128) throw new Error(`${id}: Passwort zu lang`); this.db.setSetting(`power_pw:${id}`, String(m.password)); }
    }
    for (const old of this.meters()) if (!seen.has(old.id)) { this.db.delSetting(`power_pw:${old.id}`); this.latest.delete(old.id); }
    this.db.setSetting('power_meters', JSON.stringify(out));
    if (price != null) { const p = Number(String(price).replace(',', '.')); if (!Number.isFinite(p) || p <= 0 || p > 5) throw new Error('Strompreis: z. B. 0,35 (€/kWh)'); this.db.setSetting('power_price', String(p)); }
    return out;
  }

  /** Eine Adresse probeweise lesen (Knopf „Testen“). */
  async test(address, password, id) {
    const ips = await this.resolve(String(address)).catch(() => []);
    if (!ips.length || !ips.every(isPrivateIp)) throw new Error('Nur Geräte im lokalen Netz');
    return this.read(String(address), { password: password || (id ? this.db.getSetting(`power_pw:${id}`) ?? '' : '') });
  }

  /** Jede Minute aus dem Takt der Engine. */
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.engine.now().getTime();
      await Promise.all(this.meters().map(async (m) => {
        try {
          const r = await this.read(m.address, { password: this.db.getSetting(`power_pw:${m.id}`) ?? '' });
          this.latest.set(m.id, { ...r, ts: now, error: null });
          (this.buf.get(m.id) ?? this.buf.set(m.id, []).get(m.id)).push({ power: r.power, total: r.total });
        } catch (e) { const prev = this.latest.get(m.id); this.latest.set(m.id, { ...(prev ?? {}), ts: prev?.ts ?? null, error: e.message, errorAt: now }); }
      }));
      if (now - this.lastSave >= 5 * MIN - 1000) {
        for (const [id, vals] of this.buf) {
          if (!vals.length) continue;
          const avg = vals.reduce((s, v) => s + v.power, 0) / vals.length;
          this.db.addPower(id, new Date(now), Math.round(avg * 10) / 10, vals.at(-1).total);
        }
        this.buf.clear(); this.lastSave = now;
      }
    } finally { this.running = false; }
  }
}

/**
 * Tageswerte (kWh) aus dem Zählerstand: Summe der Zuwächse zwischen aufeinanderfolgenden Messungen, dem Tag der späteren Messung zugeordnet.
 * Sprünge nach unten (Zähler zurückgesetzt, Steckdose getauscht) und unmögliche Sprünge nach oben (mehr als 5 kW im Mittel) werden ignoriert.
 */
export function dailyKwh(samples) {
  const days = new Map();
  const key = (ts) => { const d = new Date(ts); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let prev = null;
  for (const s of samples) {
    if (s.total == null || !Number.isFinite(s.total)) continue;
    const k = key(s.ts);
    if (!days.has(k)) days.set(k, 0);
    if (prev) {
      const delta = s.total - prev.total, hours = (s.ts - prev.ts) / 3.6e6;
      if (delta >= 0 && delta <= Math.max(0.01, hours * 5)) days.set(k, days.get(k) + delta);
    }
    prev = s;
  }
  return [...days].map(([day, kwh]) => ({ day, kwh: Math.round(kwh * 1000) / 1000 }));
}

/** Mittlere Leistung in einem Zeitraum (W) aus gespeicherten Mittelwerten. */
export function avgWatts(samples, from, to) {
  const v = samples.filter((s) => s.ts > from && s.ts <= to);
  return v.length ? Math.round((v.reduce((a, s) => a + s.watts, 0) / v.length) * 10) / 10 : null;
}
