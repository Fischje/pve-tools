// Bewertung einer Platte: vier Stufen mit Begründung und Handlungsempfehlung.
// ok = Gesund, watch = Beobachten, replace = Bald tauschen, critical = Kritisch.
// Die Regeln stehen in KONZEPT.md (Abschnitt „Bewertung“).

export const LEVEL_ORDER = ['ok', 'watch', 'replace', 'critical'];
export const LEVEL_LABEL = { ok: 'Gesund', watch: 'Beobachten', replace: 'Bald tauschen', critical: 'Kritisch', unknown: 'Unbekannt' };
const worst = (levels) => levels.reduce((a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a), 'ok');

/**
 * @param {object} disk Ergebnis von normalize()
 * @param {{baseline?: object|null, longHintDays?: number}} opts
 *   baseline: ein älterer Messpunkt (7–90 Tage alt) mit {reallocated, crc, reportedUncorrect, mediaErrors}.
 *   Fehlt er, wird nur der absolute Wert bewertet.
 */
export function rate(disk, { baseline = null, longHintDays = 120 } = {}) {
  if (disk.standby) return { level: 'unknown', score: null, healthText: 'Schläft', findings: [{ level: 'info', code: 'standby', title: 'Platte schläft', text: 'Die Platte ist im Standby. Zum Abfragen wurde sie nicht geweckt.', advice: '' }], wearUsed: null, remainingLife: null };
  if (disk.unreadable) return { level: 'unknown', score: null, healthText: 'Unbekannt', findings: [{ level: 'watch', code: 'unreadable', title: 'SMART nicht lesbar', text: 'smartctl lieferte keine auswertbaren Daten.', advice: 'Prüfen, ob die Platte hinter einem RAID-/HBA-Controller hängt.' }], wearUsed: null, remainingLife: null };

  const f = [];
  const add = (level, code, title, text, advice = '') => f.push({ level, code, title, text, advice });
  const rose = (cur, key) => baseline != null && baseline[key] != null && cur > baseline[key];

  if (disk.smartPassed === false) add('critical', 'smart-failed', 'SMART-Gesamtstatus: FAILED', 'Die Platte meldet selbst, dass sie ausfällt.', 'Sofort Daten sichern und Platte ersetzen.');

  if (disk.kind === 'nvme') rateNvme(disk, add, rose);
  else {
    rateAtaCommon(disk, add, rose);
    if (disk.kind === 'hdd') rateHdd(disk, add, rose);
    else rateSsd(disk, add);
  }
  rateSelfTests(disk, add, longHintDays, f);

  if (disk.hours > 30000) add('info', 'old', 'Alt', `Die Platte läuft seit ${Math.round(disk.hours / 8766 * 10) / 10} Jahren (${disk.hours} Betriebsstunden).`, 'Das ist allein kein Defekt, aber ein Grund für aktuelle Backups.');

  const level = worst(f.filter((x) => x.level !== 'info').map((x) => x.level));
  const wearUsed = disk.wearUsed;
  const base = { ok: 100, watch: 75, replace: 45, critical: 15 }[level];
  const score = wearUsed == null ? base : Math.max(0, Math.min(base, 100 - wearUsed));
  const healthText = level === 'ok' ? ((wearUsed ?? 0) <= 10 ? 'Ausgezeichnet' : 'Gut') : level === 'watch' ? 'Mittel' : 'Schlecht';
  f.sort((a, b) => ['critical', 'replace', 'watch', 'info', 'ok'].indexOf(a.level) - ['critical', 'replace', 'watch', 'info', 'ok'].indexOf(b.level));
  if (!f.some((x) => x.level !== 'info')) add('ok', 'all-good', 'Keine Auffälligkeiten', 'Alle geprüften Werte sind unauffällig.');
  return { level, score, healthText, findings: f, wearUsed, remainingLife: disk.remainingLife };
}

