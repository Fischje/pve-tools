# Installation

Ziel: Das Tool läuft in einem eigenen LXC auf dem immer eingeschalteten Host (`router`). Auf den Proxmox-Hosts wird
nur ein eingeschränkter SSH-Zugang eingerichtet. Es werden keine Pakete installiert (außer `sudo`, falls es dort fehlt).

## 1. LXC anlegen

In Proxmox einen Container aus der Debian-12-Vorlage erstellen (unprivilegiert, 1 Kern, 512 MB RAM, 4 GB Platte, feste
IP im LAN). Soll Docker darin laufen: unter *Optionen → Features* `Nesting` und `keyctl` aktivieren. Ohne Docker ist das nicht nötig.

Im Container: Zeitzone setzen (die Zeitplan-Uhrzeiten gelten in dieser Zeitzone) und Node installieren.

```bash
timedatectl set-timezone Europe/Berlin
apt update && apt install -y openssh-client git curl ca-certificates
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt install -y nodejs
```

## 2. Programm holen

```bash
git clone https://github.com/Fischje/pve-disk-tool /opt/pve-disk-tool
cd /opt/pve-disk-tool
npm test            # alle Tests sollten grün sein
```

## 3. Hosts einrichten

### Empfohlen: aus der Weboberfläche (ohne Befehlszeile auf dem Host)

1. Tool starten (Schritt 5) und unter „Zeitplan & Konto“ ein Passwort für die Seite setzen. Ohne dieses Passwort ist die Einrichtung gesperrt.
2. Reiter **Hosts → Host hinzufügen**: Kennung, Name, Adresse und Art des Hosts eintragen.
3. Der Assistent holt den **Fingerabdruck** des Hosts. Bestätigen, dann das **root-Passwort** des Hosts eingeben und „Einrichten“ wählen.

Was dabei passiert: Das Tool erzeugt beim ersten Mal selbst einen SSH-Schlüssel (`data/ssh/`), verbindet sich **einmalig** als root per
Passwort mit dem Host (nur im lokalen Netz, nur mit dem bestätigten Fingerabdruck), legt dort denselben eingeschränkten Zugang an wie
`setup-host.sh` (Benutzer `diskmon`, `/etc/diskmon/gate.sh`, sudo-Regel nur für dieses Skript, Schlüssel mit festem Befehl) und prüft, ob der neue
Zugang funktioniert. Danach erscheint der Host in der Liste. **Das Passwort wird nicht gespeichert**, nicht protokolliert und nur für diesen
einen Verbindungsaufbau verwendet. Optional: fehlende Pakete (`sudo`, `smartmontools`) installieren. Später lässt sich der Zugang dort auch
erneuern („Neu einrichten“) oder wieder entfernen („Zugang entfernen“).

Voraussetzungen: SSH-Anmeldung per Passwort für root muss auf dem Host erlaubt sein (bei Proxmox üblich), und im LXC muss OpenSSH 8.4 oder neuer
installiert sein (Debian 12: 9.2). Die Einrichtung ist im Demo-Modus nicht verfügbar.

### Alternativ: von Hand

#### SSH-Schlüssel und Hostliste

```bash
mkdir -p /opt/pve-disk-tool/data/ssh
ssh-keygen -t ed25519 -N '' -C 'diskmon@lxc' -f /opt/pve-disk-tool/data/ssh/id_ed25519
cat /opt/pve-disk-tool/data/ssh/id_ed25519.pub        # diese Zeile brauchst du gleich
cp hosts.example.json data/hosts.json
nano data/hosts.json                                   # Adressen und Art der Hosts eintragen
```

Host-Arten in `hosts.json`:

| `kind` | Bedeutung |
|--------|-----------|
| `dauer` | läuft immer (z. B. `router`) |
| `fest` | läuft zu festen Zeiten, `window` gibt das Betriebsfenster an (z. B. `pve`, 08:00–22:00) |
| `manuell` | wird von Hand gestartet, schaltet sich selbst zum Tagesende ab (`dayEnd`, z. B. der PBS um 19:00) |

