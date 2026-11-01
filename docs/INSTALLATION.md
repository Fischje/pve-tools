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

## 3. SSH-Schlüssel und Hostliste

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

## 4. Jeden Host einrichten (einmalig)

Auf jedem Host (`router`, `pve`, `pbs`) als root. Dazu `host-setup/gate.sh` und `host-setup/setup-host.sh`
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

## 5. Starten

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

Die Seite ist dann unter `http://192.168.1.20:8080` erreichbar. **Setze gleich unter „Zeitplan & Konto“ ein Passwort.**
Das Tool beantwortet ohnehin nur Anfragen aus dem lokalen Netz.

## 6. Sichern und aktualisieren

- Der Ordner `data/` enthält Datenbank, Schlüssel und Hostliste. Der LXC sollte im normalen Proxmox-Backup sein.
- Aktualisieren: `cd /opt/pve-disk-tool && git pull && npm test && systemctl restart pve-disk-tool`.

## Demo ohne echte Hosts

```bash
npm run demo        # http://localhost:8080, simulierte Hosts und Platten, beschleunigte Zeit
```
