// Demo: Tasmota-Steckdosen ohne Netzwerk. Leistung je Host nach Tageszeit, PBS nur montags an; Verlauf der letzten Tage.
const BASE = { router: 11, pve: 78, pbs: 34 };
const ADDR = { router: '10.0.0.21', pve: '10.0.0.22', pbs: '10.0.0.23' };

export function demoWatts(hostId, d, up = true) {
  if (!up) return hostId === 'pbs' ? 0.9 : 0;
  const h = d.getHours() + d.getMinutes() / 60, load = Math.max(0, Math.sin(((h - 7) / 24) * 2 * Math.PI));
  return Math.round((BASE[hostId] * (0.85 + 0.35 * load) + ((d.getTime() / 60000) % 7) * 0.3) * 10) / 10;
}

/** Messpunkte anlegen und 8 Tage Verlauf (alle 5 Minuten) einspielen, wenn noch keine da sind. */
export function seedPower(db, hosts, now) {
  if (db.getSetting('power_meters')) return;
  db.setSetting('power_meters', JSON.stringify(hosts.map((h) => ({ id: `steckdose-${h.id}`, label: `Steckdose ${h.label}`, address: ADDR[h.id] ?? '10.0.0.29', hostId: h.id }))));
  for (const h of hosts) {
    let total = { router: 210, pve: 1480, pbs: 95 }[h.id] ?? 50;
    for (let t = now.getTime() - 8 * 864e5; t <= now.getTime(); t += 5 * 60000) {
      const d = new Date(t), up = h.id !== 'pbs' || (d.getDay() === 1 && d.getHours() >= 8 && d.getHours() < 13);
      // vor 3 Tagen „ASPM eingeschaltet“: router ab da etwas sparsamer
      const w = demoWatts(h.id, d, up) * (h.id === 'router' && t > now.getTime() - 3 * 864e5 ? 0.85 : 1);
      total += (w * 5) / 60 / 1000;
      db.addPower(`steckdose-${h.id}`, new Date(t), w, Math.round(total * 1000) / 1000);
    }
  }
  db.addEvent(new Date(now.getTime() - 3 * 864e5), 'router', null, 'Energie: ASPM eingeschaltet');
}

/** Ersatz für readTasmota in der Demo. */
export function demoReader(world, clock, db) {
  const byAddr = Object.fromEntries(Object.entries(ADDR).map(([k, v]) => [v, k]));
  const tot = new Map(), last = new Map();
  return async (address) => {
    const id = byAddr[address];
    if (!id) throw new Error('nicht erreichbar');
    const d = clock(), w = demoWatts(id, d, world.state.get(id)?.up !== false);
    // Zählerstand fortschreiben, ausgehend vom letzten gespeicherten Wert
    if (!tot.has(id)) tot.set(id, db?.powerSince(`steckdose-${id}`, 0).at(-1)?.total ?? 1000);
    const lt = last.get(id) ?? d.getTime(); tot.set(id, tot.get(id) + (w * (d.getTime() - lt)) / 3.6e9); last.set(id, d.getTime());
    return { power: w, today: Math.round(w * d.getHours() * 0.9) / 1000, yesterday: Math.round(w * 22) / 1000, total: Math.round(tot.get(id) * 1000) / 1000, voltage: 231, time: d.toISOString() };
  };
}
