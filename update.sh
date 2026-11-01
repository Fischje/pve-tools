#!/usr/bin/env bash
# Aktualisiert pve-disk-tool im LXC: neue Version holen, Tests laufen lassen, Datenbank sichern, Dienst neu starten.
# Schlägt ein Schritt fehl, wird automatisch auf die vorherige Version zurückgegangen.
# Aufruf (im LXC, als root):  /opt/pve-disk-tool/update.sh        (BRANCH=main ./update.sh wechselt auf diesen Zweig)
# Wird auch von sync.sh (alle 5 Minuten, siehe install-sync.sh) aufgerufen.
# Einstellbar über Umgebungsvariablen: DIENST (Standard pve-disk-tool), BRANCH, DATA_DIR, PORT, LISTEN, HEALTH_URL.
# Werte für DATA_DIR, PORT und LISTEN werden, wenn nicht gesetzt, aus der systemd-Unit des Dienstes gelesen.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"
DIENST="${DIENST:-pve-disk-tool}"

dienst_env() { systemctl show "$DIENST" -p Environment --value 2>/dev/null | tr ' ' '\n' | sed -n "s/^$1=//p" | head -n1 || true; }
DATA_DIR="${DATA_DIR:-$(dienst_env DATA_DIR)}"; DATA_DIR="${DATA_DIR:-./data}"
PORT="${PORT:-$(dienst_env PORT)}"; PORT="${PORT:-8080}"
ADRESSE="${LISTEN:-$(dienst_env LISTEN)}"; ADRESSE="${ADRESSE:-$(hostname -I 2>/dev/null | awk '{print $1}')}"
HEALTH_URL="${HEALTH_URL:-http://${ADRESSE:-127.0.0.1}:${PORT}/api/auth/status}"

git diff --quiet && git diff --cached --quiet || { echo "Es gibt lokale Änderungen im Programmordner. Bitte erst sichern oder verwerfen (git status)." >&2; exit 1; }

zweig_alt="$(git rev-parse --abbrev-ref HEAD)"
BRANCH="${BRANCH:-$zweig_alt}"
alt="$(git rev-parse HEAD)"
ziel_alt="$(git rev-parse -q --verify "refs/heads/$BRANCH" || true)"
gestoppt=0

zurueck() {
  echo "FEHLER: $1. Gehe zurück auf die vorherige Version." >&2
  if [[ "$zweig_alt" != "$BRANCH" ]]; then
    git checkout -q "$zweig_alt"
    if [[ -n "$ziel_alt" ]]; then git branch -q -f "$BRANCH" "$ziel_alt"; else git branch -q -D "$BRANCH" || true; fi
  fi
  git reset -q --hard "$alt"
  if [[ "$gestoppt" == 1 ]]; then systemctl start "$DIENST" 2>/dev/null || true; fi
  exit 1
}

git fetch -q origin "$BRANCH"
if [[ "$zweig_alt" != "$BRANCH" ]]; then
  if [[ -n "$ziel_alt" ]]; then git checkout -q "$BRANCH"; else git checkout -q -b "$BRANCH" "origin/$BRANCH"; fi
fi
git merge -q --ff-only "origin/$BRANCH" || zurueck "der lokale Stand weicht von GitHub ab (kein Fast-Forward)"
neu="$(git rev-parse HEAD)"
if [[ "$alt" == "$neu" ]]; then echo "Bereits auf dem neuesten Stand ($(git rev-parse --short HEAD), Zweig $BRANCH)."; exit 0; fi
echo "Neue Änderungen:"; git --no-pager log --oneline "$alt..$neu"

echo "Tests …"
npm test --silent >/dev/null 2>&1 || zurueck "die Tests der neuen Version schlagen fehl"

echo "Sichere die Datenbank …"
if systemctl is-active --quiet "$DIENST" 2>/dev/null; then systemctl stop "$DIENST"; gestoppt=1; fi
if compgen -G "$DATA_DIR/disktool.sqlite*" >/dev/null; then
  sicherung="$DATA_DIR/vor-update-$(date +%Y%m%d-%H%M%S)"
  mkdir -p "$sicherung"
  cp -a "$DATA_DIR"/disktool.sqlite* "$sicherung"/
  # Nur die letzten 5 Sicherungen behalten.
  ls -1d "$DATA_DIR"/vor-update-* 2>/dev/null | head -n -5 | xargs -r rm -rf
fi

echo "Starte den Dienst …"
systemctl start "$DIENST" || zurueck "der Dienst startet nicht"
gestoppt=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  sleep 1
  if curl -fsS -m 3 "$HEALTH_URL" >/dev/null 2>&1; then echo "Fertig: $(git rev-parse --short HEAD) läuft."; exit 0; fi
done
gestoppt=1
systemctl stop "$DIENST" 2>/dev/null || true
zurueck "der Dienst antwortet nicht unter $HEALTH_URL"
