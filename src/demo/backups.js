// Erfundene, aber nach deinen echten Skripten gebaute Daten für Gäste, Snapshots, Backup-Läufe und proxmox-autosnap (Demo und Tests).
// Montag ist der Backup-Tag: dann laufen keine Snapshots, und der PBS wird hochgefahren.

const GUESTS = {
  router: [[109, 'nginx-proxy', 'running', 'autosnap;community-script;nginx;proxy'], [112, 'dns', 'running', 'autosnap'], [113, 'monitoring', 'running', 'autosnap;community-script;monitoring'],
    [115, 'test', 'stopped', ''], [116, 'helper', 'running', 'autosnap;proxmox-helper-scripts'], [119, 'documents', 'running', 'autosnap;community-script;documents'],
    [161, 'webserver', 'running', 'autosnap;community-script;webserver'], [251, 'adblock', 'running', 'adblock;autosnap;community-script']],
  pve: [[109, 'nginx-proxy', 'running', 'autosnap;community-script;nginx;proxy'], [112, 'dns', 'running', 'autosnap'], [113, 'monitoring', 'running', 'autosnap;community-script;monitoring'],
    [118, 'mail-archiver', 'running', 'autosnap;community-script;mail-archiver'], [119, 'documents', 'running', 'autosnap;community-script;documents'], [121, 'docker', 'running', 'autosnap;community-script;docker'],
    [141, 'media', 'stopped', 'community-script;media'], [142, 'media2', 'running', 'autosnap;community-script;media'], [152, 'paperless', 'running', 'autosnap;community-script;document'],
    [153, 'dashboard', 'running', 'autosnap;arr;community-script'], [158, 'finance', 'running', 'autosnap;community-script;finance'], [161, 'webserver', 'running', 'autosnap;community-script;webserver'],
    [164, 'pdf', 'running', 'autosnap;community-script;pdf-editor'], [166, 'alt', 'stopped', ''], [180, 'web', 'running', 'autosnap'], [183, 'notes', 'running', 'autosnap;community-script;notes']],
};
const EXCLUDE = { router: [], pve: [109, 112, 113, 114, 116, 119, 117, 159, 161, 171] }; // wie im Orchestrator auf dem PBS

const WRAPPER_PVE = `#!/bin/bash
# Aufruf: autosnap-run hourly|weekly|monthly
FLAG=/etc/autosnap.disabled
PAUSE_DAY=1            # 1 = Montag (date +%u): an diesem Tag keine Snapshots
TAG="autosnap"
LABEL="$1"
case "$LABEL" in
    hourly)  KEEP=8 ;;
    weekly)  KEEP=1 ;;
    monthly) KEEP=1
             if [ -z "$FORCE" ]; then
                 case "$(date +%d-%u)" in 01-*|02-2) ;; *) exit 0 ;; esac
             fi ;;
    *) echo "Aufruf: $0 hourly|weekly|monthly" >&2; exit 2 ;;
esac`;
const WRAPPER_ROUTER = WRAPPER_PVE.replace('TAG="autosnap"\n', '');
const CRON = `PATH=/usr/local/sbin:/usr/local/bin:/sbin:/bin:/usr/sbin:/usr/bin

5 * * * *     root  autosnap-run hourly
25 0 * * 0    root  autosnap-run weekly
45 0 1,2 * *  root  autosnap-run monthly`;

const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const snap = (label, d, extra = {}) => ({ name: `auto${label}${stamp(new Date(d.getTime() + 1000))}`, description: 'autosnap', snaptime: Math.floor(d.getTime() / 1000), ...extra });

/** Stündliche Snapshots der letzten 8 Betriebsstunden: nicht montags, nur, wenn der Host lief. */
function hourlyTimes(now, hostId) {
  const out = []; let d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 5, 0);
  if (d > now) d = new Date(d.getTime() - 3600e3);
  while (out.length < 8 && now - d < 14 * 864e5) {
    const up = hostId === 'router' || (d.getHours() >= 8 && d.getHours() < 22);
    if (d.getDay() !== 1 && up) out.push(new Date(d));
    d = new Date(d.getTime() - 3600e3);
  }
  return out;
}

