# Backup- und Snapshot-Steuerung (Plan)

Stand: Entwurf, noch nicht umgesetzt. Ziel: Das Tool (läuft im LXC auf dem immer eingeschalteten `router`) übernimmt Backups und Snapshots, die heute
Skripte auf dem PBS und den PVE-Hosts erledigen. Parameter lassen sich in der Oberfläche ändern, alles wird überwacht.

## Was ich aus deinen Chats entnommen habe (und was nicht)

Quelle: `notes/chats/chatgpt/2026-01-31_backup-skript-anfrage_…` im Palast. **Die tatsächlich eingesetzten Skripte habe ich nicht gesehen.**

- **Orchestrator auf dem PBS** (`/usr/local/sbin/pbs-run-backups.sh`): Cron startet ihn etwa 20 Minuten nach dem Hochfahren. Er geht die PVE-Hosts nacheinander durch
  (`192.168.1.250` und `192.168.1.2`), startet auf jedem per SSH `vzdump` mit Ziel-Storage `pbs`, Modus `snapshot`, Kompression `zstd`, wartet auf das Ende
  und fährt den PBS danach mit `systemctl poweroff` herunter. Pro Host gibt es „alle“, „alle außer …“ oder eine feste ID-Liste.
- **Bekannte Stolpersteine** aus dem Chat: Das Warten über die Task-API von PVE 9 war unzuverlässig, deshalb wurde später auf ein Backup im Vordergrund per SSH
  umgestellt. Ein laufendes Backup wurde schon einmal von Hand abgebrochen, ohne dass der PBS ausgehen sollte. „Herunterfahren nur bei vollständigem Erfolg“
  wurde vorgeschlagen, ob es umgesetzt ist, weiß ich nicht.
- **Snapshots:** Gewünscht sind stündliche Snapshots der Webserver-LXC, behalten werden die letzten 8 Stunden, die letzten 3 Tage und „alle drei Wochen einer“.
  Offen blieb dort, wie lange die Drei-Wochen-Snapshots bleiben sollen. Der Chat weist auch darauf hin, dass lokale Snapshots nicht vor dem Ausfall des Storage schützen.
- **Sicherheit:** Im Chat steht ein root-Passwort im Klartext (der Orchestrator meldet sich per Passwort an den Hosts an). Der Chat liegt im Palast und damit auf
  GitHub. Wenn es das echte Passwort ist, bitte ändern. Die neue Lösung braucht kein Passwort, sondern wie bisher einen eingeschränkten Schlüssel.

## Zielbild

```
router-LXC (Tool)  ──SSH, eingeschränkter Schlüssel──►  PVE-Hosts:  vzdump starten, Tasks lesen, Gäste auflisten, Snapshots anlegen/löschen
                                                    └─►  PBS:       Status lesen, herunterfahren
```

Die Steuerung läuft im Tool, nicht mehr auf dem PBS. Das Tool erkennt, dass der PBS hochgefahren ist (wie heute bei den Plattentests), wartet die eingestellte
Zeit, startet die Backups host für host, prüft jedes Ergebnis und fährt den PBS nur dann herunter, wenn alles erfolgreich war.

## Sicherheitsmodell

Das Prüfskript auf den Hosts (`/etc/diskmon/gate.sh`) erlaubt heute nur Lesebefehle und Selbsttests. Backup und Snapshots brauchen mehr Rechte. Deshalb:

- **Fähigkeitsgruppen je Host**, einzeln einschaltbar und vom Host aus nachvollziehbar (Datei in `/etc/diskmon`, nur root): `platten` (wie bisher), `backup` (vzdump, Tasks, Gäste lesen),
  `snapshots` (anlegen, löschen), `herunterfahren` (nur PBS). Ein Host bekommt nur, was du dort freigibst. Die Freigabe geschieht über „Neu einrichten“ mit dem root-Passwort.
- **Nur feste Befehle mit geprüften Argumenten:** IDs nur Ziffern, Storage-Name aus einer Positivliste, Modus und Kompression fest. Keine freie Shell.
- **Löschen nur für eigene Snapshots:** Das Prüfskript löscht ausschließlich Snapshots mit dem Namensmuster `auto-JJJJMMTT-HHMM`. Von Hand angelegte Snapshots sind nie betroffen.
- **Trockenlauf:** Jede neue Funktion hat zuerst einen Trockenlauf („würde löschen / würde sichern“), bevor sie wirklich handelt.
- **Nie zwei Steuerungen gleichzeitig:** Vor dem Umschalten wird der Cron-Job auf dem PBS ausgeschaltet. Das Tool warnt, solange es auf dem PBS noch den alten Orchestrator findet.

## Stufen

1. **Beobachten:** Gästeliste je Host (VMs und LXC mit Namen), letzte Backups je Gast mit Alter und Ergebnis, Snapshots je LXC, Verlauf der Läufe. Mail, wenn ein Gast länger kein Backup hat.
2. **Snapshots:** stündlich anlegen und nach der Aufbewahrungsregel aufräumen, zuerst im Trockenlauf.
3. **Backup-Lauf:** Das Tool startet und überwacht die `vzdump`-Läufe, danach optional das Herunterfahren des PBS. Zuerst im Trockenlauf, dann parallel beobachtend, dann scharf.
4. **Feinschliff:** Statistik (Dauer, Größe, Erfolgsquote), Mails bei Fehlschlag, Regel „kein Plattentest, solange auf dem Host ein Backup läuft“.

## Einstellungen in der Oberfläche

- Auswahl der VMs und LXC je Host: alle, alle außer …, oder nur bestimmte IDs.
- Startzeit und Wartezeit nach dem Hochfahren des PBS.
- Aufbewahrung der Snapshots (stündlich, täglich, Langzeit).
- PBS nach dem Backup herunterfahren: an oder aus, nur bei vollständigem Erfolg.

## Was ich zum Umsetzen noch brauche

- Die **aktuellen Skripte** als Dateien: den Orchestrator vom PBS (`/usr/local/sbin/pbs-run-backups.sh`), die Snapshot-Skripte samt Cron-Einträgen von den Hosts und die Cron-Zeile auf dem PBS.
- Hosts und IDs: Welcher Host ist `192.168.1.250`, welcher `192.168.1.2`? Welche LXC bekommen Snapshots?
- Wie lange sollen die Drei-Wochen-Snapshots bleiben (für immer, 6 oder 12 Monate)?
- Name des Storage auf den Hosts (`pbs`?) und die Wartezeit nach dem Boot.

## Umbenennung

Die Oberfläche heißt jetzt „Fischje's PVE-Tools“. Das GitHub-Repo kann ich nicht selbst umbenennen. Vorschlag für den neuen Namen: `pve-tools` (wie der LXC). Ablauf:
1. GitHub, Repo, Settings, „Repository name“ ändern. Alte Adressen leitet GitHub weiter.
2. Im LXC: `cd /opt/pve-disk-tool && git remote set-url origin https://github.com/Fischje/pve-tools.git`.
3. Die Pfade `/opt/pve-disk-tool` und der Dienstname `pve-disk-tool` können bleiben, damit der automatische Abgleich unverändert läuft.
4. In dieser Sitzung muss das Repo danach unter dem neuen Namen neu hinzugefügt werden.
