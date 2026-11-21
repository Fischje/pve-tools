// Stromsparen: Auswertung der Bestandsaufnahme (Gate-Befehl „energie“) und Hinweise.
// Gemessen wird nichts; die Werte zeigen, ob CPU und PCIe-Geräte überhaupt sparen dürfen.

const STUFE_DE = { none: 'nein', L0s: 'L0s', L1: 'L1', L0sL1: 'L0s + L1' };
export { STUFE_DE };

function stufe(s) {
  if (!s || /not supported|Disabled/i.test(s)) return 'none';
  if (/L0s L1/.test(s)) return 'L0sL1';
  if (/L1/.test(s)) return 'L1';
  if (/L0s/.test(s)) return 'L0s';
  return 'none';
}

/** Ausgabe von „energie“ -> Objekt. */
export function parseEnergy(text) {
  const t = String(text ?? '');
  const out = { system: {}, cpufreq: {}, cstates: [], aspm: { policy: null, installed: false, boot: null, exclude: [] }, pci: [], sata: [], cpus: 1, uptimeSec: null };
  let sec = null, dev = null;
  for (const raw of t.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = /^== (\w+)/.exec(line);
    if (m) { sec = m[1]; continue; }
    const kv = /^([\w-]+)=(.*)$/.exec(line);
    if (sec === 'system' && kv) {
      if (kv[1] === 'cpus') out.cpus = Number(kv[2]) || 1;
      else if (kv[1] === 'uptime') out.uptimeSec = Number(kv[2]) || null;
      else out.system[kv[1]] = kv[2].trim();
    } else if (sec === 'cpufreq' && kv) out.cpufreq[kv[1]] = kv[2].trim();
    else if (sec === 'cstates') {
      const c = /^(state\d+)\s+(\S+)\s+(\d+)\s+(\d+)$/.exec(line.trim());
      if (c) out.cstates.push({ id: c[1], name: c[2], usage: Number(c[3]), timeUs: Number(c[4]) });
    } else if (sec === 'aspm' && kv) {
      if (kv[1] === 'policy') { const p = /\[(\w+)\]/.exec(kv[2]); out.aspm.policy = p ? p[1] : (kv[2].trim() || null); }
      else if (kv[1] === 'installed') out.aspm.installed = kv[2].trim() === 'yes';
      else if (kv[1] === 'boot') out.aspm.boot = kv[2].trim() || null;
      else if (kv[1] === 'exclude' && /^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/.test(kv[2].trim())) out.aspm.exclude.push(kv[2].trim());
    } else if (sec === 'pci') {
      const d = /^([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]) (.*)$/.exec(line);
      if (d) { dev = { addr: d[1], name: d[2].trim(), cap: null, ctl: null }; out.pci.push(dev); continue; }
      if (dev && /LnkCap:/.test(line)) { const a = /ASPM ([^,]*)/.exec(line); dev.cap = stufe(a ? a[1] : ''); }
      if (dev && /LnkCtl:/.test(line)) { const a = /ASPM ([^;]*)/.exec(line); dev.ctl = stufe(a ? a[1] : ''); }
    } else if (sec === 'sata') {
      const s = /^(host\d+)\s+(\S+)$/.exec(line.trim());
      if (s) out.sata.push({ host: s[1], policy: s[2] });
    }
  }
  out.pci = out.pci.filter((p) => p.cap != null); // nur Geräte mit PCIe-Link
  return out;
}

/** Anteil der Zeit je C-State seit dem Start (über alle CPUs). Der Rest ist „aktiv“ (C0). */
export function cstateShares(e) {
  const total = (e.uptimeSec ?? 0) * 1e6 * (e.cpus || 1);
  if (!total) return [];
  const rows = e.cstates.filter((c) => c.name !== 'POLL').map((c) => ({ ...c, pct: Math.min(100, Math.round((c.timeUs / total) * 1000) / 10) }));
  let idle = rows.reduce((s, r) => s + r.pct, 0);
  // Zähler und Laufzeit sind nicht exakt gleichzeitig gelesen: über 100 % auf 100 % zurückrechnen
  if (idle > 100) { for (const r of rows) r.pct = Math.round((r.pct / idle) * 1000) / 10; idle = 100; }
  return [{ id: 'c0', name: 'aktiv (C0)', pct: Math.max(0, Math.round((100 - idle) * 10) / 10) }, ...rows];
}

