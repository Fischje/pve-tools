// E-Mail-Benachrichtigung: eine Mail pro Änderung, keine Wiederholung bei jeder Abfrage.
// Anlässe: Platte wechselt auf „Bald tauschen“/„Kritisch“, ZFS-Pool-Fehler, Selbsttest fehlgeschlagen. Optional eine Entwarnung.
import { rate, LEVEL_LABEL, LEVEL_ORDER } from './rating.js';
import { ratePool } from './zfs.js';
import { sendMail, validAddress } from './smtp.js';

export const MAIL_DEFAULTS = {
  enabled: false, host: '', port: 587, security: 'starttls', user: '', from: '', to: '', baseUrl: '', rejectUnauthorized: true,
  notify: { disk: true, pool: true, test: true, recovery: true, link: true, backup: true }, baselineAt: null,
};
const rank = (l) => LEVEL_ORDER.indexOf(l);
const ICON = { critical: '✖', replace: '▲', watch: '!', ok: '✔', info: 'i' };

/** Prüft die Mail-Einstellungen aus der Oberfläche. Wirft bei ungültigen Werten. */
export function cleanMail(input) {
  const out = {};
  const str = (v, max, name) => { const t = String(v ?? '').trim(); if (t.length > max || /[\r\n\0]/.test(t)) throw new Error(`${name}: ungültiger Wert`); return t; };
  if ('enabled' in input) out.enabled = !!input.enabled;
  if ('host' in input) { out.host = str(input.host, 253, 'Server'); if (out.host && !/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9a-fA-F:]+$/.test(out.host)) throw new Error('Server: ungültiger Name oder Adresse'); }
  if ('port' in input) { const p = Number(input.port); if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error('Port: erlaubt sind 1 bis 65535'); out.port = p; }
  if ('security' in input) { if (!['none', 'starttls', 'ssl'].includes(input.security)) throw new Error('Verschlüsselung: ungültig'); out.security = input.security; }
  if ('user' in input) out.user = str(input.user, 200, 'Benutzer');
  if ('from' in input) { out.from = str(input.from, 254, 'Absender'); if (out.from && !validAddress(out.from)) throw new Error('Absender: ungültige Adresse'); }
  if ('to' in input) {
    const list = String(input.to ?? '').split(/[,;\s]+/).filter(Boolean);
    if (list.length > 5) throw new Error('Empfänger: höchstens 5 Adressen');
    for (const a of list) if (!validAddress(a)) throw new Error(`Empfänger: „${a}“ ist keine gültige Adresse`);
    out.to = list.join(', ');
  }
  if ('baseUrl' in input) { out.baseUrl = str(input.baseUrl, 200, 'Adresse der Oberfläche'); if (out.baseUrl && !/^https?:\/\/[^\s]+$/.test(out.baseUrl)) throw new Error('Adresse der Oberfläche: muss mit http:// oder https:// beginnen'); }
  if ('rejectUnauthorized' in input) out.rejectUnauthorized = !!input.rejectUnauthorized;
  if ('notify' in input) out.notify = { disk: !!input.notify?.disk, pool: !!input.notify?.pool, test: !!input.notify?.test, recovery: !!input.notify?.recovery, link: input.notify?.link !== false, backup: input.notify?.backup !== false };
  return out;
}

export class Notifier {
  /** @param {{db, engine, send?: Function}} o */
  constructor({ db, engine, send = sendMail }) { this.db = db; this.engine = engine; this.send = send; }

  config() {
    let c = {}; try { c = JSON.parse(this.db.getSetting('mail') ?? '{}'); } catch { /* Standard */ }
    return { ...MAIL_DEFAULTS, ...c, notify: { ...MAIL_DEFAULTS.notify, ...(c.notify ?? {}) } };
  }
  /** Ohne Passwort, für die Oberfläche. */
  publicConfig() { return { config: this.config(), passwordSet: !!this.db.getSetting('mail_password') }; } // gitleaks:allow (Feldname)
  save(patch, { password, clearPassword } = {}) {
    const merged = { ...this.config(), ...patch };
    if (clearPassword) this.db.delSetting('mail_password');
    else if (password) this.db.setSetting('mail_password', password);
    this.db.setSetting('mail', JSON.stringify(merged));
    // Beim Einschalten werden bestehende Probleme still als „bekannt“ gemerkt. Gemeldet wird nur, was danach neu passiert.
    if (merged.enabled && !merged.baselineAt) this.baseline();
    if (!merged.enabled && merged.baselineAt) this.db.setSetting('mail', JSON.stringify({ ...merged, baselineAt: null }));
  }
  ready() { const c = this.config(); return !!(c.enabled && c.host && c.from && c.to && c.baselineAt); }
  ok() { const c = this.config(); return !!(c.host && c.from && c.to); }

