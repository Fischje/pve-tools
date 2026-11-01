# pve-disk-tool – Konzept

Eine kleine, nur im LAN erreichbare Website, die den Zustand der Festplatten (HDD, SATA-SSD,
NVMe) von Proxmox VE und Proxmox Backup Server so zeigt, dass es auch Laien verstehen.

Stand: Konzeptentwurf, noch kein Code.

## Ziele

1. **Der Proxmox-Host bleibt unberührt.** Keine Pakete, kein Webserver, keine Cronjobs, keine
   Dateien in `/var/www` oder `/usr/local`. Nur das, was ohnehin da ist (`smartctl`).
2. **Verständlich statt technisch.** Pro Platte eine Ampel, ein Klartext-Satz und eine
   Handlungsempfehlung. Rohwerte gibt es nur zum Aufklappen.
3. **Mehrere Hosts, eine Oberfläche.** PVE und PBS (und weitere) werden vom selben LXC abgefragt.
4. **Verlauf.** Gespeicherte Messwerte machen Trends sichtbar („steigt der Wert noch?“).
5. **Nur lesen.** Das Tool darf nichts am Host ändern und keine Tests starten, die Platten belasten.

## Architektur

```
┌────────────── LXC (eigener Container) ──────────────┐
│  Node-App (Docker oder direkt)                      │
│   ├─ Sammler: fragt Hosts per SSH ab (stündlich)    │
│   ├─ Bewertung: Regeln → Status + Klartext          │
│   ├─ SQLite: Messwerte-Verlauf                      │
│   └─ Weboberfläche (nur LAN)                        │
└──────────────┬──────────────────────────────────────┘
               │ SSH, eigener Schlüssel, nur lesende Befehle
        ┌──────┴──────┐
        │ PVE-Host    │   PBS-Host   …
        └─────────────┘
```

### Datenzugriff: SSH mit eingeschränktem Schlüssel

Auf jedem abgefragten Host wird einmalig eingerichtet (alles unter `/etc` bzw. im Home des
Benutzers, überlebt Updates, im Notfall mit drei Befehlen rückbaubar):

- Benutzer `diskmon` ohne Passwort-Login.
- Eintrag in `~diskmon/.ssh/authorized_keys` mit
  `restrict,command="…"`. Der Befehl lässt nur eine feste Liste erlaubter Aufrufe durch
  (`$SSH_ORIGINAL_COMMAND` wird gegen eine Positivliste geprüft). Keine Shell, kein Forwarding.
- `/etc/sudoers.d/diskmon`: erlaubt nur `smartctl -j …`, `lsblk -J …` und `zpool status -p`.
  (NVMe-Geräte sind `root`-only, daher sudo statt Gruppenrechten.)
- `smartmontools` muss vorhanden sein. Auf PVE und PBS ist es normalerweise schon installiert.

Der Sammler ruft `smartctl -j -a -n standby` auf. Mit `-n standby` werden schlafende HDDs nicht
aufgeweckt; sie erscheinen dann als „schläft, letzter bekannter Stand vom …“.

Alternative, falls SSH nicht gewünscht ist: API-Token mit Rolle „Audit“ (PVE und PBS bieten einen
SMART-Endpunkt). Vermutlich weniger Details und bei NVMe nur Text. Vor einer Entscheidung wäre das
zu prüfen. Von der Gerätedurchreichung in den LXC wird abgeraten (Eingriff in die Host-Konfiguration,
bindet an Gerätenamen wie `/dev/sdc`).

### Docker im LXC

Gewählt ist Node/Docker. In einem unprivilegierten LXC läuft Docker nur mit den Optionen
`nesting=1` und `keyctl=1` (Proxmox → Container → Optionen → Features). Das betrifft nur den
Container, nicht den Host. Das Tool selbst braucht aber nichts davon: Es ist eine einzelne
Node-Anwendung, die auch direkt per `systemd` im LXC laufen kann. **Empfehlung:** Dockerfile und
`docker-compose.yml` liefern, aber die Variante ohne Docker ebenfalls dokumentieren.

### Sicherheit

- Weboberfläche lauscht nur auf der LAN-Adresse des LXC, keine Weiterleitung ins Internet.
- Optional ein einfaches Passwort (Basic Auth) per Umgebungsvariable.
- SSH-Schlüssel und Host-Liste liegen nur im LXC (Volume, nie im Git). `.env`, Schlüssel und
  Datenbank kommen in die `.gitignore`.
- Ausgaben der Hosts werden nie als Shell-Befehl oder HTML interpretiert (Escaping im Frontend).

## Bewertung

Statt eines willkürlichen Punktescores gibt es vier Stufen, jeweils mit Begründung:

| Stufe | Anzeige | Bedeutung |
|-------|---------|-----------|
| 🟢 | Gesund | Nichts Auffälliges |
| 🟡 | Beobachten | Auffälligkeit, aber stabil. Weiter im Auge behalten |
| 🟠 | Bald tauschen | Zeichen von Verschleiß oder Defekt. Ersatz einplanen, Backup prüfen |
| 🔴 | Kritisch | Sofort handeln. Daten sichern |

Die Gesamtstufe einer Platte ist die schlechteste Einzelstufe. Verlaufsregeln („steigt“) gelten
erst, wenn genug Messwerte da sind; bis dahin wird nur der absolute Wert bewertet.

### HDD (ATA)

