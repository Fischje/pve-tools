// Liest die Textausgabe von `zpool status -p` (Pool, Scrub, vdev-Baum mit Fehlerzählern) und `zpool list -H -p`, und bewertet die Pools.
import { LEVEL_ORDER } from './rating.js';

const BAD_STATES = new Set(['DEGRADED', 'FAULTED', 'UNAVAIL', 'OFFLINE', 'REMOVED', 'SUSPENDED']);
const SECTION_HEADERS = new Set(['logs', 'cache', 'spares', 'special', 'dedup']);

function vdevType(name) {
  let m;
  if ((m = /^(mirror)(-\d+)?$/.exec(name))) return 'mirror';
  if ((m = /^raidz([123])?(-\d+)?$/.exec(name))) return `raidz${m[1] ?? 1}`;
  if (/^draid/.test(name)) return 'draid';
  if (/^(replacing|spare)(-\d+)?$/.test(name)) return name.replace(/-\d+$/, '');
  return null;
}

/** Zerlegt die scan:-Zeile in Art, Zustand, Fortschritt und Ergebnis. */
export function parseScan(text) {
  const t = String(text ?? '').trim();
  const kind = /resilver/i.test(t) ? 'resilver' : /scrub/i.test(t) ? 'scrub' : null;
  if (!t || /none requested/i.test(t)) return { kind: null, state: 'none', text: t };
  if (/in progress/i.test(t)) {
    const pct = /([\d.]+)% done/.exec(t);
    const toGo = /([\d:]+|\d+ days[^,]*) to go/.exec(t);
    return { kind, state: 'running', percent: pct ? Number(pct[1]) : null, toGo: toGo ? toGo[1] : null, text: t };
  }
  if (/canceled/i.test(t)) return { kind, state: 'canceled', text: t };
  const done = /(?:repaired|resilvered) (\S+) in (\S+) with (\d+) errors on (.+)$/.exec(t);
  if (done) {
    const d = new Date(done[4]);
    return { kind, state: 'finished', repaired: done[1], duration: done[2], errors: Number(done[3]), finishedAt: Number.isNaN(d.getTime()) ? null : d.toISOString(), text: t };
  }
  return { kind, state: 'unknown', text: t };
}

/** @returns {object[]} Pools mit scan, vdevs (Baum), errors, busy */
export function parseZpoolStatus(text) {
  const pools = [];
  let cur = null, mode = null, section = 'data', vdev = null;
  for (const raw of String(text ?? '').split('\n')) {
    let m;
    if ((m = /^\s*pool:\s*(\S+)/.exec(raw))) {
      cur = { name: m[1], state: 'UNKNOWN', status: '', action: '', scanText: '', scan: { kind: null, state: 'none', text: '' }, errors: '', vdevs: [], busy: false };
      pools.push(cur); mode = null; section = 'data'; vdev = null; continue;
    }
    if (!cur) continue;
    if ((m = /^\s*state:\s*(\S+)/.exec(raw))) { cur.state = m[1]; mode = null; continue; }
    if ((m = /^\s*status:\s*(.*)$/.exec(raw))) { cur.status = m[1].trim(); mode = 'status'; continue; }
    if ((m = /^\s*action:\s*(.*)$/.exec(raw))) { cur.action = m[1].trim(); mode = 'action'; continue; }
    if ((m = /^\s*scan:\s*(.*)$/.exec(raw))) { cur.scanText = m[1].trim(); mode = 'scan'; continue; }
    if (/^\s*config:\s*$/.test(raw)) { mode = 'config'; continue; }
    if ((m = /^\s*errors:\s*(.*)$/.exec(raw))) { cur.errors = m[1].trim(); mode = null; continue; }
    if (/^\s*see:/.test(raw)) { mode = null; continue; }
    if (mode === 'scan' && /^\s+\S/.test(raw)) { cur.scanText += ' ' + raw.trim(); continue; }
    if ((mode === 'status' || mode === 'action') && /^\s+\S/.test(raw)) { cur[mode] += ' ' + raw.trim(); continue; }
    if (mode === 'config' && /^\t/.test(raw)) {
      const line = raw.replace(/^\t/, '');
      if (/^\s*NAME\s+STATE/.test(line)) continue;
      const lead = /^ */.exec(line)[0].length;
      const parts = line.trim().split(/\s+/);
      const [name, state, r, w, c] = parts;
      const hasCounts = parts.length >= 5 && /^\d+$/.test(r) && /^\d+$/.test(w) && /^\d+$/.test(c);
      const node = { name, state: state ?? null, read: hasCounts ? Number(r) : 0, write: hasCounts ? Number(w) : 0, cksum: hasCounts ? Number(c) : 0, note: parts.slice(hasCounts ? 5 : (state ? 2 : 1)).join(' ') };
      const depth = Math.floor(lead / 2);
      if (depth === 0) {
        if (SECTION_HEADERS.has(name) && !state) { section = name; vdev = null; }
        else { cur.root = node; vdev = null; }          // die Zeile mit dem Pool-Namen
        continue;
      }
      if (depth === 1) { vdev = { ...node, type: vdevType(name), section, devices: [] }; cur.vdevs.push(vdev); continue; }
      if (vdev) vdev.devices.push({ ...node, level: depth - 1 });
    }
  }
  for (const p of pools) {
    for (const v of p.vdevs) if (!v.type) { v.type = 'disk'; v.devices = [{ name: v.name, state: v.state, read: v.read, write: v.write, cksum: v.cksum, note: v.note, level: 1 }]; }
    p.scan = parseScan(p.scanText);
    p.busy = p.scan.state === 'running';
  }
  return pools;
}