  async deliver(subject, text) {
    const c = this.config();
    await this.send({ host: c.host, port: c.port, security: c.security, user: c.user, password: this.db.getSetting('mail_password') ?? '', rejectUnauthorized: c.rejectUnauthorized, // gitleaks:allow (Übergabe an den Mailversand, kein Klartext im Code)
      from: c.from, to: c.to.split(/[,;\s]+/).filter(Boolean), subject, text });
  }
  /** Sendet und merkt sich Fehler (höchstens einmal pro Stunde im Ereignisprotokoll). Gibt true bei Erfolg. */
  async safeDeliver(subject, text) {
    try { await this.deliver(subject, text); return true; } catch (e) {
      const key = 'mail-error', prev = this.db.getAlert(key), now = this.engine.now();
      if (!prev || prev.alerted !== e.message || now - prev.updated > 3600e3) { this.engine.event(null, null, `Mail konnte nicht gesendet werden: ${e.message}`); this.db.setAlert(key, 'error', e.message, now); }
      return false;
    }
  }

  // ---- Zustand sammeln ----
  snapshot(hostId) {
    const now = this.engine.now(), host = this.engine.hosts.find((h) => h.id === hostId);
    const s = this.engine.settings(hostId);
    const disks = this.db.disksOfHost(hostId).filter((d) => d.last_raw).map((d) => {
      const raw = JSON.parse(d.last_raw);
      const r = rate(raw, { baseline: this.db.baseline(d.serial, now), crcBaseline: this.db.crcBaseline(d.serial, now), longHintDays: s.longHintDays });
      return { crc: raw.ata?.crc ?? null, serial: d.serial, label: `${d.model} (${d.device})`, model: d.model, device: d.device, level: r.level, findings: r.findings };
    });
    const pools = (this.db.getHostState(hostId)?.pools ?? []).map((p) => ratePool(p, now));
    return { host, disks, pools };
  }
  poolSignature(p) { return p.findings.filter((f) => ['critical', 'replace'].includes(f.level) || f.code === 'vdev-errors').map((f) => `${f.code}:${f.title}`).sort(); }
  link(c) { return c.baseUrl ? `\nÖffnen: ${c.baseUrl} (Reiter „Hosts im Detail“)\n` : ''; }
  findingLines(list) { return list.filter((f) => f.level !== 'ok').map((f) => ` ${ICON[f.level] ?? '·'} ${f.title}: ${f.text}${f.advice ? `\n    Was tun? ${f.advice}` : ''}`).join('\n'); }
  foot() { return '\n--\nDiese Mail kommt nur bei einer Änderung und wird nicht wiederholt, solange der Zustand gleich bleibt.\nFischje\'s PVE-Tools'; }

  /** Merkt den aktuellen Zustand aller Platten und Pools, ohne Mails zu senden. */
  baseline() {
    const now = this.engine.now();
    for (const h of this.engine.hosts) {
      const { disks, pools } = this.snapshot(h.id);
      for (const d of disks) { this.db.setAlert(`disk:${d.serial}`, d.level, d.level, now); if (d.crc != null) this.db.setAlert(`crc:${d.serial}`, 'seen', `${d.crc}|0`, now); }
      const lf = this.engine.linkFindings(h.id); if (lf.length) this.db.setAlert(`link:${h.id}`, 'seen', `${lf.map((f) => f.signature).join(',')}|0`, now);
      for (const p of pools) this.db.setAlert(`pool:${h.id}:${p.name}`, p.level, JSON.stringify(this.poolSignature(p)), now);
    }
    const c = this.config();
    this.db.setSetting('mail', JSON.stringify({ ...c, baselineAt: now.toISOString() }));
  }

