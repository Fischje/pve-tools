# Backup- und Snapshot-Steuerung

Stand: Stufe 1 (Beobachten) ist umgesetzt, Stufen 2 und 3 sind Plan. Ziel: Das Tool (läuft im LXC auf dem immer eingeschalteten `router`) überwacht Backups und
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

## Stufe 2: Snapshots verwalten (Plan)

Die Snapshots sollen **weiter auf den Hosts per Cron laufen**, damit sie auch dann entstehen, wenn der LXC aus ist. Das Tool verwaltet nur die Einstellungen und überwacht:
- `autosnap-run` liest `KEEP`, Pausentag und Tag aus einer kleinen Datei `/etc/autosnap.conf` statt aus dem Skript. Das Tool schreibt diese Datei über einen geprüften Befehl
  (nur Zahlen in festen Grenzen, nur der Tag-Name aus einer Positivliste).
- Ein/Aus-Schalter in der Oberfläche (setzt oder löscht `/etc/autosnap.disabled`).
- Trockenlauf-Anzeige: was `autosnap-run` jetzt tun würde.

## Stufe 3: Backup-Lauf durch das Tool (Plan)

Das Tool ersetzt den Orchestrator auf dem PBS und läuft auf dem immer eingeschalteten `router`:
- Es erkennt, dass der PBS hochgefahren ist (wie bei den Plattentests), wartet die eingestellte Zeit und startet die Backups host für host.
- Jeder Lauf wird über Aufgabenliste und Protokoll geprüft (wie in Stufe 1).
- **Der PBS wird nur heruntergefahren, wenn alle Backups erfolgreich waren** (einstellbar an/aus).
- Einstellungen in der Oberfläche: Auswahl der Gäste je Host (alle / alle außer / nur diese), Wartezeit nach dem Hochfahren, Herunterfahren an/aus.
- Neue, einzeln freigebbare Rechte im Prüfskript: `vzdump` starten, auf dem PBS `poweroff`. Nur feste Befehle mit geprüften Argumenten, keine freie Shell.
- Vor dem Umschalten wird der Cron-Eintrag des alten Orchestrators auf dem PBS ausgeschaltet, damit nie zwei Steuerungen gleichzeitig laufen.
- Zuerst ein Trockenlauf („würde sichern: …“), dann parallel beobachtend, dann scharf.

## Sicherheitsmodell

- Fähigkeitsgruppen je Host, einzeln einschaltbar über „Neu einrichten“ (mit dem root-Passwort): `platten` und `beobachten` (lesend, jetzt schon), später `snapshots-verwalten`, `backup-starten`, `herunterfahren`.
- Nur feste Befehle, IDs nur Ziffern, Namen aus Positivlisten, keine freie Shell.
- Das Tool löscht nie selbst Snapshots. Das erledigt weiter proxmox-autosnap mit eigenen Regeln.

## Umbenennung

Die Oberfläche heißt „Fischje's PVE-Tools“. Das GitHub-Repo kann ich nicht selbst umbenennen. Vorschlag: `pve-tools` (wie der LXC).
1. GitHub, Repo, Settings, „Repository name“ ändern. Alte Adressen leitet GitHub weiter.
2. Im LXC: `cd /opt/pve-disk-tool && git remote set-url origin https://github.com/Fischje/pve-tools.git`.
3. Pfade (`/opt/pve-disk-tool`) und Dienstname (`pve-disk-tool`) können bleiben, damit der automatische Abgleich unverändert läuft.
4. In dieser Sitzung muss das Repo danach unter dem neuen Namen neu hinzugefügt werden.
