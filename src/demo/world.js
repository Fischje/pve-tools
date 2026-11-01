// Simulierte Hosts für den Demo-Modus und die Tests: antwortet wie das Gate-Skript, mit Beispieldaten und simulierten Tests.
import * as fx from './fixtures.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
function as(json, device, serial, model, capBytes) {
  const j = clone(json);
  j.device.name = device; j.serial_number = serial; if (model) j.model_name = model;
  if (capBytes) j.user_capacity = { blocks: Math.round(capBytes / 512), bytes: capBytes };
  return j;
}

/** Pool-Beschreibung -> Text im Format von `zpool status -p`. Gerätenamen wie in /dev/disk/by-id (mit Seriennummer). */
function zpoolStatusText(pools) {
  return pools.map((p) => {
    const lines = [`  pool: ${p.name}`, ` state: ${p.state ?? 'ONLINE'}`, `  scan: ${p.scan ?? 'scrub repaired 0B in 05:10:12 with 0 errors on Sun Oct 11 05:34:13 2026'}`, 'config:', '', '\tNAME                                              STATE     READ WRITE CKSUM',
      `\t${p.name.padEnd(49)} ${(p.state ?? 'ONLINE').padEnd(9)} 0 0 0`];
    for (const v of p.vdevs) {
      const row = (name, state, r, w, c, ind) => `\t${' '.repeat(ind)}${name}`.padEnd(51) + ` ${state.padEnd(9)} ${String(r).padStart(4)} ${String(w).padStart(5)} ${String(c).padStart(5)}`;
      if (v.section && v.section !== 'data') lines.push(`\t${v.section}`);
      if (v.type) {
        lines.push(row(v.type, v.state ?? 'ONLINE', 0, 0, 0, 2));
        for (const d of v.devs) lines.push(row(d.name, d.state ?? 'ONLINE', d.r ?? 0, d.w ?? 0, d.c ?? 0, 4));
      } else for (const d of v.devs) lines.push(row(d.name, d.state ?? 'ONLINE', d.r ?? 0, d.w ?? 0, d.c ?? 0, 2));
    }
    lines.push('', `errors: ${p.errors ?? 'No known data errors'}`, '');
    return lines.join('\n');
  }).join('\n');
}
const zpoolListText = (pools) => pools.map((p) => [p.name, Math.round(p.size), Math.round(p.alloc), Math.round(p.size - p.alloc), p.frag ?? 2, Math.round((p.alloc / p.size) * 100), p.state ?? 'ONLINE'].join('\t')).join('\n') + '\n';
const TB = 1e12;

