// Bereich „Energie“: je Host Bestandsaufnahme (System, CPU-Regelung, C-States, ASPM je PCIe-Gerät, SATA), Hinweise und ASPM-Steuerung.
import { h, fmtDT, pill, meter, fact, ctx, hostSwitch, fold, kpiBox } from './dom.js';
import { powerChart, dailyBars, figure } from './charts.js';

const STUFE = { none: 'nein', L0s: 'L0s', L1: 'L1', L0sL1: 'L0s + L1' };
const LV = { ok: 'ok', watch: 'watch', info: 'unknown' };
const short = (n) => String(n ?? '').replace(/\s*\(rev [^)]*\)/, '').replace(/^[^:]*:\s*/, '');
const kind = (n) => String(n ?? '').split(':')[0];

function biosChecklist(e) {
  const amd = /AMD|Ryzen|EPYC/i.test(e?.system?.['processor-version'] ?? '');
  const items = amd
    ? [['Global C-state Control', 'Enabled'], ['Power Supply Idle Control', 'Low Current Idle (nicht „Typical“)'], ['CPPC / CPPC Preferred Cores', 'Enabled'], ['Cool\'n\'Quiet / PSS Support', 'Enabled'], ['ASPM / Native ASPM', 'Enabled (L1)'], ['DF C-States', 'Enabled']]
    : [['CPU C-States', 'Enabled'], ['Package C-State Limit', 'Auto oder höchster Wert (C10)'], ['C1E / Enhanced C-States', 'Enabled'], ['Intel SpeedStep (EIST) und Speed Shift (HWP)', 'Enabled'], ['Native ASPM', 'Enabled'], ['PCH/CPU PCI Express ASPM', 'L1 bzw. Auto, „L1 Substates“ Enabled'], ['DMI Link ASPM', 'Enabled']];
  const common = [['Unbenutzte Geräte', 'Onboard-Audio, serielle Schnittstelle, unbenutzte SATA-/LAN-Controller, WLAN/Bluetooth, RGB abschalten'], ['Lüfter', 'Lüfterkurve „leise“/„standard“ statt „voll“'], ['SATA Aggressive Link Power Management', 'nur, wenn der Host keine Link-Fehler zeigt (CRC-Zähler, Kernel-Meldungen)'], ['ErP / Deep Sleep', 'Vorsicht: kann Wake-on-LAN abschalten. Beim PBS aus lassen, sonst lässt er sich nicht mehr per Magic Packet einschalten']];
  return h('div', {}, h('p', { class: 'sub' }, 'Die Namen heißen je nach Hersteller etwas anders. Nach jeder Änderung im BIOS hier „Jetzt abfragen“: Werden tiefere C-States erreicht?'),
    h('table', { class: 'mini' }, h('tbody', {}, [...items, ...common].map(([k, v]) => h('tr', {}, h('td', {}, h('b', {}, k)), h('td', {}, v))))));
}

