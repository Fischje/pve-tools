# PVE-Tools

Weboberfläche „Fischje's PVE-Tools“ im LXC `pve-tools` (Ordner `/opt/pve-tools`, Dienst `pve-tools`): Platten, ZFS, Selbsttests,
Snapshots und Backup-Läufe der Proxmox-Hosts. Node 22 ohne Abhängigkeiten, Tests mit `npm test`.

## Regeln

- **Auslieferung:** Push auf `claude/**`; der Workflow prüft Tests und gitleaks und mergt nach `main`, der LXC holt `main` alle 5 Minuten.
- **Version:** Bei jeder Auslieferung die **dritte Stelle** hochzählen (zweite/erste nur auf ausdrücklichen Wunsch), und zwar an zwei Stellen:
  `package.json` (`version`) und oben in `CHANGELOG.md` (`## x.y.z – JJJJ-MM-TT` mit Spiegelstrichen). Ein Test prüft, dass beide übereinstimmen.
  Die Oberfläche zeigt die Version oben und beim Klick die letzten Einträge.
- **Changelog** in einfachen Worten für den Benutzer, keine sicherheitsrelevanten Details (keine Adressen, Schlüssel, Passwörter).
- **Prüfskript** (`host-setup/gate.sh`): Bei Änderungen `GATE_VERSION` hochzählen und im Changelog sagen, dass auf den Hosts „Skript aktualisieren“ nötig ist.
  Neue Befehle des Tools immer auch durch das echte Prüfskript testen (`test/gate-echt.test.js`), nicht nur gegen die Demo.
- **Tests** auch ohne root laufen lassen (die GitHub-Runner sind nicht root), vor dem Push gitleaks.
- Doku, Texte und Kommentare auf Deutsch.
