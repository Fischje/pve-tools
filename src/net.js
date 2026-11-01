// Hilfen für Netzwerkadressen.
import net from 'node:net';

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
