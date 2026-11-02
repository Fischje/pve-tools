import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { sendMail, validAddress } from '../src/smtp.js';

// Testzertifikat (selbstsigniert), falls openssl vorhanden ist.
let cert = null;
try {
  const dir = mkdtempSync(path.join(tmpdir(), 'smtp-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${dir}/k.pem`, '-out', `${dir}/c.pem`, '-days', '2', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1'], { stdio: 'ignore' });
  cert = { key: readFileSync(`${dir}/k.pem`), cert: readFileSync(`${dir}/c.pem`) };
} catch { /* ohne openssl werden die TLS-Tests übersprungen */ }

const servers = [];
after(() => servers.forEach((s) => s.close()));

/** Nachgebauter Mailserver. mode: 'plain' | 'starttls' | 'ssl'. */
async function fake({ mode = 'plain', auth = ['PLAIN', 'LOGIN'], user = 'u', pass = 'p', rejectRcpt = false, silent = false } = {}) {
  const mails = [];
  const handle = (sock0) => {
    let sock = sock0, secure = mode === 'ssl', buf = '', data = null, authStep = null, rcpt = [];
    const w = (s) => sock.write(`${s}\r\n`);
    const onData = (d) => {
      buf += d;
      for (;;) {
        if (data !== null) {
          const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return;
          const raw = buf.slice(0, i); buf = buf.slice(i + 5); data = null;
          const [head, ...rest] = raw.split('\r\n\r\n');
          mails.push({ head, text: Buffer.from(rest.join('').replace(/\r\n/g, ''), 'base64').toString('utf8'), rcpt: [...rcpt] }); w('250 queued'); continue;
        }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (authStep === 'user') { authStep = 'pass'; w('334 UGFzc3dvcmQ6'); continue; }
        if (authStep === 'pass') { authStep = null; w(Buffer.from(line, 'base64').toString() === pass ? '235 ok' : '535 bad'); continue; }
        const [c0, ...args] = line.split(' '); const c = c0.toUpperCase();
        if (c === 'EHLO') { const lines = ['fake', ...(mode === 'starttls' && !secure ? ['STARTTLS'] : []), ...((secure || mode === 'plain') && auth.length ? [`AUTH ${auth.join(' ')}`] : []), '8BITMIME']; lines.forEach((l, k) => w(`250${k < lines.length - 1 ? '-' : ' '}${l}`)); }
        else if (c === 'STARTTLS') { w('220 go'); const ts = new tls.TLSSocket(sock, { isServer: true, ...cert }); sock.removeAllListeners('data'); sock = ts; secure = true; ts.setEncoding('utf8'); ts.on('data', onData); ts.on('error', () => {}); }
        else if (c === 'AUTH') {
          if (args[0] === 'PLAIN') { const [, u, p] = Buffer.from(args[1], 'base64').toString().split('\0'); w(u === user && p === pass ? '235 ok' : '535 bad'); }
          else if (args[0] === 'LOGIN') { authStep = 'user'; w('334 VXNlcm5hbWU6'); }
        }
        else if (c === 'MAIL') { rcpt = []; w('250 ok'); }
        else if (c === 'RCPT') { if (rejectRcpt) w('550 no such user'); else { rcpt.push(line.match(/<(.*)>/)[1]); w('250 ok'); } }
        else if (c === 'DATA') { data = ''; w('354 go'); }
        else if (c === 'QUIT') { w('221 bye'); sock.end(); return; }
      }
    };
    sock.setEncoding('utf8'); sock.on('data', onData); sock.on('error', () => {});
    if (!silent) w('220 fake ESMTP');
  };
  const server = mode === 'ssl' ? tls.createServer(cert, handle) : net.createServer(handle);
  servers.push(server);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { port: server.address().port, mails };
}
const base = (port, o = {}) => ({ host: '127.0.0.1', port, security: 'none', from: 'platten@example.org', to: ['admin@example.org'], subject: 'Test', text: 'Hallo', timeoutMs: 3000, ...o });

test('Adressen werden geprüft', () => {
  for (const a of ['a@b.de', 'x.y+z@mail.example.org']) assert.equal(validAddress(a), true, a);
  for (const a of ['a', 'a@', '@b.de', 'a b@c.de', 'a@b.de\r\nBcc: x@y.de', '<a@b.de>']) assert.equal(validAddress(a), false, a);
});

