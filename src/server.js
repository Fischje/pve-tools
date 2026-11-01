// Webserver (nur LAN) mit Passwortschutz, API und Zeitplan-Schleife.
import http from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { openDb } from './db.js';
import { Engine } from './engine.js';
import { Auth } from './auth.js';
import { HostClient } from './hostapi.js';
import { SshTransport } from './transport.js';
import { overview, diskDetail, cleanSettings } from './service.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WEB = path.join(ROOT, 'web');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

/** true für Adressen im lokalen Netz (RFC 1918, Loopback, Link-Local, IPv6-ULA). */
export function isPrivateIp(ip) {
  let a = String(ip ?? '').replace(/^::ffff:/, '');
  if (net.isIPv4(a)) {
    const [o1, o2] = a.split('.').map(Number);
    return o1 === 10 || o1 === 127 || (o1 === 172 && o2 >= 16 && o2 <= 31) || (o1 === 192 && o2 === 168) || (o1 === 169 && o2 === 254);
  }
  a = a.toLowerCase();
  return a === '::1' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe80');
}

export function createApp({ db, engine, auth, allowPublic = false }) {
  const send = (res, status, body, headers = {}) => {
    const isStr = typeof body === 'string';
    res.writeHead(status, { 'Content-Type': isStr ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
    res.end(isStr ? body : JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => { n += c.length; if (n > 65536) { reject(new Error('Anfrage zu groß')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Ungültiges JSON')); } });
  });

  async function api(req, res, url, ip) {
    const route = `${req.method} ${url.pathname}`;
    const authed = auth.check(req.headers.cookie);
    if (route === 'GET /api/auth/status') return send(res, 200, { passwordSet: auth.hasPassword(), loggedIn: authed });
    if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'disktool') return send(res, 403, { error: 'Anfrage nicht erlaubt' });
    if (route === 'POST /api/auth/login') {
      const b = await readBody(req);
      const r = auth.login(b.password, ip);
      return r.ok ? send(res, 200, { ok: true }, { 'Set-Cookie': r.cookie }) : send(res, r.status, { error: r.error });
    }
    if (route === 'POST /api/auth/logout') return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() });
    if (!authed) return send(res, 401, { error: 'Bitte anmelden' });

    if (route === 'POST /api/auth/password') {
      const b = await readBody(req);
      if (auth.hasPassword()) {
        const r = auth.login(b.current, ip);
        if (!r.ok) return send(res, r.status, { error: r.status === 429 ? r.error : 'Das aktuelle Passwort ist falsch.' });
      }
      if (b.remove) { auth.removePassword(); return send(res, 200, { ok: true }, { 'Set-Cookie': auth.clearCookie() }); }
      try { auth.setPassword(b.password); } catch (e) { return send(res, 400, { error: e.message }); }
      return send(res, 200, { ok: true }, { 'Set-Cookie': auth.issue() });
    }
    if (route === 'GET /api/overview') return send(res, 200, overview(engine));
    let m;
    if ((m = /^\/api\/disks\/([^/]+)$/.exec(url.pathname)) && req.method === 'GET') {
      const d = diskDetail(engine, decodeURIComponent(m[1]));
      return d ? send(res, 200, d) : send(res, 404, { error: 'Platte unbekannt' });
    }
    if ((m = /^\/api\/hosts\/([^/]+)\/(settings|poll|approval)$/.exec(url.pathname))) {
      const hostId = decodeURIComponent(m[1]);
      if (!engine.hosts.some((h) => h.id === hostId)) return send(res, 404, { error: 'Host unbekannt' });
      if (m[2] === 'settings' && req.method === 'PUT') {
        let clean; try { clean = cleanSettings(await readBody(req)); } catch (e) { return send(res, 400, { error: e.message }); }
        db.setHostSettings(hostId, { ...(db.getHostSettings(hostId) ?? {}), ...clean });
        engine.event(hostId, null, 'Zeitplan-Einstellungen geändert');
        return send(res, 200, { ok: true });
      }
      if (m[2] === 'settings' && req.method === 'DELETE') { db.setHostSettings(hostId, {}); return send(res, 200, { ok: true }); }
      if (m[2] === 'poll' && req.method === 'POST') { await engine.pollHost(hostId); return send(res, 200, { ok: true }); }
      if (m[2] === 'approval' && req.method === 'POST') {
        const b = await readBody(req);
        try { engine.setApproval(hostId, b.action); } catch (e) { return send(res, 400, { error: e.message }); }
        if (b.action === 'now') { try { await engine.tickHost(hostId); } catch { /* wird beim nächsten Takt wiederholt */ } }
        return send(res, 200, { ok: true });
      }
    }
    if ((m = /^\/api\/disks\/([^/]+)\/(test|abort|pause)$/.exec(url.pathname)) && req.method === 'POST') {
      const serial = decodeURIComponent(m[1]);
      const row = db.getDisk(serial);
      if (!row) return send(res, 404, { error: 'Platte unbekannt' });
      const b = await readBody(req);
      if (m[2] === 'pause') { db.setPaused(serial, !!b.paused); return send(res, 200, { ok: true }); }
      try {
        if (m[2] === 'abort') return send(res, 200, await engine.abortManual(row.host_id, serial));
        if (!['short', 'long'].includes(b.type)) return send(res, 400, { error: 'Testtyp muss short oder long sein' });
        const r = await engine.startManual(row.host_id, serial, b.type);
        return send(res, r.ok ? 200 : 409, r.ok ? r : { error: r.reason });
      } catch (e) { return send(res, 502, { error: e.message }); }
    }
    return send(res, 404, { error: 'Nicht gefunden' });
  }

  async function serveStatic(res, pathname) {
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep)) return send(res, 404, 'Nicht gefunden');
    try {
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
      res.end(data);
    } catch { send(res, 404, 'Nicht gefunden'); }
  }

  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const ip = req.socket.remoteAddress;
    if (!allowPublic && !isPrivateIp(ip)) return send(res, 403, 'Nur aus dem lokalen Netz erreichbar.');
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, ip);
      if (req.method !== 'GET') return send(res, 405, 'Methode nicht erlaubt');
      return await serveStatic(res, url.pathname);
    } catch (e) { send(res, 500, { error: e.message }); }
  });
}