Alles Weitere (Intervalle, gesperrte Wochentage, Sperrzeiten) stellst du später in der Oberfläche unter „Zeitplan & Konto“ ein.

#### Jeden Host einrichten (einmalig)

Nur nötig, wenn du die Einrichtung nicht über die Weboberfläche machst. Auf jedem Host (`router`, `pve`, `pbs`) als root. Dazu `host-setup/gate.sh` und `host-setup/setup-host.sh`
auf den Host kopieren (zum Beispiel per `scp`) und ausführen. Der Schlüssel ist die Zeile aus Schritt 3, die Adresse die des LXC:

```bash
./setup-host.sh "ssh-ed25519 AAAA… diskmon@lxc" 192.168.1.20
```

Das Skript legt den Benutzer `diskmon` an, kopiert das Prüfskript nach `/etc/diskmon/gate.sh`, erlaubt genau dieses
Skript per sudo und beschränkt den Schlüssel auf diesen Befehl und die Quell-IP. Rückgängig mit `./setup-host.sh --entfernen`.

Test vom LXC aus (sollte eine JSON-Plattenliste liefern):

```bash
ssh -i /opt/pve-disk-tool/data/ssh/id_ed25519 diskmon@192.168.1.11 list
```

Fragt `ssh` nach einem Passwort, fehlt meist `-i <Schlüssel>` im Aufruf. Ohne `-i` probiert `ssh` nur die Standardschlüssel von root, und
der Benutzer `diskmon` hat bewusst kein Passwort. Das Tool selbst nutzt immer den Schlüssel aus `data/ssh/`.

**Fehlersuche, wenn es mit `-i` trotzdem scheitert:**

| Symptom | Ursache und Abhilfe |
|---------|---------------------|
| Fragt nach Passwort / `Permission denied (publickey)` | Auf dem Host `cat /var/lib/diskmon/.ssh/authorized_keys` ansehen. Steht bei `from="…"` die falsche IP (nicht die des LXC), `setup-host.sh` mit der richtigen IP erneut ausführen. Der Schlüssel muss vollständig und unverändert aus der `.pub`-Datei stammen. |
| `gate: unbekannter Befehl` oder `unerlaubte Zeichen` | Der Befehl steht nicht auf der Positivliste. Erlaubt sind nur `list`, `uptime`, `zpool`, `smart`, `test`, `select`. |
| `sudo: a password is required` | Die sudoers-Datei fehlt: `ls -l /etc/sudoers.d/diskmon` und `visudo -cf /etc/sudoers.d/diskmon` prüfen. |
| Zeitüberschreitung | Firewall oder falsche Adresse in `hosts.json`. |
| Genauer Grund | Auf dem Host `journalctl -u ssh -n 30`. Im LXC `ssh -v -i … diskmon@<host> list`. |

## 4. Starten

Dieser Schritt kommt vor der Einrichtung per Weboberfläche. Das Tool startet auch ohne `hosts.json` (leere Hostliste).

Mit systemd (empfohlen im LXC):

```bash
cat > /etc/systemd/system/pve-disk-tool.service <<'UNIT'
[Unit]
Description=pve-disk-tool (Platten-Gesundheit, nur LAN)
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/opt/pve-disk-tool
Environment=DATA_DIR=/opt/pve-disk-tool/data
Environment=PORT=8080
# Auf die LAN-Adresse des LXC einschränken:
Environment=LISTEN=192.168.1.20
ExecStart=/usr/bin/node --disable-warning=ExperimentalWarning src/server.js
Restart=on-failure
User=root

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload && systemctl enable --now pve-disk-tool
```

Oder mit Docker: `cp .env.example .env`, `BIND_IP` anpassen, dann `docker compose up -d --build`. Der Ordner `data/`
(mit `hosts.json` und `ssh/id_ed25519`) muss für den Benutzer `node` (UID 1000) lesbar sein: `chown -R 1000:1000 data`.

