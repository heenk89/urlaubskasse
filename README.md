# Urlaubskasse

Gemeinsame Ausgaben im Urlaub oder beim Ausflug fair aufteilen – und am Ende sehen, wer wem wie viel zahlen muss.

© by Daniel Henk

## Beispiel

3 Personen. Person 1 zahlt Tickets (3 × 50 € = 150 €), Person 2 das Essen (100 €), Person 3 die Getränke (50 €).
Gesamt 300 €, pro Person 100 €.

| Person   | Bezahlt | Anteil | Saldo  |
|----------|--------:|-------:|-------:|
| Person 1 | 150 €   | 100 €  | +50 €  |
| Person 2 | 100 €   | 100 €  | 0 €    |
| Person 3 | 50 €    | 100 €  | −50 €  |

Auswertung: **Person 3 zahlt an Person 1: 50 €.** Mit „✓ Erledigt“ wird die Zahlung eingetragen, danach sind alle bei 0.

## Funktionen

- **Mehrere Projekte** (Urlaub, Ausflug, WG-Kasse …), jeweils mit Zeitraum und Währungszeichen
- **Teilnehmer** mit oder ohne Konto. Ohne Konto = nur ein Name, du trägst für ihn ein.
- **Gewichtung:** Paar = 2, Familie = 4 → zahlt entsprechend mehr. Standard 1.
- **Ausgaben:** Betrag, wofür, Kategorie, wer hat bezahlt, auf wen wird aufgeteilt (Standard: alle). Einzelne Personen lassen sich pro Ausgabe abwählen (z. B. „trinkt nicht mit“). Cent-Reste werden fair verteilt, die Summe stimmt immer.
- **Ausgleichszahlungen** (bar/PayPal) eintragen, direkt aus der Auswertung mit „✓ Erledigt“
- **Auswertung:** Gesamt, pro Person, Tabelle Bezahlt/Anteil/Saldo, **wer zahlt wem** (möglichst wenige Überweisungen), nach Kategorie, Text zum Kopieren (WhatsApp), CSV für Excel, Drucken/PDF
- **Verlauf:** wer hat wann was eingetragen, geändert oder gelöscht
- **Projekt abschließen:** danach kann nur noch Ersteller/Verwalter ändern
- Fürs Handy gemacht, mit Dark Mode. Über „Zum Home-Bildschirm“ wie eine App nutzbar.

## Benutzer & Rechte

| Rolle | darf |
|---|---|
| **Admin** | alles in allen Projekten, Benutzer anlegen/ändern/löschen, Backup |
| **Projektersteller** | alles im eigenen Projekt, Projekt löschen, Verwalter ernennen |
| **Verwalter** (pro Projekt) | alles im Projekt, Teilnehmer & Rechte ändern |
| **Teilnehmer mit Konto** | je nach Einstellung, siehe unten |

Pro Teilnehmer einstellbar (Vorlagen: *Nur ansehen*, *Standard*, *Alles*):

- **Eintragen:** nichts · nur selbst Bezahltes · für alle
- **Bearbeiten:** nichts · Eigenes · alles
- **Löschen:** nichts · Eigenes · alles

„Eigenes“ = Einträge, die die Person selbst bezahlt oder selbst eingetragen hat.
Jeder Teilnehmer sieht alle Einträge und die Auswertung seines Projekts. Projekte, in denen man nicht Teilnehmer ist, sieht man nicht (außer Admin).

Benutzer legt der Admin unter ☰ → *Benutzer verwalten* an. Pro Benutzer: „darf eigene Projekte anlegen“ ja/nein.

## Technik

- Python 3 + Flask + Waitress, SQLite. Nur Debian-Pakete, kein pip und kein venv.
- Code: `/opt/urlaubskasse-src` (Git-Klon aus Gitea)
- Daten: `/var/lib/urlaubskasse/urlaubskasse.db`
- Dienst: `urlaubskasse.service`, läuft als Benutzer `urlaubskasse` auf Port 80
- Befehle: `urlaubskasse-update`, `urlaubskasse-admin <benutzer>`
- Login immer aktiv (mehrere Benutzer). Passwörter gehasht, Sperre nach 10 Fehlversuchen für 15 Minuten.

## Installation (neuer LXC)

1. **Repo in Gitea:** `urlaubskasse`, privat (als Mirror des GitHub-Repos).

2. **Container anlegen** (auf dem Proxmox-Host), z. B. als CT 114:
   - Template Debian 13, unprivilegiert
   - 1 Kern, 256 MB RAM, 256 MB Swap, 4 GB Disk
   - Netzwerk: feste IP, z. B. `192.168.178.114/23`, Gateway wie bei den anderen Containern
   - Start at boot: ja

3. **Im Container** (`pct enter 114`):
   ```bash
   apt update && apt install -y git
   git clone http://<TOKEN>:x-oauth-basic@192.168.178.66:3000/<gitea-user>/urlaubskasse.git /opt/urlaubskasse-src
   bash /opt/urlaubskasse-src/install.sh
   ```

4. Im Browser `http://<IP-des-Containers>` öffnen → beim ersten Aufruf das **Admin-Konto anlegen**.

## Unterwegs nutzen (Urlaub!)

Im Urlaub bist du nicht im Heimnetz. Damit alle mit dem Handy eintragen können:

1. Im Nginx Proxy Manager einen Proxy Host anlegen, z. B. `urlaub.heenk.online` → `http://192.168.178.114:80`, mit Let's-Encrypt-Zertifikat und „Force SSL“.
2. Im Container das sichere Cookie einschalten:
   ```bash
   sed -i 's/^#Environment=URLAUB_SECURE_COOKIE=1/Environment=URLAUB_SECURE_COOKIE=1/' /etc/systemd/system/urlaubskasse.service
   systemctl daemon-reload && systemctl restart urlaubskasse
   ```
   Danach funktioniert der Login **nur noch über https**.

Nur über HTTPS freigeben, nie direkt per Portfreigabe auf Port 80.

## Update

Neue Version nach GitHub pushen (Gitea spiegelt), dann im Container:
```bash
urlaubskasse-update
```
Vom Proxmox-Host aus: `pct exec 114 -- urlaubskasse-update`

Version, Versionsdatum und Zeitpunkt des letzten Updates stehen unten auf der Seite.

## Passwort vergessen

```bash
pct exec 114 -- urlaubskasse-admin daniel
```
Setzt ein neues Passwort (oder legt den Admin neu an) und gibt Admin-Rechte.

## Backup

☰ → *Benutzer verwalten* → *Backup der Datenbank*, oder die Datei `/var/lib/urlaubskasse/urlaubskasse.db` sichern (Proxmox-Backup des Containers reicht auch).