test('Mail ohne Anmeldung: Text, Umlaute und Betreff kommen richtig an', async () => {
  const f = await fake();
  await sendMail(base(f.port, { subject: 'Platte „Samsung“ – Bald tauschen', text: 'Zeile 1\nZeile 2 mit Umlauten: äöüß €\n\n.Punkt am Anfang' }));
  assert.equal(f.mails.length, 1);
  assert.equal(f.mails[0].text, 'Zeile 1\r\nZeile 2 mit Umlauten: äöüß €\r\n\r\n.Punkt am Anfang');
  assert.match(f.mails[0].head, /Subject: =\?UTF-8\?B\?/);
  assert.equal(Buffer.from(f.mails[0].head.match(/Subject: =\?UTF-8\?B\?(.*?)\?=/)[1], 'base64').toString(), 'Platte „Samsung“ – Bald tauschen');
  assert.deepEqual(f.mails[0].rcpt, ['admin@example.org']);
});

test('mehrere Empfänger', async () => {
  const f = await fake();
  await sendMail(base(f.port, { to: ['a@example.org', 'b@example.org'] }));
  assert.deepEqual(f.mails[0].rcpt, ['a@example.org', 'b@example.org']);
});

test('Anmeldung ohne Verschlüsselung wird verweigert (Passwort würde offen übertragen)', async () => {
  const f = await fake();
  await assert.rejects(sendMail(base(f.port, { user: 'u', password: 'p', security: 'none' })), /ohne Verschlüsselung/);
  assert.equal(f.mails.length, 0);
});

test('Fehler: Server lehnt Empfänger ab, Verbindung unmöglich, keine Antwort', async () => {
  const f = await fake({ rejectRcpt: true });
  await assert.rejects(sendMail(base(f.port)), /550/);
  await assert.rejects(sendMail(base(1, { host: '127.0.0.1' })), /Verbindung zu 127\.0\.0\.1:1 fehlgeschlagen/);
  const s = await fake({ silent: true });
  await assert.rejects(sendMail(base(s.port, { timeoutMs: 300 })), /Zeitüberschreitung/);
});

test('Header-Einschleusung und ungültige Adressen werden abgelehnt', async () => {
  const f = await fake();
  await assert.rejects(sendMail(base(f.port, { subject: 'x\r\nBcc: boese@example.org' })), /ungültige Zeichen/);
  await assert.rejects(sendMail(base(f.port, { to: ['a@b.de\r\nRCPT TO:<c@d.de>'] })), /ungültige Zeichen/);
  await assert.rejects(sendMail(base(f.port, { from: 'kaputt' })), /Ungültige/);
  assert.equal(f.mails.length, 0);
});

const tlsTest = cert ? test : test.skip;

tlsTest('STARTTLS mit Anmeldung (PLAIN)', async () => {
  const f = await fake({ mode: 'starttls' });
  await sendMail(base(f.port, { security: 'starttls', user: 'u', password: 'p', rejectUnauthorized: false }));
  assert.equal(f.mails.length, 1);
});

tlsTest('STARTTLS mit Anmeldung (nur LOGIN angeboten)', async () => {
  const f = await fake({ mode: 'starttls', auth: ['LOGIN'] });
  await sendMail(base(f.port, { security: 'starttls', user: 'u', password: 'p', rejectUnauthorized: false }));
  assert.equal(f.mails.length, 1);
});

tlsTest('falsches Passwort: verständliche Meldung, nichts verschickt', async () => {
  const f = await fake({ mode: 'starttls' });
  await assert.rejects(sendMail(base(f.port, { security: 'starttls', user: 'u', password: 'falsch', rejectUnauthorized: false })), /Anmeldung am Mailserver abgelehnt/);
  assert.equal(f.mails.length, 0);
});

tlsTest('selbstsigniertes Zertifikat wird standardmäßig abgelehnt, mit Hinweis', async () => {
  const f = await fake({ mode: 'starttls' });
  await assert.rejects(sendMail(base(f.port, { security: 'starttls', user: 'u', password: 'p', rejectUnauthorized: true })), /Zertifikat nicht prüfen/);
  assert.equal(f.mails.length, 0);
});

tlsTest('implizites TLS (Port 465)', async () => {
  const f = await fake({ mode: 'ssl' });
  await sendMail(base(f.port, { security: 'ssl', user: 'u', password: 'p', rejectUnauthorized: false }));
  assert.equal(f.mails.length, 1);
  const g = await fake({ mode: 'ssl' });
  await assert.rejects(sendMail(base(g.port, { security: 'ssl', rejectUnauthorized: true })), /Zertifikat nicht prüfen/);
});

tlsTest('Server ohne STARTTLS, obwohl STARTTLS verlangt: klare Meldung', async () => {
  const f = await fake({ mode: 'plain' });
  await assert.rejects(sendMail(base(f.port, { security: 'starttls', rejectUnauthorized: false })), /kein STARTTLS/);
});