  /** Nach jeder Abfrage eines Hosts aufrufen. */
  async evaluateHost(hostId) {
    if (!this.ready()) return;
    const c = this.config(), now = this.engine.now();
    const { host, disks, pools } = this.snapshot(hostId);
    const hl = host.label ?? host.id;
    for (const d of disks) {
      const key = `disk:${d.serial}`, prev = this.db.getAlert(key);
      const alerted = prev?.alerted ?? 'ok';
      let next = alerted;
      // Allein wegen eines fehlgeschlagenen Selbsttests: Dafür gibt es schon die Selbsttest-Mail, nicht doppelt melden.
      const onlyTest = c.notify.test && d.findings.filter((f) => rank(f.level) >= rank('replace')).every((f) => f.code === 'test-failed');
      if (onlyTest && rank(d.level) >= rank('replace') && rank(d.level) > rank(alerted)) next = d.level;
      else if (c.notify.disk && rank(d.level) >= rank('replace') && rank(d.level) > rank(alerted)) {
        const ok = await this.safeDeliver(`[Platten] ${hl}: ${d.model} – ${LEVEL_LABEL[d.level]}`,
          `Host: ${hl}\nPlatte: ${d.label}\nSeriennummer: ${d.serial}\nZustand: ${LEVEL_LABEL[d.level]}\n\nBefunde:\n${this.findingLines(d.findings)}\n${this.link(c)}${this.foot()}`);
        if (ok) next = d.level;
      } else if (c.notify.recovery && rank(alerted) >= rank('replace') && rank(d.level) < rank('replace')) {
        const ok = await this.safeDeliver(`[Platten] ${hl}: ${d.model} – wieder in Ordnung (${LEVEL_LABEL[d.level]})`, `Host: ${hl}\nPlatte: ${d.label}\nDer Zustand ist jetzt: ${LEVEL_LABEL[d.level]}.\n${this.link(c)}${this.foot()}`);
        if (ok) next = d.level;
      } else if (rank(d.level) < rank(alerted)) next = d.level; // verbessert, aber keine Mail gewünscht
      this.db.setAlert(key, d.level, next, now);
    }
    await this.checkLinks(hostId, hl, disks, c, now);
    for (const p of pools) {
      const key = `pool:${hostId}:${p.name}`, prev = this.db.getAlert(key);
      const was = new Set(prev ? JSON.parse(prev.alerted || '[]') : []), cur = this.poolSignature(p), curSet = new Set(cur);
      const added = cur.filter((x) => !was.has(x));
      let next = prev?.alerted ?? '[]';
      if (c.notify.pool && added.length) {
        const worst = p.findings.filter((f) => cur.includes(`${f.code}:${f.title}`));
        const ok = await this.safeDeliver(`[ZFS] ${hl}: Pool ${p.name} – ${p.level === 'critical' ? 'Fehler' : 'Auffälligkeit'}`,
          `Host: ${hl}\nPool: ${p.name} (Zustand laut ZFS: ${p.state})\n\nBefunde:\n${this.findingLines(worst)}\n${this.link(c)}${this.foot()}`);
        if (ok) next = JSON.stringify(cur);
      } else if (c.notify.recovery && was.size && !curSet.size) {
        const ok = await this.safeDeliver(`[ZFS] ${hl}: Pool ${p.name} – wieder in Ordnung`, `Host: ${hl}\nPool: ${p.name}\nDie gemeldeten Auffälligkeiten sind nicht mehr vorhanden.\n${this.link(c)}${this.foot()}`);
        if (ok) next = '[]';
      } else if (!added.length) next = JSON.stringify(cur.filter((x) => was.has(x)));
      this.db.setAlert(key, p.level, next, now);
    }
  }

