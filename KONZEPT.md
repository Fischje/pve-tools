# pve-disk-tool – Konzept

Eine kleine, nur im LAN erreichbare Website, die den Zustand der Festplatten (HDD, SATA-SSD,
NVMe) von Proxmox VE und Proxmox Backup Server so zeigt, dass es auch Laien verstehen.

Stand: Erste lauffähige Version gebaut (siehe README.md). Dieses Dokument bleibt die Begründung der Regeln.

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
  `smartctl -t short|long`, `smartctl -t select,<von>-<bis>` (nur Zahlen, innerhalb der Plattengröße) und `smartctl -X`. Das Gerät muss in der aktuellen
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
| Host-Art | PVE: „fest“, PBS: „manueller Start“ | „Fest“ = Start und Ende nach festem Rhythmus. „Manueller Start“ = beliebiger Start, aber festes Tagesende |
| Betriebsfenster | PVE: 08:00 – 22:00, PBS: Start offen, Ende 19:00 | Wann der Server läuft. Bei „manueller Start“ gibt es nur das feste Tagesende (hier schaltet sich der PBS selbst aus) |
| Sperrzeit täglich | 19:00 – 01:00 (alle Hosts) | **Absolut tabu.** Dann läuft kein Test, auch nicht „Jetzt starten“. Darf über Mitternacht gehen, mehrere Sperrzeiten möglich |
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

#### PBS: Start von Hand, festes Ende um 19:00

Der PBS wird montags um 07:50 vom Host hochgefahren. Nach einer Viertelstunde starten die Backup-Skripte auf den
Hosts. An allen anderen Tagen startest du ihn von Hand zum Testen. Er schaltet sich **jeden Tag um 19:00 selbst aus**.
Für Hosts der Art „manueller Start“ gilt:

- **Montag ist gesperrt** (Standard): Backup-Tag, der PBS wird automatisch hochgefahren und es wird nie getestet.
  Das Tool muss vom Backup nichts wissen, die Wochentagssperre genügt.
- **Ende ist bekannt:** Das Tagesende (19:00) ist eingestellt, also läuft der Test bis zum Sicherheitsabstand davor
  (18:30). Eine feste Sitzungsdauer ist nicht nötig. Wer den PBS um 14:00 startet, hat bis 18:30 Zeit, nach 08:00 bis 18:30.
- **Start erst nach Freigabe:** Nach dem Hochfahren und der Anlaufzeit zeigt das Tool ein Banner: „PBS erreichbar –
  Test startet in 20 Minuten“ mit **„Jetzt“**, **„Heute nicht“** und **„Später“**. So startet kein Test, wenn der PBS nur
  für eine Wiederherstellung läuft. Das Banner ist einstellbar (Test startet automatisch / nur nach Klick).
- Die Oberfläche zeigt: **„Test läuft – bitte den PBS nicht vorher abschalten.“** Wird er trotzdem früher
  heruntergefahren, gilt der laufende Abschnitt als unterbrochen (kein Fehler) und wird wiederholt.
- Ein geteilter Langtest läuft über mehrere Tage, wie auf dem PVE. Der Rest des Tages vor 18:30 wird genutzt, je nachdem,
  wann du den PBS gestartet hast.
- Dass der PBS um 19:00 ausgeht, passt zur Sperrzeit 19:00–01:00; beides fällt zusammen.

#### Beispielrechnung (deine 12-TB-Exos, auf dem PVE)

Die Platte nennt 1079 Minuten (≈ 18 Stunden) für einen Langtest. Der Server läuft 08:00–22:00, getestet werden
darf aber wegen der Sperrzeit nur bis 19:00. Nach 20 Minuten Anlaufzeit und 30 Minuten Sicherheitsabstand bleiben
etwa **10 Stunden Testzeit pro Tag** (08:20 – 18:30).

- Pro Platte: 18 h ÷ 10 h ⇒ **2 Tage**, aber knapp: 20 Stunden Fenster für 18 Stunden Test. Läuft nebenher Last, wird
  es der dritte Tag.
- Sechs HDDs nacheinander: 6 × 18 h = 108 h ⇒ **etwa 11 Testtage**. Mit gesperrtem Montag sind das gut **2 Kalenderwochen**.
  Bei einem Langtest alle 3 Monate ist das tragbar, auch wenn er etwas lästig ist: Die Platten sind in dieser Zeit
  etwas langsamer.
- Die Abschnitte werden bewusst etwas kürzer geplant (ca. 10 % Reserve), denn **ein vom Fensterende abgebrochener Abschnitt
  zählt nicht** und wird wiederholt. Um 19:00 wird spätestens per `smartctl -X` hart beendet.
- Die 1079 Minuten gelten für eine ruhende Platte. Das Tool misst die tatsächliche Geschwindigkeit pro Abschnitt
  und plant mit dem gemessenen Wert weiter.
- **Der Kurztest** (wenige Minuten je Platte) ist kein Problem und passt in jede Lücke.

