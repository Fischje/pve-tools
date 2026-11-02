// Erwartete Version des Prüfskripts auf den Hosts: steht in host-setup/gate.sh (GATE_VERSION=…), einzige Quelle.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'host-setup', 'gate.sh');
export const EXPECTED_GATE_VERSION = (() => {
  try { const m = /^GATE_VERSION=(\d+)/m.exec(readFileSync(file, 'utf8')); return m ? Number(m[1]) : 1; } catch { return 1; }
})();
