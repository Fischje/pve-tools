// Versionsnummer und Änderungen aus CHANGELOG.md (Überschriften „## 1.2.3 – JJJJ-MM-TT“, darunter Spiegelstriche).
import { readFileSync } from 'node:fs';

/** @returns {{version:string, date:string|null, items:string[]}[]} neueste zuerst */
export function parseChangelog(text) {
  const out = [];
  let cur = null;
  for (const raw of String(text ?? '').split('\n')) {
    const line = raw.trimEnd();
    const m = /^##\s+(\d+\.\d+\.\d+)(?:\s*[–-]\s*(\d{4}-\d{2}-\d{2}))?/.exec(line);
    if (m) { cur = { version: m[1], date: m[2] ?? null, items: [] }; out.push(cur); continue; }
    if (cur && /^\s*-\s+/.test(line)) cur.items.push(line.replace(/^\s*-\s+/, '').trim());
    else if (cur && /^\s{2,}\S/.test(line) && cur.items.length) cur.items[cur.items.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

export function loadChangelog(file) {
  try { return parseChangelog(readFileSync(file, 'utf8')); } catch { return []; }
}