Die Seite ist dann unter `http://192.168.1.20:8080` erreichbar. **Setze gleich unter „Zeitplan & Konto“ ein Passwort.** Danach kannst du unter „Hosts“ deine Proxmox-Hosts einrichten (siehe Abschnitt 3).
Das Tool beantwortet ohnehin nur Anfragen aus dem lokalen Netz.

## 5. Automatischer Abgleich (wie bei den anderen Projekten)

Der Weg einer Änderung ist derselbe wie bei deinen Webseiten und dem Discord-Bot:

1. Claude (oder du) pusht auf einen Zweig `claude/**`.
2. Der Workflow `.github/workflows/auto-merge-claude.yml` lässt die Tests laufen, prüft die neuen Commits mit gitleaks (Regeln aus dem Palast,
   `.gitleaks.toml`) und mergt bei sauberem Ergebnis nach `main`. Bei einem Fund oder fehlgeschlagenen Tests wird nicht gemergt.
3. Im LXC holt `sync.sh` alle 5 Minuten `main` per Fast-Forward. Neu gegenüber den Webseiten: Weil das Tool ein Dienst ist, führt es dafür
   `update.sh` aus (Tests, Datenbanksicherung, Neustart, Rückfall bei Fehler). Lokal geänderte Dateien im Programmordner blockieren das Update
   mit einer Warnung. Eine fehlgeschlagene Version wird nicht alle 5 Minuten neu versucht, sondern erst bei der nächsten neuen Version.

Einrichten (einmalig, im LXC als root):

```bash
cd /opt/pve-disk-tool
git pull            # holt update.sh, sync.sh und install-sync.sh
./install-sync.sh   # richtet den 5-Minuten-Timer ein
```

Der erste Lauf stellt den Klon von deinem bisherigen Zweig auf `main` um. Das Protokoll siehst du mit
`journalctl -u pve-disk-tool-sync -n 50`, den Timer mit `systemctl list-timers pve-disk-tool-sync.timer`.
Ausschalten: `./install-sync.sh --entfernen`.

**Folge:** Ein Push auf `claude/**` ist nach rund 5 Minuten im LXC produktiv. Der Dienst startet dabei kurz neu.

Voraussetzung auf GitHub: Unter *Settings → Actions → General → Workflow permissions* muss „Read and write permissions“ gewählt sein,
und `main` sollte als Standardzweig eingestellt sein.

## 6. Abfragerhythmus und E-Mail

Beides stellst du in der Oberfläche unter „Zeitplan & Konto“ ein.

**Abfragerhythmus:** Im Normalbetrieb fragt das Tool jeden Host alle 30 Minuten, einen ausgeschalteten oder nicht erreichbaren Host ebenfalls alle 30 Minuten und während eines Tests alle 5 Minuten. Alle drei Werte lassen sich ändern. Das SMART-Lesen weckt schlafende Platten nicht. Ein langer Abstand heißt: Ein Host, der gerade hochgefahren wurde, wird erst bei der nächsten Abfrage bemerkt, ein Test startet dann entsprechend später.

**E-Mail-Benachrichtigung:** Trage Mailserver, Port, Verschlüsselung (STARTTLS oder SSL/TLS), Benutzer, Passwort, Absender und Empfänger ein, schicke eine Testmail und schalte die Benachrichtigung ein. Das Mail-Passwort liegt in der Datenbank unter `data/` auf dem LXC (nie im Git) und wird nie wieder angezeigt. Für die Einstellung muss ein Passwort für die Oberfläche gesetzt sein. Es kommt eine Mail, wenn
- eine Platte auf „Bald tauschen“ oder „Kritisch“ wechselt,
- ein ZFS-Pool einen Fehler meldet (Pool nicht mehr voll in Ordnung, neuer Fehlerzähler an einem Gerät, Datenfehler, Pool fast voll),
- ein Selbsttest fehlschlägt (ein abgebrochener Test zählt nicht).

