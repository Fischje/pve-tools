# Backup- und Snapshot-Steuerung

Stand: Stufe 1 (Beobachten), Stufe 2 (Snapshots auslösen und planen) und Stufe 3 (Backup-Lauf) sind umgesetzt. Ziel: Das Tool (läuft im LXC auf dem immer eingeschalteten `router`) überwacht Backups und
Snapshots, die heute Skripte erledigen, und übernimmt später die Steuerung. Parameter lassen sich dann in der Oberfläche ändern.

## So ist es heute eingerichtet (nach deinen Skripten)

Hosts: `192.168.1.250` = **router**, `192.168.1.2` = **pve**. Backup-Ziel: Storage `pbs` auf den Hosts, Datastore `backup` (ZFS) auf dem PBS.

**Backup (Orchestrator auf dem PBS, `pbs-run-backups.sh`):**
- Läuft nach dem Hochfahren des PBS (montags). Der Reihe nach: erst `router` (alle Gäste), dann `pve` (alle außer 109, 112, 113, 114, 116, 119, 117, 159, 161, 171).
- Je Host per SSH `vzdump --all 1 [--exclude …] --storage pbs --mode snapshot --compress zstd`, danach wartet er, bis keine vzdump-Aufgabe mehr läuft.
- Danach `systemctl poweroff` auf dem PBS. Heute geschieht das **ohne Prüfung, ob alle Backups erfolgreich waren**.
- Er meldet sich per **SSH-Passwort** (sshpass, root) an den Hosts an. Dieses Passwort steht im Klartext im Skript und in einem Chat im Palast (also auf GitHub).
  Bitte ändern, sobald die Steuerung umgezogen ist. Das Tool braucht kein Passwort, sondern einen eingeschränkten Schlüssel.

**Snapshots (auf jedem Host, `proxmox-autosnap` + Wrapper `autosnap-run`):**
- Aufbewahrung: **stündlich 8, wöchentlich 1, monatlich 1** (`KEEP` im Wrapper). Montag ist Pausentag (`PAUSE_DAY=1`), weil dann das Backup läuft.
- Cron (`/etc/cron.d/proxmox-autosnap`): stündlich um :05, wöchentlich sonntags 00:25, monatlich am 1. um 00:45 (ist der 1. ein Montag, am 2.).
- Ausgewählt werden LXC mit dem Tag `autosnap`. Auf dem `pve` nur laufende Container (der Wrapper ermittelt sie selbst), auf dem `router` über `--tags autosnap`.
- Ein/Aus-Schalter: Datei `/etc/autosnap.disabled` (`autosnap-switch on|off|status`). Meldungen: `journalctl -t autosnap`.
- Die Snapshots entstehen als Proxmox-Snapshots der LXC (auf ZFS also ZFS-Snapshots auf dem jeweiligen Host).

> Korrektur: In der ersten Fassung dieses Plans stand „3 Tage und alle drei Wochen“. Das stammte aus dem Wunsch im Chat vom 28.09. Maßgeblich ist, was in den
> Skripten steht: 8 stündlich, 1 wöchentlich, 1 monatlich.

## Stufe 1: Beobachten (umgesetzt)

Reiter „Backups & Snapshots“. Das Tool liest nur, über neue, rein lesende Befehle im Prüfskript auf den Hosts (**Prüfskript Version 4**, auf den Hosts einmalig
über „Skript aktualisieren“ einspielen):
- Gäste je Host mit Status und Tags.
- Snapshots je Gast, erkannt an den Namen von proxmox-autosnap (`autohourly…`, `autoweekly…`, `automonthly…`), mit Anzahl und Alter im Vergleich zur Aufbewahrung.
- Zustand von proxmox-autosnap: Schalter, `KEEP`-Werte und Pausentag **aus deinem Wrapper gelesen**, Cron-Zeilen, letzte Meldungen.
- Backup-Läufe aus der Aufgabenliste von Proxmox samt Protokoll: je Lauf Dauer und Ergebnis, je Gast gesichert / fehlgeschlagen / unterbrochen mit Fehlertext.
- Hinweise: fehlgeschlagenes Backup, länger als 9 Tage kein Backup bei einem früher gesicherten Gast, ausgebliebene Stunden-Snapshots, ausgeschaltete Snapshots.

Die Abfrage läuft höchstens einmal pro Stunde (auf Knopfdruck sofort). Ob ein Gast ein Backup bekommen soll, weiß das Tool in dieser Stufe nicht, denn die Ausschlussliste
steht im Orchestrator. Deshalb gibt es nur dann einen Hinweis, wenn ein Gast früher gesichert wurde.

