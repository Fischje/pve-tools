// Richtet einen Proxmox-Host aus der Weboberfläche ein (ersetzt das Ausführen von host-setup/setup-host.sh von Hand).
//
// Ablauf: 1) Fingerabdruck des Hosts holen und vom Benutzer bestätigen lassen, 2) einmalig als root mit Passwort verbinden,
// 3) dieselbe Einrichtung wie setup-host.sh ausführen (Benutzer diskmon, gate.sh, sudoers, Schlüssel mit festem Befehl),
// 4) prüfen, ob der Zugang mit dem eingeschränkten Schlüssel funktioniert, 5) Host in die Liste aufnehmen.
// Das Passwort wird nur für diesen einen SSH-Aufruf per Umgebungsvariable (SSH_ASKPASS) weitergereicht. Es steht nie in
// Argumenten, Dateien, Datenbank oder Protokoll und taucht in Ausgaben nicht auf.
import { execFile } from 'node:child_process';
import { readFile, writeFile, mkdtemp, rm, chmod, appendFile, rename, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import { isPrivateIp } from './net.js';

const ADDRESS_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$|^[0-9a-fA-F:]+$/;
const KEY_RE = /^ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( [A-Za-z0-9@._-]*)?$/;
const FP_RE = /^SHA256:[A-Za-z0-9+/]{43}$/;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function defaultRunner(cmd, args, { env, input, timeoutMs = 60000 } = {}) {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { env: env ?? process.env, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 255) : 0, stdout: stdout ?? '', stderr: (stderr || (err && err.code === 'ENOENT' ? `${cmd} ist nicht installiert` : '') || '').toString() });
    });
    if (input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
  });
}

async function defaultResolve(address) {
  if (net.isIP(address)) return [address];
  return (await dns.lookup(address, { all: true })).map((r) => r.address);
}

export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Das Skript, das auf dem Host über `bash -s` läuft. gate.sh und setup-host.sh werden darin als Dateien abgelegt. */
export function buildRemoteScript({ gate, setup, publicKey, action, bindIp, installPackages }) {
  if (!KEY_RE.test(publicKey)) throw new Error('Ungültiger öffentlicher Schlüssel');
  let d1, d2;
  do { d1 = `DISKTOOL_${randomBytes(8).toString('hex')}_A`; d2 = `DISKTOOL_${randomBytes(8).toString('hex')}_B`; } while (gate.includes(d1) || setup.includes(d2));
  const run = action === 'remove'
    ? 'bash "$T/setup-host.sh" --entfernen'
    : `SRC=""
${bindIp ? 'SRC="${SSH_CONNECTION%% *}"' : ''}
if [[ -n "$SRC" ]]; then bash "$T/setup-host.sh" ${shq(publicKey)} "$SRC"; else bash "$T/setup-host.sh" ${shq(publicKey)}; fi`;
  return `set -euo pipefail
export DISKMON_PAKETE_INSTALLIEREN=${installPackages ? 1 : 0}
T="$(mktemp -d)"
trap 'rm -rf "$T"' EXIT
cat > "$T/gate.sh" <<'${d1}'
${gate}
${d1}
cat > "$T/setup-host.sh" <<'${d2}'
${setup}
${d2}
chmod 0755 "$T/gate.sh" "$T/setup-host.sh"
${run}
`;
}

const redact = (text, secret) => {
  let t = String(text ?? '');
  if (secret) t = t.split(secret).join('••••••');
  return t;
};

export class Provisioner {
  /**
   * @param {{engine, dataDir:string, repoDir:string, persist:(hosts:object[])=>void, runner?:Function, resolve?:Function, tmp?:string}} o
   */
  constructor({ engine, dataDir, repoDir, persist, runner = defaultRunner, resolve = defaultResolve, tmp = tmpdir() }) {
    Object.assign(this, { engine, dataDir, repoDir, persist, runner, resolve, tmp });
    this.keyFile = path.join(dataDir, 'ssh', 'id_ed25519');
    this.knownHosts = path.join(dataDir, 'known_hosts');
  }

