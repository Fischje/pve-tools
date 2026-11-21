import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnergy, rateEnergy, cstateShares } from '../src/energy.js';
import { demoEnergyText } from '../src/demo/energy.js';

const LSPCI = `0000:00:1c.0 PCI bridge: Intel Corporation Root Port (rev 11)
		LnkCap:	Port #5, Speed 8GT/s, Width x1, ASPM L1, Exit Latency L1 <16us
		LnkCtl:	ASPM L1 Enabled; RCB 64 bytes, Disabled- CommClk+
0000:03:00.0 SATA controller: ASMedia Technology Inc. ASM1166 Serial ATA Controller (rev 02)
		LnkCap:	Port #0, Speed 8GT/s, Width x2, ASPM L0s L1, Exit Latency L0s <4us, L1 <64us
		LnkCtl:	ASPM Disabled; RCB 64 bytes, Disabled- CommClk+
0000:04:00.0 Ethernet controller: Realtek Semiconductor Co., Ltd. RTL8125 2.5GbE Controller (rev 05)
		LnkCap:	Port #0, Speed 5GT/s, Width x1, ASPM L0s L1, Exit Latency L0s unlimited, L1 <64us
		LnkCtl:	ASPM Disabled; RCB 64 bytes, Disabled- CommClk+
0000:00:17.0 SATA controller: Intel Corporation SATA AHCI Controller
0000:05:00.0 Non-Volatile memory controller: Samsung NVMe
		LnkCap:	Port #0, Speed 16GT/s, Width x4, ASPM not supported
		LnkCtl:	ASPM Disabled; RCB 64 bytes, Disabled- CommClk+
`;

test('Bestandsaufnahme lesen: System, CPU-Regelung, C-States, ASPM je Gerät, SATA', () => {
  const e = parseEnergy(demoEnergyText('pve', { installed: true, boot: true, exclude: ['0000:03:00.0'] }));
  assert.equal(e.system['baseboard-product-name'], 'B760M DS3H DDR4');
  assert.equal(e.cpufreq.scaling_governor, 'performance');
  assert.equal(e.cpus, 20);
  assert.deepEqual(e.cstates.map((c) => c.name), ['POLL', 'C1E', 'C6']);
  assert.equal(e.aspm.policy, 'default'); assert.equal(e.aspm.installed, true); assert.equal(e.aspm.boot, 'enabled');
  assert.deepEqual(e.aspm.exclude, ['0000:03:00.0']);
  const sata = e.pci.find((p) => p.addr === '0000:03:00.0');
  assert.equal(sata.cap, 'L0sL1'); assert.equal(sata.ctl, 'none');
  assert.equal(e.sata.length, 2);
});

test('Hinweise: performance-Regelung, Geräte ohne ASPM, kaum tiefe C-States; gesunder Host ohne Hinweis', () => {
  const pve = rateEnergy(parseEnergy(demoEnergyText('pve')));
  assert.ok(pve.some((f) => f.code === 'governor' && f.level === 'watch'));
  assert.ok(pve.some((f) => f.code === 'aspm' && /3 PCIe-Geräte/.test(f.title)), pve.map((f) => f.title).join('|'));
  assert.ok(pve.some((f) => f.code === 'sata'));
  const shares = cstateShares(parseEnergy(demoEnergyText('router')));
  assert.equal(shares[0].id, 'c0');
  assert.ok(Math.abs(shares.reduce((s, r) => s + r.pct, 0) - 100) < 1, 'Anteile ergeben zusammen 100 %');
  const ok = rateEnergy(parseEnergy(demoEnergyText('router', { aspmOn: true })).valueOf());
  assert.ok(!ok.some((f) => f.code === 'aspm'), 'nach dem Einschalten keine ASPM-Warnung');
});