**Was die Ansicht vermutlich zeigen wird:** Die wöchentlichen und monatlichen Snapshots laufen um 00:25 und 00:45. Läuft der `pve` dann nicht, fallen sie aus. Das ist eine
Vermutung aus den Cron-Zeiten, die Ansicht klärt sie. Fehlt dort der wöchentliche oder monatliche Snapshot, steht ein Hinweis bei dem Gast.

## Stufe 2: Snapshots auslösen durch das Tool (umgesetzt)

Entscheidung: Das Tool löst die Snapshots aus, der Cron auf den Hosts entfällt. `proxmox-autosnap` bleibt die Werkzeugbasis: Das Tool startet nur den vorhandenen
`autosnap-run` mit der Bezeichnung (`hourly`, `weekly`, `monthly`). Anlegen, Auswahl der Gäste, Aufbewahrung und Löschen alter Snapshots regelt weiter dieses Skript.
Das Tool bekommt kein Löschrecht.

- **Recht „snapshots“:** Schreibende Befehle brauchen eine eigene Freigabe auf dem Host (Prüfskript Version 6, Datei `/etc/diskmon/rechte`). Sie wird mit dem root-Passwort
  im Reiter „Hosts einrichten“ erteilt (Haken „Snapshots auslösen erlauben“, auch bei „Skript aktualisieren“). Ohne Freigabe lehnt das Prüfskript sie ab.
- **Neue Befehle im Prüfskript:** `snap-run hourly|weekly|monthly [force]`, `snap-switch on|off`, `snap-cron on|off|status`, lesend `rechte`. Alle mit festen Werten,
  ein Sperrmechanismus (`flock`) verhindert zwei Läufe gleichzeitig.
- **Übernahme:** Button „Das Tool übernimmt“ im Reiter „Backups & Snapshots“. Das Tool benennt zuerst `/etc/cron.d/proxmox-autosnap` in `….tool-aus` um (cron ignoriert
  Dateien mit Punkt im Namen, nichts wird gelöscht) und stellt dann um. „Zurück zum Cron“ macht es rückgängig, in umgekehrter Reihenfolge.
- **Zeitplan wie bisher:** stündlich um :05, wöchentlich sonntags 00:25, monatlich am 1. um 00:45 (ist der 1. der Pausentag, am 2.). Pausentag und Schalter liest das Tool
  aus dem Wrapper. Montags löst es nichts aus.
- **Nachholen:** Ist der Host zur Zeit eines Wochen- oder Monatslaufs aus (der `pve` nachts), holt das Tool den Lauf nach, sobald der Host läuft (nach 10 Minuten Laufzeit,
  damit die Container oben sind). Der Monatslauf geht dann mit `force`, sonst blockt das Datumsfenster im Wrapper. Verpasste Stundenläufe werden nicht nachgeholt.
- **Fehler:** Schlägt ein Lauf fehl, steht der Fehler in der Oberfläche und im Ereignisprotokoll, ein neuer Versuch folgt nach 15 Minuten.
- **Ein/Aus-Schalter** und **„Jetzt stündlichen Lauf auslösen“** in der Oberfläche.
- **Zu bedenken:** Fällt der LXC `pve-tools` aus, entstehen keine Snapshots mehr (der Cron lief auf den Hosts selbst). Die vorhandene Prüfung „ausgebliebene Stunden-Snapshots“
  zeigt das an. Ein Alarm per Mail dafür ist ein nächster Schritt.
- **Planung ändern** (Reiter „Backups & Snapshots“, „Planung ändern“):
  - *Zeitpunkte* (stündlich Minute, wöchentlich Tag und Uhrzeit, monatlich Tag und Uhrzeit, je einzeln abschaltbar) gelten im Tool, also nur, wenn das Tool auslöst.
  - *Aufbewahrung* (1–99 stündlich, 1–52 wöchentlich, 1–36 monatlich) und *Pausentag* stehen auf dem Host in `/etc/autosnap.conf`. Das Tool schreibt die Datei über den
    Befehl `snap-conf`, nur Zahlen in festen Grenzen.
  - *Probelauf*: `snap-dryrun` zeigt, welche Container betroffen wären, ohne etwas anzulegen oder zu löschen.
- **Verwalteter Wrapper (v2):** `host-setup/autosnap-run` ersetzt eure beiden Wrapper (router: alle mit Tag, pve: nur laufende mit Tag). Er arbeitet wie bisher
  (Hauptschalter, Pausentag, Datumsfenster beim Monatslauf, `FORCE`, `DRYRUN`), liest aber die Werte aus `/etc/autosnap.conf`. Beim Einrichten mit dem Haken
  „Snapshots auslösen erlauben“ wird er installiert. Der alte Wrapper bleibt als `/usr/local/sbin/autosnap-run.vorher-<Zeit>` erhalten, seine Werte (Aufbewahrung,
  Pausentag, Tag, nur laufende) werden einmalig in `/etc/autosnap.conf` übernommen. Zurück geht es, indem ihr die Sicherung wieder nach `autosnap-run` kopiert.
