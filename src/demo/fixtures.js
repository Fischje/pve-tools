// Beispieldaten im Format von `smartctl -j -a` (smartmontools 7.x).
// Dienen den Tests und dem Demo-Modus (DEMO=1). Die Werte sind an deine echten Platten angelehnt:
// Exos 12 TB (gesund), die Seagate mit 16 umgelagerten Sektoren, die WD-SATA-SSD mit 86 % Verbrauch,
// Lexar-NVMe und eine 6-TB-HDD vom PBS.

const attr = (id, name, value, worst, thresh, raw, extra = {}) => ({
  id, name, value, worst, thresh, when_failed: extra.when_failed ?? '',
  raw: { value: raw, string: String(raw) },
});

// Statusbyte eines ATA-Selbsttests: hohes Halbbyte = Ergebnis, niedriges = Rest in 10-%-Schritten.
export const ataStatus = (nibble, remainingTens = 0) => nibble * 16 + remainingTens;
const STATUS_TEXT = {
  0: 'Completed without error', 1: 'Aborted by host', 2: 'Interrupted (host reset)',
  3: 'Fatal or unknown error', 4: 'Completed: unknown failure', 5: 'Completed: electrical failure',
  6: 'Completed: servo/seek failure', 7: 'Completed: read failure', 8: 'Completed: handling damage',
};
export function ataLogEntry(type, nibble, lifetimeHours) {
  const types = { short: [1, 'Short offline'], extended: [2, 'Extended offline'], selective: [4, 'Selective offline'] };
  const [v, s] = types[type];
  return {
    type: { value: v, string: s },
    status: { value: ataStatus(nibble, nibble === 0 ? 0 : 9), string: STATUS_TEXT[nibble], passed: nibble === 0 },
    lifetime_hours: lifetimeHours,
  };
}

function ataBase(o) {
  return {
    json_format_version: [1, 0],
    smartctl: { version: [7, 5], exit_status: 0 },
    device: { name: o.device, type: 'sat', protocol: 'ATA' },
    model_name: o.model, serial_number: o.serial, firmware_version: o.firmware ?? 'SN03',
    user_capacity: { blocks: o.blocks, bytes: o.blocks * 512 },
    logical_block_size: 512, physical_block_size: 4096,
    rotation_rate: o.rotation,
    smart_status: { passed: o.passed ?? true },
    ata_smart_data: {
      self_test: {
        status: o.running
          ? { value: ataStatus(15, o.running.remainingTens ?? 5), string: 'in progress', remaining_percent: (o.running.remainingTens ?? 5) * 10 }
          : { value: 0, string: 'completed without error', passed: true },
        polling_minutes: { short: o.pollShort ?? 1, extended: o.pollExtended },
      },
      capabilities: { self_tests_supported: true, selective_self_test_supported: o.selective ?? true },
    },
    ata_smart_attributes: { revision: 4, table: o.attrs },
    power_on_time: { hours: o.hours },
    power_cycle_count: o.cycles ?? 100,
    temperature: { current: o.temp ?? 34 },
    ata_smart_error_log: { summary: { revision: 1, count: o.errorCount ?? 0 } },
    ata_smart_self_test_log: { standard: { revision: 1, table: o.log ?? [], count: (o.log ?? []).length } },
  };
}

const hddAttrs = (o = {}) => [
  attr(1, 'Raw_Read_Error_Rate', 80, 64, 44, 100000000),
  attr(5, 'Reallocated_Sector_Ct', 100, 100, 10, o.reallocated ?? 0),
  attr(9, 'Power_On_Hours', 90, 90, 0, o.hours ?? 1000),
  attr(12, 'Power_Cycle_Count', 100, 100, 20, 60),
  attr(187, 'Reported_Uncorrect', 100, 100, 0, o.reportedUncorrect ?? 0),
  attr(188, 'Command_Timeout', 100, 100, 0, 0),
  attr(194, 'Temperature_Celsius', 66, 50, 0, o.temp ?? 34),
  attr(197, 'Current_Pending_Sector', 100, 100, 0, o.pending ?? 0),
  attr(198, 'Offline_Uncorrectable', 100, 100, 0, o.uncorrectable ?? 0),
  attr(199, 'UDMA_CRC_Error_Count', 200, 200, 0, o.crc ?? 0),
];

/** Exos 12 TB, gesund. `o` überschreibt Werte. */
export function exos12(o = {}) {
  const hours = o.hours ?? 12000;
  return ataBase({
    device: '/dev/sda', model: 'ST12000NM003G-2MT113', serial: 'ZL2M2KFZ',
    blocks: 23437770752, rotation: 7200, pollExtended: 1079, pollShort: 1,
    hours, attrs: hddAttrs({ hours, ...o }), log: [ataLogEntry('short', 0, hours - 700), ataLogEntry('extended', 0, hours - 1500)],
    ...o,
  });
}

/** PBS-Platte (6 TB, Langtest 637 min). */
export function hdd6(o = {}) {
  const hours = o.hours ?? 30000;
  return ataBase({
    device: '/dev/sda', model: 'ST6000NM019B-2TG103', serial: 'WX002XFY',
    blocks: 11721045168, rotation: 7200, pollExtended: 637, pollShort: 2,
    hours, attrs: hddAttrs({ hours, ...o }), log: [ataLogEntry('short', 0, hours - 300)], ...o,
  });
}

