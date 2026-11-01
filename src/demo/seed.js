// Erfundener Verlauf für den Demo-Modus: etwa ein Jahr Tests und Messwerte, damit die Diagramme etwas zeigen.
// Hält sich an dieselben Regeln wie der echte Zeitplan (nie montags, nie in der Sperrzeit 19:00–01:00).

function prng(seed) { // deterministisch
  let a = seed >>> 0;
  return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const DAY = 864e5;

export function seedDemo(db, hosts, now) {
  if (db.allRuns(0, 1).length) return false;
  const rnd = prng(42);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const allowedDay = (d) => { const x = new Date(d); while (x.getDay() === 1) x.setDate(x.getDate() + 1); return x; }; // nie Montag
  const at = (day, h, m) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime();

  for (const host of hosts) {
    const disks = db.disksOfHost(host.id);
    for (const [i, d] of disks.entries()) {
      const hdd = d.kind === 'hdd';
      const seg = d.polling_extended && d.polling_extended > 400; // große HDDs: Langtest in Abschnitten
      const startHour = host.kind === 'manuell' ? 9 + Math.floor(rnd() * 5) : 8 + Math.floor(rnd() * 6);
      let lastShort = null, lastLong = null;
      // Kurztests: monatlich, die letzten 12 Monate
      for (let m = 12; m >= 1; m--) {
        const day = allowedDay(new Date(now.getFullYear(), now.getMonth() - m, 1 + Math.floor(rnd() * 24) + (i % 3), 0));
        if (day > now) continue;
        const started = at(day, startHour, Math.floor(rnd() * 50));
        const minutes = (d.polling_short ?? 2) + Math.floor(rnd() * 2);
        const interrupted = rnd() < 0.04;
        db.addRun({ serial: d.serial, hostId: host.id, kind: 'short', started: new Date(started), ended: new Date(started + minutes * 60000), result: interrupted ? 'interrupted' : 'ok', note: interrupted ? 'Abgebrochen: Fensterende' : 'Completed without error', plannedMinutes: d.polling_short ?? 2, origin: 'plan' });
        if (!interrupted) lastShort = started;
      }
      // Langtests: etwa alle drei Monate
      for (const m of [10, 7, 4, 1]) {
        const failedCase = d.serial === 'ZHZ0RHKE' && m === 7;
        const first = allowedDay(new Date(now.getFullYear(), now.getMonth() - m, 4 + (i % 8), 0));
        if (first > now) continue;
        const segments = hdd && seg ? (d.polling_extended > 900 ? 3 : 2) : 1;
        let day = first;
        for (let sIdx = 0; sIdx < segments; sIdx++) {
          const started = at(day, 8, 25 + Math.floor(rnd() * 10));
          const planned = hdd && seg ? Math.round(d.polling_extended / segments * 1.05) : (d.polling_extended ?? 20);
          const last = sIdx === segments - 1;
          const cut = rnd() < 0.06 && !last;
          const ended = started + (cut ? 9.9 * 3600000 : planned * 60000);
          const kind = hdd && seg ? 'select' : 'long';
          db.addRun({ serial: d.serial, hostId: host.id, kind, started: new Date(started), ended: new Date(ended), result: cut ? 'interrupted' : failedCase && last ? 'failed' : 'ok',
            note: cut ? 'Abgebrochen: Fensterende' : failedCase && last ? 'Completed: read failure' : 'Completed without error', plannedMinutes: planned, origin: 'plan', completesLong: last && !cut });
          day = allowedDay(new Date(day.getTime() + DAY));
          if (last && !cut) lastLong = started;
        }
      }
      if (lastShort) db.setLastOk(d.serial, 'short', new Date(lastShort + (3 + Math.floor(rnd() * 18)) * DAY));
      if (lastLong) db.setLastOk(d.serial, 'long', new Date(lastLong));
      // Messwerte: täglich eine Messung, 60 Tage
      const base = d.kind === 'nvme' ? 38 : d.kind === 'ssd' ? 33 : 35 + (i % 4);
      for (let day = 60; day >= 1; day--) {
        const ts = new Date(now.getTime() - day * DAY); ts.setHours(12, 0, 0, 0);
        const temp = Math.round(base + 4 * Math.sin(day / 6 + i) + (rnd() - 0.5) * 3 + (day < 12 ? 2 : 0));
        db.addSample(d.serial, ts, { temp, hours: 1000 + (60 - day) * 24, level: 'ok' });
      }
    }
  }
  return true;
}