- **Offen:** Die Auswahl der Gäste (Tag `autosnap`) lässt sich noch nicht in der Oberfläche setzen. Das bräuchte ein weiteres Schreibrecht.

## Stufe 3: Backup-Lauf durch das Tool (umgesetzt)

Das Tool ersetzt den Orchestrator auf dem PBS (`pbs-run-backups.sh`). Es läuft auf dem immer eingeschalteten `router`.

**Was am alten Skript auffiel** (und im Tool anders ist):
- `ssh … "vzdump … &"` blockiert, bis vzdump fertig ist. Das „Warten“ danach prüft mit `pvesh … --type … --status …`, das auf PVE 9 ungültig ist, und meldet deshalb immer sofort „fertig“.
  Bricht die SSH-Verbindung ab, weiß das Skript nichts mehr vom Backup.
- `systemctl poweroff` kommt immer, auch bei fehlgeschlagenen Backups.
- Im Tool: vzdump läuft als eigener systemd-Dienst auf dem Host (überlebt einen SSH-Abbruch), das Tool wartet über die **Aufgabenliste des Hosts** (UPID, Status, Protokoll je Gast)
  und fährt den PBS **nur bei vollständigem Erfolg** herunter.

**Ablauf**
1. Der PBS (Host-Art „manuell“, wird von Hand oder automatisch eingeschaltet) fährt hoch. Das Tool erkennt den neuen Boot über die Laufzeit.
   Gesichert wird nur, wenn der PBS an einem **Backup-Tag** hochgefahren ist (Voreinstellung: Montag, einstellbar). An anderen Tagen
   sichert das Tool nicht und fährt den PBS auch nicht herunter: Er bleibt an, bis ihr ihn ausschaltet. „Jetzt Backup starten …“ geht an jedem Tag:
   Ein Dialog fragt, welche Hosts und Gäste gesichert werden sollen (vorausgewählt ist die normale Auswahl). Nach einem Lauf von Hand wird der PBS
   **nie** heruntergefahren, auch an einem Backup-Tag nicht, und der geplante Lauf dieses Tages findet trotzdem statt.
   Automatisch heruntergefahren wird nur nach dem geplanten Lauf an einem Backup-Tag, und nur bei vollständigem Erfolg.

**Ein- und Ausschalten von Hand** (Reiter „Backups & Snapshots“, „Überblick“ und „Backup-Lauf“):
- „PBS einschalten“ schickt ein Magic Packet (Wake-on-LAN) aus dem LXC auf dem `router` an die MAC-Adresse des PBS. Die Adresse lernt das Tool, sobald der
  PBS läuft (Prüfskript ab Version 9, Befehl `netinfo`, sonst aus der ARP-Tabelle), oder ihr tragt sie ein. Voraussetzung: Wake-on-LAN im BIOS des PBS an und an
  der Karte aktiv (`ethtool <karte>` zeigt `Wake-on: g`; einschalten mit `ethtool -s <karte> wol g`). Das Tool zeigt den Zustand an.
- „PBS herunterfahren“ fährt ihn sauber über das Prüfskript herunter (Recht `herunterfahren`), nicht während eines Backup-Laufs.
2. Nach der **Wartezeit** (Voreinstellung 20 Minuten wie bisher) beginnt der Lauf. Pro Boot gibt es genau einen Lauf.
3. Host für Host, in der festen Reihenfolge (Voreinstellung wie im alten Skript: `router`, dann `pve`): Ist der Host nicht erreichbar oder der Speicher `pbs` dort nicht aktiv, wartet das Tool
   (höchstens „Wartezeit auf einen Host“, Voreinstellung 30 Minuten) und überspringt den Host dann mit Fehler. Läuft auf dem Host schon ein vzdump (etwa vom alten Skript), wird er **übernommen**
   und nicht doppelt gestartet. Sonst startet das Tool `vzdump --all 1 [--exclude …] --storage pbs --mode snapshot --compress zstd`.
4. Das Tool prüft jede Minute die Aufgabenliste. Erfolgreich ist ein Host, wenn der Task `OK` (oder `WARNINGS`) meldet **und** kein Gast fehlgeschlagen ist.
5. Am Ende: Alles erfolgreich → Mail „Lauf abgeschlossen“ und der PBS wird heruntergefahren (einstellbar). Sonst bleibt der PBS an, und eine Mail nennt Host, fehlgeschlagene Gäste und, wenn erkennbar,
   die Ursache („Verbindung zum PBS fehlte oder brach ab“).
