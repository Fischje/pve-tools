// Verbindung zu einem Host: SSH mit dem eingeschränkten Schlüssel (siehe host-setup/gate.sh).
import { execFile } from 'node:child_process';

export class SshTransport {
  /** @param {{address:string, port?:number, user?:string, keyFile:string}} host @param {{knownHosts:string, sshBin?:string}} opts */
  constructor(host, opts) { this.host = host; this.opts = opts; }

  /** @returns {Promise<{code:number, stdout:string, stderr:string}>} */
  run(command, timeoutMs = 60000) {
    const h = this.host;
    const args = [
      '-i', h.keyFile, '-p', String(h.port ?? 22),
      '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', `UserKnownHostsFile=${this.opts.knownHosts}`,
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15', '-o', 'IdentitiesOnly=yes',
      `${h.user ?? 'diskmon'}@${h.address}`, command,
    ];
    return new Promise((resolve) => {
      execFile(this.opts.sshBin ?? 'ssh', args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 255) : 0, stdout: stdout ?? '', stderr: (stderr || err?.message || '').toString() });
      });
    });
  }
}