#### Beispielrechnung PBS (6-TB-HDD `/dev/sda`)

Die Platte nennt 637 Minuten (≈ 10,6 Stunden) für einen Langtest. Wird der PBS um 08:00 gestartet, bleiben nach der
Anlaufzeit bis 18:30 gut 10 Stunden. Das reicht knapp nicht für eine Platte am Stück. Wird er später gestartet,
noch weniger. Der aufgeteilte Test löst das: Ein Rest von 1–2 Stunden folgt in der nächsten Sitzung.

- Sechs HDDs nacheinander: etwa 6 × 10,6 h ≈ 64 Stunden ⇒ **6 bis 8 Sitzungen**, je nach Startzeit. Die Zahl hängt von den
  anderen Modellen ab (jedes Modell nennt seine eigene Dauer).
- Da der PBS nur an Tagen läuft, an denen du ihn startest, kann ein Langtest mehrere Wochen dauern. Das ist okay, weil
  das Tool den Fortschritt merkt. Der Hinweis „letzter Langtest vor …“ wird entsprechend großzügig eingestellt (Standard 4 Monate).

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

## Deine Hosts und Platten

Stand laut Screenshots der Proxmox-Oberfläche (Karte „Disks“ je Knoten):

| Host | Läuft | Platten | Rolle für das Tool |
|------|-------|---------|--------------------|
| **router** (PVE) | immer an | 2 × WD Red SN700 500 GB (NVMe), 1 × WDC WDS500G2B0A 500 GB (SATA-SSD) | **Hier läuft der LXC mit dem Tool.** Wird wie die anderen per SSH abgefragt, auch der eigene Host |
| **pve** (PVE) | 08:00 – 22:00 | 6 × 12 TB Exos (4 × ST12000NM003G, 2 × ST12000NM0248), 3 × Lexar NM790 4 TB, 2 × Samsung 980 1 TB (Systemplatten) | Der große Test: die sechs 12-TB-HDDs |
| **pbs** | Start von Hand (montags automatisch 07:50), aus um 19:00 | 6 × 6 TB HDD (Toshiba MG06ACA600E, WD WD60EZAZ, 2 × Toshiba HDWN160, WD WD64PURZ, Seagate ST6000NM019B), 1 × ESO 512 GB NVMe (System) | HDD-Tests in Sitzungen, siehe oben |

Folgen für das Konzept:

- **Der LXC läuft auf dem immer eingeschalteten `router`.** Damit ist das Tool selbst immer da. Der Zeitplan
  und die Historie gehen nicht verloren, wenn `pve` nachts ausgeht. Der LXC sollte vom normalen Proxmox-Backup
  gesichert werden, weil in ihm die Datenbank liegt.
- **Für `router`** gibt es keine Anlaufzeit und kein Herunterfahren. Hier gilt nur die Sperrzeit (19:00–01:00)
  und der gesperrte Montag. Das Testfenster ist 01:00–19:00 (abzüglich Sicherheitsabstand), also groß genug für alles.
  Die kleinen SSDs sind in Minuten bis wenigen Stunden fertig.
- **Auf `pve` und `pbs` gleichzeitig** darf getestet werden (verschiedene Hosts), pro Host aber immer nur eine Platte.
  Das ist wichtig, weil die Platten eines ZFS-Pools zusammengehören: Würden mehrere Platten desselben Pools
  gleichzeitig getestet, wäre der Pool langsamer und nicht mehr redundant belastbar.
- **Automatischer Start auf dem PBS** ist gewünscht und wird zum Standard (mit Banner und „Heute nicht“).
- **Anzeige „Wearout“ in Proxmox:** Die Zahl bedeutet durchgehend **verbraucht**, auch bei SATA-SSDs (Proxmox rechnet
  dort 100 minus normalisierten Wert). Die SATA-SSD im `router` (WD, `/dev/sda`) zeigt `Media_Wearout_Indicator = 14`,
  also **86 % verbraucht, 14 % Rest**. Das ist **kein** Rest von 86 %. Siehe „Befund SATA-SSD im router“ unten.
- **Auffälliges auf dem PBS:** Die WD60EZAZ ist nach meinem Wissen eine SMR-Platte (Shingled Magnetic Recording).
  SMR und ZFS vertragen sich schlecht, besonders bei Resilver und beim Schreiben vieler kleiner Blöcke. Das könnte
  zum hohen IO-Delay beitragen, den du im August auf dem PBS hattest. Das Tool kann künftig ein „Bekannte SMR-Modelle“-Hinweis
  zeigen, das ist aber ein späterer Zusatz und keine Bewertung der Gesundheit.

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

### Befund SATA-SSD im `router` (Beispiel für die Bewertung)

Aus `smartctl -a /dev/sda` (WD Blue, 500 GB, 44603 Betriebsstunden ≈ 5,1 Jahre):