/** Platten und Hosts, angelehnt an die echte Umgebung. */
export function demoDefinition() {
  const disks = {
    router: [
      as(fx.wdSsd86(), '/dev/sda', '210623444409', 'WDC WDS500G2B0A-00SM50'),
      as(fx.nvme({ used: 4, model: 'WD Red SN700 500GB' }), '/dev/nvme0n1', '25434G800337', 'WD Red SN700 500GB', 500107862016),
      as(fx.nvme({ used: 4, model: 'WD Red SN700 500GB' }), '/dev/nvme1n1', '25434G801133', 'WD Red SN700 500GB', 500107862016),
    ],
    pve: [
      as(fx.exos12({ hours: 19000 }), '/dev/sda', 'ZL2M2KFZ'),
      as(fx.exos12({ hours: 19100 }), '/dev/sdb', 'ZL2M6GPD'),
      as(fx.seagateDefekt(), '/dev/sdc', 'ZHZ0RHKE'),
      as(fx.exos12({ hours: 19200 }), '/dev/sdd', 'ZTN0HXBH'),
      as(fx.exos12({ hours: 19300 }), '/dev/sde', 'ZTN0HZ5A'),
      as(fx.exos12({ hours: 20000, model: 'ST12000NM0248-2H3111' }), '/dev/sdf', 'ZHZ640G8', 'ST12000NM0248-2H3111'),
      as(fx.nvme({ used: 2 }), '/dev/nvme1n1', 'NJF381R004120P2202'),
      as(fx.nvme({ used: 2, temp: 44 }), '/dev/nvme2n1', 'NJF381R004786P2202'),
      as(fx.nvme({ used: 1, temp: 42 }), '/dev/nvme3n1', 'NJF381R004808P2202'),
      as(fx.nvme({ used: 9, model: 'Samsung SSD 980 1TB' }), '/dev/nvme0n1', 'S649NL0T759253H', 'Samsung SSD 980 1TB', 1000204886016),
      as(fx.nvme({ used: 9, model: 'Samsung SSD 980 1TB', temp: 47 }), '/dev/nvme4n1', 'S649NL0T759254M', 'Samsung SSD 980 1TB', 1000204886016),
    ],
    pbs: [
      as(fx.hdd6(), '/dev/sda', 'WX002XFY'),
      as(fx.hdd6({ hours: 41000 }), '/dev/sdb', '61X0A03HFKUE', 'TOSHIBA MG06ACA600E'),
      as(fx.hdd6({ hours: 36000 }), '/dev/sdc', 'WD-WX31D298FL3C', 'WDC WD60EZAZ-00ZGHB0'),
      as(fx.nvme({ used: 0, model: 'ESO512GYLCT-EP3-2L' }), '/dev/nvme0n1', '511220816260005114', 'ESO512GYLCT-EP3-2L', 512110190592),
    ],
  };
  const hosts = [
    { id: 'router', label: 'router', kind: 'dauer', uptime: 86400 * 20, pools: [
      { name: 'rpool', size: 0.47 * TB, alloc: 0.09 * TB, vdevs: [{ type: 'mirror-0', devs: [{ name: 'nvme-WD_Red_SN700_500GB_25434G800337-part3' }, { name: 'nvme-WD_Red_SN700_500GB_25434G801133-part3' }, { name: 'ata-WDC_WDS500G2B0A-00SM50_210623444409-part3' }] }] }] },
    { id: 'pve', label: 'pve', kind: 'fest', window: { from: '08:00', to: '22:00' }, uptime: 7200, pools: [
      { name: 'rpool', size: 0.93 * TB, alloc: 0.21 * TB, vdevs: [{ type: 'mirror-0', devs: [{ name: 'nvme-Samsung_SSD_980_1TB_S649NL0T759253H-part3' }, { name: 'nvme-Samsung_SSD_980_1TB_S649NL0T759254M-part3' }] }] },
      { name: 'tank', size: 65.4 * TB, alloc: 31.2 * TB, frag: 6, vdevs: [{ type: 'raidz2-0', devs: [
        { name: 'ata-ST12000NM003G-2MT113_ZL2M2KFZ' }, { name: 'ata-ST12000NM003G-2MT113_ZL2M6GPD' }, { name: 'ata-ST12000NM0248-2H3111_ZHZ0RHKE', c: 3 },
        { name: 'ata-ST12000NM003G-2MT113_ZTN0HXBH' }, { name: 'ata-ST12000NM003G-2MT113_ZTN0HZ5A' }, { name: 'ata-ST12000NM0248-2H3111_ZHZ640G8' }] }] },
      { name: 'fast', size: 11.2 * TB, alloc: 9.7 * TB, frag: 14, scan: 'scrub repaired 0B in 01:12:40 with 0 errors on Sun Oct 11 03:12:40 2026', vdevs: [{ type: 'raidz1-0', devs: [
        { name: 'nvme-Lexar_SSD_NM790_4TB_NJF381R004120P2202' }, { name: 'nvme-Lexar_SSD_NM790_4TB_NJF381R004786P2202' }, { name: 'nvme-Lexar_SSD_NM790_4TB_NJF381R004808P2202' }] }] }] },
    { id: 'pbs', label: 'pbs (backup)', kind: 'manuell', dayEnd: '19:00', uptime: 1800, pools: [
      { name: 'backup', size: 16.3 * TB, alloc: 8.4 * TB, frag: 21, vdevs: [{ type: 'raidz1-0', devs: [
        { name: 'ata-ST6000NM019B-2TG103_WX002XFY' }, { name: 'ata-TOSHIBA_MG06ACA600E_61X0A03HFKUE' }, { name: 'ata-WDC_WD60EZAZ-00ZGHB0_WD-WX31D298FL3C' }] }] }] },
  ];
  return { hosts, disks };
}

export class DemoWorld {
  /** @param {() => Date} clock @param {{testMinutes?: number}} opts Dauer simulierter Tests in virtuellen Minuten (Obergrenze) */
  constructor(clock, opts = {}) {
    const def = demoDefinition();
    this.clock = clock; this.opts = opts; this.hosts = def.hosts;
    this.state = new Map(def.hosts.map((h) => [h.id, { up: true, bootAt: clock().getTime() - h.uptime * 1000, disks: new Map(def.disks[h.id].map((j) => [j.device.name, { json: j, running: null }])), scrub: false }]));
  }
  setUp(hostId, up) { const s = this.state.get(hostId); s.up = up; if (up) s.bootAt = this.clock().getTime(); }
  setScrub(hostId, v) { this.state.get(hostId).scrub = v; }
  disk(hostId, dev) { return this.state.get(hostId).disks.get(dev); }