Jede Mail kommt nur einmal pro Änderung. Optional gibt es eine Entwarnung, wenn wieder alles in Ordnung ist. Beim Einschalten werden bereits bestehende Probleme still übernommen, gemeldet wird nur, was danach neu passiert. „Zusammenfassung jetzt senden“ schickt den aktuellen Stand. Ist der Mailserver nicht erreichbar, versucht das Tool es bei der nächsten Abfrage erneut und schreibt den Fehler höchstens einmal pro Stunde ins Ereignisprotokoll (Reiter „Tests“).

## 7. Sichern und aktualisieren

- Der Ordner `data/` enthält Datenbank, Schlüssel und Hostliste. Der LXC sollte im normalen Proxmox-Backup sein.
- **Von Hand aktualisieren:** `/opt/pve-disk-tool/update.sh` (im LXC als root). Mit dem automatischen Abgleich (Abschnitt 5) ist das nur noch nötig, wenn du nicht bis zum nächsten Lauf warten willst. Das Skript holt die neue Version, lässt die Tests laufen, sichert die
  Datenbank nach `data/vor-update-…` (die letzten 5 bleiben), startet den Dienst neu und prüft, ob er antwortet. Schlägt ein Schritt fehl, geht es
  automatisch auf die vorherige Version zurück. Es ändert nichts, wenn schon alles aktuell ist, und bricht bei lokalen Änderungen im Programmordner ab.
  Einstellungen, Passwort, Hostliste und Verlauf liegen in `data/` und bleiben unberührt.
- **Mit Docker:** `cd /opt/pve-disk-tool && git pull && docker compose up -d --build`.
- **Neue Prüfskript-Version:** Das Prüfskript auf den Hosts hat eine Versionsnummer. Ist sie älter als die im Tool, steht auf der Startseite ein Hinweis und im Reiter „Hosts einrichten“ bei dem Host „veraltet“. Ein Klick auf „Skript aktualisieren“ spielt es neu auf. Dafür gibst du das root-Passwort des Hosts kurz ein (wird nicht gespeichert). Der Fingerabdruck von der Einrichtung wird wieder verwendet. Bis dahin funktioniert alles Bisherige weiter, nur neue Funktionen (z. B. der Füllstand der ZFS-Pools) fehlen auf diesem Host.
- **Verbindungsfehler (Kabel/Port) melden:** Der CRC-Anstieg einer Platte wird mit jedem Prüfskript erkannt. Die Kernel-Meldungen (`ata… bus error`, Link zurückgefallen) braucht Prüfskript Version 5 (rein lesender Befehl `kernel`, nur ausgewählte Zeilen der letzten 48 Stunden). Dafür bei allen Hosts, auch beim PBS, „Skript aktualisieren“ wählen. Mails dazu höchstens alle 12 Stunden je Ursache; abschaltbar unter „E-Mail-Benachrichtigung“.
- **Snapshots vom Tool auslösen lassen:** Prüfskript Version 7 und das Recht „Snapshots auslösen erlauben“ (Haken beim Einrichten bzw. „Skript aktualisieren“, mit dem root-Passwort). Dabei wird auch der verwaltete Wrapper `autosnap-run` v2 installiert (der alte bleibt als Sicherung, seine Werte werden übernommen). Danach im Reiter „Backups & Snapshots“ „Das Tool übernimmt“. Siehe [BACKUP-STEUERUNG.md](BACKUP-STEUERUNG.md).
- **Backups und Snapshots anzeigen:** Dafür braucht das Prüfskript Version 4 (rein lesende Befehle für Gäste, Snapshots und Backup-Läufe). Im Reiter „Hosts einrichten“ bei den PVE-Hosts „Skript aktualisieren“ wählen. Der PBS braucht es dafür nicht.
- **Zugang auf den Hosts erneuern:** Nur nötig, wenn in den Hinweisen zu einer neuen Version steht, dass sich `host-setup/gate.sh` geändert hat.
  Dann im Reiter „Hosts“ bei jedem Host „Neu einrichten“ wählen. Sonst bleibt der Zugang unverändert gültig.

## Demo ohne echte Hosts

```bash
npm run demo        # http://localhost:8080, simulierte Hosts und Platten, beschleunigte Zeit
```
