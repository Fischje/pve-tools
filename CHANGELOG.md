# Changelog

Neueste Version oben. Die Oberfläche liest die Versionsnummer und die letzten Einträge aus dieser Datei.
Bei jeder Auslieferung die dritte Stelle hochzählen und hier einen Eintrag ergänzen (siehe `CLAUDE.md`).

## 0.6.13 – 2026-11-23
- Backup-Tag: Fährt der PBS nach dem geplanten Lauf am selben Tag erneut hoch, sichert das Tool nicht noch einmal und fährt ihn auch nicht wieder herunter. Er bleibt an, bis du ihn ausschaltest. Bisher hätte jedes erneute Einschalten einen weiteren Lauf mit Herunterfahren ausgelöst.

## 0.6.12 – 2026-11-23
- Am Snapshot-Pausentag (z. B. Backup-Montag) zeigten „Läuft gerade“ und der Reiter „Snapshots“ trotzdem einen nächsten stündlichen Snapshot für heute an. Es wurde aber keiner gemacht, nur die Anzeige war falsch. Jetzt steht dort der richtige Zeitpunkt am Folgetag.

## 0.6.11 – 2026-11-23
- Übersicht: neuer Bereich „Läuft gerade“ ganz oben. Er zeigt laufende Backup-Läufe, Backups auf den Hosts, Snapshot-Läufe und Plattentests, mit Fortschritt. Ein Klick öffnet die Einzelheiten. Läuft nichts, steht dort, was als Nächstes geplant ist.
- Die Meldung oben („… brauchen Aufmerksamkeit“) ist anklickbar. Bei einer betroffenen Platte springt sie direkt hin, bei mehreren öffnet sie eine Liste mit Grund, z. B. „Nicht korrigierbare Lesefehler“.
- Zustände wie „Beobachten“ oder „Bald tauschen“ in Tabellen und Karten sind anklickbar und springen zur Platte bzw. zum Pool mit dem Befund. „Gesamtzustand“ auf der Host-Seite springt zum schlimmsten Befund.
- Das Seitenmenü auf „Hosts im Detail“ bleibt beim Scrollen sichtbar.

## 0.6.10 – 2026-11-23
- Hintergrund dunkler, Laser-Gitter etwas zurückhaltender.
- Tabellen unter „Energie“: Überschriften der Zahlenspalten stehen jetzt rechtsbündig über den Zahlen, mehr Abstand zur Spalte danach.

## 0.6.9 – 2026-11-21
- Neuer Look im Stil der 80er (Synth-Pop): Neonfarben Gelb, Grün und Blau auf dunklem Grund, im Hintergrund ein schwaches Laser-Gitter, das langsam wandert.
- Schriften Afacad Flux (Überschriften, Kennzahlen) und Miranda Sans (Text); sie werden vom Tool selbst geladen, nicht aus dem Internet.
- Wer in den Systemeinstellungen „Bewegung reduzieren“ eingeschaltet hat, sieht das Gitter still.
- Einige Abstände und Feldbreiten wurden vom Browser bisher ignoriert und stimmen jetzt.

## 0.6.8 – 2026-11-21
- Stromverbrauch mit Tasmota-Steckdosen: jede Minute gelesen, Verbrauch jetzt, heute, Ø 7 Tage, Hochrechnung aufs Jahr in kWh und Euro.
- Verlauf der letzten 24 Stunden je Steckdose und Verbrauch je Tag der letzten 30 Tage.
- „Was hat eine Änderung gebracht?“: mittlere Leistung 24 Stunden vor und nach jeder Energie-Änderung (z. B. ASPM eingeschaltet).
- Steckdosen im Reiter „Energie“ einrichten, mit Knopf „Testen“; ein Web-Passwort von Tasmota wird gespeichert, aber nie angezeigt.

## 0.6.7 – 2026-11-21
- Neuer Reiter „Energie“: je Host Mainboard, BIOS, CPU-Regelung, wie viel Zeit die CPU in sparsamen Zuständen (C-States) verbringt, ASPM je PCIe-Gerät und SATA-Stromsparen, dazu Hinweise und eine BIOS-Checkliste.
- ASPM einschalten nach dem Vorbild von AutoASPM (pvetools-aspm): für alle geeigneten Geräte, mit Ausnahmeliste, Ausschalten je Gerät und auf Wunsch bei jedem Start.
- Dafür Prüfskript Version 13 und das neue Recht „Energie-Einstellungen erlauben“ (Hosts einrichten, Skript aktualisieren).

