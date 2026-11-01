// Liest die Textausgabe von `zpool status` und bewertet die Pools.

/** @returns {{name:string,state:string,scan:string,errors:string,busy:boolean}[]} */
export function parseZpoolStatus(text) {
  const pools = [];
  let cur = null;
  let inScan = false;
  for (const line of String(text ?? '').split('\n')) {
    let m;
    if ((m = line.match(/^\s*pool:\s*(\S+)/))) {
      cur = { name: m[1], state: 'UNKNOWN', scan: '', errors: '', busy: false };
      pools.push(cur); inScan = false; continue;
    }
    if (!cur) continue;
    if ((m = line.match(/^\s*state:\s*(\S+)/))) { cur.state = m[1]; inScan = false; continue; }
    if ((m = line.match(/^\s*scan:\s*(.*)$/))) { cur.scan = m[1].trim(); inScan = true; continue; }
    if ((m = line.match(/^\s*errors:\s*(.*)$/))) { cur.errors = m[1].trim(); inScan = false; continue; }
    if (/^\s*\w+:/.test(line)) { inScan = false; continue; } // anderer Schlüssel (status:, config: …)
    if (inScan && /^\s+\S/.test(line)) cur.scan += ' ' + line.trim();
  }
  for (const p of pools) p.busy = /(scrub|resilver)(ing)?\s+in progress|resilvering|scrub in progress/i.test(p.scan);
  return pools;
}

export function ratePool(p) {
  const bad = /^(DEGRADED)$/.test(p.state) ? 'critical' : /^(FAULTED|UNAVAIL|SUSPENDED|REMOVED)$/.test(p.state) ? 'critical' : null;
  const findings = [];
  if (bad) findings.push({ level: 'critical', code: 'pool-state', title: `Pool ${p.name}: ${p.state}`, text: 'Der Speicherpool ist nicht mehr voll redundant oder nicht verfügbar.', advice: 'Betroffene Platte mit `zpool status` ermitteln und ersetzen. Backup prüfen.' });
  if (p.errors && !/no known data errors/i.test(p.errors)) findings.push({ level: 'critical', code: 'pool-errors', title: `Pool ${p.name}: Datenfehler`, text: p.errors, advice: 'Sofort Daten sichern und `zpool status -v` prüfen.' });
  const level = findings.length ? 'critical' : 'ok';
  return { ...p, level, findings };
}