function rateAtaCommon(disk, add) {
  const a = disk.ata;
  if (a.failingAttrs.length) add('critical', 'attr-failing', 'Attribut unter Grenzwert', `Folgende SMART-Attribute liegen unter ihrem Grenzwert: ${a.failingAttrs.join(', ')}.`, 'Platte ersetzen.');
  if (a.pastFailedAttrs.length) add('watch', 'attr-past', 'Attribut war schon unter Grenzwert', `In der Vergangenheit waren betroffen: ${a.pastFailedAttrs.join(', ')}.`);
  if (a.unexpectedPowerLoss > 20) add('info', 'power-loss', 'Viele unsaubere Abschaltungen', `${a.unexpectedPowerLoss}× ohne ordentliches Herunterfahren (Stromausfall, harter Reset).`, 'Kein Defekt, aber bei vielen Fällen eine USV oder die Stromversorgung prüfen.');
}

function rateHdd(disk, add, rose) {
  const a = disk.ata;
  if (a.pending > 0 || a.offlineUncorrectable > 0) add('critical', 'bad-sectors-open', 'Defekte Sektoren, die nicht lesbar sind', `${a.pending} wartende und ${a.offlineUncorrectable} nicht korrigierbare Sektoren. Daten darauf können verloren sein.`, 'Sofort sichern und die Platte ersetzen.');
  if (a.reallocated > 0 && rose(a.reallocated, 'reallocated')) add('replace', 'realloc-rising', 'Umgelagerte Sektoren nehmen zu', `${a.reallocated} Sektoren wurden bereits ersetzt, und es werden mehr. Die Oberfläche der Platte verschleißt.`, 'Ersatz einplanen und Backup prüfen.');
  else if (a.reallocated > 0) add('watch', 'realloc', 'Umgelagerte Sektoren', `${a.reallocated} defekte Sektoren wurden durch Reserve ersetzt. Das ist stabil, wenn der Wert nicht weiter steigt.`, 'Im Verlauf beobachten. Steigt er, ist die Platte zu ersetzen.');
  if (a.reportedUncorrect > 0) add('replace', 'uncorrect', 'Nicht korrigierbare Lesefehler', `${a.reportedUncorrect}× konnte die Platte Daten nicht lesen.`, 'Ersatz einplanen und Backup prüfen.');
  if (disk.ataErrorCount > 0) add('watch', 'ata-errors', 'Einträge im Fehlerprotokoll', `Die Platte hat ${disk.ataErrorCount} Fehler protokolliert.`, 'Mit `smartctl -l error` ansehen.');
  if (a.crc > 0) {
    const rising = rose(a.crc, 'crc');
    if (rising || (a.crc >= 1000 && !rising)) add('watch', 'crc', rising ? 'Übertragungsfehler nehmen zu' : 'Viele Übertragungsfehler (CRC)', `${a.crc} Übertragungsfehler zwischen Platte und Controller${rising ? ', Tendenz steigend' : ' seit Beginn der Lebensdauer'}. Das liegt meist an Kabel, Stecker oder Backplane, nicht an der Platte.`, 'Kabel/Stecker/Backplane prüfen oder tauschen. Danach beobachten, ob der Wert noch steigt.');
  }
  if (disk.temperature >= 50) add('watch', 'temp', 'Platte ist warm', `${disk.temperature} °C. HDDs halten dauerhaft über 50 °C deutlich kürzer.`, 'Belüftung prüfen.');
}

function rateSsd(disk, add) {
  const a = disk.ata;
  const rem = disk.remainingLife;
  if (rem != null) {
    const txt = `Verschleiß ${100 - rem} %, Restlebensdauer ${rem} % (laut Platte).`;
    if (rem <= 10) add('critical', 'ssd-wear', 'SSD fast am Lebensende', txt, 'Sofort ersetzen.');
    else if (rem <= 20) add('replace', 'ssd-wear', 'SSD stark verschlissen', txt, 'Ersatz einplanen, in den nächsten Wochen bis Monaten. Kein Notfall, solange keine Fehler auftreten.');
    else if (rem <= 40) add('watch', 'ssd-wear', 'SSD verschleißt', txt, 'Im Auge behalten.');
  }
  if (a.reallocated > 0) add('watch', 'realloc', 'Umgelagerte Blöcke', `${a.reallocated} Blöcke wurden ersetzt.`);
  if (a.reportedUncorrect > 0) add('replace', 'uncorrect', 'Nicht korrigierbare Lesefehler', `${a.reportedUncorrect}× konnte die SSD Daten nicht lesen.`, 'Ersatz einplanen.');
  if (disk.temperature >= 70) add('watch', 'temp', 'SSD ist heiß', `${disk.temperature} °C.`, 'Belüftung prüfen.');
}