// ---------- Start ----------
async function main() {
  const env = process.env;
  const dataDir = path.resolve(env.DATA_DIR ?? './data');
  mkdirSync(dataDir, { recursive: true });
  const db = openDb(dataDir);
  const demo = env.DEMO === '1';
  const log = (m) => console.log(`${new Date().toISOString()} ${m}`);
  let hosts, makeClient, now = () => new Date(), tickMs = 60000;

  if (demo) {
    const { DemoWorld, DemoTransport } = await import('./demo/world.js');
    const speed = Number(env.DEMO_SPEED ?? 60);
    const startVirtual = env.DEMO_NOW ? new Date(env.DEMO_NOW) : (() => { const d = new Date(); d.setDate(d.getDate() + ((2 - d.getDay() + 7) % 7 || 7)); d.setHours(9, 0, 0, 0); return d; })();
    const t0 = Date.now();
    now = () => new Date(startVirtual.getTime() + (Date.now() - t0) * speed);
    const world = new DemoWorld(now, { testMinutes: 5 });
    hosts = world.hosts; makeClient = (h) => new HostClient(new DemoTransport(world, h.id));
    tickMs = 60000 / speed;
    log(`DEMO-Modus: virtuelle Zeit startet ${startVirtual.toString()}, ${speed}-fache Geschwindigkeit`);
  } else {
    const cfgFile = path.join(dataDir, 'hosts.json');
    if (!existsSync(cfgFile)) log(`Keine ${cfgFile} gefunden. Vorlage: hosts.example.json. Die Oberfläche startet ohne Hosts.`);
    hosts = existsSync(cfgFile) ? JSON.parse(readFileSync(cfgFile, 'utf8')) : [];
    const knownHosts = path.join(dataDir, 'known_hosts');
    makeClient = (h) => new HostClient(new SshTransport({ ...h, keyFile: h.keyFile ?? path.join(dataDir, 'ssh', 'id_ed25519') }, { knownHosts }));
  }

  const engine = new Engine({ db, hosts, makeClient, now, log });
  const auth = new Auth(db);
  const app = createApp({ db, engine, auth, allowPublic: env.ALLOW_PUBLIC === '1' });
  const port = Number(env.PORT ?? 8080), listen = env.LISTEN ?? '0.0.0.0';
  app.listen(port, listen, () => log(`pve-disk-tool läuft auf http://${listen}:${port} (nur lokales Netz)`));

  let running = false;
  const tick = async () => { if (running) return; running = true; try { await engine.tick(); } finally { running = false; } };
  setTimeout(tick, 1000);
  setInterval(tick, tickMs);
  setInterval(() => db.prune(now()), 24 * 3600 * 1000);
  const stop = () => { db.close(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((e) => { console.error(e); process.exit(1); });
