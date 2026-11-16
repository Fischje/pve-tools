import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseChangelog, loadChangelog } from '../src/changelog.js';

test('Changelog: Versionen mit Datum und Punkten, neueste zuerst', () => {
  const c = parseChangelog('# Changelog\n\nText\n\n## 1.2.3 – 2026-11-16\n- Neu\n  weiter\n- Fix\n\n## 1.2.2 - 2026-11-01\n- Alt\n');
  assert.deepEqual(c, [{ version: '1.2.3', date: '2026-11-16', items: ['Neu weiter', 'Fix'] }, { version: '1.2.2', date: '2026-11-01', items: ['Alt'] }]);
  assert.deepEqual(parseChangelog(''), []);
});

test('Changelog im Repo: oberste Version = package.json, Versionen absteigend, jede mit Datum und Inhalt', () => {
  const c = loadChangelog('CHANGELOG.md');
  const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.ok(c.length > 0);
  assert.equal(c[0].version, pkg.version, 'Bei jeder Auslieferung: package.json und CHANGELOG.md zusammen hochzählen');
  const num = (v) => v.split('.').map(Number).reduce((a, x) => a * 1000 + x, 0);
  for (let i = 1; i < c.length; i++) assert.ok(num(c[i - 1].version) > num(c[i].version), `${c[i - 1].version} vor ${c[i].version}`);
  for (const e of c) { assert.match(e.date ?? '', /^\d{4}-\d{2}-\d{2}$/, e.version); assert.ok(e.items.length, e.version); }
});
