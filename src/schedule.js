// Zeitplanlogik für Selbsttests. Reine Funktionen ohne Zugriff auf Datenbank oder Netzwerk,
// damit sich alle Regeln einzeln testen lassen. Alle Zeiten sind lokale Zeit des Servers (TZ setzen!).
// Regeln: siehe KONZEPT.md, Abschnitt „Zeitplan für Selbsttests“.

export const DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'fest',                          // 'fest' = fester Rhythmus, 'manuell' = Start von Hand, festes Tagesende
  window: { from: '08:00', to: '22:00' }, // Betriebsfenster (mode 'fest')
  dayEnd: '19:00',                        // Tagesende (mode 'manuell', der Host schaltet sich selbst ab)
  blockedWeekdays: [1],                   // 0 = Sonntag … 1 = Montag … 6 = Samstag
  blockedTimes: [{ from: '19:00', to: '01:00' }], // täglich, darf über Mitternacht gehen
  shortIntervalMonths: 1,
  longIntervalMonths: 3,
  startupMinutes: 20,                     // Anlaufzeit nach dem Hochfahren
  marginMinutes: 30,                      // Sicherheitsabstand vor Ende
  reservePercent: 10,                     // Reserve bei der Abschnittsgröße
  minSegmentMinutes: 20,                  // kleinere Abschnitte lohnen nicht
  autoStart: true,                        // nur mode 'manuell': Test startet nach der Anlaufzeit selbst
  longHintDays: 120,
};

const ABORT_LEAD_MIN = 2; // Schon kurz vor dem harten Ende abbrechen, weil nur minütlich geprüft wird.

export const parseHM = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
export const atMinutes = (day, min) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, min, 0, 0);
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n, d.getHours(), d.getMinutes(), d.getSeconds());
export const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Kalendermonate addieren; ein 31. wird auf den letzten Tag des Zielmonats gekürzt. */
export function addMonths(d, n) {
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1, d.getHours(), d.getMinutes());
  const last = new Date(t.getFullYear(), t.getMonth() + 1, 0).getDate();
  t.setDate(Math.min(d.getDate(), last));
  return t;
}

export const dayAllowed = (d, s) => !s.blockedWeekdays.includes(d.getDay());

