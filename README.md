# pve-disk-tool

Eine kleine Website nur für das lokale Netz, die den Zustand der Festplatten (HDD, SATA-SSD, NVMe) von Proxmox VE und
Proxmox Backup Server so zeigt, dass es auch Laien verstehen. Das Tool läuft in einem eigenen LXC. Auf den Proxmox-Hosts
bleibt der Kern unberührt: dort liegen nur ein eingeschränkter SSH-Zugang und ein kleines Prüfskript.

- **Verständliche Bewertung:** Gesund, Beobachten, Bald tauschen, Kritisch. Dazu ein Satz, was es bedeutet, und was zu tun ist.
- **Mehrere Hosts, eine Oberfläche:** PVE und PBS, mit ZFS-Poolstatus.
- **Selbsttests mit Zeitplan:** Kurztest und Langtest einstellbar (Intervall, gesperrte Wochentage, Sperrzeiten). Immer eine
  Platte nach der anderen. Langtests, die nicht in ein Betriebsfenster passen, werden über mehrere Tage aufgeteilt.
  Berücksichtigt Server, die nachts ausgehen, und Hosts, die von Hand gestartet werden.
- **Verlauf:** Messwerte in SQLite, damit sichtbar wird, ob ein Fehlerwert noch steigt.
- **Passwort in der Oberfläche** setzbar. Erreichbar nur aus dem lokalen Netz.
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
| `src/server.js`, `src/auth.js`, `src/service.js` | Webserver, Passwort, Aufbereitung für die Oberfläche |
| `web/` | Oberfläche (reines JavaScript, kein Build-Schritt) |
| `host-setup/` | Prüfskript und Einrichtung für die Proxmox-Hosts |
| `src/demo/` | Beispieldaten und simulierte Hosts für Tests und Demo |
