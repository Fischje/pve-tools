# pve-disk-tool

Eine kleine Website nur für das lokale Netz, die den Zustand der Festplatten (HDD, SATA-SSD, NVMe) von Proxmox VE und
Proxmox Backup Server so zeigt, dass es auch Laien verstehen. Das Tool läuft in einem eigenen LXC. Auf den Proxmox-Hosts
bleibt der Kern unberührt: dort liegen nur ein eingeschränkter SSH-Zugang und ein kleines Prüfskript.

- **Verständliche Bewertung:** Gesund, Beobachten, Bald tauschen, Kritisch. Dazu ein Satz, was es bedeutet, und was zu tun ist.
- **Mehrere Hosts, eine Oberfläche:** PVE und PBS, mit ZFS-Poolstatus.
- **Selbsttests mit Zeitplan:** Kurztest und Langtest einstellbar (Intervall, gesperrte Wochentage, Sperrzeiten). Immer eine
  Platte nach der anderen. Langtests, die nicht in ein Betriebsfenster passen, werden über mehrere Tage aufgeteilt.
  Berücksichtigt Server, die nachts ausgehen, und Hosts, die von Hand gestartet werden.
- **Statistiken:** Tests pro Monat, wann Tests laufen, Ergebnisse, Abdeckung (Tage seit dem letzten Test), Testverlauf der letzten 14 Tage, Temperaturverlauf; gesamt und je Host.
- **Host-Seite:** gruppiertes Menü mit Hosts, Pools und Platten. Je Host: Zustand der Platten, ZFS-Pools mit vdev-Baum (Fehlerzähler, Zuordnung der Geräte zu Platten, Scrub, Füllstand), laufende und alle Tests des Hosts.
- **Verlauf:** Messwerte in SQLite, damit sichtbar wird, ob ein Fehlerwert noch steigt.
- **Hosts aus der Oberfläche einrichten:** Assistent, der den eingeschränkten Zugang auf dem Host anlegt (einmalig mit dem root-Passwort, das nicht gespeichert wird). Kein Zugriff auf die Befehlszeile des Hosts nötig.
- **Passwort in der Oberfläche** setzbar. Erreichbar nur aus dem lokalen Netz.
- **Automatisch aktuell:** Push auf `claude/**` -> Tests und Secret-Scan -> Merge nach `main` -> der LXC holt `main` alle 5 Minuten (mit Tests, Sicherung und Rückfall).
- Läuft ohne externe Abhängigkeiten (Node 22).

Konzept und Begründung der Regeln: [KONZEPT.md](KONZEPT.md). Einrichtung: [docs/INSTALLATION.md](docs/INSTALLATION.md).

## Entwicklung

```bash
npm test            # Bewertung, Zeitplan, Steuerung, Server, Prüfskript
npm run demo        # Demo mit simulierten Hosts
```

## Aufbau

| Ordner | Inhalt |
|--------|--------|
| `src/smart.js`, `src/rating.js`, `src/zfs.js` | SMART-Daten einlesen, Bewertung, ZFS-Status |
| `src/schedule.js` | Zeitplanlogik als reine Funktionen (gut testbar) |
| `src/engine.js` | Abfragen, Testergebnisse verbuchen, Tests starten und abbrechen |
| `src/stats.js`, `src/zfs.js` | Statistik-Berechnung, ZFS-Auswertung (Pools, vdevs, Scrub) |
| `src/server.js`, `src/auth.js`, `src/service.js` | Webserver, Passwort, Aufbereitung für die Oberfläche |
| `src/provision.js` | Einrichtung eines Hosts aus der Oberfläche (Fingerabdruck, Passwort einmalig, Prüfung) |
| `web/` | Oberfläche (reines JavaScript, kein Build-Schritt): `app.js` (Rahmen), `stats-view.js`, `host-view.js`, `tests-view.js`, `charts.js` (SVG-Diagramme) |
| `host-setup/` | Prüfskript und Einrichtung für die Proxmox-Hosts |
| `update.sh`, `sync.sh`, `install-sync.sh` | Aktualisierung im LXC: von Hand, alle 5 Minuten automatisch, Einrichtung des Timers |
| `.github/workflows/` | Auto-Merge von `claude/**` nach `main` mit Tests und Secret-Scan |
| `src/demo/` | Beispieldaten und simulierte Hosts für Tests und Demo |
