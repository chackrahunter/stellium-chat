# Stellium auf dem Raspberry Pi

Ein Aufruf, danach läuft alles. Voraussetzung ist **Raspberry Pi OS 64-bit**
(Bookworm oder neuer) auf einem Pi 4, Pi 5 oder Pi 400.

## Auf den Pi bringen

Das Repository ist privat, deshalb geht der bequeme `curl | sudo bash`-Weg
nicht — GitHub liefert anonym nur einen 404. Nimm stattdessen das Paket:

```bash
scp stellium-server.tar.gz pi@raspberrypi.local:~
ssh pi@raspberrypi.local
tar xzf stellium-server.tar.gz && cd stellium-server
sudo bash server-setup/stellium-installieren.sh
```

Das Skript merkt, dass es im ausgepackten Paket liegt, und nimmt den Quelltext
von dort — es braucht GitHub überhaupt nicht.

Zwei Wege gäbe es sonst noch: das Repository öffentlich schalten, dann
funktioniert die `curl`-Zeile. Oder mit einem Zugriffstoken starten:

```bash
sudo STELLIUM_TOKEN=ghp_… bash server-setup/stellium-installieren.sh
```

## Was dich erwartet

Das Skript fragt zweimal etwas — wie der Server erreichbar sein soll und nach
dem Groq-Schlüssel. Danach arbeitet es allein, etwa zehn bis zwanzig Minuten,
je nach Pi und Leitung.

## Wie der Server erreichbar wird

Beim Start stehen drei Wege zur Wahl.

**1 · Eigene Domain.** Der übliche Weg für den Firmenbetrieb. Das Skript holt
ein Zertifikat von Let's Encrypt und verlängert es von selbst. Du brauchst eine
Domain, die auf euren Anschluss zeigt, und die Ports 80 und 443 im Router auf
den Pi weitergeleitet.

**2 · DuckDNS.** Wenn du keine Domain hast. Du bekommst kostenlos eine Adresse
wie `meinefirma.duckdns.org`, ebenfalls mit echtem Let's-Encrypt-Zertifikat.
Das Skript hält sie aktuell, auch wenn euer Anschluss die IP-Adresse wechselt.

**3 · Nur im Heimnetz.** Ohne Verschlüsselung. Zum Ausprobieren in Ordnung, für
echte Gespräche nicht.

### Die E-Mail-Adresse

Beim Zertifikat fragt das Skript nach einer Adresse. Die geht an Let's Encrypt
und wird nur benutzt, um dich zu warnen, falls das Zertifikat abzulaufen droht.
Sie steht nicht im Zertifikat, ist für Besucher nicht sichtbar und wird nirgends
verschlüsselt abgelegt — sie hat mit der Verschlüsselung des Chats nichts zu tun.

Leer lassen geht. Dann verlängert sich das Zertifikat weiterhin von selbst, nur
die Warnung im Störfall bleibt aus.

### Die Ports

Für 1 und 2 müssen **Port 80 und 443** vom Router auf den Pi zeigen — sonst
kann Let's Encrypt nicht prüfen, dass die Adresse wirklich dir gehört.

Das Skript nimmt dir das ab, soweit es geht: es prüft erst, ob eine Anfrage
von außen ankommt. Kommt keine an, bittet es den Router selbst darum — über
UPnP, sonst über NAT-PMP — und prüft danach noch einmal. Klappt das, richtet es
gleich einen Timer ein, der die Freigabe stündlich erneuert, damit sie nicht
abläuft.

Erst wenn auch das scheitert (weil UPnP im Router abgeschaltet ist), musst du
selbst ran. Dann nennt dir das Skript die genauen zwei Zeilen, deine lokale
Adresse und deine öffentliche IP — und wo das bei einer FRITZ!Box steht.

Auf den Geräten im Team ist nichts zu installieren außer der Stellium-App.

Wechseln geht jederzeit: Skript noch einmal ausführen, andere Zahl wählen.

## Was eingerichtet wird

| | |
|---|---|
| **Chat-Dienst** | systemd, startet bei jedem Neustart mit, startet nach einem Absturz neu |
| **nginx** | nimmt HTTPS entgegen, reicht nach innen weiter, hält die WebSocket-Verbindung offen |
| **Firewall** | nur SSH, 80 und 443 — sonst nichts |
| **fail2ban** | sperrt aus, wer Passwörter durchprobiert |
| **Aktualisierungen** | Sicherheitspakete kommen automatisch, Neustart nachts um vier falls nötig |
| **Sicherung** | jede Nacht um 3:30, vierzehn Stände unter `/var/lib/stellium/sicherungen` |
| **Portfreigabe** | über UPnP oder NAT-PMP, stündlich erneuert |
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

## Unbeaufsichtigt einrichten

Für eine Automatisierung lassen sich die beiden Fragen vorwegnehmen:

```bash
sudo STELLIUM_MODE=1 STELLIUM_DOMAIN=chat.meinefirma.de \
     STELLIUM_MAIL=du@meinefirma.de STELLIUM_GROQ=gsk_… \
     bash server-setup/stellium-installieren.sh
```

Für DuckDNS: `STELLIUM_MODE=2 STELLIUM_DUCK=meinefirma:dein-token`.

## Danach

Die Statuskonsole zeigt: Adressen zum Verbinden, Zustand von Chat-Dienst und
nginx, gewählte KI-Modelle, Zahl der Konten, Kanäle und Nachrichten, Restlaufzeit
des Zertifikats, Firewall und fail2ban, Auslastung von Prozessor, Arbeitsspeicher,
Auslagerung und Platte, Temperaturen, Taktrate, Grafikspeicher, Netzverkehr,
Fassungen aller beteiligten Programme und das Alter der letzten Sicherung.

Was dieser Rechner nicht hat, wird auch nicht angezeigt — keine leeren Zeilen
für eine Grafikeinheit, die es nicht gibt.

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
