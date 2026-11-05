#!/usr/bin/env bash
# Automatischer Abgleich mit GitHub, alle 5 Minuten per systemd-Timer (Einrichtung: install-sync.sh).
# Wie bei den anderen Projekten: holt "main" per Fast-Forward, aber hier mit Tests, Datenbanksicherung, Neustart des Dienstes
# und automatischem Rückfall (update.sh). Lokal geänderte Dateien blockieren das Update (Warnung im Log).
# Ist eine neue Version fehlgeschlagen, wird sie erst bei der nächsten neuen Version erneut versucht (keine Dauerschleife).
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")" || exit 1
# Die Sperrdatei ist einstellbar, damit die Tests von sync.sh nicht mit einem echten Abgleich um dieselbe Sperre streiten.
exec 9>"${SYNC_LOCK:-/tmp/pve-tools-sync.lock}"
flock -n 9 || exit 0
log() { echo "$(date '+%F %T') $*"; }

BRANCH="${BRANCH:-main}"
DATA_DIR="${DATA_DIR:-./data}"
MARKER="$DATA_DIR/sync-fehler"

git fetch -q origin "$BRANCH" 2>/dev/null || { log "fetch fehlgeschlagen (GitHub nicht erreichbar?)"; exit 0; }
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [[ "$(git rev-parse --abbrev-ref HEAD)" == "$BRANCH" ]] && git merge-base --is-ancestor "$REMOTE" HEAD 2>/dev/null; then exit 0; fi
if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$REMOTE" ]]; then exit 0; fi

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  log "WARNUNG – Dateien auf dem Server direkt geändert, Update übersprungen"
  git status --short --untracked-files=no | sed 's/^/    /'
  exit 0
fi

log "Neue Version $(git rev-parse --short "$REMOTE") auf $BRANCH, aktualisiere …"
if BRANCH="$BRANCH" ./update.sh 9>&- 2>&1 | sed 's/^/    /'; [[ "${PIPESTATUS[0]}" == 0 ]]; then
  rm -f "$MARKER"
  log "aktualisiert: $(git log --oneline -1)"
else
  mkdir -p "$DATA_DIR"; echo "$REMOTE" > "$MARKER"
  log "FEHLER – Version bleibt bei $(git rev-parse --short HEAD). Nächster Versuch erst bei einer neuen Version auf $BRANCH. Ausgabe der Tests: $DATA_DIR/letzter-testlauf.log"
fi
