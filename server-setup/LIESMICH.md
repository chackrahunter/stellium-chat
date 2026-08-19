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

**4 · Tunnel.** Der Pi baut die Verbindung selbst nach außen auf, statt auf
Anfragen zu warten. Kein Port, kein Router-Zugang, funktioniert auch hinter
CGNAT. Verschlüsselt wird außen von Cloudflare, auf den Geräten im Team ist
nichts zu installieren. Zwei Ausprägungen:

- **schnell** — sofort, ohne Konto. Adresse wie `wort-wort-name.trycloudflare.com`,
  wechselt aber bei jedem Neustart des Tunnels. Gut zum Ausprobieren.
- **fest** — eine eigene Adresse, die bleibt. Kostenlos, braucht aber ein
  Cloudflare-Konto und eine dort geführte Domain.

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

**Mit DuckDNS braucht das Zertifikat keinen offenen Port.** Let's Encrypt prüft
dort über einen DNS-Eintrag, den der Pi selbst setzt und wieder wegräumt. Der
Router muss dafür gar nichts durchlassen.

Damit euer Team den Pi erreicht, muss trotzdem **ein** Port durchgereicht sein
— der HTTPS-Port. Sind 80 und 443 auf dem Pi belegt, weicht die Einrichtung
selbständig auf 8080 und 8443 aus und nennt die Adresse dann mit Port.

Am Ende prüft das Skript, ob von außen wirklich etwas ankommt. Kommt nichts an,
steht dort genau die eine Zeile, die im Router fehlt — samt eurer öffentlichen
Adresse. Im Heimnetz läuft Stellium bis dahin schon.

**Mit eigener Domain** ruft Let's Encrypt den Pi direkt auf Port 80 auf. Der
muss also erreichbar sein, bevor es ein Zertifikat gibt.


## Was eingerichtet wird

| | |
|---|---|
| **Chat-Dienst** | systemd, startet bei jedem Neustart mit, startet nach einem Absturz neu |
| **nginx** | nimmt HTTPS entgegen, reicht nach innen weiter, hält die WebSocket-Verbindung offen |
| **Firewall** | nur SSH, 80 und 443 — sonst nichts |
| **fail2ban** | sperrt aus, wer Passwörter durchprobiert |
| **Aktualisierungen** | Sicherheitspakete kommen automatisch, Neustart nachts um vier falls nötig |
| **Sicherung** | jede Nacht um 3:30, vierzehn Stände unter `/var/lib/stellium/sicherungen` |
| **Portwahl** | 80 und 443, sonst automatisch 8080 und 8443 |
| **Statuskonsole** | öffnet sich beim Anmelden von selbst |
| **Browser-Zugang** | die Oberfläche läuft auch ohne App, direkt im Browser |

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

## Auf dem Handy

Der Server liefert die Oberfläche gleich mit. Ruf die Adresse einfach im
Browser auf — auf dem iPhone, dem iPad, unter Android, überall. Es gibt nichts
zu installieren, und die Serveradresse muss auch niemand eintragen: die Seite
weiß, von wo sie kommt.

In Safari lässt sie sich über *Teilen → Zum Home-Bildschirm* ablegen, dann
sieht und startet sie wie eine App.

## Kein Zugang zum Router?

Zwei Wege, unabhängig voneinander:

```bash
sudo stellium-zugang     # Router überreden
sudo stellium-tunnel     # oder ganz ohne Router
```

### Router überreden

```bash
sudo stellium-zugang
```

Das versucht, die Freigabe beim Router selbst zu erwirken — über UPnP, sonst
NAT-PMP. Viele Router haben das ab Werk an; dann klappt es ohne Anmeldung an
der Oberfläche. Gelingt es, wird die Freigabe stündlich erneuert, weil solche
Regeln ablaufen.

Vorher prüft es noch etwas Wichtigeres: ob euer Anschluss überhaupt eine eigene
öffentliche Adresse hat. Teilt sich der Provider eine Adresse unter vielen
Kunden (CGNAT oder DS-Lite), hilft auch die schönste Portfreigabe nichts — die
Anfragen kommen gar nicht erst bei euch an. Dann sagt es das klar und nennt die
beiden Auswege: eine öffentliche IPv4 beim Provider beantragen, oder einen
Tunnel benutzen, bei dem der Pi die Verbindung nach außen aufbaut.

### Ohne Router

```bash
sudo stellium-tunnel            # fragt, welche Art
sudo stellium-tunnel schnell    # sofort, Adresse wechselt
sudo stellium-tunnel fest       # feste Adresse, Cloudflare-Konto nötig
sudo stellium-tunnel adresse    # aktuelle Adresse anzeigen
sudo stellium-tunnel aus        # wieder abschalten
```

Der Pi hält die Verbindung nach außen offen; Anfragen kommen darüber herein.
Weder eine Portfreigabe noch eine öffentliche IP-Adresse sind nötig. nginx
bleibt dazwischen und bedient den Tunnel nur noch lokal.

## Nichts doppelt eintippen

Alle Antworten landen in `/etc/stellium-einrichtung.conf` (nur für root
lesbar). Beim nächsten Lauf gelten sie als Vorgabe — beim Nachbessern musst du
also nicht noch einmal Domain, Token und Schlüssel eingeben.

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

Neues Paket auspacken und eine Zeile:

```bash
tar xzf stellium-server.tar.gz && cd stellium-server
sudo bash server-setup/stellium-aktualisieren.sh
```

Keine Fragen, keine Wiederholung der Einrichtung. Angefasst wird nur der
Programmcode — Datenbank, Konten, Schlüssel, Zertifikat, nginx, Firewall und
alle Einstellungen bleiben unberührt.

Vorher wird der alte Stand beiseitegelegt. Startet der Dienst danach nicht oder
antwortet er nicht, kommt der alte automatisch zurück; du kannst also nichts
kaputt machen.

Später genügt auch:

```bash
sudo stellium-update
```

Die Apps für Mac, Windows und Linux aktualisieren sich selbst, sobald du unter
*Einstellungen → Aktualisierung* eine neue Version hochlädst.
