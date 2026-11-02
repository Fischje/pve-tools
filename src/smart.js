// Wandelt die JSON-Ausgabe von `smartctl -j -a` in ein einheitliches Platten-Objekt um.
// Gleiche Struktur für HDD, SATA-SSD und NVMe, damit Bewertung und Oberfläche nichts über Hersteller wissen müssen.

// Namen von Verschleiß-Attributen bei SATA-SSDs. Der normalisierte Wert (100 = neu) ist die Restlebensdauer in %.
// Wichtig: Der Rohwert ist bei manchen Herstellern ein gepacktes Feld (z. B. WD: 0x0e1a0c280e1a) und taugt nicht.
const SSD_LIFE_LEFT_NAMES = [
  'Media_Wearout_Indicator', 'SSD_Life_Left', 'Wear_Leveling_Count', 'Percent_Lifetime_Remain',
  'Remaining_Lifetime_Perc', 'Perc_Rated_Life_Remain',
];

/** Ergebnis-Nibble eines ATA-Selbsttests in unsere Kategorien. */
function ataResult(statusValue) {
  const n = statusValue >> 4;
  if (n === 0) return 'ok';
  if (n === 1 || n === 2) return 'interrupted';
  if (n >= 3 && n <= 8) return 'failed';
  if (n === 15) return 'running';
  return 'other';
}

/** Ergebnis-Code eines NVMe-Selbsttests. */
function nvmeResult(code) {
  if (code === 0) return 'ok';
  if (code === 5 || code === 6 || code === 7) return 'failed';
  return 'interrupted'; // 1-4, 8, 9: abgebrochen (Befehl, Reset, Namespace, Format, Sanitize)
}

function testKind(text) {
  const t = String(text ?? '').toLowerCase();
  if (t.includes('short')) return 'short';
  if (t.includes('ext') || t.includes('long')) return 'extended';
  if (t.includes('select')) return 'selective';
  return 'other';
}

export function isStandby(json) {
  const msgs = json?.smartctl?.messages ?? [];
  return msgs.some((m) => /standby|sleep/i.test(m.string ?? ''));
}

/**
 * @param {object} json Ausgabe von `smartctl -j -a`
 * @param {{device?: string, rota?: boolean}} info zusätzliche Angaben aus `lsblk`
 */
