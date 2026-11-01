# pve-disk-tool – Konzept

Eine kleine, nur im LAN erreichbare Website, die den Zustand der Festplatten (HDD, SATA-SSD,
NVMe) von Proxmox VE und Proxmox Backup Server so zeigt, dass es auch Laien verstehen.

Stand: Konzeptentwurf (mit Übernahme deiner Skripte), noch kein Code.

## Ziele

1. **Der Proxmox-Host bleibt unberührt.** Keine Pakete, kein Webserver, keine Cronjobs, keine
   Dateien in `/var/www` oder `/usr/local`. Nur das, was ohnehin da ist (`smartctl`).
2. **Verständlich statt technisch.** Pro Platte eine Ampel, ein Klartext-Satz und eine
   Handlungsempfehlung. Rohwerte gibt es nur zum Aufklappen.
3. **Mehrere Hosts, eine Oberfläche.** PVE und PBS (und weitere) werden vom selben LXC abgefragt.
4. **Verlauf.** Gespeicherte Messwerte machen Trends sichtbar („steigt der Wert noch?“).
5. **Bestehende Funktionen bleiben.** Alles, was deine Skripte heute können (siehe nächster Abschnitt),
   gibt es auch im Interface. Schreibend ist nur eine Aktion erlaubt: SMART-Selbsttests starten
   (und abbrechen). Sonst nichts am Host.

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
- Der feste Befehl ist ein kleines Prüfskript `/etc/diskmon/gate.sh` (gehört `root`, unter `/etc`,
  also von Updates unberührt). Es erlaubt nur eine Positivliste:
  `smartctl -j -a`, `smartctl -j -x`, `lsblk -J`, `zpool status -p` sowie
  `smartctl -t short|long` und `smartctl -X`. Das Gerät muss in der aktuellen
  `lsblk`-Liste stehen und zu `/dev/sd[a-z]+` oder `/dev/nvme[0-9]+` passen. Alles andere wird abgelehnt.
- `/etc/sudoers.d/diskmon`: erlaubt `diskmon` nur, genau dieses Prüfskript als `root` zu starten
  (keine Platzhalter auf `smartctl`). NVMe-Geräte sind `root`-only, daher sudo.
- `smartmontools` muss vorhanden sein. Auf PVE und PBS ist es normalerweise schon installiert.

Der Sammler ruft `smartctl -j -a -n standby` auf. Mit `-n standby` werden schlafende HDDs nicht
aufgeweckt; sie erscheinen dann als „schläft, letzter bekannter Stand vom …“.

Alternative, falls SSH nicht gewünscht ist: API-Token mit Rolle „Audit“ (PVE und PBS bieten einen
SMART-Endpunkt). Vermutlich weniger Details und bei NVMe nur Text. Vor einer Entscheidung wäre das
zu prüfen. Von der Gerätedurchreichung in den LXC wird abgeraten (Eingriff in die Host-Konfiguration,
bindet an Gerätenamen wie `/dev/sdc`).

### Zeitplan für Selbsttests

Der Zeitplan läuft im Tool (im LXC), nicht als Cronjob auf dem Host. Der Host bleibt unverändert.
Die Platte führt den Test selbst aus. Das Tool stößt ihn nur an und liest später das Ergebnis.
Fällt der LXC zwischendurch aus, läuft ein begonnener Test trotzdem zu Ende.

Voreinstellung (pro Host und pro Plattentyp änderbar):

| Test | Standard | Hinweis |
|------|----------|---------|
| Kurztest | wöchentlich, Sonntag 03:00 | Minuten, kaum Last. Alle Platten eines Hosts nacheinander |
| Langtest | monatlich, rollierend | **Eine Platte nach der anderen** pro Host, nicht alle zugleich |

Regeln, damit der Zeitplan nichts kaputt macht:

- **Rollierender Langtest:** Große HDDs (z. B. 12 TB) brauchen für einen Langtest viele Stunden.
  Das Tool startet pro Host immer nur einen Langtest. Die nächste Platte folgt erst, wenn der
  vorherige Test fertig ist. Die Reihenfolge wird so verteilt, dass jede Platte innerhalb des Monats
  einmal drankommt. Verschiedene Hosts (PVE und PBS) dürfen parallel laufen.
- **Rücksicht auf Last:** Ein Test wird verschoben, wenn auf dem Host gerade ein ZFS-Scrub oder
  Resilver läuft oder schon ein Selbsttest auf der Platte läuft. Er holt den Termin im nächsten Zeitfenster nach.
  Sperrzeiten (z. B. Backup-Fenster auf dem PBS) lassen sich einstellen.
- **Nachholen:** War der Host zum Termin nicht erreichbar, wird der Test beim nächsten
  erfolgreichen Abruf nachgeholt, aber nur innerhalb des erlaubten Zeitfensters.
- **Schlafende HDDs:** Ein geplanter Test weckt die Platte bewusst auf. Das ist gewollt und
  wird in der Oberfläche vermerkt.