/** Die Seagate aus dem ChatGPT-Verlauf: 16 umgelagerte Sektoren, 11266 CRC-Fehler, Lesefehler im Langtest. */
export function seagateDefekt(o = {}) {
  const hours = 19758;
  return ataBase({
    device: '/dev/sdc', model: 'ST12000NM0248-2H3111', serial: 'ZHZ0RHKE',
    blocks: 23437770752, rotation: 7200, pollExtended: 1079, hours,
    attrs: hddAttrs({ hours, reallocated: 16, crc: 11266, reportedUncorrect: 3 }),
    errorCount: 3,
    log: [ataLogEntry('short', 0, hours - 100), ataLogEntry('extended', 7, hours - 2000), ataLogEntry('extended', 7, hours - 9000)],
    ...o,
  });
}

/** WD-SATA-SSD aus dem router: 86 % verbraucht (Media_Wearout_Indicator 14), sonst sauber. */
export function wdSsd86(o = {}) {
  const hours = 44603;
  const attrs = [
    attr(5, 'Reallocated_Sector_Ct', 100, 100, 0, 0), attr(9, 'Power_On_Hours', 100, 100, 0, hours),
    attr(12, 'Power_Cycle_Count', 100, 100, 0, 198), attr(169, 'Total_Bad_Blocks', 100, 100, 0, 117),
    attr(170, 'Grown_Bad_Blocks', 100, 100, 0, 0), attr(171, 'Program_Fail_Count', 100, 100, 0, 0),
    attr(172, 'Erase_Fail_Count', 100, 100, 0, 0), attr(174, 'Unexpected_Power_Loss', 100, 100, 0, 99),
    attr(187, 'Reported_Uncorrect', 100, 100, 0, 0), attr(188, 'Command_Timeout', 100, 100, 0, 23),
    attr(194, 'Temperature_Celsius', 57, 58, 0, 43), attr(199, 'UDMA_CRC_Error_Count', 100, 100, 0, 1),
    attr(230, 'Media_Wearout_Indicator', o.wearValue ?? 14, o.wearValue ?? 14, 0, 0x0e1a0c280e1a),
    attr(232, 'Available_Reservd_Space', 100, 100, 4, 100),
    attr(233, 'NAND_GB_Written_TLC', 100, 100, 0, 63912), attr(234, 'NAND_GB_Written_SLC', 100, 100, 0, 84790),
    attr(241, 'Host_Writes_GiB', 253, 253, 0, 44780),
  ];
  return ataBase({
    device: '/dev/sda', model: 'WDC WDS500G2B0A-00SM50', serial: '210623444409', firmware: '415020WD',
    blocks: 976773168, rotation: 0, pollExtended: 10, pollShort: 2, selective: false, hours, attrs,
    log: [ataLogEntry('short', 0, 33759), ataLogEntry('extended', 0, 32646)], ...o,
  });
}

/** NVMe, Standard: Lexar NM790 4 TB, 2 % verbraucht. */
export function nvme(o = {}) {
  const hours = o.hours ?? 5000;
  return {
    json_format_version: [1, 0],
    smartctl: { version: [7, 5], exit_status: 0 },
    device: { name: o.device ?? '/dev/nvme1n1', type: 'nvme', protocol: 'NVMe' },
    model_name: o.model ?? 'Lexar SSD NM790 4TB', serial_number: o.serial ?? 'NJF381R004120P2202',
    firmware_version: 'V1',
    user_capacity: { blocks: 8001563222, bytes: 4096000000000 }, logical_block_size: 512,
    smart_status: { passed: true, nvme: { value: o.criticalWarning ?? 0 } },
    nvme_smart_health_information_log: {
      critical_warning: o.criticalWarning ?? 0, temperature: o.temp ?? 40,
      available_spare: o.spare ?? 100, available_spare_threshold: o.spareThreshold ?? 5,
      percentage_used: o.used ?? 2, data_units_written: 20000000, data_units_read: 30000000,
      power_cycles: 40, power_on_hours: hours, unsafe_shutdowns: o.unsafe ?? 5,
      media_errors: o.mediaErrors ?? 0, num_err_log_entries: 0,
    },
    power_on_time: { hours }, temperature: { current: o.temp ?? 40 },
    nvme_self_test_log: {
      current_self_test_operation: o.running ? { value: 1, string: 'Short self-test in progress' } : { value: 0, string: 'No self-test in progress' },
      current_self_test_completion_percent: o.running ? 40 : 0,
      table: o.log ?? [],
    },
  };
}

/** Meldung von `smartctl -n standby` für eine schlafende Platte. */
export const standby = (device = '/dev/sdb') => ({
  json_format_version: [1, 0],
  smartctl: { version: [7, 5], exit_status: 2, messages: [{ string: 'Device is in STANDBY (OS) mode, exit(2)', severity: 'information' }] },
  device: { name: device, type: 'sat', protocol: 'ATA' },
});
