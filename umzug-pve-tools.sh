#!/usr/bin/env bash
# Einmaliger Umzug im LXC vom alten Namen „pve-disk-tool“ auf „pve-tools“ (als root ausführen).
#
# Was passiert:
#   1. Automatischen Abgleich anhalten und einen gerade laufenden Abgleich abwarten.
#   2. Dienst pve-disk-tool anhalten.
#   3. Programmordner /opt/pve-disk-tool -> /opt/pve-tools verschieben. Unter dem alten Pfad bleibt ein Verweis (Symlink),
#      damit alte Pfadangaben (z. B. in hosts.json oder eigenen Skripten) weiter funktionieren. Er kann später weg.
#   4. Datenbank data/disktool.sqlite -> data/pvetools.sqlite umbenennen (der Dienst ist dabei aus).
#   5. Dienst als pve-tools.service neu anlegen (Pfade angepasst, sonst unverändert: Port, Adresse, Datenordner), starten, prüfen.
#   6. Automatischen Abgleich unter dem neuen Namen pve-tools-sync einrichten (der alte wird entfernt).
# Schlägt ein Schritt fehl, wird alles auf den alten Stand zurückgesetzt und der alte Dienst wieder gestartet.
#
# Aufruf:  /opt/pve-disk-tool/umzug-pve-tools.sh
# Danach:  Dienst = pve-tools, Abgleich = pve-tools-sync, Ordner = /opt/pve-tools.
set -euo pipefail

ALT=/opt/pve-disk-tool
NEU=/opt/pve-tools
ALT_UNIT=/etc/systemd/system/pve-disk-tool.service
NEU_UNIT=/etc/systemd/system/pve-tools.service
SICHERUNG="/root/pve-disk-tool.service.vor-umzug"

fail() { echo "Abbruch: $*" >&2; exit 1; }
[[ $EUID -eq 0 ]] || fail "Bitte als root ausführen."

if [[ -f "$NEU_UNIT" && -d "$NEU/.git" && ! -L "$NEU" ]]; then echo "Schon umgezogen: Dienst pve-tools, Ordner $NEU."; exit 0; fi
[[ -d "$ALT/.git" && ! -L "$ALT" ]] || fail "$ALT ist kein Programmordner (schon umgezogen oder anders installiert?)."
[[ ! -e "$NEU" ]] || fail "$NEU gibt es schon. Bitte prüfen und ggf. wegräumen."
[[ -f "$ALT_UNIT" ]] || fail "$ALT_UNIT fehlt. Läuft der Dienst unter einem anderen Namen?"
command -v curl >/dev/null || fail "curl fehlt."

# Datenordner, Port und Adresse aus der Unit (wie update.sh)
unit_env() { sed -n "s/^Environment=\"\{0,1\}$1=\([^\" ]*\).*/\1/p" "$ALT_UNIT" | head -n1; }
DATA_ALT="$(unit_env DATA_DIR)"; DATA_ALT="${DATA_ALT:-$ALT/data}"
[[ "$DATA_ALT" = /* ]] || DATA_ALT="$ALT/$DATA_ALT"
DATA_NEU="${DATA_ALT/#$ALT/$NEU}"
PORT="$(unit_env PORT)"; PORT="${PORT:-8080}"
ADRESSE="$(unit_env LISTEN)"; ADRESSE="${ADRESSE:-127.0.0.1}"
[[ "$ADRESSE" == 0.0.0.0 ]] && ADRESSE=127.0.0.1

echo "1/6 Abgleich anhalten …"
systemctl stop pve-disk-tool-sync.timer 2>/dev/null || true
flock -w 600 /tmp/pve-disk-tool-sync.lock true 2>/dev/null || fail "ein Abgleich läuft noch (Sperre /tmp/pve-disk-tool-sync.lock)."
flock -w 600 /tmp/pve-tools-sync.lock true 2>/dev/null || fail "ein Abgleich läuft noch (Sperre /tmp/pve-tools-sync.lock)."

echo "2/6 Dienst pve-disk-tool anhalten …"
systemctl stop pve-disk-tool
cp -a "$ALT_UNIT" "$SICHERUNG"

umbenannt=()
zurueck() {
  echo "FEHLER in Schritt ${schritt:-?}. Setze alles zurück …" >&2
  systemctl disable --now pve-tools 2>/dev/null || true
  rm -f "$NEU_UNIT"
  for paar in "${umbenannt[@]}"; do mv "${paar#*|}" "${paar%%|*}" 2>/dev/null || true; done
  if [[ -L "$ALT" ]]; then rm -f "$ALT"; fi
  if [[ -d "$NEU" && ! -e "$ALT" ]]; then mv "$NEU" "$ALT"; fi
  cp -a "$SICHERUNG" "$ALT_UNIT"
  systemctl daemon-reload
  systemctl enable --now pve-disk-tool || true
  systemctl start pve-disk-tool-sync.timer 2>/dev/null || true
  echo "Zurückgesetzt: Es läuft wieder pve-disk-tool aus $ALT." >&2
}
trap zurueck ERR

schritt=3; echo "3/6 Ordner $ALT -> $NEU …"
mv "$ALT" "$NEU"
ln -s "$NEU" "$ALT"

schritt=4; echo "4/6 Datenbank umbenennen …"
if [[ -f "$DATA_NEU/disktool.sqlite" && ! -e "$DATA_NEU/pvetools.sqlite" ]]; then
  for teil in "" -wal -shm; do
    if [[ -e "$DATA_NEU/disktool.sqlite$teil" ]]; then mv "$DATA_NEU/disktool.sqlite$teil" "$DATA_NEU/pvetools.sqlite$teil"; umbenannt+=("$DATA_NEU/disktool.sqlite$teil|$DATA_NEU/pvetools.sqlite$teil"); fi
  done
fi

schritt=5; echo "5/6 Dienst pve-tools anlegen und starten …"
sed -e "s#$ALT#$NEU#g" -e 's/^Description=.*/Description=PVE-Tools (Platten, ZFS, Backups und Snapshots; nur LAN)/' "$SICHERUNG" > "$NEU_UNIT"
systemctl disable pve-disk-tool 2>/dev/null || true
rm -f "$ALT_UNIT"
systemctl daemon-reload
systemctl enable --now pve-tools
ok=0
for _ in $(seq 1 20); do sleep 1; if curl -fsS -m 3 "http://$ADRESSE:$PORT/api/auth/status" >/dev/null 2>&1; then ok=1; break; fi; done
[[ "$ok" == 1 ]] || false

schritt=6; echo "6/6 Abgleich als pve-tools-sync einrichten …"
"$NEU/install-sync.sh"
trap - ERR

git -C "$NEU" remote set-url origin https://github.com/Fischje/pve-tools.git 2>/dev/null || true
echo
echo "Fertig. Dienst: pve-tools (systemctl status pve-tools), Abgleich: pve-tools-sync, Ordner: $NEU, Datenbank: $DATA_NEU/pvetools.sqlite."
echo "Der Verweis $ALT -> $NEU bleibt, damit alte Pfade funktionieren. Entfernen, wenn alles läuft:  rm $ALT"
echo "Die alte Unit liegt als Sicherung unter $SICHERUNG."
