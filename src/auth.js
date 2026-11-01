// Passwortschutz der Oberfläche. Das Passwort wird in der Oberfläche gesetzt und als scrypt-Hash in der Datenbank gespeichert.
// Ohne gesetztes Passwort ist die Oberfläche offen (nur LAN) und zeigt einen Hinweis.
import { scryptSync, randomBytes, timingSafeEqual, createHmac } from 'node:crypto';

const MAX_AGE_S = 30 * 24 * 3600;

export function hashPassword(pw) {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${scryptSync(pw, salt, 32).toString('hex')}`;
}
export function verifyPassword(pw, stored) {
  const [alg, saltHex, hashHex] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const h = scryptSync(pw, Buffer.from(saltHex, 'hex'), 32);
  const want = Buffer.from(hashHex, 'hex');
  return h.length === want.length && timingSafeEqual(h, want);
}

export class Auth {
  constructor(db, now = () => Date.now()) { this.db = db; this.now = now; this.fails = new Map(); }

  hasPassword() { return !!this.db.getSetting('password_hash'); }
  get secret() {
    let s = this.db.getSetting('session_secret');
    if (!s) { s = randomBytes(32).toString('hex'); this.db.setSetting('session_secret', s); }
    return s;
  }
  validate(pw) { if (typeof pw !== 'string' || pw.length < 8) throw new Error('Das Passwort muss mindestens 8 Zeichen lang sein.'); if (pw.length > 200) throw new Error('Das Passwort ist zu lang.'); }
  setPassword(pw) {
    this.validate(pw);
    this.db.setSetting('password_hash', hashPassword(pw));
    this.db.setSetting('session_secret', randomBytes(32).toString('hex')); // alle bisherigen Anmeldungen ungültig
  }
  removePassword() { this.db.delSetting('password_hash'); this.db.setSetting('session_secret', randomBytes(32).toString('hex')); }

  /** Begrenzt falsche Versuche: 5 pro 10 Minuten und Adresse. */
  tooMany(ip) { const f = (this.fails.get(ip) ?? []).filter((t) => this.now() - t < 600000); this.fails.set(ip, f); return f.length >= 5; }
  noteFail(ip) { this.fails.set(ip, [...(this.fails.get(ip) ?? []), this.now()]); }

  login(pw, ip) {
    if (this.tooMany(ip)) return { ok: false, status: 429, error: 'Zu viele Versuche. Bitte in 10 Minuten erneut versuchen.' };
    if (!verifyPassword(pw ?? '', this.db.getSetting('password_hash'))) { this.noteFail(ip); return { ok: false, status: 401, error: 'Passwort falsch.' }; }
    return { ok: true, cookie: this.issue() };
  }
  sign(payload) { return createHmac('sha256', this.secret).update(payload).digest('hex'); }
  issue() {
    const payload = `${Math.floor(this.now() / 1000) + MAX_AGE_S}.${randomBytes(8).toString('hex')}`;
    return `session=${payload}.${this.sign(payload)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${MAX_AGE_S}`;
  }
  clearCookie() { return 'session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'; }
  /** true, wenn kein Passwort gesetzt ist oder das Cookie gültig ist. */
  check(cookieHeader) {
    if (!this.hasPassword()) return true;
    const m = /(?:^|;\s*)session=([^;]+)/.exec(cookieHeader ?? '');
    if (!m) return false;
    const parts = m[1].split('.');
    if (parts.length !== 3) return false;
    const payload = `${parts[0]}.${parts[1]}`;
    const want = Buffer.from(this.sign(payload)); const got = Buffer.from(parts[2]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return false;
    return Number(parts[0]) * 1000 > this.now();
  }
}