function hostBody(en, host, data) {
  const hostObj = data.hosts.find((x) => x.id === host.id);
  const post = (body, okText) => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/energy`, body), okText);
  if (!host.supported) return h('section', { class: 'panel' }, h('p', {}, host.gate == null ? 'Von diesem Host liegen noch keine Daten vor.' : `Das Prüfskript auf ${host.label} hat Version ${host.gate}. Für den Bereich „Energie“ wird Version 13 gebraucht.`),
    host.reachable && hostObj ? h('button', { class: 'primary', onclick: () => ctx.openUpdate(hostObj) }, 'Prüfskript aktualisieren') : null);
  const e = host.data;
  if (!e) return h('section', { class: 'panel' }, h('p', {}, 'Noch keine Bestandsaufnahme gelesen.'), h('button', { onclick: () => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/poll`, {}), 'Abgefragt.') }, 'Jetzt abfragen'));
  const s = e.system ?? {}, cf = e.cpufreq ?? {};
  const head = h('section', { class: 'panel' }, h('div', { class: 'card-title' }, h('h2', {}, host.label), h('span', { class: 'sub' }, `Stand ${fmtDT(e.ts)}${host.reachable ? '' : ' · Host ist gerade aus'}`), h('span', { class: 'spacer' }),
    h('button', { onclick: () => ctx.act(() => ctx.api('POST', `/api/hosts/${host.id}/poll`, {}), 'Abgefragt.') }, 'Jetzt abfragen')),
    e.findings.map((f) => h('div', { class: `finding ${f.level === 'watch' ? 'watch' : f.level === 'ok' ? 'ok' : 'info'}` }, h('b', {}, f.title), h('div', {}, f.text), f.advice ? h('div', { class: 'sub' }, `Was tun? ${f.advice}`) : null)),
    h('div', { class: 'facts' },
      ...(en.power?.meters ?? []).filter((m) => m.hostId === host.id).map((m) => fact('Verbrauch jetzt', m.latest?.error ? 'Steckdose nicht erreichbar' : `${watt(m.latest?.power)} (Ø 7 Tage ${watt(m.avg7d)})`)),
      fact('Mainboard', `${s['baseboard-manufacturer'] ?? '–'} ${s['baseboard-product-name'] ?? ''}`.trim()),
      fact('BIOS', `${s['bios-version'] ?? '–'}${s['bios-release-date'] ? ` (${s['bios-release-date']})` : ''}`),
      fact('CPU', s['processor-version'] ?? '–'),
      fact('CPU-Regelung', `${cf.scaling_governor ?? '–'}${cf.scaling_driver ? ` (${cf.scaling_driver})` : ''}`),
      fact('Energievorgabe', cf.energy_performance_preference || '–'),
      fact('ASPM-Vorgabe Kernel', e.aspm?.policy ?? '–')));

  const cst = h('section', { class: 'panel' }, h('h2', {}, 'Wo verbringt die CPU ihre Zeit? (seit dem Start)'),
    h('p', { class: 'sub' }, 'Je mehr Zeit in tiefen Zuständen (C6, C8, C10), desto weniger Strom. Viel „aktiv“ oder nur C1/C1E heißt: Die CPU darf nicht sparen (BIOS) oder ein Gerät hält sie wach.'),
    e.shares.length ? e.shares.map((r) => meter(r.name, Math.round(r.pct), r.id === 'c0' ? 'watch' : /C[6-9]|C10/.test(r.name) ? 'ok' : 'unknown', `${r.pct} %`)) : h('p', { class: 'sub' }, 'Keine C-States gemeldet.'));

  const excl = new Set(e.aspm?.exclude ?? []);
  const boxes = new Map();
  const rows = (e.pci ?? []).map((p) => {
    const box = h('input', { type: 'checkbox', checked: excl.has(p.addr), disabled: !host.right, 'aria-label': `${short(p.name)} ausnehmen` });
    boxes.set(p.addr, box);
    const on = p.ctl !== 'none', can = p.cap !== 'none';
    return h('tr', {}, h('td', {}, h('div', { class: 'model' }, short(p.name)), h('div', { class: 'sub' }, `${kind(p.name)} · ${p.addr}`)),
      h('td', {}, STUFE[p.cap] ?? p.cap), h('td', {}, can ? pill(on ? 'ok' : 'watch', on ? STUFE[p.ctl] : 'aus') : h('span', { class: 'sub' }, '–')),
      h('td', {}, can ? h('label', {}, box, ' ausnehmen') : null),
      h('td', {}, host.right && on ? h('button', { onclick: () => { if (confirm(`ASPM für ${short(p.name)} bis zum nächsten Neustart ausschalten?`)) post({ action: 'off', arg: p.addr }, 'ASPM für das Gerät ausgeschaltet.'); } }, 'Aus') : null));
  });
  const a = e.aspm ?? {};
  const aspm = h('section', { class: 'panel' }, h('h2', {}, 'PCIe-Geräte und ASPM'),
    h('p', { class: 'sub' }, 'ASPM lässt die PCIe-Verbindung eines Geräts im Leerlauf schlafen. Erst wenn alle Geräte das dürfen, erreicht die CPU die tiefsten C-States. Selten verursacht es Aussetzer, vor allem bei SATA-Controllern und Netzwerkkarten: Solche Geräte dann ausnehmen.'),
    rows.length ? h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Gerät', 'kann', 'ist an', '', ''].map((t) => h('th', {}, t)))), h('tbody', {}, rows))) : h('p', { class: 'sub' }, 'Keine PCIe-Geräte gemeldet.'),
    !host.right
      ? h('div', { class: 'finding info' }, h('b', {}, 'Einschalten durch das Tool: noch nicht freigegeben'), h('div', { class: 'sub' }, 'Im Reiter „Hosts einrichten“ bei „Skript aktualisieren“ den Haken „Energie-Einstellungen erlauben“ setzen (root-Passwort). Das installiert pvetools-aspm auf dem Host.'),
          hostObj ? h('div', { class: 'actions' }, h('button', { onclick: () => ctx.openUpdate(hostObj) }, 'Recht freigeben')) : null)
      : h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: () => { if (confirm(`ASPM auf ${host.label} jetzt für alle geeigneten Geräte einschalten (außer den ausgenommenen)? Gilt bis zum nächsten Neustart. Danach ein paar Tage auf Verbindungsfehler achten.`)) post({ action: 'apply' }, 'ASPM eingeschaltet.'); } }, 'ASPM jetzt einschalten'),
          h('button', { onclick: () => post({ action: 'exclude', arg: [...boxes].filter(([, b]) => b.checked).map(([addr]) => addr) }, 'Ausnahmen gespeichert.') }, 'Ausnahmen speichern'),
          h('span', { class: 'spacer' }),
          h('label', {}, h('input', { type: 'checkbox', checked: a.boot === 'enabled', class: 'no-dirty', onchange: (ev) => post({ action: 'boot', arg: ev.target.checked }, ev.target.checked ? 'ASPM wird bei jedem Start eingeschaltet.' : 'ASPM wird beim Start nicht mehr eingeschaltet.') }), ' bei jedem Start einschalten')));

  const sata = (e.sata ?? []).length ? h('section', { class: 'panel' }, h('h2', {}, 'SATA-Anschlüsse'), h('p', {}, e.sata.map((x) => `${x.host}: ${x.policy}`).join(' · ')),
    h('p', { class: 'sub' }, '„max_performance“ spart nichts, „med_power_with_dipm“ spart etwas. Bei Hosts mit SATA-Link-Fehlern erst die Kabel prüfen.')) : null;
  return [head, cst, aspm, sata, fold(`bios-${host.id}`, 'BIOS: Checkliste zum Stromsparen', `${s['baseboard-product-name'] ?? ''}`, () => biosChecklist(e))];
}