export function normalize(json, info = {}) {
  const device = json.device?.name ?? info.device ?? null;
  if (isStandby(json) || !json.model_name) {
    return { device, standby: isStandby(json), unreadable: !isStandby(json), serial: null };
  }
  const isNvme = json.device?.protocol === 'NVMe' || json.device?.type === 'nvme' || !!json.nvme_smart_health_information_log;
  const kind = isNvme ? 'nvme' : (json.rotation_rate > 0 ? 'hdd' : (json.rotation_rate === 0 ? 'ssd' : (info.rota ? 'hdd' : 'ssd')));

  const disk = {
    device, kind, standby: false, serial: json.serial_number, model: json.model_name,
    firmware: json.firmware_version ?? null,
    capacityBytes: json.user_capacity?.bytes ?? null, totalLba: json.user_capacity?.blocks ?? null,
    hours: json.power_on_time?.hours ?? json.nvme_smart_health_information_log?.power_on_hours ?? null,
    temperature: json.temperature?.current ?? json.nvme_smart_health_information_log?.temperature ?? null,
    smartPassed: json.smart_status?.passed ?? null,
    powerCycles: json.power_cycle_count ?? json.nvme_smart_health_information_log?.power_cycles ?? null,
    bytesWritten: null, unsafeShutdowns: null,
    attrs: {}, ata: null, nvme: null, wearUsed: null, remainingLife: null,
    selftest: { running: false, remainingPercent: null, pollingShort: null, pollingExtended: null, selective: false, log: [] },
    ataErrorCount: json.ata_smart_error_log?.summary?.count ?? 0,
    exitStatus: json.smartctl?.exit_status ?? 0,
  };

  if (isNvme) {
    const h = json.nvme_smart_health_information_log ?? {};
    disk.nvme = {
      criticalWarning: h.critical_warning ?? 0, availableSpare: h.available_spare ?? null,
      spareThreshold: h.available_spare_threshold ?? null, percentageUsed: h.percentage_used ?? null,
      mediaErrors: h.media_errors ?? 0, unsafeShutdowns: h.unsafe_shutdowns ?? 0,
      dataUnitsWritten: h.data_units_written ?? null, powerCycles: h.power_cycles ?? null,
    };
    // Eine „Data Unit“ sind 1000 Blöcke zu 512 Byte (NVMe-Spezifikation).
    disk.bytesWritten = h.data_units_written != null ? h.data_units_written * 512000 : null;
    disk.unsafeShutdowns = h.unsafe_shutdowns ?? null;
    disk.wearUsed = h.percentage_used ?? null;
    disk.remainingLife = disk.wearUsed == null ? null : Math.max(0, 100 - disk.wearUsed);
    const log = json.nvme_self_test_log ?? {};
    disk.selftest.running = (log.current_self_test_operation?.value ?? 0) !== 0;
    disk.selftest.remainingPercent = disk.selftest.running ? Math.max(0, 100 - (log.current_self_test_completion_percent ?? 0)) : null;
    disk.selftest.selective = false;
    disk.selftest.log = (log.table ?? []).map((e) => ({
      kind: testKind(e.self_test_code?.string), result: nvmeResult(e.self_test_result?.value ?? 0),
      hours: e.power_on_hours ?? null, text: e.self_test_result?.string ?? '',
    }));
  } else {
    for (const a of json.ata_smart_attributes?.table ?? []) {
      disk.attrs[a.id] = { id: a.id, name: a.name, value: a.value, worst: a.worst, thresh: a.thresh, raw: a.raw?.value ?? 0, whenFailed: a.when_failed || '' };
    }
    const byName = (n) => Object.values(disk.attrs).find((a) => a.name === n);
    const raw = (id) => disk.attrs[id]?.raw ?? 0;
    disk.ata = {
      reallocated: raw(5), pending: raw(197), offlineUncorrectable: raw(198), reportedUncorrect: raw(187),
      crc: raw(199), commandTimeout: raw(188), unexpectedPowerLoss: byName('Unexpected_Power_Loss')?.raw ?? null,
      failingAttrs: Object.values(disk.attrs).filter((a) => a.whenFailed === 'FAILING_NOW').map((a) => a.name),
      pastFailedAttrs: Object.values(disk.attrs).filter((a) => a.whenFailed === 'In_the_past').map((a) => a.name),
    };
    // Geschriebene Datenmenge: je nach Hersteller als GiB, als 32-MiB-Einheiten oder als Anzahl Blöcke angegeben.
    const lbs = json.logical_block_size ?? 512;
    const written = byName('Host_Writes_GiB') ? byName('Host_Writes_GiB').raw * 2 ** 30
      : byName('Host_Writes_32MiB') ? byName('Host_Writes_32MiB').raw * 32 * 2 ** 20
      : byName('Total_LBAs_Written') ? byName('Total_LBAs_Written').raw * lbs : null;
    disk.bytesWritten = written != null && Number.isFinite(written) ? written : null;
    disk.unsafeShutdowns = disk.ata.unexpectedPowerLoss;
    if (kind === 'ssd') {
      const wear = SSD_LIFE_LEFT_NAMES.map(byName).find(Boolean);
      if (wear) {
        disk.remainingLife = Math.max(0, Math.min(100, wear.value));
        disk.wearUsed = 100 - disk.remainingLife;
      }
    }
    const st = json.ata_smart_data?.self_test;
    disk.selftest.running = st?.status?.value != null && ataResult(st.status.value) === 'running';
    disk.selftest.remainingPercent = disk.selftest.running ? (st.status.remaining_percent ?? ((st.status.value & 15) * 10)) : null;
    disk.selftest.pollingShort = st?.polling_minutes?.short ?? null;
    disk.selftest.pollingExtended = st?.polling_minutes?.extended ?? null;
    disk.selftest.selective = !!json.ata_smart_data?.capabilities?.selective_self_test_supported;
    disk.selftest.log = (json.ata_smart_self_test_log?.standard?.table ?? []).map((e) => ({
      kind: testKind(e.type?.string), result: ataResult(e.status?.value ?? 0),
      hours: e.lifetime_hours ?? null, text: e.status?.string ?? '',
    }));
  }
  return disk;
}
