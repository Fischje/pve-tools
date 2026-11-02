import test from 'node:test';
import assert from 'node:assert/strict';
import { parseKernelLog, rateKernel } from '../src/kernel.js';

const LOG = `2026-11-01T16:34:06+01:00 backup kernel: ata4.00: failed command: WRITE FPDMA QUEUED
2026-11-01T16:34:06+01:00 backup kernel: ata4.00: cmd 61/40:08 ncq dma 688128 out res 40/00 Emask 0x10 (ATA bus error)
2026-11-01T16:35:07+01:00 backup kernel: ata4.00: exception Emask 0x10 SAct 0x188000 SErr 0x4c0000 action 0x6 frozen
2026-11-01T16:35:07+01:00 backup kernel: ata4: SError: { CommWake 10B8B Handshk }
2026-11-01T16:35:07+01:00 backup kernel: ata4: SATA link up 1.5 Gbps (SStatus 113 SControl 310)
2026-11-01T16:35:07+01:00 backup kernel: sda: irrelevant`;

test('Kernel-Meldungen: SATA-Fehler je Port zusammenfassen', () => {
  const k = parseKernelLog(LOG);
  assert.equal(k.ports.length, 1);
  const p = k.ports[0];
  assert.equal(p.port, 'ata4');
  assert.ok(p.errors >= 2 && p.frozen >= 1);
  assert.equal(p.slowLink, '1.5 Gbps');
  assert.equal(p.last, '2026-11-01T16:35:07+01:00');
});

test('Kernel-Meldungen: leer oder ohne Fehler ergibt keine Befunde', () => {
  assert.deepEqual(rateKernel(parseKernelLog('')), []);
  assert.deepEqual(rateKernel(null), []);
  const f = rateKernel(parseKernelLog(LOG));
  assert.equal(f.length, 1);
  assert.equal(f[0].level, 'replace');
  assert.match(f[0].text, /Kabel/);
});
