#!/bin/bash
# Aufruf: autosnap-run hourly|weekly|monthly
# Testlauf ohne Wirkung: DRYRUN=1 autosnap-run hourly
FLAG=/etc/autosnap.disabled
PAUSE_DAY=1            # 1 = Montag (date +%u): an diesem Tag keine Snapshots
TAG="autosnap"
LABEL="$1"

if [ -e "$FLAG" ] && [ -z "$DRYRUN" ]; then
    logger -t autosnap "übersprungen ($LABEL): Snapshots sind ausgeschaltet"
    exit 0
fi

if [ -z "$FORCE" ] && [ "$(date +%u)" = "$PAUSE_DAY" ]; then
    exit 0
fi

case "$LABEL" in
    hourly)  KEEP=8 ;;
    weekly)  KEEP=1 ;;
    monthly) KEEP=1
             if [ -z "$FORCE" ]; then
                 case "$(date +%d-%u)" in 01-*|02-2) ;; *) exit 0 ;; esac
             fi ;;
    *) echo "Aufruf: $0 hourly|weekly|monthly" >&2; exit 2 ;;
esac

# Nur laufende LXCs mit dem Tag
IDS=""
for id in $(pct list | awk 'NR>1 && $2=="running" {print $1}'); do
    case ";$(pct config "$id" | awk '/^tags:/{print $2}');" in
        *";$TAG;"*) IDS="$IDS $id" ;;
    esac
done
[ -z "$IDS" ] && exit 0

OPTS="--autosnap --vmid $IDS --label $LABEL --keep $KEEP --check-free-space --mute"
if [ -n "$DRYRUN" ]; then
    echo "Container:$IDS"
    /usr/local/sbin/proxmox-autosnap.py $OPTS --dryrun
else
    /usr/local/sbin/proxmox-autosnap.py $OPTS 2>&1 | logger -t autosnap
fi
