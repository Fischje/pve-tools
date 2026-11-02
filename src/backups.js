// Auswertung der (nur lesenden) Backup- und Snapshot-Abfragen: Gäste, Snapshots, vzdump-Läufe samt Protokoll und der Zustand von proxmox-autosnap.
// Reine Funktionen, damit sie sich mit Beispielausgaben testen lassen.

const json = (s) => { try { return JSON.parse(s); } catch { return null; } };
const LABEL_RE = /^auto(_?)(minute|hourly|daily|weekly|monthly)/;

/** "lxc\t[…json…]" je Zeile -> Gäste */
export function parseGuests(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const i = line.indexOf('\t'); if (i < 0) continue;
    const type = line.slice(0, i), list = json(line.slice(i + 1));
    if (!['lxc', 'qemu'].includes(type) || !Array.isArray(list)) continue;
    for (const g of list) {
      if (g?.vmid == null) continue;
      out.push({ vmid: Number(g.vmid), type, name: g.name ?? `${type}-${g.vmid}`, status: g.status ?? 'unknown',
        tags: String(g.tags ?? '').split(/[;,]/).map((t) => t.trim()).filter(Boolean), template: Number(g.template ?? 0) === 1 });
    }
  }
  return out;
}

/** "lxc\t109\t[…json…]" je Zeile -> Snapshots (ohne den Eintrag "current") */
export function parseSnapshots(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const [type, id, ...rest] = line.split('\t'); if (!id || !rest.length) continue;
    const list = json(rest.join('\t')); if (!Array.isArray(list)) continue;
    for (const sn of list) {
      if (!sn?.name || sn.name === 'current') continue;
      const m = LABEL_RE.exec(sn.name);
      out.push({ type, vmid: Number(id), name: sn.name, label: m ? m[2] : null, ts: sn.snaptime ? Number(sn.snaptime) * 1000 : null, description: sn.description ?? '' });
    }
  }
  return out;
}

/** Liste der vzdump-Aufgaben (JSON-Feld von pvesh) */
export function parseTasks(text) {
  const list = json(text);
  if (!Array.isArray(list)) return [];
  return list.filter((t) => t?.upid).map((t) => ({
    upid: t.upid, start: t.starttime ? Number(t.starttime) * 1000 : null, end: t.endtime ? Number(t.endtime) * 1000 : null,
    status: t.status ?? null, user: t.user ?? null, id: t.id ?? '',
  }));
}

const secs = (hms) => { const p = String(hms).split(':').map(Number); return p.length === 3 && p.every(Number.isFinite) ? p[0] * 3600 + p[1] * 60 + p[2] : null; };

// Hinweise auf eine fehlende oder abgebrochene Verbindung zum Backup-Ziel (PBS aus, zwischendurch heruntergefahren, Netzwerk).
const CONN_RE = /error trying to connect|tcp connect error|connection (?:refused|reset|closed|timed out)|broken pipe|no route to host|network is unreachable|connect failed|client error \(Connect\)|timed out/i;
export const failureCause = (text) => (CONN_RE.test(String(text ?? '')) ? 'verbindung' : 'sonstiges');
const clean = (l) => String(l).replace(/^(INFO|ERROR|WARN):\s*/, '').trim();

/**
 * Protokoll einer vzdump-Aufgabe -> Ergebnis je Gast.
 * Erkennt die Zeilen „Starting Backup of VM 109 (lxc)“, „Finished Backup of VM 109 (00:01:22)“ und „ERROR: Backup of VM 112 failed - …“.
 * Bei einem Fehlschlag wird der Grund aus den Zeilen des Gastes gelesen: Meist steht er VOR der letzten ERROR-Zeile (z. B. „error trying to connect“).
 * Gäste, die begonnen haben, aber weder fertig noch fehlgeschlagen sind (Abbruch), gelten als „unterbrochen“.
 */
export function parseVzdumpLog(text) {
  const raw = json(text);
  const lines = Array.isArray(raw) ? raw.map((l) => (typeof l === 'string' ? l : l?.t ?? '')) : String(text ?? '').split('\n');
  const guests = new Map(); const block = new Map(); let cur = null, job = null;
  const note = (id, l) => { if (id != null) (block.get(id) ?? block.set(id, []).get(id)).push(l); };
  for (const l of lines) {
    let m;
    if ((m = /Starting Backup of VM (\d+) \((\w+)\)/.exec(l))) { cur = Number(m[1]); guests.set(cur, { vmid: cur, type: m[2], result: 'interrupted', seconds: null, note: '', cause: null }); block.set(cur, []); continue; }
    if ((m = /Finished Backup of VM (\d+) \(([\d:]+)\)/.exec(l))) { const g = guests.get(Number(m[1])) ?? { vmid: Number(m[1]), type: '?', note: '', cause: null }; g.result = 'ok'; g.seconds = secs(m[2]); guests.set(g.vmid, g); cur = null; continue; }
    if ((m = /ERROR: Backup of VM (\d+) failed(?: - (.*))?/.exec(l))) {
      const id = Number(m[1]); const g = guests.get(id) ?? { vmid: id, type: '?', seconds: null, cause: null };
      const lines2 = [...(block.get(id) ?? []), l];
      g.result = 'failed'; g.cause = failureCause(lines2.join('\n'));
      const conn = lines2.find((x) => CONN_RE.test(x));
      g.note = clean(conn ?? m[2] ?? '').slice(0, 300);
      g.detail = lines2.slice(-6).map(clean).join(' | ').slice(0, 600);
      guests.set(id, g); cur = null; continue;
    }
    if (/Backup job finished successfully/.test(l)) job = 'ok';
    else if (/Backup job finished with errors/.test(l)) job = 'errors';
    else if (/^TASK OK/.test(l)) job ??= 'ok';
    else if (/^TASK ERROR/.test(l)) job ??= 'errors';
    else note(cur, l);
  }
  return { guests: [...guests.values()], job };
}