  async publicKey() {
    if (!existsSync(this.keyFile)) {
      await mkdir(path.dirname(this.keyFile), { recursive: true, mode: 0o700 });
      const r = await this.runner('ssh-keygen', ['-t', 'ed25519', '-N', '', '-C', 'diskmon@pve-disk-tool', '-f', this.keyFile]);
      if (r.code !== 0) throw new Error(`SSH-Schlüssel konnte nicht erzeugt werden: ${r.stderr.trim()}`);
    }
    const pub = (await readFile(`${this.keyFile}.pub`, 'utf8')).trim().split('\n')[0];
    if (!KEY_RE.test(pub)) throw new Error('Der öffentliche Schlüssel hat ein unerwartetes Format.');
    return pub;
  }

  /** Adresse und Port prüfen. Nur Hosts im lokalen Netz. */
  async checkTarget({ address, port }) {
    address = String(address ?? '').trim();
    port = Number(port ?? 22);
    if (!ADDRESS_RE.test(address)) throw new Error('Ungültige Adresse.');
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Ungültiger Port.');
    let ips;
    try { ips = await this.resolve(address); } catch { throw new Error('Adresse konnte nicht aufgelöst werden.'); }
    if (!ips.length || !ips.every(isPrivateIp)) throw new Error('Nur Hosts im lokalen Netz sind erlaubt.');
    return { address, port };
  }

  /** Schritt 1: Fingerabdrücke des Hosts holen (noch ohne Passwort). */
  async scan(target) {
    const { address, port } = await this.checkTarget(target);
    const r = await this.runner('ssh-keyscan', ['-T', '6', '-t', 'ed25519,ecdsa,rsa', '-p', String(port), address], { timeoutMs: 20000 });
    const lines = r.stdout.split('\n').filter((l) => l && !l.startsWith('#'));
    if (!lines.length) throw new Error(`Keine Antwort von ${address}:${port}. Läuft der Host, und ist SSH erreichbar?`);
    const fp = await this.runner('ssh-keygen', ['-lf', '-'], { input: lines.join('\n') + '\n', timeoutMs: 10000 });
    const keys = [];
    for (const [i, l] of fp.stdout.split('\n').filter(Boolean).entries()) {
      const m = /(SHA256:\S+)\s.*\((\w+)\)\s*$/.exec(l);
      if (m && FP_RE.test(m[1])) keys.push({ type: m[2], sha256: m[1], line: lines[i] });
    }
    if (!keys.length) throw new Error('Fingerabdruck konnte nicht berechnet werden.');
    return { address, port, keys };
  }

  async pin(address, port, sha256) {
    const found = (await this.scan({ address, port })).keys.find((k) => k.sha256 === sha256);
    if (!found) throw new Error('Der Fingerabdruck des Hosts hat sich geändert. Abbruch, bitte erneut prüfen.');
    const existing = existsSync(this.knownHosts) ? await readFile(this.knownHosts, 'utf8') : '';
    if (!existing.split('\n').includes(found.line)) await appendFile(this.knownHosts, `${found.line}\n`, { mode: 0o600 });
  }

