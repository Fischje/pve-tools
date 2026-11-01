#!/usr/bin/env bash
# Prüfskript für den SSH-Zugang von pve-disk-tool (läuft AUF dem Proxmox-Host).
#
# Zweck: Der SSH-Schlüssel des Tools darf auf dem Host nur diese kleine Liste von Befehlen ausführen.
# Aufruf: Per sudo aus authorized_keys (command="sudo /etc/diskmon/gate.sh"). Der Befehl des Tools steht
#         in $SSH_ORIGINAL_COMMAND. Alles, was nicht auf der Positivliste steht, wird abgelehnt.
# Installation: host-setup/setup-host.sh kopiert diese Datei nach /etc/diskmon/gate.sh (gehört root).
#
# Erlaubte Befehle:
#   list                         Platten auflisten (lsblk, JSON)
#   uptime                       Sekunden seit dem Hochfahren
#   zpool                        zpool status (falls ZFS vorhanden)
#   smart <dev> [standby]        smartctl -j -a; mit "standby" wird eine schlafende Platte nicht geweckt
#   test <dev> short|long|abort  Selbsttest starten bzw. abbrechen
#   select <dev> <von> <bis>     Selektiver Selbsttest über einen Sektorbereich (nur Zahlen)
set -euo pipefail

fail() { echo "gate: $*" >&2; exit 64; }

cmd="${SSH_ORIGINAL_COMMAND:-}"
[[ -n "$cmd" ]] || fail "kein Befehl"
[[ "$cmd" =~ ^[A-Za-z0-9/\ ]+$ ]] || fail "unerlaubte Zeichen"
read -r -a a <<< "$cmd"

dev_ok() {
  local d="$1" name
  [[ "$d" =~ ^/dev/(sd[a-z]{1,3}|nvme[0-9]{1,2}n[0-9]{1,2})$ ]] || fail "ungültiges Gerät"
  name="${d#/dev/}"
  # Das Gerät muss eine echte Platte laut lsblk sein (keine Partition, kein Loop-Gerät).
  lsblk -dn -o NAME,TYPE | awk -v n="$name" '$1==n && $2=="disk" {found=1} END {exit !found}' || fail "keine Platte: $d"
}
num_ok() { [[ "$1" =~ ^[0-9]{1,13}$ ]] || fail "keine Zahl: $1"; }

case "${a[0]}" in
  list)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    exec lsblk -J -d -b -o NAME,TYPE,MODEL,SERIAL,SIZE,ROTA,TRAN ;;
  uptime)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    cut -d' ' -f1 /proc/uptime ;;
  zpool)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    if command -v zpool >/dev/null 2>&1; then exec zpool status -p; fi ;;
  smart)
    [[ ${#a[@]} -ge 2 && ${#a[@]} -le 3 ]] || fail "Argumente: smart <dev> [standby]"
    dev_ok "${a[1]}"
    if [[ "${a[2]:-}" == "standby" ]]; then exec smartctl -j -a -n standby "${a[1]}"; fi
    [[ -z "${a[2]:-}" ]] || fail "unbekannte Option"
    exec smartctl -j -a "${a[1]}" ;;
  test)
    [[ ${#a[@]} -eq 3 ]] || fail "Argumente: test <dev> short|long|abort"
    dev_ok "${a[1]}"
    case "${a[2]}" in
      short) exec smartctl -j -t short "${a[1]}" ;;
      long)  exec smartctl -j -t long "${a[1]}" ;;
      abort) exec smartctl -j -X "${a[1]}" ;;
      *) fail "unbekannter Testtyp" ;;
    esac ;;
  select)
    [[ ${#a[@]} -eq 4 ]] || fail "Argumente: select <dev> <von> <bis>"
    dev_ok "${a[1]}"; num_ok "${a[2]}"; num_ok "${a[3]}"
    (( a[2] <= a[3] )) || fail "von muss kleiner als bis sein"
    exec smartctl -j -t "select,${a[2]}-${a[3]}" "${a[1]}" ;;
  *) fail "unbekannter Befehl" ;;
esac