function rateNvme(disk, add, rose) {
  const n = disk.nvme;
  if (n.criticalWarning) add('critical', 'nvme-warning', 'NVMe meldet eine kritische Warnung', `Warnbits: 0x${n.criticalWarning.toString(16)} (zu wenig Reserve, Übertemperatur, Schreibschutz oder Ausfall).`, 'Sofort sichern und Ursache prüfen.');
  if (n.availableSpare != null && n.spareThreshold != null && n.availableSpare < n.spareThreshold) add('critical', 'nvme-spare', 'Reserve aufgebraucht', `Verfügbare Reserve ${n.availableSpare} % liegt unter dem Grenzwert ${n.spareThreshold} %.`, 'Sofort ersetzen.');
  const used = n.percentageUsed;
  if (used != null) {
    const txt = `Verschleiß ${used} %, Restlebensdauer ${Math.max(0, 100 - used)} %. ${used <= 10 ? 'Das ist fast neu.' : ''}`.trim();
    if (used >= 100) add('critical', 'nvme-wear', 'NVMe hat die Nennlebensdauer erreicht', txt, 'Ersetzen.');
    else if (used >= 90) add('replace', 'nvme-wear', 'NVMe fast verbraucht', txt, 'Ersatz einplanen.');
    else if (used >= 70) add('watch', 'nvme-wear', 'NVMe verschleißt', txt, 'Im Auge behalten.');
  }
  if (n.mediaErrors > 0) {
    if (rose(n.mediaErrors, 'mediaErrors')) add('replace', 'nvme-media', 'Medienfehler nehmen zu', `${n.mediaErrors} Medienfehler, und es werden mehr.`, 'Ersatz einplanen.');
    else add('watch', 'nvme-media', 'Medienfehler', `${n.mediaErrors} Medienfehler gemeldet.`, 'Beobachten, ob es mehr werden.');
  }
  if (disk.temperature >= 70) add('watch', 'temp', 'NVMe ist heiß', `${disk.temperature} °C.`, 'Kühlung prüfen (Kühlkörper, Luftstrom).');
  if (n.unsafeShutdowns > 20) add('info', 'power-loss', 'Unsaubere Abschaltungen', `${n.unsafeShutdowns}× ohne ordentliches Herunterfahren.`);
}

function rateSelfTests(disk, add, longHintDays, f) {
  const log = disk.selftest.log; // neuester zuerst
  const tests = log.filter((e) => e.result !== 'running' && e.result !== 'other');
  const newest = (kind) => tests.find((e) => e.kind === kind);
  for (const kind of ['short', 'extended', 'selective']) {
    const t = newest(kind);
    if (t?.result === 'failed') add('replace', 'test-failed', `Selbsttest fehlgeschlagen (${kind === 'short' ? 'Kurztest' : kind === 'extended' ? 'Langtest' : 'Abschnittstest'})`, `Letztes Ergebnis: ${t.text}. Die Platte konnte beim Test nicht alles fehlerfrei lesen.`, 'Ersatz einplanen und Backup prüfen. Kabel/Controller ausschließen.');
  }
  const failedOld = tests.filter((e) => e.result === 'failed' && newest(e.kind) !== e);
  if (failedOld.length && !f.some((x) => x.code === 'test-failed')) add('watch', 'test-failed-old', 'Frühere Selbsttest-Fehler', `${failedOld.length} frühere Test(s) sind fehlgeschlagen, spätere waren in Ordnung.`, 'Beobachten.');
  const lastLong = newest('extended');
  const hint = longHintDays;
  if (disk.hours != null) {
    if (!lastLong) add('info', 'no-long', 'Noch nie ein Langtest', 'Im Testprotokoll steht kein Langtest.', 'Einen Langtest einplanen.');
    else if (lastLong.hours != null) {
      const days = Math.round((disk.hours - lastLong.hours) / 24);
      if (days > hint) add('info', 'long-old', 'Letzter Langtest ist lange her', `Der letzte Langtest war vor etwa ${days} Tagen Betriebszeit (die Platte lief seitdem so lange).`, 'Einen Langtest einplanen.');
    }
  }
}