// pvetools-aspm in einem Sandkasten mit falschem lspci/setpci
const T = mkdtempSync(path.join(tmpdir(), 'aspm-'));
const bin = path.join(T, 'bin'); mkdirSync(bin);
writeFileSync(path.join(T, 'lspci.txt'), LSPCI);
const fake = (n, b) => { writeFileSync(path.join(bin, n), `#!/usr/bin/env bash\n${b}\n`); chmodSync(path.join(bin, n), 0o755); };
fake('lspci', `cat "${path.join(T, 'lspci.txt')}"`);
fake('setpci', `echo "setpci $*" >> "${path.join(T, 'setpci.log')}"`);
fake('logger', 'exit 0');
writeFileSync(path.join(T, 'aspm'), readFileSync('host-setup/pvetools-aspm', 'utf8').replaceAll('/etc/pvetools-aspm.conf', path.join(T, 'conf')));
const aspm = (...args) => spawnSync('bash', [path.join(T, 'aspm'), ...args], { env: { PATH: `${bin}:${process.env.PATH}` }, encoding: 'utf8' });
const setpci = () => (existsSync(path.join(T, 'setpci.log')) ? readFileSync(path.join(T, 'setpci.log'), 'utf8').trim().split('\n') : []);

test('pvetools-aspm: Status, Einschalten genau der gemeldeten Stufe, Ausnahmen, schon aktive und nicht unterstützte Geräte bleiben', () => {
  const st = aspm('status');
  assert.equal(st.status, 0, st.stderr);
  const lines = st.stdout.trim().split('\n').map((l) => l.split('\t'));
  assert.deepEqual(lines.map((l) => [l[0], l[1], l[2]]), [['0000:00:1c.0', 'L1', 'L1'], ['0000:03:00.0', 'L0sL1', 'none'], ['0000:04:00.0', 'L0sL1', 'none'], ['0000:05:00.0', 'none', 'none']]);
  writeFileSync(path.join(T, 'conf'), 'EXCLUDE=0000:04:00.0\n');
  const r = aspm('apply');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(setpci(), ['setpci -s 0000:03:00.0 CAP_EXP+10.b=03:03']);
  assert.match(r.stdout, /0000:04:00.0: ausgenommen/);
  assert.match(r.stdout, /0000:00:1c.0: schon L1/);
  const off = aspm('off', '0000:03:00.0');
  assert.equal(off.status, 0); assert.equal(setpci().at(-1), 'setpci -s 0000:03:00.0 CAP_EXP+10.b=00:03');
  assert.equal(aspm('off', '0000:03:00.0;id').status, 2);
});

test('Einrichten mit Recht „energie“: pvetools-aspm und Dienst werden angelegt, der Dienst aber nicht eingeschaltet', () => {
  const setup = readFileSync('host-setup/setup-host.sh', 'utf8');
  const from = setup.indexOf('# Mit dem Recht "energie"'), to = setup.indexOf('tmp="$(mktemp)"');
  assert.ok(from > 0 && to > from);
  const D = path.join(T, 'setup'); mkdirSync(D, { recursive: true });
  const block = setup.slice(from, to).replaceAll(' -o root -g root', '')
    .replaceAll('/usr/local/sbin/pvetools-aspm', path.join(D, 'pvetools-aspm')).replaceAll('/etc/systemd/system/pvetools-aspm.service', path.join(D, 'pvetools-aspm.service'));
  writeFileSync(path.join(D, 'quelle-aspm'), '#!/bin/bash\necho neu\n');
  fake('systemctl', `echo "systemctl $*" >> "${path.join(T, 'systemctl.log')}"`);
  const run = (rechte) => spawnSync('bash', ['-c', `set -euo pipefail; HIER=${D}; cp ${D}/quelle-aspm ${D}/pvetools-aspm.src; ${block.replaceAll('"$HIER/pvetools-aspm"', `"${D}/quelle-aspm"`)}`], { env: { PATH: `${bin}:${process.env.PATH}`, DISKMON_RECHTE: rechte }, encoding: 'utf8' });
  let r = run('snapshots');
  assert.equal(r.status, 0, r.stderr); assert.ok(!existsSync(path.join(D, 'pvetools-aspm')), 'ohne Recht nichts installiert');
  r = run('snapshots,energie');
  assert.equal(r.status, 0, r.stderr);
  assert.match(readFileSync(path.join(D, 'pvetools-aspm'), 'utf8'), /echo neu/);
  assert.match(readFileSync(path.join(D, 'pvetools-aspm.service'), 'utf8'), /ExecStart=\S*pvetools-aspm apply/);
  assert.ok(!(existsSync(path.join(T, 'systemctl.log')) && /enable/.test(readFileSync(path.join(T, 'systemctl.log'), 'utf8'))), 'Dienst nicht eingeschaltet');
});