/** Hinweise: level ok | watch | info, mit Text und Was tun. */
export function rateEnergy(e) {
  const f = [];
  const add = (level, code, title, text, advice = '') => f.push({ level, code, title, text, advice });
  const gov = e.cpufreq.scaling_governor, drv = e.cpufreq.scaling_driver, epp = e.cpufreq.energy_performance_preference;
  if (gov === 'performance' && /pstate/.test(drv ?? '')) add('watch', 'governor', 'CPU-Regelung auf „performance“', `Treiber ${drv}: Die CPU bleibt dauerhaft auf hohem Takt.`, 'Auf „powersave“ stellen: Bei intel_pstate/amd-pstate heißt das trotzdem volle Leistung unter Last, aber sparsam im Leerlauf.');
  else if (gov === 'performance') add('watch', 'governor', 'CPU-Regelung auf „performance“', 'Die CPU bleibt dauerhaft auf hohem Takt.', 'Auf „schedutil“ oder „ondemand“ stellen.');
  if (epp && /^performance$/.test(epp)) add('watch', 'epp', 'Energievorgabe „performance“', 'Die CPU bevorzugt Leistung auch im Leerlauf.', 'Auf „balance_power“ oder „power“ stellen.');
  const sh = cstateShares(e).filter((r) => r.id !== 'c0' && r.pct >= 1);
  const deepest = sh.at(-1);
  if (e.cstates.length && !e.cstates.some((c) => /C[3-9]|C10/.test(c.name))) add('watch', 'cstates', 'Keine tiefen C-States verfügbar', `Der Kernel kennt nur ${e.cstates.map((c) => c.name).join(', ')}.`, 'Im BIOS die C-States einschalten (C-States, Package C-State Limit „Auto“ oder höchster Wert).');
  else if (deepest && !/C[6-9]|C10/.test(deepest.name)) add('info', 'cstates', 'Tiefe C-States werden kaum genutzt', `Am meisten Zeit in ${deepest.name}.`, 'Oft verhindert ein Gerät ohne ASPM die tiefen Zustände. Erst ASPM einschalten, dann erneut ansehen.');
  const off = e.pci.filter((p) => p.cap !== 'none' && p.ctl === 'none');
  if (off.length) add('watch', 'aspm', `${off.length} PCIe-${off.length === 1 ? 'Gerät spart' : 'Geräte sparen'} nicht`, `Sie können ASPM, es ist aber aus: ${off.slice(0, 4).map((p) => p.name.replace(/\s*\(rev [^)]*\)/, '')).join('; ')}${off.length > 4 ? ' …' : ''}`, 'Mit „ASPM einschalten“ unten. Danach einige Tage auf Verbindungsfehler achten.');
  if (e.pci.length && !e.pci.some((p) => p.cap !== 'none')) add('info', 'aspm-none', 'Kein Gerät meldet ASPM', 'Entweder ist ASPM im BIOS ausgeschaltet, oder die Geräte können es nicht.', 'Im BIOS „Native ASPM“ und „PCIe ASPM“ (L1) einschalten.');
  if (e.aspm.policy === 'performance') add('info', 'aspm-policy', 'Kernel-Vorgabe für ASPM: performance', 'Der Kernel schaltet ASPM selbst nicht ein.', 'Kein Muss: pvetools-aspm schaltet ASPM pro Gerät trotzdem ein.');
  const maxPerf = e.sata.filter((s) => s.policy === 'max_performance');
  if (maxPerf.length) add('info', 'sata', 'SATA ohne Stromsparen', `${maxPerf.length} SATA-Anschlüsse auf „max_performance“.`, 'Möglich ist „med_power_with_dipm“. Vorsicht bei Hosts mit Link-Fehlern (z. B. CRC-Zähler steigt): dort erst die Kabel prüfen.');
  if (!f.length) add('ok', 'all-good', 'Keine Auffälligkeiten', 'CPU-Regelung, C-States und ASPM sehen gut aus.');
  return f;
}