const kwh = (v) => (v == null ? '–' : `${(Math.round(v * 100) / 100).toLocaleString('de-DE')} kWh`);
const watt = (v) => (v == null ? '–' : `${(Math.round(v * 10) / 10).toLocaleString('de-DE')} W`);
const euro = (v) => (v == null ? '–' : `${Math.round(v).toLocaleString('de-DE')} €`);

/** Strommessung: Übersicht, Verlauf, Vorher/Nachher und Einrichtung der Tasmota-Steckdosen. */
function powerSection(pw, data) {
  const meters = pw?.meters ?? [];
  const label = (m) => m.label + (m.hostId ? '' : ' (anderes Gerät)');
  const now = Date.parse(pw?.now ?? '') || Date.now(); // Zeit des Servers (in der Demo eine andere als im Browser)
  const parts = [];
  if (meters.length) {
    const t = pw.total;
    parts.push(h('div', { class: 'kpis' },
      kpiBox('Verbrauch jetzt', watt(t.power), `${meters.length} ${meters.length === 1 ? 'Steckdose' : 'Steckdosen'}`),
      kpiBox('Heute', kwh(t.today), `gestern ${kwh(t.yesterday)}`),
      kpiBox('Ø letzte 7 Tage', watt(t.avg7d), t.kwhYear != null ? `≈ ${t.kwhYear.toLocaleString('de-DE')} kWh im Jahr` : ''),
      kpiBox('Kosten im Jahr', euro(t.kwhYear != null ? t.kwhYear * pw.price : null), `bei ${pw.price.toLocaleString('de-DE')} €/kWh`)));
    const rows = meters.map((m, i) => h('tr', {}, h('td', {}, h('span', { class: `sw bar-p${i % 5}`, style: 'display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px' }), h('b', {}, label(m))),
      h('td', { class: 'num' }, m.latest?.error ? h('span', { class: 'bad' }, m.latest.error) : watt(m.latest?.power)), h('td', { class: 'num' }, kwh(m.latest?.today)), h('td', { class: 'num' }, watt(m.avg7d)),
      h('td', { class: 'sub' }, m.latest?.ts ? fmtDT(m.latest.ts) : 'noch nicht gelesen')));
    parts.push(h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Steckdose', 'jetzt', 'heute', 'Ø 7 Tage', 'zuletzt gelesen'].map((x) => h('th', {}, x)))), h('tbody', {}, rows))));
    const legend = meters.map((m, i) => [`bar-p${i % 5}`, label(m)]);
    parts.push(h('div', { class: 'statgrid' },
      figure('Leistung der letzten 24 Stunden', powerChart(meters.map((m, i) => ({ label: label(m), cls: `p${i % 5}`, points: m.series })), { fromMs: now - 864e5, toMs: now, label: 'Leistung je Steckdose, letzte 24 Stunden' }), { legend }),
      figure('Verbrauch je Tag (kWh)', dailyBars((() => { const days = [...new Set(meters.flatMap((m) => m.daily.map((d) => d.day)))].sort().slice(-30); return days.map((day) => ({ day, parts: meters.map((m, i) => ({ cls: `bar-p${i % 5}`, label: label(m), kwh: m.daily.find((d) => d.day === day)?.kwh ?? 0 })) })); })()), { legend, note: 'Aus den Zählerständen der Steckdosen.' })));
    if (pw.changes.length) parts.push(h('h3', {}, 'Was hat eine Änderung gebracht?'), h('p', { class: 'sub' }, 'Mittlere Leistung 24 Stunden vor und nach jeder Energie-Änderung im Tool. Andere Einflüsse (Last, Backups) spielen mit hinein: erst über mehrere Tage aussagekräftig.'),
      h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Wann', 'Host', 'Änderung', 'vorher', 'nachher', 'Unterschied'].map((x) => h('th', {}, x)))),
        h('tbody', {}, pw.changes.map((c) => { const d = c.before != null && c.after != null ? Math.round((c.after - c.before) * 10) / 10 : null;
          return h('tr', {}, h('td', {}, fmtDT(c.ts)), h('td', {}, data.hosts.find((x) => x.id === c.hostId)?.label ?? c.hostId), h('td', {}, c.text), h('td', { class: 'num' }, watt(c.before)), h('td', { class: 'num' }, `${watt(c.after)}${c.complete ? '' : ' (läuft noch)'}`),
            h('td', { class: `num ${d == null ? '' : d < 0 ? 'better' : 'worse'}` }, d == null ? '–' : `${d > 0 ? '+' : ''}${d.toLocaleString('de-DE')} W`)); })))));
  } else parts.push(h('p', {}, 'Noch keine Steckdose eingerichtet. Unten unter „Steckdosen einrichten“ die Tasmota-Steckdosen eintragen.'));
  parts.push(fold('power-setup', 'Steckdosen einrichten (Tasmota)', `${meters.length} eingetragen`, () => powerSetup(pw, data), { open: !meters.length }));
  return h('section', { class: 'panel', style: 'margin-top:14px' }, h('h2', {}, 'Stromverbrauch'), parts);
}

