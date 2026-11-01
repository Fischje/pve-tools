#!/usr/bin/env bash
# Aktualisiert pve-disk-tool im LXC: neue Version holen, Tests laufen lassen, Datenbank sichern, Dienst neu starten.
# Schlägt ein Schritt fehl, wird automatisch auf die vorherige Version zurückgegangen.
# Aufruf (im LXC, als root):  /opt/pve-disk-tool/update.sh
# Einstellbar über Umgebungsvariablen: DIENST (Standard pve-disk-tool), DATA_DIR (Standard ./data), HEALTH_URL.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
DIENST="${DIENST:-pve-disk-tool}"
DATA_DIR="${DATA_DIR:-./data}"
PORT="${PORT:-8080}"
ADRESSE="${LISTEN:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
HEALTH_URL="${HEALTH_URL:-http://${ADRESSE:-127.0.0.1}:${PORT}/api/auth/status}"

git diff --quiet && git diff --cached --quiet || { echo "Es gibt lokale Änderungen im Programmordner. Bitte erst sichern oder verwerfen (git status)." >&2; exit 1; }

alt="$(git rev-parse HEAD)"
git pull --ff-only
neu="$(git rev-parse HEAD)"
if [[ "$alt" == "$neu" ]]; then echo "Bereits auf dem neuesten Stand ($(git rev-parse --short HEAD))."; exit 0; fi
echo "Neue Änderungen:"; git --no-pager log --oneline "$alt..$neu"

zurueck() {
  echo "FEHLER: $1. Gehe zurück auf die vorherige Version." >&2
  git reset --hard "$alt" >/dev/null
  systemctl restart "$DIENST" 2>/dev/null || true
  exit 1
}

echo "Tests …"
npm test --silent >/dev/null 2>&1 || zurueck "die Tests der neuen Version schlagen fehl"

echo "Sichere die Datenbank …"
systemctl stop "$DIENST" 2>/dev/null || true
if compgen -G "$DATA_DIR/disktool.sqlite*" >/dev/null; then
  sicherung="$DATA_DIR/vor-update-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$sicherung"
  cp -a "$DATA_DIR"/disktool.sqlite* "$sicherung"/
  # Nur die letzten 5 Sicherungen behalten.
  ls -1d "$DATA_DIR"/vor-update-* 2>/dev/null | head -n -5 | xargs -r rm -rf
fi

echo "Starte den Dienst …"
systemctl start "$DIENST" || zurueck "der Dienst startet nicht"
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then echo "Fertig: $(git rev-parse --short HEAD) läuft."; exit 0; fi
done
zurueck "der Dienst antwortet nicht unter $HEALTH_URL"