export function demoGuests(hostId) {
  return (GUESTS[hostId] ?? []).map(([vmid, name, status, tags]) => ({ vmid, name, status, tags, maxmem: 536870912 }));
}

export function demoSnapshots(hostId, now) {
  const lastSunday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay(), 0, 25, 0);
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1, 0, 45, 0);
  const rows = [];
  for (const [vmid, , status, tags] of GUESTS[hostId] ?? []) {
    const list = [];
    if (tags.split(';').includes('autosnap') && status === 'running') {
      for (const t of hourlyTimes(now, hostId)) list.push(snap('hourly', t));
      // pve ist nachts aus: wöchentlich/monatlich um 00:25/00:45 läuft dort nur manchmal (zwei Gäste zeigen die Lücke)
      if (hostId === 'router' || ![119, 161].includes(vmid)) { list.push(snap('weekly', lastSunday)); list.push(snap('monthly', firstOfMonth)); }
    }
    list.push({ name: 'current', digest: 'x', parent: list.length ? list[0].name : undefined });
    rows.push({ type: 'lxc', vmid, list });
  }
  return rows;
}

const hex = (n, w) => n.toString(16).toUpperCase().padStart(w, '0');
/** vzdump-Läufe: jeden Montag; auf dem pve fehlschlagend am 12.10. (Gast 164). */
export function demoBackups(hostId, now) {
  const tasks = [], logs = {};
  const ids = (GUESTS[hostId] ?? []).filter(([id, , st]) => st === 'running' && !(EXCLUDE[hostId] ?? []).includes(id));
  for (let w = 0; w < 6; w++) {
    const mon = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7) - 7 * w, hostId === 'router' ? 8 : 9, hostId === 'router' ? 15 : 0, 12);
    if (mon > now) continue;
    const per = hostId === 'router' ? 90 : 150; // Sekunden je Gast
    const end = new Date(mon.getTime() + ids.length * per * 1000 + 30000);
    const failed = hostId === 'pve' && mon.getMonth() === 9 && mon.getDate() === 12;
    const upid = `UPID:${hostId}:${hex(4000 + w, 8)}:${hex(900000 + w, 8)}:${hex(Math.floor(mon / 1000), 8)}:vzdump::root@pam:`;
    tasks.push({ upid, node: hostId, pid: 4000 + w, pstart: 900000, starttime: Math.floor(mon / 1000), type: 'vzdump', id: '', user: 'root@pam', endtime: Math.floor(end / 1000), status: failed ? 'job errors' : 'OK' });
    const lines = [`INFO: starting new backup job: vzdump --all 1 --storage pbs --mode snapshot --compress zstd${EXCLUDE[hostId]?.length ? ` --exclude ${EXCLUDE[hostId].join(',')}` : ''}`];
    for (const [id, , , ] of ids) {
      lines.push(`INFO: Starting Backup of VM ${id} (lxc)`, `INFO: Backup started at ${mon.toISOString()}`);
      if (failed && id === 164) lines.push(`ERROR: Backup of VM ${id} failed - proxmox-backup-client failed: Error: error trying to connect: Connection refused`);
      else { const s = per - 20 + (id % 40); lines.push(`INFO: Finished Backup of VM ${id} (${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)})`); }
    }
    lines.push(failed ? 'INFO: Backup job finished with errors' : 'INFO: Backup job finished successfully', failed ? 'TASK ERROR: job errors' : 'TASK OK');
    logs[upid] = lines.map((t, i) => ({ n: i + 1, t }));
  }
  return { tasks, logs };
}

export function demoAutosnapText(hostId, now, { cronOff = false, off = false } = {}) {
  const t = new Date(now.getTime() - 3600e3);
  return `schalter: ${off ? 'aus' : 'an'}\n== wrapper\n${hostId === 'router' ? WRAPPER_ROUTER : WRAPPER_PVE}\n== cron\n${cronOff ? '' : CRON}\n== log\n${t.toISOString().slice(0, 19)}+01:00 ${hostId} autosnap[4242]: VM 112 - Removing snapshot autohourly000101000000\n`;
}