  /**
   * Verbindungsfehler (Kabel/Anschluss): CRC-Zähler einer Platte steigt, oder der Kernel meldet SATA/NVMe-Fehler.
   * Höchstens eine Mail je 12 Stunden und Ursache, damit ein dauerhaft wackelndes Kabel nicht jede Stunde eine Mail auslöst.
   */
  async checkLinks(hostId, hl, disks, c, now) {
    if (!c.notify.link) return;
    const COOL = 12 * 3600e3, link = this.link(c);
    for (const d of disks) {
      const rising = d.findings.some((f) => f.code === 'crc' && f.title.startsWith('Übertragungsfehler nehmen zu'));
      const key = `crc:${d.serial}`, prev = this.db.getAlert(key);
      const [pc, pt] = String(prev?.alerted ?? '').split('|').map(Number);
      if (!rising || d.crc == null || (prev && d.crc <= (pc || 0)) || (prev && now - pt < COOL)) continue;
      const ok = await this.safeDeliver(`[Verbindung] ${hl}: ${d.model} – Übertragungsfehler nehmen zu`,
        `Host: ${hl}\nPlatte: ${d.label}\nSeriennummer: ${d.serial}\nCRC-Zähler: ${d.crc}${prev && pc != null && !Number.isNaN(pc) ? ` (vorher ${pc})` : ''}\n\nDie Platte meldet mehr Übertragungsfehler zwischen Platte und Controller. Das liegt fast immer am SATA-Datenkabel, am Stecker, am Port oder an der Stromversorgung, selten an der Platte selbst.\n\nWas tun? Kabel tauschen oder neu stecken, notfalls anderen Port nehmen. Der Zähler geht nie zurück: Wichtig ist nur, ob er danach weiter steigt.\n${link}${this.foot()}`);
      if (ok) this.db.setAlert(key, 'sent', `${d.crc}|${now.getTime()}`, now);
    }
    const lf = this.engine.linkFindings(hostId);
    const key = `link:${hostId}`, prev = this.db.getAlert(key);
    const sig = lf.map((f) => f.signature).join(',');
    const [ps, pt] = String(prev?.alerted ?? '').split('|');
    if (lf.length && sig !== ps && (!prev || now - Number(pt) >= COOL)) {
      const ok = await this.safeDeliver(`[Verbindung] ${hl}: Fehler an ${lf.map((f) => f.port).join(', ')}`,
        `Host: ${hl}\n\nDer Kernel meldet Verbindungsfehler zu Platten (letzte 48 Stunden):\n${this.findingLines(lf)}\n${link}${this.foot()}`);
      if (ok) this.db.setAlert(key, 'sent', `${sig}|${now.getTime()}`, now);
    }
  }

  /** Ergebnis eines vom Tool gesteuerten Backup-Laufs: bei Fehlern immer eine Mail (PBS bleibt an), bei Erfolg eine kurze Meldung. */
  async backupJob(job) {
    if (!this.ready() || !this.config().notify.backup) return;
    const key = `bkjob:${job.id}`;
    if (this.db.getAlert(key)) return;
    const c = this.config(), ok = job.phase === 'fertig';
    const label = (id) => this.engine.hosts.find((h) => h.id === id)?.label ?? id;
    const lines = job.hosts.map((h) => ` ${h.state === 'ok' ? '✔' : '✖'} ${label(h.id)}: ${{ ok: 'in Ordnung', fehler: 'nicht erfolgreich', fehlt: 'nicht erreicht', übersprungen: 'übersprungen', wartet: 'nicht gestartet', läuft: 'läuft noch' }[h.state] ?? h.state}${h.total != null ? ` (${h.total - (h.failed ?? 0)} von ${h.total} Gästen, ${h.minutes ?? '?'} min)` : ''}${h.note ? ` – ${h.note}` : ''}${h.failedGuests?.length ? `\n     Fehlgeschlagen: ${h.failedGuests.map((g) => g.vmid).join(', ')}` : ''}`).join('\n');
    const pbs = { angefordert: 'Der PBS wird heruntergefahren.', aus: 'Der PBS bleibt an (Herunterfahren ist ausgeschaltet).', 'fehlt-recht': 'Der PBS bleibt an: das Recht „Herunterfahren“ fehlt.', 'von-hand': 'Der PBS bleibt an (Lauf von Hand). Ausschalten mit „PBS herunterfahren“.', 'kein-backup-tag': 'Der PBS bleibt an: Er ist an keinem Backup-Tag hochgefahren. Ausschalten mit „PBS herunterfahren“.', fehler: `Der PBS konnte nicht heruntergefahren werden: ${job.shutdownNote ?? ''}`, nein: 'Der PBS bleibt an, damit nichts verloren geht. Bitte die Ursache prüfen.' }[job.shutdown] ?? '';
    const sent = await this.safeDeliver(ok ? '[Backup] Lauf abgeschlossen: alles gesichert' : '[Backup] Lauf NICHT vollständig erfolgreich',
      `Backup-Lauf vom ${new Date(job.startedAt).toLocaleString('de-DE')}${job.manual ? ' (von Hand gestartet)' : ''}\n\n${lines}\n\n${pbs}\n${this.link(c)}${this.foot()}`);
    if (sent) this.db.setAlert(key, 'sent', 'sent', this.engine.now());
  }

