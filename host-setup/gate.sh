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
#   rechte                       Welche Rechtegruppen für dieses Skript freigegeben sind (Datei /etc/diskmon/rechte)
#   kernel                       Kernel-Meldungen der letzten 48 h zu SATA/NVMe-Verbindungsfehlern (nur ausgewählte Zeilen)
# Schreibende Befehle, nur wenn die Rechtegruppe "snapshots" bei der Einrichtung freigegeben wurde (mit dem root-Passwort):
#   snap-run hourly|weekly|monthly [force]   startet den vorhandenen /usr/local/sbin/autosnap-run mit dieser Bezeichnung
#   snap-switch on|off                       setzt/löscht /etc/autosnap.disabled (Snapshots aus/an)
#   snap-conf <stündlich> <wöchentlich> <monatlich> <pausentag> <monatstag>
#                                            schreibt /etc/autosnap.conf (Aufbewahrung 1–99/1–52/1–36, Pausentag 0=keiner oder 1–7, Monatstag 1–28)
#   snap-dryrun hourly|weekly|monthly        Probelauf ohne Wirkung (zeigt, welche Container betroffen wären)
#   snap-cron on|off|status                  benennt /etc/cron.d/proxmox-autosnap um (aus) bzw. zurück (an), damit nie zwei Auslöser laufen
set -euo pipefail

# Version dieses Prüfskripts. Das Tool vergleicht sie mit der eigenen und zeigt veraltete Hosts an. Bei Änderungen hochzählen.
GATE_VERSION=7

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

