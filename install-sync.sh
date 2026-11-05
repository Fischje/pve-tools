#!/usr/bin/env bash
# Richtet den automatischen Abgleich ein (einmalig im LXC, als root): ein systemd-Timer ruft alle 5 Minuten sync.sh auf.
# Aufruf:  ./install-sync.sh            einrichten
#          ./install-sync.sh --entfernen  wieder ausschalten
# Protokoll:  journalctl -u pve-tools-sync -n 50
set -euo pipefail

[[ $EUID -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Alter Name (vor der Umbenennung): wird immer mit entfernt, damit nie zwei Abgleiche laufen.
alte_weg() { systemctl disable --now pve-disk-tool-sync.timer 2>/dev/null || true; rm -f /etc/systemd/system/pve-disk-tool-sync.service /etc/systemd/system/pve-disk-tool-sync.timer; }

if [[ "${1:-}" == "--entfernen" ]]; then
  systemctl disable --now pve-tools-sync.timer 2>/dev/null || true
  rm -f /etc/systemd/system/pve-tools-sync.service /etc/systemd/system/pve-tools-sync.timer
  alte_weg
  systemctl daemon-reload
  echo "Automatischer Abgleich ist aus."
  exit 0
fi

for befehl in git npm curl flock node; do command -v "$befehl" >/dev/null || { echo "$befehl fehlt." >&2; exit 1; }; done
[[ -d "$DIR/.git" ]] || { echo "$DIR ist kein Git-Klon." >&2; exit 1; }
chmod +x "$DIR/sync.sh" "$DIR/update.sh"
alte_weg

cat > /etc/systemd/system/pve-tools-sync.service <<UNIT
[Unit]
Description=PVE-Tools: neue Version von GitHub holen (main, Fast-Forward)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
ExecStart=$DIR/sync.sh
UNIT

cat > /etc/systemd/system/pve-tools-sync.timer <<'UNIT'
[Unit]
Description=PVE-Tools: alle 5 Minuten abgleichen

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
AccuracySec=10s

[Install]
WantedBy=timers.target
UNIT

systemctl daemon-reload
systemctl enable --now pve-tools-sync.timer
echo "Eingerichtet. Nächster Lauf:"
systemctl list-timers pve-tools-sync.timer --no-pager | head -3