| Befund | Stufe |
|--------|-------|
| SMART-Gesamtstatus „FAILED“ | Kritisch |
| Offene defekte Sektoren (197 Current_Pending_Sector > 0) oder nicht korrigierbar (198 Offline_Uncorrectable > 0) | Kritisch |
| Reallocated Sectors (5) > 0 und in den letzten 90 Tagen gestiegen; oder 187 Reported_Uncorrect > 0 | Bald tauschen |
| Letzter Extended-Selftest mit „read failure“ | Bald tauschen |
| Reallocated Sectors > 0, aber stabil | Beobachten |
| CRC-Fehler (199) gestiegen | Beobachten, Hinweis auf **Kabel/Backplane**, nicht auf die Platte |
| Temperatur ≥ 50 °C (HDD) | Beobachten |
| Betriebsstunden > 5 Jahre | nur Hinweis, keine Abwertung |

Erklärtext-Beispiel zu CRC: „Es gab Übertragungsfehler zwischen Platte und Controller. Das liegt
meist an Kabel, Stecker oder Backplane. Die Platte selbst ist dabei oft in Ordnung.“

### SATA-SSD

- Restlebensdauer aus den normalisierten Verschleißwerten (177 / 231 / 233 / 202, je nach
  Hersteller): ≤ 10 % Kritisch, ≤ 20 % Bald tauschen, ≤ 40 % Beobachten.
- Sektor-/Fehlerattribute wie bei HDD. Temperatur ≥ 70 °C: Beobachten.

### NVMe

| Befund | Stufe |
|--------|-------|
| `critical_warning` ≠ 0 | Kritisch |
| `available_spare` unter `available_spare_threshold` | Kritisch |
| `percentage_used` ≥ 100 | Kritisch |
| `percentage_used` ≥ 90 | Bald tauschen |
| `media_errors` gestiegen | Bald tauschen |
| `percentage_used` ≥ 70 | Beobachten |
| `media_errors` > 0, aber stabil | Beobachten |
| Temperatur ≥ 70 °C | Beobachten |
| unsichere Abschaltungen, Datenmenge | nur Info |

„Percentage Used“ wird in der Oberfläche als **„Verschleiß“** mit Balken und Restlebensdauer
erklärt: 3 % bedeuten fast neu, nicht „3 % kaputt“.

### ZFS (zusätzlich, weil auf PVE/PBS üblich)

Pro Pool `ONLINE` / `DEGRADED` / `FAULTED`, letzter Scrub, Fehlerzähler. Ein Pool in
`DEGRADED` ist Kritisch, und die zugehörige Platte wird markiert. Für Laien ist das oft die
wichtigste Information.

## Oberfläche

1. **Übersicht:** Eine Kachel pro Host, darunter pro Platte eine Karte mit Ampel, Name/Modell/
   Größe, Alter, Temperatur, einem Satz „Was heißt das?“ und der Empfehlung.
2. **Detailansicht** (aufklappbar): Rohwerte, Selftest-Verlauf, Diagramme (Temperatur,
   Verschleiß, Fehlerzähler über Zeit).
3. **Kopfzeile:** „Alles in Ordnung“ bzw. „2 Platten brauchen Aufmerksamkeit“ und Zeit der
   letzten Abfrage. Wirkt auch auf dem Handy.
4. **Legende** mit kurzen Erklärungen („Was ist ein umgelagerter Sektor?“) für Nicht-Experten.

Später möglich (nicht im ersten Wurf): Benachrichtigung per Mail/Telegram bei Stufenwechsel,
Export für Grafana.

## Datenmodell (SQLite)

- `host(id, name, adresse, typ)`
- `disk(id, host_id, seriennummer, modell, typ, kapazität)`. Die **Seriennummer** ist der
  Schlüssel, weil Gerätenamen wie `/dev/sdc` sich beim Booten ändern.
- `sample(disk_id, zeit, json_roh, temperatur, stunden, verschleiß, fehlerzähler …)`
- `finding(disk_id, zeit, stufe, code, text)`

Aufbewahrung: Stündliche Werte 90 Tage, danach tägliche Werte ohne Rohdaten.

## Geplante Repo-Struktur

```
pve-disk-tool/
├─ KONZEPT.md
├─ README.md
├─ src/            # Sammler, Bewertung, Server
├─ web/            # HTML/CSS/JS
├─ test/fixtures/  # echte smartctl-JSON-Ausgaben (HDD, SSD, NVMe, defekte Platte)
├─ host-setup/     # Skript + Anleitung für Benutzer, Schlüssel, sudoers
├─ Dockerfile, docker-compose.yml
└─ docs/           # LXC-Einrichtung Schritt für Schritt
```

Die Bewertungsregeln werden mit Testdateien abgesichert, darunter deine Seagate mit 16
umgelagerten Sektoren und 11266 CRC-Fehlern als Testfall („Bald tauschen“ plus Kabelhinweis).

## Vorgehen

1. Konzept abstimmen (dieses Dokument).
2. Sammler und Bewertung mit Beispieldaten, Tests.
3. Weboberfläche.
4. Host-Setup-Skript und LXC-Anleitung, Test auf PVE und PBS.
5. Verlauf/Diagramme, danach optional Benachrichtigungen.

## Offene Fragen

- Wie viele Hosts sind es genau (ein PVE, ein PBS), und stehen Platten hinter einem HBA/RAID-Controller?
  (Dann kann `smartctl -d …` nötig sein.)
- Reicht ein stündlicher Abfrageintervall?
- Soll die Seite ein Passwort haben oder LAN-only genügen?
- Sollen auch Self-Tests gestartet werden dürfen oder strikt nur lesen? (Empfehlung: nur lesen, Tests
  weiter über Proxmox oder `smartd`.)
- Bisherige Skripte aus dem ChatGPT-Verlauf im Palast bleiben dort als Notiz; hier wird neu begonnen.
