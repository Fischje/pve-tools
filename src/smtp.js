// Minimaler SMTP-Client ohne Abhängigkeiten: Verbindung unverschlüsselt, per STARTTLS (Port 587) oder implizitem TLS (Port 465),
// Anmeldung mit AUTH PLAIN oder LOGIN, eine Textmail an mehrere Empfänger. Mehr braucht das Tool nicht.
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';
import os from 'node:os';

const ADDR = /^[^\s<>()@",;:\\]+@[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/;
export const validAddress = (a) => typeof a === 'string' && a.length <= 254 && ADDR.test(a);
const noCtl = (s, name) => { if (/[\r\n\0]/.test(String(s))) throw new Error(`${name} enthält ungültige Zeichen`); return String(s); };
/** Kopfzeilen mit Umlauten nach RFC 2047 kodieren. */
const encHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);

class Session {
  constructor(sock, timeoutMs) { this.timeoutMs = timeoutMs; this.buf = ''; this.waiter = null; this.err = null; this.attach(sock); }
  attach(sock) {
    this.sock = sock; sock.setEncoding('utf8');
    sock.on('data', (d) => { this.buf += d; this.check(); });
    sock.on('error', (e) => this.fail(e));
    sock.on('close', () => this.fail(new Error('Verbindung vom Mailserver beendet')));
  }
  fail(e) { this.err ??= e; if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.t); w.reject(e); } }
  /** Eine vollständige (ggf. mehrzeilige) Antwort aus dem Puffer holen. Die letzte Zeile des Puffers ist noch unvollständig. */
  take() {
    const parts = this.buf.split('\r\n');
    const complete = parts.slice(0, -1);
    const done = complete.findIndex((l) => /^\d{3}( |$)/.test(l)); // letzte Zeile einer Antwort: "250 …" (Fortsetzung wäre "250-…")
    if (done < 0) return null;
    const got = complete.slice(0, done + 1);
    this.buf = [...complete.slice(done + 1), parts.at(-1)].join('\r\n');
    return { code: Number(got[done].slice(0, 3)), lines: got.map((l) => l.slice(4)) };
  }
  check() { if (!this.waiter) return; const r = this.take(); if (r) { const w = this.waiter; this.waiter = null; clearTimeout(w.t); w.resolve(r); } }
  reply() {
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      this.waiter = { resolve, reject, t: setTimeout(() => { this.waiter = null; reject(new Error('Zeitüberschreitung beim Mailserver')); }, this.timeoutMs) };
      this.check();
    });
  }
  async cmd(line, ok, secret = false) {
    this.sock.write(`${line}\r\n`);
    const r = await this.reply();
    if (!ok.includes(r.code)) throw new Error(`Mailserver antwortet ${r.code}${secret ? '' : ` auf „${line.split(' ')[0]}“`}: ${r.lines.join(' ')}`.trim());
    return r;
  }
}

function connect({ host, port, security, rejectUnauthorized, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const opts = { host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized };
    const sock = security === 'ssl' ? tls.connect(opts) : net.connect({ host, port });
    const t = setTimeout(() => { sock.destroy(); reject(new Error(`Zeitüberschreitung beim Verbinden mit ${host}:${port}`)); }, timeoutMs);
    sock.once(security === 'ssl' ? 'secureConnect' : 'connect', () => { clearTimeout(t); resolve(sock); });
    sock.once('error', (e) => { clearTimeout(t); reject(e); });
  });
}

