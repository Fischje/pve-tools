// Wake-on-LAN: „Magic Packet“ an die MAC-Adresse des PBS senden (UDP-Broadcast, Port 9).
// Gesendet wird aus dem LXC selbst. Der LXC hängt auf dem router im selben Netz wie der PBS, das wirkt wie ein Paket vom router.
// Voraussetzung auf dem PBS: Wake-on-LAN im BIOS an und an der Netzwerkkarte aktiv (ethtool zeigt „Wake-on: g“).
import dgram from 'node:dgram';
import { readFileSync } from 'node:fs';

export const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i;
export const normMac = (m) => String(m ?? '').trim().toLowerCase().replace(/-/g, ':');

/** 6 × 0xFF, dann 16 × die MAC-Adresse (102 Byte). */
export function magicPacket(mac) {
  const m = normMac(mac);
  if (!MAC_RE.test(m)) throw new Error('Ungültige MAC-Adresse (Format aa:bb:cc:dd:ee:ff)');
  const bytes = Buffer.from(m.split(':').map((x) => parseInt(x, 16)));
  return Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(bytes)]);
}

/** Sendet das Paket dreimal an die Broadcast-Adresse(n). */
export async function sendWol(mac, { broadcast = '255.255.255.255', port = 9, socketFactory = () => dgram.createSocket('udp4') } = {}) {
  const pkt = magicPacket(mac);
  const targets = [...new Set(String(broadcast).split(/[,\s]+/).filter(Boolean))];
  const sock = socketFactory();
  try {
    await new Promise((res, rej) => { sock.once('error', rej); sock.bind(0, () => { sock.setBroadcast(true); res(); }); });
    for (let i = 0; i < 3; i++) for (const t of targets) await new Promise((res, rej) => sock.send(pkt, port, t, (e) => (e ? rej(e) : res())));
  } finally { sock.close(); }
  return { packets: 3 * targets.length, targets };
}

/** MAC-Adresse einer IP aus der ARP-Tabelle des LXC (nur, solange der Host vor Kurzem erreichbar war). */
export function macFromArp(ip, text = (() => { try { return readFileSync('/proc/net/arp', 'utf8'); } catch { return ''; } })()) {
  for (const line of String(text).split('\n').slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c[0] === ip && MAC_RE.test(c[3] ?? '') && c[3] !== '00:00:00:00:00:00') return c[3].toLowerCase();
  }
  return null;
}

/** Ausgabe des Gate-Befehls „netinfo“: dev=…, mac=…, wol=… */
export function parseNetinfo(text) {
  const out = {};
  for (const l of String(text ?? '').split('\n')) { const m = /^(dev|phys|mac|wol)=(.*)$/.exec(l.trim()); if (m) out[m[1]] = m[2].trim(); }
  if (out.mac && !MAC_RE.test(out.mac)) delete out.mac;
  return out;
}
