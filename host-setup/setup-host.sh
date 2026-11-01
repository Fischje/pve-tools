#!/usr/bin/env bash
# Richtet auf einem Proxmox-Host (PVE/PBS) den eingeschränkten SSH-Zugang für pve-disk-tool ein.
#
# Zweck: Legt den Benutzer "diskmon" an, installiert das Prüfskript nach /etc/diskmon/gate.sh und erlaubt dem
#        Schlüssel des Tools genau dieses Skript (sudoers + authorized_keys mit festem Befehl).
# Aufruf (als root, einmalig pro Host):
#   ./setup-host.sh "<öffentlicher Schlüssel aus dem LXC>" [Quell-IP des LXC]
#   ./setup-host.sh --entfernen          # macht alles wieder rückgängig
# Es werden keine Pakete installiert; sudo und smartmontools müssen vorhanden sein.
set -euo pipefail

BENUTZER=diskmon
ZIEL=/etc/diskmon
SUDOERS=/etc/sudoers.d/diskmon
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

[[ $EUID -eq 0 ]] || { echo "Bitte als root ausführen." >&2; exit 1; }

if [[ "${1:-}" == "--entfernen" ]]; then
  rm -f "$SUDOERS"
  rm -rf "$ZIEL"
  if id "$BENUTZER" >/dev/null 2>&1; then userdel -r "$BENUTZER" 2>/dev/null || userdel "$BENUTZER"; fi
  echo "Entfernt: Benutzer $BENUTZER, $ZIEL, $SUDOERS."
  exit 0
fi

SCHLUESSEL="${1:-}"
QUELLE="${2:-}"
[[ "$SCHLUESSEL" =~ ^ssh-(ed25519|rsa)\ [A-Za-z0-9+/=]+(\ [^\"]*)?$ ]] || { echo "Erster Parameter muss ein öffentlicher SSH-Schlüssel sein (ssh-ed25519 AAAA…)." >&2; exit 1; }
[[ -z "$QUELLE" || "$QUELLE" =~ ^[0-9a-fA-F:.]+$ ]] || { echo "Zweiter Parameter muss eine IP-Adresse sein." >&2; exit 1; }
command -v sudo >/dev/null || { echo "sudo fehlt. Bitte 'apt install sudo' (kleines Paket, ändert nichts am Proxmox-Kern)." >&2; exit 1; }
command -v smartctl >/dev/null || { echo "smartctl fehlt. Bitte 'apt install smartmontools'." >&2; exit 1; }
[[ -f "$HIER/gate.sh" ]] || { echo "gate.sh liegt nicht neben diesem Skript." >&2; exit 1; }

id "$BENUTZER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$BENUTZER" --shell /bin/bash "$BENUTZER"
passwd -l "$BENUTZER" >/dev/null

install -d -m 0755 -o root -g root "$ZIEL"
install -m 0755 -o root -g root "$HIER/gate.sh" "$ZIEL/gate.sh"

tmp="$(mktemp)"
cat > "$tmp" <<SUDO
# pve-disk-tool: Benutzer $BENUTZER darf nur das Prüfskript als root ausführen.
Defaults:$BENUTZER env_keep += "SSH_ORIGINAL_COMMAND"
Defaults:$BENUTZER !requiretty
$BENUTZER ALL=(root) NOPASSWD: $ZIEL/gate.sh
SUDO
visudo -cf "$tmp" >/dev/null
install -m 0440 -o root -g root "$tmp" "$SUDOERS"
rm -f "$tmp"

install -d -m 0700 -o "$BENUTZER" -g "$BENUTZER" "/var/lib/$BENUTZER/.ssh"
optionen='restrict,command="sudo '"$ZIEL"'/gate.sh"'
[[ -n "$QUELLE" ]] && optionen="from=\"$QUELLE\",$optionen"
printf '%s %s\n' "$optionen" "$SCHLUESSEL" > "/var/lib/$BENUTZER/.ssh/authorized_keys"
chown "$BENUTZER:$BENUTZER" "/var/lib/$BENUTZER/.ssh/authorized_keys"
chmod 0600 "/var/lib/$BENUTZER/.ssh/authorized_keys"

echo "Fertig. Test vom LXC aus:  ssh $BENUTZER@<dieser-host> list"