function powerSetup(pw, data) {
  const rows = [];
  const tbody = h('tbody', {});
  const out = h('div', {});
  const price = h('input', { type: 'text', value: String(pw?.price ?? 0.35).replace('.', ','), size: 6 });
  const addRow = (m = {}) => {
    const f = { id: h('input', { type: 'text', value: m.id ?? '', placeholder: 'z. B. steckdose-pve', size: 16 }), label: h('input', { type: 'text', value: m.label ?? '', placeholder: 'Anzeigename', size: 16 }),
      address: h('input', { type: 'text', value: m.address ?? '', placeholder: 'IP-Adresse', size: 14 }),
      host: h('select', {}, h('option', { value: '' }, 'anderes Gerät'), data.hosts.map((x) => h('option', { value: x.id, selected: x.id === m.hostId }, x.label))),
      pw: h('input', { type: 'password', autocomplete: 'new-password', placeholder: m.passwordSet ? 'gespeichert' : 'ohne', size: 10 }), clear: false };
    const tr = h('tr', {}, h('td', {}, f.id), h('td', {}, f.label), h('td', {}, f.address), h('td', {}, f.host), h('td', {}, f.pw),
      h('td', {}, h('div', { class: 'row' },
        h('button', { type: 'button', onclick: async () => { out.replaceChildren(h('p', { class: 'sub' }, 'Lese …')); try { const r = (await ctx.api('POST', '/api/power', { action: 'test', address: f.address.value.trim(), password: f.pw.value, id: f.id.value.trim() })).reading; out.replaceChildren(h('div', { class: 'finding ok' }, `${f.address.value}: ${watt(r.power)} jetzt, heute ${kwh(r.today)}, Zähler ${kwh(r.total)}${r.voltage ? `, ${r.voltage} V` : ''}`)); } catch (e) { out.replaceChildren(h('div', { class: 'finding critical' }, `${f.address.value}: ${e.message}`)); } } }, 'Testen'), // gitleaks:allow (Feldname, kein Wert)
        h('button', { type: 'button', onclick: () => { rows.splice(rows.indexOf(f), 1); tr.remove(); } }, 'Entfernen'))));
    rows.push(f); tbody.append(tr);
  };
  for (const m of pw?.meters ?? []) addRow(m);
  const save = () => ctx.act(() => ctx.api('POST', '/api/power', { action: 'save', price: price.value, meters: rows.map((f) => ({ id: f.id.value.trim(), label: f.label.value.trim(), address: f.address.value.trim(), hostId: f.host.value || null, password: f.pw.value || undefined })) }), 'Steckdosen gespeichert.'); // gitleaks:allow (Feldname, kein Wert)
  return h('div', {},
    h('p', { class: 'sub' }, 'Je Server die IP-Adresse seiner Tasmota-Steckdose. Das Tool fragt jede Minute „Status 8“ ab (Leistung und Zähler). Ist in Tasmota ein Web-Passwort gesetzt, hier eintragen (Benutzer „admin“); es wird gespeichert, aber nie wieder angezeigt.'),
    h('div', { class: 'scroll' }, h('table', {}, h('thead', {}, h('tr', {}, ['Kennung', 'Name', 'Adresse', 'gehört zu', 'Passwort', ''].map((x) => h('th', {}, x)))), tbody)),
    h('div', { class: 'row' }, h('button', { type: 'button', onclick: () => addRow() }, 'Steckdose hinzufügen'), h('span', { class: 'spacer' }), h('label', { class: 'f inline' }, 'Strompreis €/kWh', price)),
    out, h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Speichern')));
}

export function energyView(en, data) {
  if (!en) return h('p', { class: 'empty' }, 'Keine Daten. Bitte neu laden.');
  const hosts = en.hosts;
  if (!hosts.length) return h('p', { class: 'empty' }, 'Keine Hosts eingerichtet.');
  return [h('section', { class: 'panel', style: 'margin-top:14px' }, h('h2', {}, 'Energie sparen'),
    h('p', { class: 'sub' }, 'Ziel: viel Leistung nur, wenn die Server etwas zu tun haben, sonst sparen. Diese Ansicht zeigt je Host, ob CPU und PCIe-Geräte sparen dürfen, und schaltet ASPM ein. Der echte Verbrauch kommt von den Tasmota-Steckdosen.')),
    powerSection(en.power, data),
    hostSwitch('en-host', hosts.map((x) => ({ id: x.id, label: x.label, level: !x.data ? 'unknown' : x.data.findings.some((f) => f.level === 'watch') ? 'watch' : 'ok' })), (id) => hostBody(en, hosts.find((x) => x.id === id), data))];
}