  /** Laufende Tests, die ihre Zeit erreicht haben, beenden und ins Testprotokoll schreiben. */
  settle(hostId) {
    const now = this.clock().getTime();
    for (const d of this.state.get(hostId).disks.values()) {
      if (d.running && now >= d.running.endAt) this.finish(d, d.running.fail ? 7 : 0);
    }
  }
  finish(d, nibble) {
    const j = d.json; const hours = j.power_on_time.hours;
    const r = d.running; d.running = null;
    if (j.device.protocol === 'NVMe') {
      j.nvme_self_test_log.table.unshift({ self_test_code: r.kind === 'short' ? { value: 1, string: 'Short' } : { value: 2, string: 'Extended' }, self_test_result: { value: nibble === 0 ? 0 : nibble === 2 ? 2 : 7, string: nibble === 0 ? 'Completed without error' : 'x' }, power_on_hours: hours });
    } else {
      j.ata_smart_self_test_log.standard.table.unshift(fx.ataLogEntry(r.kind === 'short' ? 'short' : r.kind === 'select' ? 'selective' : 'extended', nibble, hours));
    }
  }

  view(hostId, dev) {
    this.settle(hostId);
    const d = this.disk(hostId, dev);
    const j = clone(d.json);
    if (d.running) {
      if (j.device.protocol === 'NVMe') { j.nvme_self_test_log.current_self_test_operation = { value: 1, string: 'in progress' }; j.nvme_self_test_log.current_self_test_completion_percent = 40; }
      else j.ata_smart_data.self_test.status = { value: 15 * 16 + 5, string: 'in progress', remaining_percent: 50 };
    }
    return j;
  }
}

export class DemoTransport {
  constructor(world, hostId) { this.w = world; this.id = hostId; }
  async run(command) {
    const w = this.w; const st = w.state.get(this.id);
    if (!st.up) return { code: 255, stdout: '', stderr: 'ssh: connect to host: No route to host' };
    const a = command.split(' ');
    const ok = (o) => ({ code: 0, stdout: typeof o === 'string' ? o : JSON.stringify(o), stderr: '' });
    switch (a[0]) {
      case 'uptime': return ok(String((w.clock().getTime() - st.bootAt) / 1000));
      case 'list': return ok({ blockdevices: [...st.disks.values()].map((d) => ({ name: d.json.device.name.slice(5), type: 'disk', model: d.json.model_name, serial: d.json.serial_number, size: d.json.user_capacity.bytes, rota: d.json.rotation_rate > 0, tran: d.json.device.protocol === 'NVMe' ? 'nvme' : 'sata' })) });
      case 'zpool': { const h = w.hosts.find((x) => x.id === this.id); const t = zpoolStatusText(h.pools); return ok(st.scrub ? t.replace(/scrub repaired[^\n]*/, 'scrub in progress since Tue Nov  3 10:00:00 2026\n\t1.20T scanned at 1.0G/s, 400G issued at 500M/s, 3.00T total\n\t10.00% done, 05:00:00 to go') : t); }
      case 'zpoollist': { const h = w.hosts.find((x) => x.id === this.id); return ok(zpoolListText(h.pools)); }
      case 'smart': return ok(w.view(this.id, a[1]));
      case 'test': case 'select': {
        const d = w.disk(this.id, a[1]);
        w.settle(this.id);
        if (a[0] === 'test' && a[2] === 'abort') { if (d.running) w.finish(d, 2); return ok({ smartctl: { exit_status: 0 } }); }
        if (d.running) return { code: 4, stdout: JSON.stringify({ smartctl: { exit_status: 4 } }), stderr: '' };
        const kind = a[0] === 'select' ? 'select' : a[2];
        const mins = Math.min(w.opts.testMinutes ?? 5, kind === 'short' ? 2 : 999);
        d.running = { kind, endAt: w.clock().getTime() + mins * 60000 };
        return ok({ smartctl: { exit_status: 0 } });
      }
      default: return { code: 64, stdout: '', stderr: 'gate: unbekannter Befehl' };
    }
  }
}