| Wert | Messung | Einordnung |
|------|---------|------------|
| Media_Wearout_Indicator (230) | 14 (normalisiert, schlechtester Wert auch 14) | Verbrauch 86 %. **Bald tauschen** |
| Reallocated, Grown_Bad_Blocks, Program-/Erase-Fail, Reported_Uncorrect | alle 0 | keine Defekte |
| Available_Reserved_Space (232) | 100 (Schwelle 4) | Reserve unangetastet |
| Fehlerprotokoll | „No Errors Logged“ | sauber |
| Unexpected_Power_Loss (174) | 99 bei 198 Einschaltvorgängen | viele unsaubere Abschaltungen (Stromausfall/Hard-Reset?). Hinweis |
| Temperatur | 43 °C, Maximum je 58 °C | unauffällig |
| Letzte Selbsttests | Kurztest bei 33759 h, Langtest bei 32646 h | ca. 10800 Stunden (≈ 15 Monate) her. Hinweis „lange kein Test“ |
| Host-Schreibmenge (241) | 44780 GiB ≈ 48 TB | |
| NAND-Schreibmenge (233 + 234) | 63912 + 84790 GB ≈ 149 TB | Schreibverstärkung ca. Faktor 3 |

Einordnung: **Die Platte selbst sagt, dass sie zu 86 % verbraucht ist, aber sie ist noch fehlerfrei.** Die Herstellerangabe
und die geschriebene Datenmenge passen nicht ganz zusammen: Bei 48 TB Host-Schreibmenge wäre ich bei einer 500-GB-Consumer-SSD
eher bei einem Viertel der üblichen Schreibleistung (laut Datenblatt meist um 200 TBW, bitte prüfen), die Kennzahl der Platte
rechnet aber mit den echten NAND-Zyklen inklusive SLC-Cache. **Maßgeblich ist der Wert der Platte.** Empfehlung im Tool:
„Ersatz einplanen, in den nächsten Wochen bis Monaten, kein Notfall“. Dazu der Hinweis: Diese SSD ist Teil des Systems
(Partitionen BIOS boot, EFI, ZFS) und vermutlich im ZFS-Spiegel mit den beiden NVMe. Ob der Spiegel gesund ist, sagt
`zpool status`. Das Tool zeigt das neben der Platte an.

Folgen für die Umsetzung:
- Bei WD/SanDisk-SSDs enthält die Rohspalte von Attribut 230 ein gepacktes Feld (`0x0e1a0c280e1a`). Das Tool bewertet hier den
  **normalisierten Wert**, nicht den Rohwert.
- Herstellerspezifische Attributnamen kommen aus der `smartctl`-Laufwerksdatenbank, die Bewertung nutzt eine Liste
  bekannter Verschleiß-Attribute je Hersteller.
- SATA-SSDs unterstützen oft keine selektiven Selbsttests („Selective Self-tests/Logging not supported“), brauchen sie aber auch nicht,
  denn ein Langtest einer 500-GB-SSD dauert Minuten bis wenige Stunden.
- Diese SSD ist ein Testfall für die Bewertung (siehe „Geplante Repo-Struktur“).

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
- `testplan(host_id, art, intervall_monate, gesperrte_wochentage, fenster_von, fenster_bis, anlaufzeit, abstand)`
- `testlauf(disk_id, art, start, ende, ergebnis, lba_von, lba_bis)`. Hält bei geteilten Langtests den Fortschritt fest

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

Die Bewertungsregeln werden mit Testdateien abgesichert, darunter die WD-SATA-SSD aus dem `router` (86 % verbraucht, sonst sauber) und deine Seagate mit 16
umgelagerten Sektoren und 11266 CRC-Fehlern als Testfall („Bald tauschen“ plus Kabelhinweis).

## Vorgehen

1. Konzept abstimmen (dieses Dokument).
2. Sammler und Bewertung mit Beispieldaten, Tests.
3. Weboberfläche.
4. Host-Setup-Skript und LXC-Anleitung, Test auf PVE und PBS.
5. Verlauf/Diagramme, danach optional Benachrichtigungen.

## Offene Fragen

- Hängen Platten hinter einem HBA oder RAID-Controller? (Dann kann `smartctl -d …` nötig sein. Die Screenshots
  zeigen echte Modellnamen, was für direkte Anbindung spricht.)
- Reicht ein stündlicher Abfrageintervall?
- Soll die Seite ein Passwort haben oder LAN-only genügen?
- Selektive Selbsttests: **Auf `pve` und `pbs` bestätigt** (`smartctl 7.5`). `pve`, Exos 12 TB: Kurztest 1 min, Langtest
  1079 min. `pbs` (Rechnername `backup`), `/dev/sda`: Kurztest 2 min, Langtest 637 min. Die zweite Exos-Variante und die
  übrigen PBS-Platten prüft das Tool beim ersten Lauf selbst.
- Bisherige Skripte aus dem ChatGPT-Verlauf im Palast bleiben dort als Notiz; hier wird neu begonnen.
