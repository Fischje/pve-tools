#!/usr/bin/env bash
# Prüfskript für den SSH-Zugang von pve-disk-tool (läuft AUF dem Proxmox-Host).
#
# Zweck: Der SSH-Schlüssel des Tools darf auf dem Host nur diese kleine Liste von Befehlen ausführen.
# Aufruf: Per sudo aus authorized_keys (command="sudo /etc/diskmon/gate.sh"). Der Befehl des Tools steht
#         in $SSH_ORIGINAL_COMMAND. Alles, was nicht auf der Positivliste steht, wird abgelehnt.
# Installation: host-setup/setup-host.sh kopiert diese Datei nach /etc/diskmon/gate.sh (gehört root).
#
# Erlaubte Befehle:
#   version                      Version dieses Prüfskripts
#   list                         Platten auflisten (lsblk, JSON)
#   uptime                       Sekunden seit dem Hochfahren
#   zpool                        zpool status (falls ZFS vorhanden)
#   zpoollist                    zpool list: Größe, belegt, frei, Fragmentierung (falls ZFS vorhanden)
#   smart <dev> [standby]        smartctl -j -a; mit "standby" wird eine schlafende Platte nicht geweckt
#   test <dev> short|long|abort  Selbsttest starten bzw. abbrechen
#   select <dev> <von> <bis>     Selektiver Selbsttest über einen Sektorbereich (nur Zahlen)
# Nur lesend, für Backup- und Snapshot-Überwachung (nur auf PVE-Hosts):
#   guests                       LXC und VMs dieses Knotens (JSON, mit Tags und Status)
#   snapshots                    alle Snapshots aller Gäste dieses Knotens (JSON je Gast)
#   tasks                        letzte vzdump-Aufgaben dieses Knotens (JSON)
#   tasklog <UPID>               Protokoll einer vzdump-Aufgabe (JSON)
#   autosnap                     Zustand der Snapshot-Skripte (Schalter, Aufbewahrung, Cron, letzte Meldungen)
#   kernel                       Kernel-Meldungen der letzten 48 h zu SATA/NVMe-Verbindungsfehlern (nur ausgewählte Zeilen)
set -euo pipefail

# Version dieses Prüfskripts. Das Tool vergleicht sie mit der eigenen und zeigt veraltete Hosts an. Bei Änderungen hochzählen.
GATE_VERSION=5

fail() { echo "gate: $*" >&2; exit 64; }

cmd="${SSH_ORIGINAL_COMMAND:-}"
[[ -n "$cmd" ]] || fail "kein Befehl"
[[ "$cmd" =~ ^[A-Za-z0-9/\ :@._-]+$ ]] || fail "unerlaubte Zeichen"
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
  version)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    echo "$GATE_VERSION" ;;
  list)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    exec lsblk -J -d -b -o NAME,TYPE,MODEL,SERIAL,SIZE,ROTA,TRAN ;;
  uptime)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    cut -d' ' -f1 /proc/uptime ;;
  zpool)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    if command -v zpool >/dev/null 2>&1; then exec zpool status -p; fi ;;
  zpoollist)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    if command -v zpool >/dev/null 2>&1; then exec zpool list -H -p -o name,size,alloc,free,frag,cap,health; fi ;;
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
  guests)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    command -v pvesh >/dev/null 2>&1 || exit 0
    node="$(hostname -s)"
    for t in lxc qemu; do printf '%s\t' "$t"; pvesh get "/nodes/$node/$t" --output-format json | tr -d '\n'; echo; done ;;
  snapshots)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    command -v pvesh >/dev/null 2>&1 || exit 0
    node="$(hostname -s)"
    for t in lxc qemu; do
      for id in $(pvesh get "/nodes/$node/$t" --output-format json | grep -oE '"vmid": *"?[0-9]+' | grep -oE '[0-9]+$'); do
        printf '%s\t%s\t' "$t" "$id"; pvesh get "/nodes/$node/$t/$id/snapshot" --output-format json | tr -d '\n'; echo
      done
    done ;;
  tasks)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    command -v pvesh >/dev/null 2>&1 || exit 0
    exec pvesh get "/nodes/$(hostname -s)/tasks" --typefilter vzdump --limit 40 --output-format json ;;
  tasklog)
    [[ ${#a[@]} -eq 2 ]] || fail "Argumente: tasklog <UPID>"
    [[ "${a[1]}" =~ ^UPID:[A-Za-z0-9._:@-]{10,200}$ ]] || fail "ungültige UPID"
    command -v pvesh >/dev/null 2>&1 || exit 0
    exec pvesh get "/nodes/$(hostname -s)/tasks/${a[1]}/log" --limit 20000 --output-format json ;;
  autosnap)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    echo "schalter: $([[ -e /etc/autosnap.disabled ]] && echo aus || echo an)"
    echo "== wrapper"; cat /usr/local/sbin/autosnap-run 2>/dev/null || true
    echo "== cron"; cat /etc/cron.d/proxmox-autosnap 2>/dev/null || true
    echo "== log"; journalctl -t autosnap -n 40 --no-pager -o short-iso 2>/dev/null || true ;;
  kernel)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    # Nur Zeilen zu ATA-Bus-/Link-Fehlern und NVMe-Resets, höchstens 300. Kein Zugriff auf andere Logs.
    { journalctl -k --since "-48 hours" --no-pager -o short-iso 2>/dev/null || true; } \
      | { grep -E 'ata[0-9]+(\.[0-9]+)?: .*(ATA bus error|failed command|frozen|hard resetting|link up 1\.5 Gbps|link up 3\.0 Gbps|SError)|nvme[0-9]+: .*(reset|timeout|controller is down)' || true; } \
      | tail -n 300 ;;
  *) fail "unbekannter Befehl" ;;
esac