- **Ergebnis zählt in die Bewertung:** Ein fehlgeschlagener Test (z. B. „read failure“) lässt die Stufe
  auf mindestens „Bald tauschen“ steigen. Ein zu lange zurückliegender erfolgreicher Test wird als Hinweis
  angezeigt („letzter Langtest vor 94 Tagen“).
- **Anzeige:** In der Tests-Ansicht steht pro Platte der nächste geplante Termin. Der Zeitplan kann
  pro Platte oder Host pausiert werden. „Jetzt starten“ per Knopf bleibt zusätzlich möglich.

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
- Selbsttests starten nur nach Rückfrage, nie mehrere Langtests gleichzeitig auf demselben Host, und nur eine
  begrenzte Zahl pro Tag.
- Ausgaben der Hosts werden nie als Shell-Befehl oder HTML interpretiert (Escaping im Frontend).

## Übernahme deiner bisherigen Skripte

| Skript | Was es kann | Im Interface |
|--------|-------------|--------------|
| `disk_zustand.sh` / `disk_age.sh` | Tabelle: Gerät, Modell, Typ, Score, Verschleiß/Health, Stunden, Status; farbig | **Übersicht** (Tabellen- und Kartenansicht): gleiche Spalten, plus Klartext. Beide Skripte werden zu einer Bewertung zusammengeführt |
| `disk_age.sh` | Health-Text (EXCELLENT … POOR), Status „ALT“ ab 30000 h | Health-Text bleibt (Spalte „Zustand“), „Alt“-Hinweis ab 30000 Betriebsstunden bleibt |
| `disk_zustand.sh` | Score 0–100, CRC-Fehler, „REPLACE SOON“ | Score bleibt als Zahl sichtbar (abgeleitet aus den Stufen unten). CRC wird zum Kabel-Hinweis |
| `disk_test.sh` | SHORT oder LONG Selbsttest auf allen Platten starten, Dauerhinweise | Button „Kurztest“ / „Langtest“ pro Platte und „für alle Platten“, mit Rückfrage und Dauerhinweis |
| `disk_ergebnisse.sh` | Status des laufenden Tests und die letzten 4 Testergebnisse | **Tests**-Ansicht: laufender Test mit Fortschritt, die letzten Ergebnisse pro Platte |

Beim Übernehmen fallen folgende Schwächen auf, die dann behoben sind:

- `disk_ergebnisse.sh` sucht nur nach `# 1` bis `# 4`. Das ist das ATA-Format. Bei NVMe sieht das
  Testprotokoll anders aus, dort kommt vermutlich nichts an. Mit `smartctl -j` (JSON) gibt es
  für beide Typen dieselbe Struktur.
- `disk_test.sh` prüft nur, ob `smartctl -t` angenommen wurde. Das Tool zeigt zusätzlich, ob
  der Test wirklich läuft und wie er ausging.
- `disk_test.sh` startet auf **allen** Platten gleichzeitig. Auf einem PBS mit ohnehin hohem
  IO-Delay ist das heikel. Das Tool warnt davor und bietet an, die Tests nacheinander zu starten
  (Standard).
- Die Tests laufen auf dem Host selbst (die Platte führt sie intern aus). Das Tool stößt sie nur an
  und liest später das Ergebnis.

### Nicht übernommen: `enable-aspm.sh`

Das ist ein fremdes Skript (Luis R. Rodriguez, ISC-Lizenz), das per `setpci` PCIe-Register
ändert, um Stromsparen (ASPM) zu erzwingen. Es hat mit Plattengesundheit nichts zu tun, schreibt
direkt in die Hardware-Konfiguration des Hosts (nach einem Neustart wieder weg) und passt weder
zu „Host bleibt unberührt“ noch in eine Weboberfläche. Es bleibt außen vor. Das ist ein eigenes
Projekt für später. Die hochgeladene Datei
war außerdem eine als HTML gespeicherte GitHub-Seite und kein reines Skript.

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
2. **Tests:** Laufende Selbsttests mit Fortschritt, letzte Ergebnisse, Buttons zum Starten/Abbrechen.
3. **Detailansicht** (aufklappbar): Rohwerte, Selftest-Verlauf, Diagramme (Temperatur,
   Verschleiß, Fehlerzähler über Zeit).
4. **Kopfzeile:** „Alles in Ordnung“ bzw. „2 Platten brauchen Aufmerksamkeit“ und Zeit der
   letzten Abfrage. Wirkt auch auf dem Handy.
5. **Legende** mit kurzen Erklärungen („Was ist ein umgelagerter Sektor?“) für Nicht-Experten.

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
- Selbsttests starten ist gesetzt (per Knopf wie `disk_test.sh` und nach Zeitplan). Zu klären: Gibt es
  Zeiten, in denen nicht getestet werden darf (z. B. Backup-Fenster auf dem PBS)?
- Bisherige Skripte aus dem ChatGPT-Verlauf im Palast bleiben dort als Notiz; hier wird neu begonnen.
