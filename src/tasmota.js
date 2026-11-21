// Tasmota-Steckdosen mit Strommessung abfragen: HTTP-Befehl „Status 8“ liefert Leistung (W) und Zähler (kWh).
// Nur Adressen im lokalen Netz. Ist in Tasmota ein Web-Passwort gesetzt, wird es mitgeschickt (Benutzer „admin“).
import http from 'node:http';

export const ADDR_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** Antwort von „Status 8“ -> Messwerte. */
export function parseStatus8(json) {
  const e = json?.StatusSNS?.ENERGY ?? json?.ENERGY;
  if (!e || typeof e.Power === 'undefined') throw new Error('Keine Energiewerte in der Antwort (ist es eine Steckdose mit Strommessung?)');
  const num = (v) => (Array.isArray(v) ? v.reduce((a, b) => a + Number(b || 0), 0) : Number(v));
  return { power: num(e.Power), today: num(e.Today), yesterday: num(e.Yesterday), total: num(e.Total), voltage: e.Voltage != null ? num(e.Voltage) : null, time: json?.StatusSNS?.Time ?? null };
}

/** Eine Steckdose lesen. get: (url, timeoutMs) => Promise<string> (für Tests austauschbar). */
export async function readTasmota(address, { password = '', timeoutMs = 5000, get = httpGet } = {}) {
  if (!ADDR_RE.test(String(address))) throw new Error('Ungültige Adresse');
  const q = new URLSearchParams({ cmnd: 'Status 8' });
  if (password) { q.set('user', 'admin'); q.set('password', password); }
  const body = await get(`http://${address}/cm?${q}`, timeoutMs);
  let json;
  try { json = JSON.parse(body); } catch { throw new Error('Antwort ist kein JSON (ist es eine Tasmota-Steckdose?)'); }
  if (json?.WARNING) throw new Error(/password/i.test(json.WARNING) ? 'Passwort fehlt oder ist falsch' : json.WARNING);
  return parseStatus8(json);
}

function httpGet(url, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 65536) req.destroy(new Error('Antwort zu groß')); });
      res.on('end', () => (res.statusCode === 200 ? resolve(data) : reject(new Error(`HTTP ${res.statusCode}`))));
    });
    req.on('timeout', () => req.destroy(new Error('keine Antwort (Zeitüberschreitung)')));
    req.on('error', (e) => reject(new Error(e.code === 'ECONNREFUSED' ? 'Verbindung abgelehnt' : e.code === 'EHOSTUNREACH' ? 'nicht erreichbar' : e.message)));
  });
}
