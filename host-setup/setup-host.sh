#!/usr/bin/env bash
# Richtet auf einem Proxmox-Host (PVE/PBS) den eingeschränkten SSH-Zugang für pve-disk-tool ein.
#
# Zweck: Legt den Benutzer "diskmon" an, installiert das Prüfskript nach /etc/diskmon/gate.sh und erlaubt dem
#        Schlüssel des Tools genau dieses Skript (sudoers + authorized_keys mit festem Befehl).
# Aufruf (als root, einmalig pro Host):
#   ./setup-host.sh "<öffentlicher Schlüssel aus dem LXC>" [Quell-IP des LXC]
#   ./setup-host.sh --entfernen          # macht alles wieder rückgängig
# Es werden keine Pakete installiert, außer auf ausdrücklichen Wunsch (DISKMON_PAKETE_INSTALLIEREN=1): dann nur sudo und smartmontools.
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
# Fehlende Pakete werden nur installiert, wenn DISKMON_PAKETE_INSTALLIEREN=1 gesetzt ist (Haken in der Weboberfläche).
paket_pruefen() { # $1 = Befehl, $2 = Paket
  command -v "$1" >/dev/null && return 0
  if [[ "${DISKMON_PAKETE_INSTALLIEREN:-0}" == 1 ]]; then
    echo "Installiere Paket $2 …"
    export DEBIAN_FRONTEND=noninteractive
    apt-get install -y --no-install-recommends "$2" || { apt-get update -qq || true; apt-get install -y --no-install-recommends "$2"; }
    command -v "$1" >/dev/null && return 0
  fi
  echo "$2 fehlt. Bitte 'apt install $2' (kleines Paket, ändert nichts am Proxmox-Kern)." >&2
  exit 1
}
paket_pruefen sudo sudo
paket_pruefen smartctl smartmontools
[[ -f "$HIER/gate.sh" ]] || { echo "gate.sh liegt nicht neben diesem Skript." >&2; exit 1; }

id "$BENUTZER" >/dev/null 2>&1 || useradd --system --create-home --home-dir "/var/lib/$BENUTZER" --shell /bin/bash "$BENUTZER"
passwd -l "$BENUTZER" >/dev/null

install -d -m 0755 -o root -g root "$ZIEL"
install -m 0755 -o root -g root "$HIER/gate.sh" "$ZIEL/gate.sh"
# Rechtegruppen für schreibende Befehle (z. B. "snapshots"). Nur setzen, wenn DISKMON_RECHTE gesetzt ist, sonst bleibt die Datei, wie sie ist.
if [[ -n "${DISKMON_RECHTE+x}" ]]; then
  [[ "$DISKMON_RECHTE" =~ ^[a-z,-]*$ ]] || { echo "DISKMON_RECHTE: ungültiger Wert" >&2; exit 1; }
  : > "$ZIEL/rechte"
  for r in ${DISKMON_RECHTE//,/ }; do echo "$r" >> "$ZIEL/rechte"; done
  chmod 0644 "$ZIEL/rechte"
fi

# Mit dem Recht "snapshots" wird auch der verwaltete Wrapper autosnap-run (v2) installiert, damit das Tool Aufbewahrung und Pausentag
# ändern kann. Der alte Wrapper bleibt als autosnap-run.vorher-<Zeit> erhalten. Seine Werte werden in /etc/autosnap.conf übernommen.
if [[ ",${DISKMON_RECHTE:-}," == *,snapshots,* && -f "$HIER/autosnap-run" ]]; then
  WRAP=/usr/local/sbin/autosnap-run
  if [[ ! -x /usr/local/sbin/proxmox-autosnap.py ]]; then
    echo "Hinweis: /usr/local/sbin/proxmox-autosnap.py fehlt, der Wrapper autosnap-run wird nicht installiert."
  else
    if [[ -f "$WRAP" ]] && ! grep -q '^# autosnap-run v2' "$WRAP"; then
      cp -p "$WRAP" "$WRAP.vorher-$(date +%Y%m%d%H%M%S)"
      if [[ ! -e /etc/autosnap.conf ]]; then
        num() { sed -n "s/^$1=\([0-9]\{1,3\}\).*/\1/p" "$WRAP" | head -1; }
        keep() { sed -n "s/^[[:space:]]*$1)[[:space:]]*KEEP=\([0-9]\{1,3\}\).*/\1/p" "$WRAP" | head -1; }
        kh="$(keep hourly)"; kw="$(keep weekly)"; km="$(keep monthly)"; pd="$(num PAUSE_DAY)"
        tg="$(sed -n 's/^TAG="\([A-Za-z0-9_-]\{1,32\}\)".*/\1/p' "$WRAP" | head -1)"
        [[ -n "$tg" ]] || tg="$(sed -n 's/.*--tags \([A-Za-z0-9_-]\{1,32\}\).*/\1/p' "$WRAP" | head -1)"
        grep -q 'pct list' "$WRAP" && onlyrun=1 || onlyrun=0
        printf 'KEEP_HOURLY=%s\nKEEP_WEEKLY=%s\nKEEP_MONTHLY=%s\nPAUSE_DAY=%s\nMONTHLY_DAY=1\nTAG=%s\nONLY_RUNNING=%s\n' "${kh:-8}" "${kw:-1}" "${km:-1}" "${pd:-1}" "${tg:-autosnap}" "$onlyrun" > /etc/autosnap.conf
        chmod 0644 /etc/autosnap.conf
        echo "Werte aus dem alten Wrapper übernommen: /etc/autosnap.conf"
      fi
    fi
    install -m 0755 -o root -g root "$HIER/autosnap-run" "$WRAP"
    echo "Wrapper autosnap-run (v2) installiert."
  fi
fi

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