6. Während auf einem Host ein vom Tool gesteuertes Backup läuft, startet das Tool dort keine Platten-Tests.

**Einstellungen** (Reiter „Backups & Snapshots“, „Backup-Lauf“): Betriebsart „beobachten“ oder „steuern“, Backup-Tage, PBS-Host, Speichername, Wartezeiten, Herunterfahren an/aus, je Host die Auswahl der Gäste.
Gespeichert wird eine **Ausschlussliste** (wie `--all --exclude`), deshalb werden neue Gäste automatisch mitgesichert. Voreinstellung für `pve`: Ausschluss von 109, 112, 113, 114, 116, 119, 117, 159, 161, 171
(aus dem alten Skript übernommen).

**Neue Rechte** (nur mit dem root-Passwort freigebbar, Prüfskript Version 8): `backup-starten` auf den PVE-Hosts (Befehl `backup-start <speicher> all|exclude <ids>|only <ids>`, feste Parameter, nur Ziffern in den Listen,
fester Dienstname, damit nie zwei Läufe gleichzeitig starten) und `herunterfahren` auf dem PBS (Befehl `poweroff`, 20 Sekunden Verzögerung). Lesend ohne Recht: `storage-status <name>`.

**Umstellen (empfohlene Reihenfolge)**
1. „Skript aktualisieren“ bei `router`, `pve` und `pbs`: Haken „Backups starten erlauben“ bei den PVE-Hosts, „Herunterfahren erlauben“ beim PBS.
2. In „Backup-Lauf“ den PBS-Host prüfen, die Gäste-Auswahl ansehen, „Speichern und Trockenlauf“. Der Trockenlauf startet nichts und meldet Probleme (Recht fehlt, Host/Speicher nicht erreichbar).
3. Mit der Betriebsart „beobachten“ lassen, bis ein Lauf des alten Orchestrators durch ist: Das Tool zeigt ihn wie bisher in „Backup-Läufe“.
4. **Den alten Orchestrator auf dem PBS abschalten** (Cron `@reboot`, z. B. mit `crontab -e` auskommentieren). Er soll nicht neben dem Tool laufen.
5. Betriebsart auf „Das Tool steuert“. Beim Umschalten gilt der gerade laufende Boot des PBS als erledigt, es startet also nicht sofort ein Lauf. Der nächste Boot löst den ersten Lauf aus.
   Zum Testen gibt es „Jetzt Backup starten“ (PBS muss laufen).
6. Danach das root-Passwort aus `pbs-run-backups.sh` auf den Hosts ändern und das Skript löschen.

**Grenzen**
- Das Tool schaltet den PBS nicht ein (Wake-on-LAN, Zeitschaltuhr oder BIOS bleiben Sache der Umgebung). Das ließe sich später ergänzen.
- „Abbrechen“ im Tool beendet nur die Steuerung. Ein schon laufendes vzdump läuft auf dem Host weiter.
- Fällt der LXC `pve-tools` aus, gibt es weder Backup-Läufe noch Snapshots. Die Mail-Überwachung der Läufe zeigt nur, was das Tool selbst gesehen hat.

## Sicherheitsmodell

- Fähigkeitsgruppen je Host, einzeln einschaltbar über „Neu einrichten“ (mit dem root-Passwort): `platten` und `beobachten` (lesend, jetzt schon), `snapshots`, `backup-starten` und `herunterfahren` (Rechtegruppen, einzeln freigebbar).
- Nur feste Befehle, IDs nur Ziffern, Namen aus Positivlisten, keine freie Shell.
- Das Tool löscht nie selbst Snapshots. Das erledigt weiter proxmox-autosnap mit eigenen Regeln.

## Umbenennung (erledigt)

- GitHub-Repo: `Fischje/pve-tools` (alte Adressen leitet GitHub weiter).
- Im LXC: Programmordner `/opt/pve-tools`, Dienst `pve-tools`, Abgleich `pve-tools-sync`, Datenbank `data/pvetools.sqlite`.
  Der Umzug einer bestehenden Installation geht in einem Schritt mit `umzug-pve-tools.sh`, siehe [INSTALLATION.md](INSTALLATION.md), Abschnitt „Umzug vom alten Namen“.
- Auf den Proxmox-Hosts bleiben Benutzer `diskmon` und Ordner `/etc/diskmon`. Eine Umbenennung dort hieße, jeden Host neu einzurichten, und brächte keinen Nutzen.
