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
**Alles Folgende ist in der Oberfläche unter „Einstellungen → Zeitplan“ einstellbar**, pro Host
(PVE und PBS können verschieden sein).

| Einstellung | Standard | Bedeutung |
|-------------|----------|-----------|
| Kurztest-Intervall | alle 1 Monat | Anzahl Monate (1–12) |
| Langtest-Intervall | alle 3 Monate | Anzahl Monate (1–12), empfohlen 3–4 |
| Gesperrte Wochentage | Montag | Mehrfachauswahl. Gilt für Kurz- **und** Langtests. Fällt ein Termin darauf, rutscht er auf den nächsten erlaubten Tag |
| Betriebsfenster des Hosts | 07:00 – 22:00 | Wann der Server läuft. Tests dürfen nur in diesem Fenster laufen |
| Anlaufzeit nach dem Hochfahren | 20 Minuten | Wartezeit, bis nach dem Boot getestet wird (ZFS-Import, Dienste, Backups) |
| Sicherheitsabstand vor Ende | 30 Minuten | So lange vor dem Herunterfahren wird kein Test mehr gestartet und ein laufender sauber beendet |
| Reihenfolge | seriell | Immer nur **eine** Platte pro Host gleichzeitig, nacheinander |
| Kurz- und Langtest am selben Tag | verboten | Ein Langtest ersetzt in seinem Monat den Kurztest |

#### Ablauf

- **Seriell:** Pro Host läuft immer nur ein Test. Die nächste Platte folgt erst, wenn die vorige fertig ist.
  Die Reihenfolge ist fest (z. B. nach Seriennummer), damit sie nachvollziehbar bleibt.
  Verschiedene Hosts dürfen parallel laufen.
- **Kurztest** (wenige Minuten je Platte) passt in jedes Fenster. Alle Platten sind an einem Tag durch.
- **Terminlogik:** Das Intervall rechnet ab dem letzten **erfolgreich abgeschlossenen** Test. Ist er fällig, wird
  er am nächsten erlaubten Tag im Betriebsfenster gestartet, nicht an einem gesperrten Wochentag.
- **Rücksicht auf Last:** Läuft gerade ein ZFS-Scrub oder Resilver, wird verschoben. Ebenso, wenn
  schon ein Test auf der Platte läuft oder eine einstellbare Sperrzeit gilt (z. B. Backup-Fenster auf dem PBS).

#### Server geht nachts aus

Fährt der Server herunter, wird ein laufender Selbsttest abgebrochen (im Testprotokoll steht dann
„Interrupted (host reset)“ und er zählt nicht). Deshalb gilt:

1. **Nie außerhalb des Fensters starten.** Das Tool kennt das Betriebsfenster und startet nur darin.
   Ist der Host nicht erreichbar, passiert nichts; der Termin wird nachgeholt (siehe „Terminlogik“).
2. **Rechtzeitig aufhören.** Vor Fensterende minus Sicherheitsabstand wird kein neuer Test gestartet. Läuft einer
   noch, wird er per `smartctl -X` sauber abgebrochen und als „unterbrochen, wird fortgesetzt“ vermerkt (kein Fehlalarm).
3. **Langtest passt nicht in ein Fenster.** Ein Langtest einer 12-TB-HDD dauert viele Stunden (nach den Angaben der
   Platte oft über 15 Stunden); das Fenster ist kürzer, und das gilt noch mehr, wenn mehrere Platten nacheinander dran sind.
   Lösung: Der Langtest wird **auf mehrere Tage aufgeteilt**. ATA-Platten können dafür *selektive Selbsttests*
   (`smartctl -t select,<von>-<bis>`). Das Tool teilt die Plattenfläche in Abschnitte, die jeweils ins Restfenster
   passen. Es merkt sich in der Datenbank den Fortschritt (bis zu welchem Sektor gelesen wurde) und macht am
   nächsten erlaubten Tag dort weiter, bis die ganze Platte einmal gelesen ist. Erst dann gilt der Langtest als
   bestanden. Die Dauer pro Abschnitt kommt aus den Angaben der Platte (empfohlene Testzeit) und wird beim ersten Lauf
   nachgemessen.
   - Das gleiche Prinzip gilt für die nächste Platte: Der Rest des Tages wird nicht verschwendet, sondern geht an sie.
   - NVMe und SATA-SSDs sind schnell genug, hier genügt ein normaler Langtest im Fenster.
   - Unterstützt eine Platte keine selektiven Tests, meldet das Tool das und bietet an, den Test an einem
     Tag mit längerem Betriebsfenster zu starten (Fenster einmalig verlängern; dazu muss der Server aber wirklich an bleiben).
4. **Nach dem Hochfahren warten.** Nach der Anlaufzeit wird getestet, vorher nicht. Der Host muss zuerst
   mindestens so lange ohne Unterbrechung erreichbar gewesen sein.
5. **Auch das Tool selbst kann schlafen.** Läuft der LXC auf demselben Server, ist er nachts ebenfalls aus. Das ist
   unkritisch: Der Zeitplan wird beim Start neu berechnet, und ein begonnener Test läuft in der Platte weiter.
   Läuft der LXC auf einem Gerät, das durchläuft, während der Ziel-Host schläft, wird nur auf Erreichbarkeit
   des Hosts reagiert.

#### Ergebnis und Anzeige

- Ein fehlgeschlagener Test (z. B. „read failure“) lässt die Stufe auf mindestens „Bald tauschen“ steigen.
  Ein unterbrochener Test (Fensterende, Neustart) ist **kein** Fehler.
- Ist der letzte erfolgreiche Test sehr lange her, steht ein Hinweis da („letzter Langtest vor 140 Tagen“).
- In der Tests-Ansicht steht pro Platte: nächster Termin, bei einem geteilten Langtest „Abschnitt 3 von 7, 43 % gelesen“,
  sowie Knöpfe zum Pausieren und „Jetzt starten“ (auch dieser nur im Betriebsfenster, mit Rückfrage).
- Geplante Tests wecken schlafende HDDs bewusst auf; das wird vermerkt.

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
- Wann genau läuft der PVE-Host (Hochfahren/Herunterfahren) und wann der PBS? Laufen beide im gleichen Rhythmus?
  Das sind die Voreinstellungen fürs Betriebsfenster.
- Gibt es Sperrzeiten innerhalb des Fensters (z. B. Backup-Fenster auf dem PBS)?
- Wie lange dauert ein Langtest deiner Platten laut `smartctl -c` (Zeile „Extended self-test routine recommended
  polling time“)? Daraus ergibt sich, in wie viele Tage er geteilt wird.
- Wird der Server automatisch heruntergefahren (Zeitplan im BIOS/Skript) oder von Hand?
- Bisherige Skripte aus dem ChatGPT-Verlauf im Palast bleiben dort als Notiz; hier wird neu begonnen.
