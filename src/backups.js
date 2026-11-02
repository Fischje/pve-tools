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

/**
 * Protokoll einer vzdump-Aufgabe -> Ergebnis je Gast.
 * Erkennt die Zeilen „Starting Backup of VM 109 (lxc)“, „Finished Backup of VM 109 (00:01:22)“ und „ERROR: Backup of VM 112 failed - …“.
 * Gäste, die begonnen haben, aber weder fertig noch fehlgeschlagen sind (Abbruch), gelten als „unterbrochen“.
 */
export function parseVzdumpLog(text) {
  const raw = json(text);
  const lines = Array.isArray(raw) ? raw.map((l) => (typeof l === 'string' ? l : l?.t ?? '')) : String(text ?? '').split('\n');
  const guests = new Map(); let cur = null, job = null;
  for (const l of lines) {
    let m;
    if ((m = /Starting Backup of VM (\d+) \((\w+)\)/.exec(l))) { cur = Number(m[1]); guests.set(cur, { vmid: cur, type: m[2], result: 'interrupted', seconds: null, note: '' }); continue; }
    if ((m = /Finished Backup of VM (\d+) \(([\d:]+)\)/.exec(l))) { const g = guests.get(Number(m[1])) ?? { vmid: Number(m[1]), type: '?', note: '' }; g.result = 'ok'; g.seconds = secs(m[2]); guests.set(g.vmid, g); continue; }
    if ((m = /ERROR: Backup of VM (\d+) failed(?: - (.*))?/.exec(l))) { const g = guests.get(Number(m[1])) ?? { vmid: Number(m[1]), type: '?', seconds: null }; g.result = 'failed'; g.note = (m[2] ?? '').trim().slice(0, 300); guests.set(g.vmid, g); continue; }
    if (/Backup job finished successfully/.test(l)) job = 'ok';
    else if (/Backup job finished with errors/.test(l)) job = 'errors';
    else if (/^TASK OK/.test(l)) job ??= 'ok';
    else if (/^TASK ERROR/.test(l)) job ??= 'errors';
  }
  return { guests: [...guests.values()], job };
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
  const wrapper = part('wrapper'), cron = part('cron'), log = part('log');
  const keep = {};
  for (const l of ['hourly', 'weekly', 'monthly']) { const m = new RegExp(`^\\s*${l}\\)[^\\n]*?KEEP=(\\d+)`, 'm').exec(wrapper); if (m) keep[l] = Number(m[1]); }
  const pause = /^\s*PAUSE_DAY=(\d)/m.exec(wrapper);
  const tag = /^\s*TAG="?([\w-]+)"?/m.exec(wrapper)?.[1] ?? /--tags\s+(\S+)/.exec(wrapper)?.[1] ?? 'autosnap';
  const entries = [];
  for (const l of cron.split('\n')) {
    const s = l.trim(); if (!s || s.startsWith('#') || /^[A-Z_]+=/.test(s)) continue;
    const m = CRON_RE.exec(s); if (m) entries.push({ spec: m[1], text: describeCron(m[1]), user: m[2], command: m[3] });
  }
  return {
    enabled: /^schalter:\s*an/mi.test(t), known: /^schalter:/m.test(t), keep, pauseDay: pause ? Number(pause[1]) : null, tag, cron: entries,
    log: log.split('\n').map((x) => x.trim()).filter((x) => x && !x.startsWith('-- ')).slice(-40),
  };
}
