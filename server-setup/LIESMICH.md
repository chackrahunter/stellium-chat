# Stellium auf dem Raspberry Pi

Ein Aufruf, danach läuft alles. Voraussetzung ist **Raspberry Pi OS 64-bit**
(Bookworm oder neuer) auf einem Pi 4, Pi 5 oder Pi 400.

```bash
curl -fsSL https://raw.githubusercontent.com/chackrahunter/stellium-chat/main/server-setup/stellium-installieren.sh | sudo bash
```

Das Skript fragt zweimal etwas — wie der Server erreichbar sein soll und nach
dem Groq-Schlüssel. Danach arbeitet es allein, etwa zehn bis zwanzig Minuten,
je nach Pi und Leitung.

## Wie der Server erreichbar wird

Beim Start stehen drei Wege zur Wahl.

**1 · Eigene Domain.** Der übliche Weg für den Firmenbetrieb. Das Skript holt
ein Zertifikat von Let's Encrypt und verlängert es von selbst. Du brauchst eine
Domain, die auf euren Anschluss zeigt, und die Ports 80 und 443 im Router auf
den Pi weitergeleitet.

**2 · Tailscale.** Ein verschlüsseltes privates Netz zwischen euren Geräten.
Kein Port im Router offen, kein Zertifikat zu beantragen — Tailscale bringt
eines mit. Zwei Befehle brauchen danach noch deine Anmeldung im Browser; sie
stehen am Ende auf dem Bildschirm.

**3 · Nur im Heimnetz.** Ohne Verschlüsselung. Zum Ausprobieren in Ordnung, für
echte Gespräche nicht.

Wechseln geht jederzeit: Skript noch einmal ausführen, andere Zahl wählen.

## Was eingerichtet wird

| | |
|---|---|
| **Chat-Dienst** | systemd, startet bei jedem Neustart mit, startet nach einem Absturz neu |
| **nginx** | nimmt HTTPS entgegen, reicht nach innen weiter, hält die WebSocket-Verbindung offen |
| **Firewall** | nur SSH, 80 und 443 — bei Tailscale nicht einmal das |
| **fail2ban** | sperrt aus, wer Passwörter durchprobiert |
| **Aktualisierungen** | Sicherheitspakete kommen automatisch, Neustart nachts um vier falls nötig |
| **Sicherung** | jede Nacht um 3:30, vierzehn Stände unter `/var/lib/stellium/sicherungen` |
| **Statuskonsole** | öffnet sich beim Anmelden von selbst |

## Wie die Verbindung geschützt ist

Der Chat-Dienst hört ausschließlich auf `127.0.0.1`. Von außen führt kein Weg
an ihm vorbei — jede Verbindung geht durch nginx und damit durch TLS. Selbst
wenn die Firewall einmal falsch stünde, wäre der Port nicht erreichbar.

Dazu kommt: HSTS, damit ein Browser nach dem ersten Besuch gar nicht mehr
unverschlüsselt fragt. OCSP-Stapling. Keine Versionsnummer in den Antworten.
Der Dienst läuft unter einem eigenen Konto ohne Anmeldemöglichkeit und darf
über systemd nur an sein eigenes Datenverzeichnis.

Das Masterpasswort für den Schlüsseltresor liegt in `/etc/stellium.env`, lesbar
nur für root und den Dienst. Der Groq-Schlüssel liegt damit verschlüsselt in
`/var/lib/stellium/secrets.enc` — kein Gerät im Team trägt ihn je ein.

## Danach

```bash
stellium                          # Statuskonsole
sudo systemctl restart stellium   # neu starten
sudo journalctl -u stellium -f    # mitlesen
sudo stellium-sichern             # sofort sichern
```

Der erste Zugang — Benutzername und Einmal-Passwort — steht am Ende der
Einrichtung auf dem Bildschirm. Später wiederfinden:

```bash
sudo journalctl -u stellium | grep -A6 Einmal
```

## Aktualisieren

```bash
sudo bash /opt/stellium/server-setup/stellium-installieren.sh
```

Holt den neuen Stand, baut ihn und startet den Dienst neu. Daten, Konten und
Schlüssel bleiben unangetastet.

Die Apps für Mac, Windows und Linux aktualisieren sich selbst, sobald du unter
*Einstellungen → Aktualisierung* eine neue Version hochlädst.