  /** Schritt 2: einrichten oder Zugang entfernen. */
  async run(req) {
    const action = req.action === 'remove' ? 'remove' : 'install';
    const existing = req.hostId ? this.engine.hosts.find((h) => h.id === req.hostId) : null;
    if (req.hostId && !existing) throw new Error('Host unbekannt.');
    const password = String(req.password ?? '');
    if (!password || password.length > 256) throw new Error('Bitte das root-Passwort des Hosts eingeben.');
    if (!FP_RE.test(String(req.fingerprint ?? ''))) throw new Error('Bitte zuerst den Fingerabdruck des Hosts prüfen und bestätigen.');

    let host;
    if (existing) host = existing;
    else {
      const id = String(req.id ?? '').trim().toLowerCase();
      if (!ID_RE.test(id)) throw new Error('Die Kennung darf nur Kleinbuchstaben, Ziffern und Bindestriche enthalten (höchstens 32 Zeichen).');
      if (this.engine.hosts.some((h) => h.id === id)) throw new Error('Diese Kennung gibt es schon.');
      if (!['dauer', 'fest', 'manuell'].includes(req.kind)) throw new Error('Ungültige Host-Art.');
      const label = String(req.label || id).trim().slice(0, 60);
      host = { id, label, address: '', port: 22, kind: req.kind };
      if (req.kind === 'fest') host.window = this.cleanWindow(req.window);
      if (req.kind === 'manuell') host.dayEnd = this.cleanTime(req.dayEnd ?? '19:00');
    }
    const target = await this.checkTarget({ address: existing?.address ?? req.address, port: existing?.port ?? req.port });
    host = { ...host, address: target.address, port: target.port };

    await this.pin(target.address, target.port, req.fingerprint);
    const publicKey = await this.publicKey();
    const gate = await readFile(path.join(this.repoDir, 'host-setup', 'gate.sh'), 'utf8');
    const setup = await readFile(path.join(this.repoDir, 'host-setup', 'setup-host.sh'), 'utf8');
    const script = buildRemoteScript({ gate, setup, publicKey, action, bindIp: req.bindIp !== false, installPackages: !!req.installPackages });

    const dir = await mkdtemp(path.join(this.tmp, 'disktool-'));
    let res;
    try {
      const askpass = path.join(dir, 'askpass.sh');
      await writeFile(askpass, '#!/bin/sh\nprintf \'%s\\n\' "$DISKTOOL_PW"\n');
      await chmod(askpass, 0o700);
      const env = { ...process.env, SSH_ASKPASS: askpass, SSH_ASKPASS_REQUIRE: 'force', DISKTOOL_PW: password, DISPLAY: process.env.DISPLAY ?? 'none' };
      const args = ['-o', `UserKnownHostsFile=${this.knownHosts}`, '-o', 'StrictHostKeyChecking=yes', '-o', 'PreferredAuthentications=password,keyboard-interactive',
        '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=10', '-p', String(target.port), `root@${target.address}`, 'bash -s'];
      res = await this.runner('ssh', args, { env, input: script, timeoutMs: 120000 });
    } finally { await rm(dir, { recursive: true, force: true }); }

    const log = redact(`${res.stdout}${res.stderr}`, password).trim();
    if (res.code !== 0) return { ok: false, log, error: this.explain(log) };
    if (action === 'remove') {
      if (existing && req.removeFromList) await this.removeHost(existing.id);
      return { ok: true, log, removed: true };
    }

    // Prüfen, ob der neue, eingeschränkte Zugang funktioniert.
    let disks;
    try { const c = this.engine.makeClient(host); await c.uptime(); disks = (await c.listDisks()).length; } catch (e) {
      return { ok: false, log, error: `Die Einrichtung lief durch, aber die Verbindung mit dem neuen Schlüssel schlägt fehl: ${e.message}. Meist stimmt die Quell-IP nicht (Haken „Schlüssel an die IP dieses Tools binden“ abschalten und erneut versuchen).` };
    }
    if (!existing) await this.addHost(host);
    this.engine.pollHost(host.id).catch(() => {});
    return { ok: true, log, host: { id: host.id, label: host.label }, disks };
  }

  explain(log) {
    if (/Permission denied/i.test(log)) return 'Anmeldung abgelehnt: Das Passwort ist falsch, oder die SSH-Anmeldung per Passwort ist für root auf dem Host nicht erlaubt (PermitRootLogin).';
    if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(log)) return 'Der Host-Schlüssel stimmt nicht mit dem bestätigten Fingerabdruck überein. Abbruch.';
    if (/Connection (timed out|refused)|No route/i.test(log)) return 'Der Host ist nicht erreichbar.';
    if (/sudo fehlt|smartmontools fehlt|smartctl fehlt/i.test(log)) return 'Es fehlt ein benötigtes Paket. Hake „Fehlende Pakete installieren“ an und versuche es erneut.';
    return 'Die Einrichtung ist fehlgeschlagen. Die Ausgabe unten zeigt den Grund.';
  }

  cleanTime(v) { if (!/^([01]?\d|2[0-3]):[0-5]\d$|^24:00$/.test(String(v))) throw new Error(`Ungültige Uhrzeit: ${v}`); return String(v).padStart(5, '0'); }
  cleanWindow(w) { return { from: this.cleanTime(w?.from ?? '08:00'), to: this.cleanTime(w?.to ?? '22:00') }; }

  async addHost(host) { this.engine.addHost(host); await this.persist(this.engine.hosts); }
  async removeHost(id) { this.engine.removeHost(id); await this.persist(this.engine.hosts); }
}

/** hosts.json atomar schreiben. */
export async function writeHostsFile(file, hosts) {
  const tmp = `${file}.${process.pid}.tmp`;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(tmp, `${JSON.stringify(hosts, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, file);
}