RECHTE=/etc/diskmon/rechte
recht() { [[ -r "$RECHTE" ]] && grep -qx "$1" "$RECHTE"; }
need() { recht "$1" || fail "Recht '$1' ist für diesen Host nicht freigegeben (Reiter Hosts einrichten, Skript aktualisieren)"; }

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
    echo "== conf"; cat /etc/autosnap.conf 2>/dev/null || true
    echo "== log"; journalctl -t autosnap -n 40 --no-pager -o short-iso 2>/dev/null || true ;;
  rechte)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    cat "$RECHTE" 2>/dev/null || true ;;
  snap-run)
    need snapshots
    [[ ${#a[@]} -ge 2 && ${#a[@]} -le 3 ]] || fail "Argumente: snap-run hourly|weekly|monthly [force]"
    [[ "${a[1]}" =~ ^(hourly|weekly|monthly)$ ]] || fail "unbekannte Bezeichnung"
    [[ -z "${a[2]:-}" || "${a[2]}" == "force" ]] || fail "unbekannte Option"
    [[ -x /usr/local/sbin/autosnap-run ]] || fail "autosnap-run fehlt"
    [[ "${a[2]:-}" == "force" ]] && export FORCE=1
    exec flock -n /run/diskmon-snap.lock /usr/local/sbin/autosnap-run "${a[1]}" ;;
  snap-switch)
    need snapshots
    [[ ${#a[@]} -eq 2 && "${a[1]}" =~ ^(on|off)$ ]] || fail "Argumente: snap-switch on|off"
    if [[ "${a[1]}" == "off" ]]; then touch /etc/autosnap.disabled; else rm -f /etc/autosnap.disabled; fi
    echo "schalter: $([[ -e /etc/autosnap.disabled ]] && echo aus || echo an)" ;;
  snap-conf)
    need snapshots
    [[ ${#a[@]} -eq 6 ]] || fail "Argumente: snap-conf <stündlich> <wöchentlich> <monatlich> <pausentag> <monatstag>"
    for i in 1 2 3 4 5; do [[ "${a[$i]}" =~ ^[0-9]{1,2}$ ]] || fail "keine Zahl: ${a[$i]}"; done
    kh=$((10#${a[1]})); kw=$((10#${a[2]})); km=$((10#${a[3]})); pd=$((10#${a[4]})); md=$((10#${a[5]}))
    (( kh >= 1 && kh <= 99 )) || fail "stündlich: erlaubt sind 1 bis 99"
    (( kw >= 1 && kw <= 52 )) || fail "wöchentlich: erlaubt sind 1 bis 52"
    (( km >= 1 && km <= 36 )) || fail "monatlich: erlaubt sind 1 bis 36"
    (( pd >= 0 && pd <= 7 )) || fail "pausentag: erlaubt sind 0 (keiner) oder 1 bis 7"
    (( md >= 1 && md <= 28 )) || fail "monatstag: erlaubt sind 1 bis 28"
    # Auswahl (Tag, nur laufende) bleibt, wie sie ist; nur die Werte aus dem Befehl werden neu gesetzt.
    tag="autosnap"; onlyrun=0
    if [[ -r /etc/autosnap.conf ]]; then
      t="$(sed -n 's/^TAG=\([A-Za-z0-9_-]\{1,32\}\)$/\1/p' /etc/autosnap.conf | head -1)"; [[ -n "$t" ]] && tag="$t"
      o="$(sed -n 's/^ONLY_RUNNING=\([01]\)$/\1/p' /etc/autosnap.conf | head -1)"; [[ -n "$o" ]] && onlyrun="$o"
    fi
    tmp="$(mktemp /etc/autosnap.conf.XXXXXX)"
    printf 'KEEP_HOURLY=%s\nKEEP_WEEKLY=%s\nKEEP_MONTHLY=%s\nPAUSE_DAY=%s\nMONTHLY_DAY=%s\nTAG=%s\nONLY_RUNNING=%s\n' "$kh" "$kw" "$km" "$pd" "$md" "$tag" "$onlyrun" > "$tmp"
    chmod 0644 "$tmp"; mv "$tmp" /etc/autosnap.conf
    cat /etc/autosnap.conf ;;
  snap-dryrun)
    need snapshots
    [[ ${#a[@]} -eq 2 && "${a[1]}" =~ ^(hourly|weekly|monthly)$ ]] || fail "Argumente: snap-dryrun hourly|weekly|monthly"
    [[ -x /usr/local/sbin/autosnap-run ]] || fail "autosnap-run fehlt"
    grep -q '^# autosnap-run v2' /usr/local/sbin/autosnap-run || fail "autosnap-run ist noch nicht die verwaltete Version (Skript aktualisieren mit Haken Snapshots auslösen erlauben)"
    export DRYRUN=1 FORCE=1
    exec flock -n /run/diskmon-snap.lock /usr/local/sbin/autosnap-run "${a[1]}" ;;
  snap-cron)
    need snapshots
    [[ ${#a[@]} -eq 2 && "${a[1]}" =~ ^(on|off|status)$ ]] || fail "Argumente: snap-cron on|off|status"
    # Dateien mit Punkt im Namen ignoriert cron: so ist "aus" reversibel, ohne etwas zu löschen.
    c=/etc/cron.d/proxmox-autosnap; d=/etc/cron.d/proxmox-autosnap.tool-aus
    case "${a[1]}" in
      off) [[ -e "$c" ]] && mv "$c" "$d" ;;
      on)  [[ -e "$d" ]] && mv "$d" "$c" ;;
    esac
    echo "cron: $([[ -e "$c" ]] && echo an || { [[ -e "$d" ]] && echo vom-tool-aus || echo fehlt; })" ;;
  kernel)
    [[ ${#a[@]} -eq 1 ]] || fail "zu viele Argumente"
    # Nur Zeilen zu ATA-Bus-/Link-Fehlern und NVMe-Resets, höchstens 300. Kein Zugriff auf andere Logs.
    { journalctl -k --since "-48 hours" --no-pager -o short-iso 2>/dev/null || true; } \
      | { grep -E 'ata[0-9]+(\.[0-9]+)?: .*(ATA bus error|failed command|frozen|hard resetting|link up 1\.5 Gbps|link up 3\.0 Gbps|SError)|nvme[0-9]+: .*(reset|timeout|controller is down)' || true; } \
      | tail -n 300 ;;
  *) fail "unbekannter Befehl" ;;
esac