export function buildMessage({ from, to, subject, text, hostname }) {
  const body = Buffer.from(String(text).replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [`From: ${encHeader("Fischje's PVE-Tools")} <${from}>`, `To: ${to.join(', ')}`, `Subject: ${encHeader(subject)}`, `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${hostname}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', 'X-Mailer: pve-disk-tool', '', body, ''].join('\r\n');
}

/**
 * @param {{host:string, port:number, security:'none'|'starttls'|'ssl', user?:string, password?:string, from:string, to:string[], subject:string, text:string, rejectUnauthorized?:boolean, timeoutMs?:number}} o
 */
export async function sendMail(o) {
  const { host, port, security = 'starttls', user = '', password = '', rejectUnauthorized = true, timeoutMs = 15000 } = o;
  const to = o.to.map((a) => noCtl(a, 'Empfänger'));
  const from = noCtl(o.from, 'Absender'), subject = noCtl(o.subject, 'Betreff');
  if (![from, ...to].every(validAddress) || !to.length) throw new Error('Ungültige Absender- oder Empfängeradresse');
  if (user && security === 'none') throw new Error('Anmeldung ohne Verschlüsselung ist nicht erlaubt. Bitte STARTTLS oder SSL/TLS wählen.');
  const hostname = os.hostname().replace(/[^A-Za-z0-9.-]/g, '') || 'localhost';
  let sock;
  try { sock = await connect({ host, port, security, rejectUnauthorized, timeoutMs }); } catch (e) {
    throw new Error(`Verbindung zu ${host}:${port} fehlgeschlagen: ${/self.signed|unable to verify|certificate/i.test(e.message) ? `${e.message}. Bei selbstsigniertem Zertifikat „Zertifikat nicht prüfen“ aktivieren.` : e.message}`);
  }
  let s = new Session(sock, timeoutMs);
  try {
    const greet = await s.reply();
    if (greet.code !== 220) throw new Error(`Mailserver antwortet ${greet.code}: ${greet.lines.join(' ')}`);
    let caps = (await s.cmd(`EHLO ${hostname}`, [250])).lines.map((l) => l.toUpperCase());
    if (security === 'starttls') {
      if (!caps.some((c) => c.startsWith('STARTTLS'))) throw new Error('Der Mailserver bietet kein STARTTLS an. Anderen Port oder „SSL/TLS“ wählen.');
      await s.cmd('STARTTLS', [220]);
      const plain = s.sock; plain.removeAllListeners('data'); plain.removeAllListeners('error'); plain.removeAllListeners('close');
      const secure = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: plain, servername: net.isIP(host) ? undefined : host, rejectUnauthorized }, () => resolve(t));
        t.once('error', reject);
      }).catch((e) => { throw new Error(`TLS-Aufbau fehlgeschlagen: ${e.message}${/self.signed|unable to verify|certificate/i.test(e.message) ? '. Bei selbstsigniertem Zertifikat „Zertifikat nicht prüfen“ aktivieren.' : ''}`); });
      s = new Session(secure, timeoutMs);
      caps = (await s.cmd(`EHLO ${hostname}`, [250])).lines.map((l) => l.toUpperCase());
    }
    if (user) {
      const auth = caps.find((c) => c.startsWith('AUTH')) ?? '';
      try {
        if (/\bPLAIN\b/.test(auth)) await s.cmd(`AUTH PLAIN ${Buffer.from(`\0${user}\0${password}`, 'utf8').toString('base64')}`, [235], true);
        else if (/\bLOGIN\b/.test(auth)) {
          await s.cmd('AUTH LOGIN', [334], true);
          await s.cmd(Buffer.from(user, 'utf8').toString('base64'), [334], true);
          await s.cmd(Buffer.from(password, 'utf8').toString('base64'), [235], true);
        } else throw new Error('Der Mailserver bietet keine Anmeldung per PLAIN oder LOGIN an.');
      } catch (e) { throw new Error(/^Mailserver antwortet 5\d\d/.test(e.message) ? 'Anmeldung am Mailserver abgelehnt (Benutzer oder Passwort falsch?)' : e.message); }
    }
    await s.cmd(`MAIL FROM:<${from}>`, [250]);
    for (const r of to) await s.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await s.cmd('DATA', [354]);
    s.sock.write(`${buildMessage({ from, to, subject, text: o.text, hostname })}\r\n.\r\n`);
    const done = await s.reply();
    if (done.code !== 250) throw new Error(`Mailserver hat die Mail nicht angenommen (${done.code}): ${done.lines.join(' ')}`);
    s.sock.write('QUIT\r\n');
    return { accepted: to.length };
  } finally { s.sock.destroy(); }
}