/** `zpool list -H -p -o name,size,alloc,free,frag,cap,health` -> { poolName: {...} } */
export function parseZpoolList(text) {
  const out = {};
  for (const line of String(text ?? '').split('\n')) {
    const f = line.split('\t');
    if (f.length < 7 || !f[0]) continue;
    const num = (v) => (/^\d+$/.test(v) ? Number(v) : null);
    out[f[0]] = { size: num(f[1]), alloc: num(f[2]), free: num(f[3]), frag: num(f[4]), cap: num(f[5]), health: f[6] };
  }
  return out;
}

const worstOf = (levels) => levels.reduce((a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a), 'ok');

/** Bewertung eines Pools samt vdevs. now: Date */
export function ratePool(p, now = new Date()) {
  const f = [];
  const add = (level, code, title, text, advice = '') => f.push({ level, code, title, text, advice });
  if (BAD_STATES.has(p.state)) add('critical', 'pool-state', `Pool ${p.name}: ${p.state}`, p.status || 'Der Speicherpool ist nicht mehr voll redundant oder nicht verfügbar.', p.action || 'Betroffene Platte mit `zpool status` ermitteln und ersetzen. Backup prüfen.');
  if (p.errors && !/no known data errors/i.test(p.errors)) add('critical', 'pool-errors', `Pool ${p.name}: Datenfehler`, p.errors, 'Sofort Daten sichern und `zpool status -v` prüfen.');
  for (const v of p.vdevs) {
    const members = v.type === 'disk' ? v.devices : [v, ...v.devices];
    for (const d of members) {
      if (d.state && BAD_STATES.has(d.state) && !(d === v && v.type !== 'disk' && v.devices.length && p.state !== 'ONLINE' && false)) {
        add('critical', 'vdev-state', `${d.name}: ${d.state}`, `Im Pool ${p.name} ist ${d === v ? `der vdev ${v.name}` : `das Gerät ${d.name}`} im Zustand ${d.state}.`, 'Gerät prüfen und gegebenenfalls ersetzen.');
      }
      const errs = (d.read || 0) + (d.write || 0) + (d.cksum || 0);
      if (errs > 0) add('watch', 'vdev-errors', `${d.name}: Fehler gezählt`, `${d.read} Lesefehler, ${d.write} Schreibfehler, ${d.cksum} Prüfsummenfehler (Pool ${p.name}).`, 'Ein Scrub korrigiert Prüfsummenfehler meist. Kabel/Backplane und SMART der Platte prüfen. Danach `zpool clear` und beobachten, ob sie wiederkommen.');
    }
  }
  const sc = p.scan;
  if (sc?.state === 'finished') {
    if (sc.errors > 0) add('replace', 'scan-errors', `Letzter ${sc.kind === 'resilver' ? 'Resilver' : 'Scrub'} fand Fehler`, `${sc.errors} Fehler (repariert: ${sc.repaired}).`, 'Platten und Verkabelung prüfen.');
    if (sc.kind === 'scrub' && sc.finishedAt) {
      const days = Math.floor((now - new Date(sc.finishedAt)) / 864e5);
      if (days > 75) add('watch', 'scrub-old', 'Letzter Scrub ist lange her', `Der letzte Scrub war vor ${days} Tagen.`, 'Einen Scrub starten (`zpool scrub`), Proxmox macht das normalerweise monatlich.');
    }
  } else if (sc?.state === 'none') add('info', 'scrub-never', 'Noch nie ein Scrub', 'Für diesen Pool wurde kein Scrub protokolliert.', 'Einen Scrub einplanen.');
  if (p.cap != null) {
    if (p.cap >= 90) add('replace', 'pool-full', 'Pool fast voll', `${p.cap} % belegt. Ab ca. 90 % wird ZFS deutlich langsamer.`, 'Daten löschen oder Speicher erweitern.');
    else if (p.cap >= 80) add('watch', 'pool-filling', 'Pool füllt sich', `${p.cap} % belegt.`, 'Erweiterung einplanen.');
  }
  const level = worstOf(f.filter((x) => x.level !== 'info').map((x) => x.level));
  if (!f.some((x) => x.level !== 'info')) add('ok', 'all-good', 'Keine Auffälligkeiten', 'Pool und alle Geräte sind in Ordnung.');
  return { ...p, level, findings: f };
}
