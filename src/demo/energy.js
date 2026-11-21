// Demo-Daten für den Bereich „Energie“, angelehnt an typische Proxmox-Hosts.
const SYS = {
  router: ['ASRock', 'N100DC-ITX', 'Intel(R) N100', 'intel_pstate', 'powersave', 'balance_performance'],
  pve: ['Gigabyte Technology Co., Ltd.', 'B760M DS3H DDR4', '13th Gen Intel(R) Core(TM) i5-13500', 'intel_pstate', 'performance', 'performance'],
  pbs: ['ASUSTeK COMPUTER INC.', 'PRIME B460M-A', 'Intel(R) Core(TM) i3-10100', 'intel_pstate', 'powersave', 'balance_performance'],
};
const PCI = {
  router: [['0000:00:1c.0', 'PCI bridge: Intel Corporation Alder Lake-N PCH PCI Express Root Port', 'L1', 'L1'], ['0000:01:00.0', 'Ethernet controller: Intel Corporation Ethernet Controller I226-V (rev 04)', 'L1', 'Disabled'], ['0000:02:00.0', 'Non-Volatile memory controller: Western Digital WD Red SN700', 'L1', 'L1']],
  pve: [['0000:00:1c.0', 'PCI bridge: Intel Corporation Raptor Lake PCH Root Port', 'L1', 'Disabled'], ['0000:03:00.0', 'SATA controller: ASMedia Technology Inc. ASM1166 Serial ATA Controller (rev 02)', 'L0s L1', 'Disabled'], ['0000:04:00.0', 'Ethernet controller: Realtek Semiconductor Co., Ltd. RTL8125 2.5GbE Controller (rev 05)', 'L0s L1', 'Disabled'], ['0000:05:00.0', 'Non-Volatile memory controller: Lexar NM790', 'L1', 'L1']],
  pbs: [['0000:00:17.0', 'SATA controller: Intel Corporation Comet Lake SATA AHCI Controller', 'not supported', 'Disabled'], ['0000:02:00.0', 'Ethernet controller: Intel Corporation Ethernet Connection I219-V', 'L1', 'L1']],
};
export function demoEnergyText(hostId, st = {}) {
  const [man, board, cpu, drv, gov, epp] = SYS[hostId] ?? SYS.router;
  const deep = hostId === 'pve' ? [['state0', 'POLL', 10, 1e6], ['state1', 'C1E', 9e7, 6e12], ['state2', 'C6', 2e7, 2e12]] : [['state0', 'POLL', 10, 1e6], ['state1', 'C1E', 3e6, 1e11], ['state2', 'C6', 4e6, 2e11], ['state3', 'C8', 2e6, 2e11], ['state4', 'C10', 9e6, 6e11]];
  const pci = (PCI[hostId] ?? []).map(([a, n, cap, ctl]) => `${a} ${n}\n\t\tLnkCap:\tPort #0, Speed 8GT/s, Width x1, ASPM ${cap}, Exit Latency L1 <16us\n\t\tLnkCtl:\tASPM ${st.aspmOn && cap !== 'not supported' && !(st.exclude ?? []).includes(a) ? (cap === 'L0s L1' ? 'L0s L1 Enabled' : `${cap} Enabled`) : ctl}; RCB 64 bytes, LnkDisable- CommClk+`).join('\n');
  return `== system\nsystem-manufacturer=${man}\nsystem-product-name=${board}\nbaseboard-manufacturer=${man}\nbaseboard-product-name=${board}\nbios-vendor=American Megatrends International, LLC.\nbios-version=F12\nbios-release-date=03/14/2025\nprocessor-version=${cpu}\ncpus=${hostId === 'pve' ? 20 : 4}\nuptime=${hostId === 'pve' ? 600000 : 300000}\n`
    + `== cpufreq\nscaling_driver=${drv}\nscaling_governor=${gov}\nenergy_performance_preference=${epp}\nscaling_available_governors=performance powersave\nenergy_performance_available_preferences=default performance balance_performance balance_power power\n`
    + `== cstates\n${deep.map((d) => d.join(' ')).join('\n')}\n== aspm\npolicy=[default] performance powersave powersupersave\ninstalled=${st.installed ? 'yes' : 'no'}\n${st.installed ? `boot=${st.boot ? 'enabled' : 'disabled'}\n` : ''}${(st.exclude ?? []).map((x) => `exclude=${x}`).join('\n')}\n== pci\n${pci}\n== sata\nhost0 max_performance\nhost1 max_performance\n`;
}