  /** Aufgerufen, wenn ein Selbsttest mit Fehler endet (nicht bei „unterbrochen“). */
  async testFailed({ hostId, runId, disk, note, kind }) {
    if (!this.ready() || !this.config().notify.test) return;
    const key = `test:${runId}`;
    if (this.db.getAlert(key)) return;
    const c = this.config(), host = this.engine.hosts.find((h) => h.id === hostId), hl = host?.label ?? hostId;
    const kt = { short: 'Kurztest', long: 'Langtest', select: 'Langtest-Abschnitt' }[kind] ?? 'Selbsttest';
    const ok = await this.safeDeliver(`[Selbsttest] ${hl}: ${disk.model} – ${kt} fehlgeschlagen`,
      `Host: ${hl}\nPlatte: ${disk.model} (${disk.device})\nSeriennummer: ${disk.serial}\nTest: ${kt}\nErgebnis: ${note || 'Fehler beim Lesen'}\n\nDie Platte konnte beim Test nicht alles fehlerfrei lesen. Backup prüfen und Ersatz einplanen. Kabel und Controller ausschließen.\n${this.link(c)}${this.foot()}`);
    if (ok) this.db.setAlert(key, 'sent', 'sent', this.engine.now());
  }

  async sendTest() {
    if (!this.ok()) throw new Error('Bitte zuerst Server, Absender und Empfänger eintragen und speichern.');
    await this.deliver('[PVE-Tools] Testmail', `Das ist eine Testmail von Fischje's PVE-Tools.\nWenn du sie liest, funktioniert der Mailversand.\n\nGesendet: ${this.engine.now().toLocaleString('de-DE')}${this.foot()}`);
  }

  /** Zusammenfassung aller aktuellen Auffälligkeiten (auf Knopfdruck). */
  async sendDigest() {
    if (!this.ok()) throw new Error('Bitte zuerst Server, Absender und Empfänger eintragen und speichern.');
    const c = this.config(), lines = [];
    let bad = 0, total = 0;
    for (const h of this.engine.hosts) {
      const { disks, pools } = this.snapshot(h.id);
      total += disks.length;
      const items = [];
      for (const d of disks) if (d.level !== 'ok') { bad += d.level === 'watch' ? 0 : 1; items.push(` ${ICON[d.level] ?? '·'} ${d.label}: ${LEVEL_LABEL[d.level] ?? d.level}${d.findings.find((f) => f.level !== 'ok' && f.level !== 'info') ? ` – ${d.findings.find((f) => f.level !== 'ok' && f.level !== 'info').title}` : ''}`); }
      for (const p of pools) if (p.level !== 'ok') items.push(` ${ICON[p.level] ?? '·'} Pool ${p.name}: ${p.findings.find((f) => f.level !== 'ok' && f.level !== 'info')?.title ?? p.state}`);
      lines.push(`${h.label ?? h.id}: ${disks.length} Platten${items.length ? '' : ', alles in Ordnung'}`, ...items, '');
    }
    await this.deliver(`[PVE-Tools] Zusammenfassung: ${bad ? `${bad} Platte${bad === 1 ? '' : 'n'} brauchen Aufmerksamkeit` : 'alles in Ordnung'}`, `Stand ${this.engine.now().toLocaleString('de-DE')}\n\n${lines.join('\n')}${this.link(c)}${this.foot()}`);
  }
}
