# Fernzugang, der sich selbst heilt

Der Pi steht hinter einem Router. Damit `ssh stellium` vom Mac aus funktioniert,
muss im Router eine Weiterleitung stehen — und die ist nicht fest eingetragen,
sondern wird alle 20 Minuten per NAT-PMP erbeten (`server-setup/ssh-zugang.sh`).

Das hat eine Lücke: **der Router darf ausweichen.** Ist der gewünschte äußere
Port belegt, bekommt man einen anderen. Nach einem Neustart des Routers passiert
das regelmäßig — und ab da zeigt `~/.ssh/config` auf einen Port, hinter dem
nichts mehr ist. Wer nicht im Heimnetz steht, kann auch nicht nachsehen.

Diese drei Dateien schließen die Lücke.

| Datei | Läuft wo | Tut was |
|---|---|---|
| `melden.sh` | Pi, alle 10 Minuten | schreibt Adresse und aktuellen äußeren Port auf |
| `einrichten.sh` | Pi, einmal | legt Timer und nginx-Regel an |
| `mac-ssh-config.sh` | Mac, bei Bedarf | holt den Zettel und trägt ihn in `~/.ssh/config` ein |

## Einrichten

Auf dem Pi, einmal:

```bash
sudo bash /opt/stellium/server-setup/fernzugang/einrichten.sh
```

Danach liegt der Zettel an zwei Stellen und ist über HTTPS abrufbar:

```
/var/lib/stellium/zugang.json                      ← der Urstand
/opt/stellium/packages/desktop/dist/zugang.json    ← der ausgelieferte
https://stellium-chat.duckdns.org/zugang.json      ← seit 20.08. tot, siehe unten
```

> **Stand 20.08.2026.** Die HTTPS-Stelle antwortet nicht mehr. Beim Umzug auf
> den Cloudflare-Tunnel wurde die nginx-Seite ausgehängt (`sites-enabled` ist
> leer) und das Zertifikat entfernt; auf 443 und 9443 lauscht nichts mehr.
> Nachgemessen: `https://stellium-chat.duckdns.org/zugang.json` liefert gar
> nichts, `https://chat.stellium.club/zugang.json` liefert 404 — der
> Node-Dienst kennt diesen Pfad nicht, den hat nginx ausgeliefert.
> Der Zettel steht also nur noch lokal auf dem Pi. Wer ihn wieder über HTTPS
> braucht, muss ihn im Node-Dienst ausliefern lassen oder die nginx-Seite
> wieder einhängen. **Zum Hereinkommen braucht man ihn nicht:** Tailscale und
> der Tunnel führen beide ohne Zettel zum Ziel.

Inhalt:

```json
{
  "host": "stellium-chat.duckdns.org",
  "port": 2222,
  "zeit": "2026-08-19T19:40:02Z",
  "zeitStempel": 1787168402000
}
```

**Nichts Geheimes.** Adresse, Portnummer, Zeit — alle drei Angaben erfährt
ohnehin jeder, der den Port einmal anspricht. Kein Benutzername, kein
Schlüssel, kein Fingerabdruck. Wer den Port kennt, kommt damit keinen Schritt
weiter: die Anmeldung braucht einen Schlüssel, `fail2ban` wacht davor.

## Benutzen

Auf dem Mac, wenn `ssh stellium` ins Leere läuft:

```bash
bash server-setup/fernzugang/mac-ssh-config.sh
```

Das Skript holt den Zettel, prüft ihn (eine Adresse darf nur aus Buchstaben,
Ziffern, Punkt und Bindestrich bestehen, ein Port muss eine Zahl sein), trägt
`HostName` und `Port` im Block `Host stellium` ein und probiert die Verbindung.
Alles andere im Block — `User`, `IdentityFile`, Optionen — bleibt unangetastet.
Der vorherige Stand liegt danach unter `~/.ssh/config.stellium-vorher`.

Nur nachsehen, ohne etwas zu ändern:

```bash
bash server-setup/fernzugang/mac-ssh-config.sh --zeigen
```

## Warum nginx den Zettel ausliefert

Der Anwendungsserver sucht sich die auslieferbaren Dateien **beim Start einmal**
zusammen. Eine Datei, die danach entsteht, kennt er nicht — sie käme erst nach
dem nächsten Neustart heraus. Ausgerechnet der Zettel, den man braucht, wenn
etwas klemmt, wäre damit der letzte, der stimmt.

nginx sieht bei jeder Anfrage frisch auf die Platte. Und er liefert den Zettel
auch dann noch aus, wenn Stellium selbst gerade nicht antwortet.

## Wenn der Zettel selbst nicht mehr erreichbar ist

Dann ist auch die HTTPS-Weiterleitung verrutscht, und es gibt keinen Weg mehr
von außen hinein — außer diesem:

### Tailscale

Der Pi hängt im Tailnet unter einer Adresse, die sich **nie** ändert:

```
100.102.168.44
```

Kein Router, keine Weiterleitung, kein Port, der wandern kann. Das Gerät heißt
dort `stellium`.

```bash
ssh -p 2222 aryan@100.102.168.44
```

oder in einem Rutsch in die Konfiguration:

```bash
bash server-setup/fernzugang/mac-ssh-config.sh --tailscale
```

Voraussetzung ist, dass auf dem Mac Tailscale läuft und im selben Tailnet
angemeldet ist (`stelliumprime@`). Auf dem Pi ist es ein Dienst und läuft von
allein; `tailscale status` zeigt, wer sonst noch da ist.

**Achtung:** `tailscaled` belegt auf dem Pi bereits Port 443 auf der
Tailnet-Adresse. Deshalb hört nginx dort nicht auf `0.0.0.0:443`, sondern nur
auf der Adresse im Heimnetz — das ist Absicht und darf nicht "aufgeräumt"
werden.

### Wenn auch das nicht geht

Bildschirm und Tastatur an den Pi, dann:

```bash
sudo bash /opt/stellium/server-setup/ssh-zugang.sh
sudo /usr/local/bin/stellium-zugang-melden
```

## Nachsehen, ob es läuft

```bash
systemctl list-timers stellium-zugang-melden.timer
journalctl -t stellium-zugang-melden -n 20
cat /var/lib/stellium/zugang.json
```

Ist die Zeit im Zettel älter als eine Stunde, hat der Router auf die letzten
Anfragen nicht mehr geantwortet. Der Zettel wird in dem Fall **nicht**
überschrieben — eine alte, vermutlich noch richtige Angabe ist mehr wert als
gar keine, und das Alter der Zeitangabe ist das Warnsignal.
