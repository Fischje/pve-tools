// Auswertung der Kernel-Meldungen zu Verbindungsfehlern (SATA/NVMe), gelesen über den Gate-Befehl „kernel“.
// Solche Fehler liegen meist an Kabel, Stecker, Stromversorgung oder Port und nicht an der Platte selbst.

const LINE = /^(\S+)\s+\S+\s+kernel:\s+(.*)$/;

/** @returns {{ports:{port:string, errors:number, frozen:number, resets:number, slowLink:string|null, first:string, last:string}[], total:number}} */
export function parseKernelLog(text) {
  const map = new Map();
  for (const raw of String(text ?? '').split('\n')) {
    const m = LINE.exec(raw.trim());
    if (!m) continue;
    const [, ts, msg] = m;
    const pm = /^(ata\d+)(?:\.\d+)?:\s*(.*)$/.exec(msg) ?? /^(nvme\d+):\s*(.*)$/.exec(msg);
    if (!pm) continue;
    const [, port, rest] = pm;
    const e = map.get(port) ?? { port, errors: 0, frozen: 0, resets: 0, slowLink: null, first: ts, last: ts };
    if (/ATA bus error|failed command/.test(rest)) e.errors++;
    if (/frozen|SError/.test(rest)) e.frozen++;
    if (/hard resetting|reset|timeout|controller is down/.test(rest)) e.resets++;
    const sl = /link up (1\.5|3\.0) Gbps/.exec(rest);
    if (sl) e.slowLink = `${sl[1]} Gbps`;
    if (ts < e.first) e.first = ts;
    if (ts > e.last) e.last = ts;
    map.set(port, e);
  }
  const ports = [...map.values()].filter((p) => p.errors || p.frozen || p.resets || p.slowLink).sort((a, b) => b.last.localeCompare(a.last));
  return { ports, total: ports.reduce((n, p) => n + p.errors + p.frozen + p.resets, 0) };
}

/** Befunde für die Oberfläche und Mails. Mehrere Fehler oder ein Einfrieren der Verbindung zählen als „Bald tauschen“ (Kabel/Anschluss). */
export function rateKernel(k) {
  return (k?.ports ?? []).map((p) => {
    const hard = p.frozen > 0 || p.errors >= 3 || p.resets > 0;
    return {
      level: hard ? 'replace' : 'watch', code: 'link-errors', port: p.port, last: p.last,
      title: `Verbindungsfehler an ${p.port}`,
      text: `${p.errors} Übertragungsfehler${p.frozen ? `, Verbindung ${p.frozen}× eingefroren` : ''}${p.resets ? `, ${p.resets}× zurückgesetzt` : ''}${p.slowLink ? `, Link auf ${p.slowLink} zurückgefallen` : ''} (zuletzt ${p.last.replace('T', ' ').slice(0, 16)}). Das liegt meist an Kabel, Stecker oder Stromversorgung, selten an der Platte.`,
      advice: 'SATA-Datenkabel und Stromstecker der Platte tauschen oder neu stecken, notfalls anderen Port nehmen. Danach beobachten, ob neue Meldungen kommen und ob der CRC-Zähler der Platte weiter steigt.',
      signature: `${p.port}:${p.last}`,
    };
  });
}