/** Zusammenfassung eines Laufs: wie viele Gäste, wie viele davon wegen der Verbindung zum Ziel fehlgeschlagen. */
export function summarizeRun(guests) {
  const failed = guests.filter((g) => g.result === 'failed');
  const conn = failed.filter((g) => g.cause === 'verbindung');
  return { total: guests.length, failed: failed.length, connection: conn.length, cause: failed.length >= 2 && conn.length >= Math.ceil(failed.length * 0.7) ? 'verbindung' : null };
}

const CRON_RE = /^(\S+\s+\S+\s+\S+\s+\S+\s+\S+)\s+(\S+)\s+(.+)$/;
/** Lesbare Beschreibung der drei üblichen Zeitmuster, sonst der Rohtext. */
export function describeCron(spec) {
  let m;
  if ((m = /^(\d+) \* \* \* \*$/.exec(spec))) return `stündlich um :${String(m[1]).padStart(2, '0')}`;
  if ((m = /^(\d+) (\d+) \* \* (\d)$/.exec(spec))) return `wöchentlich ${['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][Number(m[3]) % 7]} ${String(m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}`;
  if ((m = /^(\d+) (\d+) ([\d,]+) \* \*$/.exec(spec))) return `monatlich am ${m[3].replace(/,/g, '. und ')}. um ${String(m[2]).padStart(2, '0')}:${String(m[1]).padStart(2, '0')}`;
  return spec;
}

/** Ausgabe des Befehls „autosnap“: Schalter, Aufbewahrung und Pausentag aus deinem Wrapper, Cron-Zeilen, letzte Meldungen. */
export function parseAutosnap(text) {
  const t = String(text ?? '');
  const part = (name) => { const m = new RegExp(`^== ${name}\\n([\\s\\S]*?)(?=^== |\\s*$(?![\\s\\S]))`, 'm').exec(t); return m ? m[1] : ''; };
  const wrapper = part('wrapper'), cron = part('cron'), log = part('log'), confText = part('conf');
  const keep = {};
  for (const l of ['hourly', 'weekly', 'monthly']) { const m = new RegExp(`^\\s*${l}\\)[^\\n]*?KEEP=(\\d+)`, 'm').exec(wrapper); if (m) keep[l] = Number(m[1]); }
  const pause = /^\s*PAUSE_DAY=(\d)/m.exec(wrapper);
  let tag = /^\s*TAG="?([\w-]+)"?/m.exec(wrapper)?.[1] ?? /--tags\s+(\S+)/.exec(wrapper)?.[1] ?? 'autosnap';
  // Verwalteter Wrapper (v2): Die Werte stehen in /etc/autosnap.conf, im Skript nur die Standardwerte.
  const managed = /^# autosnap-run v2/m.test(wrapper);
  const conf = {};
  for (const l of confText.split('\n')) { const m = /^([A-Z_]+)=(\S+)$/.exec(l.trim()); if (m) conf[m[1]] = m[2]; }
  const cn = (k, d) => (/^\d{1,3}$/.test(conf[k] ?? '') ? Number(conf[k]) : d);
  let pauseDay = pause ? Number(pause[1]) : null, onlyRunning = /pct list/.test(wrapper), monthlyDay = 1;
  if (managed) {
    keep.hourly = cn('KEEP_HOURLY', 8); keep.weekly = cn('KEEP_WEEKLY', 1); keep.monthly = cn('KEEP_MONTHLY', 1);
    const pd = cn('PAUSE_DAY', 1); pauseDay = pd === 0 ? null : pd % 7; // 0 = kein Pausentag, 7 = Sonntag
    monthlyDay = cn('MONTHLY_DAY', 1); onlyRunning = cn('ONLY_RUNNING', 0) === 1;
    if (/^[\w-]{1,32}$/.test(conf.TAG ?? '')) tag = conf.TAG;
  }
  const entries = [];
  for (const l of cron.split('\n')) {
    const s = l.trim(); if (!s || s.startsWith('#') || /^[A-Z_]+=/.test(s)) continue;
    const m = CRON_RE.exec(s); if (m) entries.push({ spec: m[1], text: describeCron(m[1]), user: m[2], command: m[3] });
  }
  return {
    enabled: /^schalter:\s*an/mi.test(t), known: /^schalter:/m.test(t), keep, pauseDay, tag, cron: entries, managed, monthlyDay, onlyRunning,
    log: log.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('-- ')).slice(-40),
  };
}
