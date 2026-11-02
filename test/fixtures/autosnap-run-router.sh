#!/bin/bash
# Aufruf: autosnap-run hourly|weekly|monthly
FLAG=/etc/autosnap.disabled
PAUSE_DAY=1            # 1 = Montag (date +%u): an diesem Tag keine Snapshots
LABEL="$1"

# Hauptschalter
if [ -e "$FLAG" ]; then
    logger -t autosnap "übersprungen ($LABEL): Snapshots sind ausgeschaltet"
    exit 0
fi

# Montag-Pause (FORCE=1 umgeht die Zeitregeln, nicht aber den Hauptschalter)
if [ -z "$FORCE" ] && [ "$(date +%u)" = "$PAUSE_DAY" ]; then
    exit 0
fi

case "$LABEL" in
    hourly)  KEEP=8 ;;
    weekly)  KEEP=1 ;;
    monthly) KEEP=1
             # Läuft am 1.; ist der 1. ein Montag, wird am 2. (Dienstag) nachgeholt
             if [ -z "$FORCE" ]; then
                 case "$(date +%d-%u)" in 01-*|02-2) ;; *) exit 0 ;; esac
             fi ;;
    *) echo "Aufruf: $0 hourly|weekly|monthly" >&2; exit 2 ;;
esac

/usr/local/sbin/proxmox-autosnap.py --autosnap --tags autosnap \
    --label "$LABEL" --keep "$KEEP" --check-free-space --mute 2>&1 | logger -t autosnap