## 0.6.6 – 2026-11-16
- Jedes Backup bekommt den Namen des Gastes als Notiz. Im PBS steht er in der Spalte „Comment“, so weiß man später, was hinter einer ID steckte.
- Dafür ist das Prüfskript Version 12 nötig: auf router und pve „Skript aktualisieren“.

## 0.6.5 – 2026-11-16
- „PBS herunterfahren“ wird abgelehnt, solange auf einem Host ein Backup läuft, auch eines, das das Tool nicht selbst gestartet hat.
- Kann das Tool das bei einem Host nicht prüfen (älteres Prüfskript), fragt es vor dem Herunterfahren noch einmal nach.

## 0.6.4 – 2026-11-16
- Backup-Lauf: Das Tool sieht jetzt auch das gerade laufende Backup auf einem Host. Bisher erschien es erst nach dem Ende, und das Tool meldete nach 10 Minuten „keine Backup-Aufgabe“.
- Dafür ist das Prüfskript Version 11 nötig: auf router und pve „Skript aktualisieren“. Der Trockenlauf warnt, solange ein Host noch eine ältere Version hat.

## 0.6.3 – 2026-11-16
- Versionsnummer oben auf der Seite; ein Klick darauf zeigt die letzten Änderungen.

## 0.6.2 – 2026-11-16
- Backup-Lauf: Gast-Listen mit Komma (z. B. die Ausschlussliste von pve) werden vom Prüfskript angenommen (Prüfskript Version 10).
- Klarer Hinweis, wenn ein Host für die Auswahl von Gästen ein neueres Prüfskript braucht. Der Trockenlauf meldet das schon vorher.

## 0.6.1 – 2026-11-05
- Hosts der Art „manuell“: Das Tagesende gilt nur für Tests. Die Hinweise sagen nicht mehr, der Host schalte sich selbst ab.

## 0.6.0 – 2026-11-05
- Das Tool steuert die Backup-Läufe immer (keine Betriebsart „beobachten“ mehr).
- Backup-Tage einstellbar (Voreinstellung Montag). Nur nach dem geplanten Lauf an einem Backup-Tag wird der PBS heruntergefahren.
- „Jetzt Backup starten …“ mit Auswahl der Hosts und Gäste; danach bleibt der PBS an.
- PBS ein- und ausschalten: Wake-on-LAN (auch automatisch an Backup-Tagen) und sauberes Herunterfahren per Knopf.

## 0.5.1 – 2026-11-05
- Kennzahl-Kästen sind anklickbar und führen zur passenden Detailansicht.
- Neue Namen im LXC (/opt/pve-tools, Dienst pve-tools) mit einmaligem Umzugsskript.
- Startseite ohne die Balken „Tage seit dem letzten Test“.

## 0.5.0 – 2026-11-04
- Oberfläche neu aufgeteilt: Unterreiter statt langer Seiten, große Klappbereiche, die offen bleiben.
- Keine automatische Aktualisierung, während in einem Formular etwas geändert wird.
- Füllstand der ZFS-Pools je Host auf der Startseite.

## 0.4.0 – 2026-11-02
- Snapshots löst das Tool selbst aus (statt Cron auf dem Host), mit Planung, Aufbewahrung und Probelauf.
- Backup-Lauf durch das Tool: Host für Host, Warten über die Aufgabenliste, Herunterfahren des PBS nur bei Erfolg.
- Erkennung von Verbindungsfehlern (steigender CRC-Zähler, Kernel-Meldungen zu SATA/NVMe) mit Mail.

## 0.3.0 – 2026-11-02
- Backups und Snapshots: Gäste, Snapshot-Stand, Backup-Läufe mit Ergebnis je Gast und Ursache bei Fehlern.

## 0.2.0 – 2026-11-02
- E-Mail-Benachrichtigung, Statistiken, Abfragerhythmus einstellbar.
- Automatischer Abgleich mit GitHub alle 5 Minuten, mit Tests und Rückfall bei Fehlern.

## 0.1.0 – 2026-11-01
- Erste Version: Zustand der Platten (HDD, SATA-SSD, NVMe) und ZFS-Pools, Selbsttests nach Zeitplan, Einrichtung der Hosts in der Oberfläche.