/** Alle Sperrzeit-Intervalle, die sich mit gestern bis übermorgen überschneiden. */
export function blockedIntervals(now, blockedTimes) {
  const out = [];
  for (let off = -1; off <= 2; off++) {
    const day = addDays(startOfDay(now), off);
    for (const b of blockedTimes ?? []) {
      const from = parseHM(b.from); let to = parseHM(b.to);
      const start = atMinutes(day, from);
      if (to <= from) to += 1440;
      out.push({ start, end: atMinutes(day, to) });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * Darf jetzt getestet werden, und bis wann?
 * @returns {{open:boolean, hardClosed:boolean, reason:string, softEnd:Date|null, hardEnd:Date|null, minutesLeft:number}}
 *   hardClosed = es gilt eine Sperre (Wochentag/Sperrzeit/Ende) -> laufende Tests müssen abgebrochen werden.
 */
export function testWindow(now, s, uptimeSec) {
  const closed = (reason, hard = false) => ({ open: false, hardClosed: hard, reason, softEnd: null, hardEnd: null, minutesLeft: 0 });
  if (!s.enabled) return closed('Zeitplan ist pausiert');
  if (!dayAllowed(now, s)) return closed('Gesperrter Wochentag', true);
  const ivs = blockedIntervals(now, s.blockedTimes);
  const inBlock = ivs.find((i) => now >= i.start && now < i.end);
  if (inBlock) return closed(`Sperrzeit bis ${hhmm(inBlock.end)}`, true);

  const from = s.mode === 'manuell' ? 0 : parseHM(s.window.from);
  const to = parseHM(s.mode === 'manuell' ? s.dayEnd : s.window.to);
  const winStart = atMinutes(now, from), winEnd = atMinutes(now, to);
  if (now < winStart) return closed(`Host läuft laut Plan erst ab ${s.window.from}`);
  if (now >= winEnd) return closed('Betriebsfenster ist zu Ende', true);

  let hardEnd = winEnd;
  const nextBlock = ivs.find((i) => i.start > now);
  if (nextBlock && nextBlock.start < hardEnd) hardEnd = nextBlock.start;
  const tomorrow = addDays(startOfDay(now), 1);
  if (!dayAllowed(tomorrow, s) && tomorrow < hardEnd) hardEnd = tomorrow;

  if (uptimeSec == null) return closed('Laufzeit des Hosts unbekannt');
  if (uptimeSec < s.startupMinutes * 60) return closed(`Anlaufzeit: noch ${Math.ceil((s.startupMinutes * 60 - uptimeSec) / 60)} min`);

  const softEnd = new Date(hardEnd.getTime() - s.marginMinutes * 60000);
  if (now >= softEnd) return { open: false, hardClosed: now >= new Date(hardEnd.getTime() - ABORT_LEAD_MIN * 60000), reason: 'Sicherheitsabstand vor dem Ende', softEnd, hardEnd, minutesLeft: 0 };
  return { open: true, hardClosed: false, reason: '', softEnd, hardEnd, minutesLeft: Math.floor((softEnd - now) / 60000) };
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

export const isDue = (lastOk, months, now) => lastOk == null || now >= startOfDay(addMonths(lastOk, months));

/** Erster erlaubter Tag ab dem Fälligkeitstag, nie in der Vergangenheit. */
export function nextAllowedDay(lastOk, months, now, s) {
  let d = lastOk == null ? startOfDay(now) : startOfDay(addMonths(lastOk, months));
  if (d < startOfDay(now)) d = startOfDay(now);
  for (let i = 0; i < 8 && !dayAllowed(d, s); i++) d = addDays(d, 1);
  return d;
}

/**
 * Planung eines Langtests für eine Platte.
 * @returns {{test:'long'}|{test:'select',from:number,to:number,minutes:number}|{wait:string}}
 */
export function planLong(disk, minutesLeft, s) {
  const ext = disk.pollingExtended;
  const reserve = 1 + s.reservePercent / 100;
  const prog = disk.longProgress;
  if (!prog && (ext ? ext * reserve <= minutesLeft : minutesLeft >= 60)) return { test: 'long', minutes: ext ?? null };
  if (!disk.selective || !disk.totalLba) {
    const need = ext ? Math.ceil(ext * reserve) : 60;
    return { wait: `Langtest braucht ca. ${need} min am Stück, frei sind ${minutesLeft} min (selektive Tests nicht unterstützt)`, tooLong: true };
  }
  const speed = prog?.lbaPerMin ?? disk.lbaPerMin ?? (ext ? disk.totalLba / ext : null);
  if (!speed) return { wait: 'Testgeschwindigkeit unbekannt', tooLong: true };
  const segMin = Math.floor(minutesLeft / reserve);
  if (segMin < s.minSegmentMinutes) return { wait: `Nur noch ${minutesLeft} min frei, zu wenig für einen Abschnitt` };
  const from = prog?.nextLba ?? 0;
  const remaining = disk.totalLba - from;
  const lba = Math.min(remaining, Math.floor(speed * segMin));
  return { test: 'select', from, to: from + lba - 1, minutes: Math.ceil(lba / speed), last: lba >= remaining };
}

const byOldest = (key) => (a, b) => (a[key]?.getTime() ?? -Infinity) - (b[key]?.getTime() ?? -Infinity) || String(a.serial).localeCompare(String(b.serial));

/**
 * Was soll dieser Host jetzt tun?
 * @param {Date} now
 * @param {object} s Einstellungen (DEFAULT_SETTINGS + Überschreibungen)
 * @param {object} st Zustand: {reachable, uptimeSec, zfsBusy, todayRuns:{short,long}, approval:{skipDate,snoozeUntil,goNow}, disks:[…]}
 * @returns {{action:'start'|'abort'|'none', reason:string, serial?:string, device?:string, test?:object, kind?:'short'|'long'}}
 */
export function decide(now, s, st) {
  const none = (reason) => ({ action: 'none', reason });
  if (!st.reachable) return none('Host nicht erreichbar');
  const win = testWindow(now, s, st.uptimeSec);
  const running = st.disks.find((d) => d.running);

  if (running) {
    if (win.hardClosed || (win.hardEnd && now >= new Date(win.hardEnd.getTime() - ABORT_LEAD_MIN * 60000))) {
      return { action: 'abort', serial: running.serial, device: running.device, reason: win.reason || 'Testfenster zu Ende' };
    }
    return none(`Test läuft auf ${running.device}`);
  }
  if (!win.open) return none(win.reason);
  if (st.zfsBusy) return none('ZFS-Scrub oder Resilver läuft');
  if (st.backupBusy) return none('Ein Backup läuft');

  if (s.mode === 'manuell') {
    const ap = st.approval ?? {};
    if (ap.skipDate === dayKey(now)) return none('Heute nicht testen (Auswahl im Banner)');
    if (ap.snoozeUntil && new Date(ap.snoozeUntil) > now) return none('Später (Auswahl im Banner)');
    if (!s.autoStart && !ap.goNow) return none('Wartet auf Freigabe per Klick');
  }

  const disks = st.disks.filter((d) => !d.paused && !d.cooldown);
  const todayRuns = st.todayRuns ?? {};

  // Langtest hat Vorrang, aber nie am selben Tag wie ein Kurztest.
  const longCands = disks.filter((d) => d.longProgress || isDue(d.lastLongOk, s.longIntervalMonths, now));
  if (longCands.length) {
    if (todayRuns.short) return none('Heute lief schon ein Kurztest, Langtest ab morgen');
    const ordered = [...longCands.filter((d) => d.longProgress).sort(byOldest('lastLongOk')), ...longCands.filter((d) => !d.longProgress).sort(byOldest('lastLongOk'))];
    let wait = null;
    for (const d of ordered) {
      const plan = planLong(d, win.minutesLeft, s);
      if (plan.test) return { action: 'start', kind: 'long', serial: d.serial, device: d.device, test: plan, reason: 'Langtest fällig' };
      if (!plan.tooLong) return none(`${d.device}: ${plan.wait}`); // seriell: auf diese Platte warten
      wait ??= `${d.device}: ${plan.wait}`;
    }
    return none(wait ?? 'Langtest wartet');
  }

  if (todayRuns.long) return none('Heute lief schon ein Langtest, Kurztest ab morgen');
  const shortCands = disks.filter((d) => isDue(d.lastShortOk, s.shortIntervalMonths, now)).sort(byOldest('lastShortOk'));
  if (shortCands.length) {
    const d = shortCands[0];
    const need = (d.pollingShort ?? 5) + 2;
    if (win.minutesLeft < need) return none('Zu wenig Zeit bis zum Ende des Fensters für einen Kurztest');
    return { action: 'start', kind: 'short', serial: d.serial, device: d.device, test: { test: 'short', minutes: d.pollingShort }, reason: 'Kurztest fällig' };
  }
  return none('Nichts fällig');
}

/** Dürfen wir jetzt auf Knopfdruck (nicht nach Zeitplan) einen Test starten? */
export function canStartManual(now, s, st, serial, type) {
  if (!st.reachable) return { ok: false, reason: 'Host nicht erreichbar' };
  const win = testWindow(now, s, st.uptimeSec);
  if (!win.open) return { ok: false, reason: win.reason };
  if (st.disks.some((d) => d.running)) return { ok: false, reason: 'Auf diesem Host läuft schon ein Test' };
  if (st.zfsBusy) return { ok: false, reason: 'ZFS-Scrub oder Resilver läuft' };
  if (st.backupBusy) return { ok: false, reason: 'Ein Backup läuft' };
  const d = st.disks.find((x) => x.serial === serial);
  if (!d) return { ok: false, reason: 'Platte unbekannt' };
  if (type === 'short') {
    if (win.minutesLeft < (d.pollingShort ?? 5) + 2) return { ok: false, reason: 'Zu wenig Zeit bis zum Ende des Fensters' };
    return { ok: true, test: { test: 'short', minutes: d.pollingShort } };
  }
  const plan = planLong(d, win.minutesLeft, s);
  return plan.test ? { ok: true, test: plan } : { ok: false, reason: plan.wait };
}

/** Nächste geplante Tage für die Anzeige. */
export function nextPlanned(now, s, disk) {
  return {
    short: nextAllowedDay(disk.lastShortOk, s.shortIntervalMonths, now, s),
    long: disk.longProgress ? startOfDay(now) : nextAllowedDay(disk.lastLongOk, s.longIntervalMonths, now, s),
  };
}

/** Bei erfolgreichem Abschnitt: Fortschritt fortschreiben. */
export function advanceProgress(prog, segment, totalLba, minutesTaken) {
  const lbaPerMin = minutesTaken > 0 ? Math.round((segment.to - segment.from + 1) / minutesTaken) : prog?.lbaPerMin ?? null;
  const next = segment.to + 1;
  return next >= totalLba ? { done: true } : { done: false, progress: { nextLba: next, totalLba, lbaPerMin, segments: (prog?.segments ?? 0) + 1 } };
}
