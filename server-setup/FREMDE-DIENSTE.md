# Was auf dem Pi **nicht** uns gehört

Auf demselben Raspberry Pi läuft eine Website eines Kollegen. Sie hat mit dem
Chat nichts zu tun und darf von keiner Auslieferung, keinem Aufräumlauf und
keiner Sicherung berührt werden. Don hat ausdrücklich darum gebeten.

Diese Datei steht hier, damit niemand sie erst wieder zusammensuchen muss.
Stand: 19.08.2026, auf dem laufenden System nachgesehen.

## Die Trennlinie

| | Chat (unser) | Website des Kollegen |
|---|---|---|
| Dienst | `stellium`, `nginx` | **`caddy`** |
| Adresse | `:80`, `192.168.1.66:443`, `:9443` | **`:8080`** |
| Dateien | `/opt/stellium`, `/var/lib/stellium` | **`/srv/stellium`** |
| Einstellungen | `/etc/stellium.env`, `/etc/nginx/` | **`/etc/caddy/Caddyfile`** |
| nach außen | Cloudflare Tunnel (`chat.stellium.club`) | **Tailscale Funnel _und_ Cloudflare Tunnel** |

## `cloudflared` gehört seit dem 20.08. beiden

Stand 20.08.2026 — beim Prüflauf auf dem laufenden System gefunden.

Der Cloudflare Tunnel ist **kein reiner Chat-Dienst mehr**. `/etc/cloudflared/config.yml`
führt drei Namen, und nur einer davon ist unserer:

| Name | Ziel | wem |
|---|---|---|
| `chat.stellium.club` | `127.0.0.1:8787` | uns (Node direkt, **nicht** über nginx) |
| `stellium.club` | `127.0.0.1:8080` | **dem Kollegen** (caddy) |
| `www.stellium.club` | `127.0.0.1:8080` | **dem Kollegen** (caddy) |

Damit ist `cloudflared` genau das geworden, was `caddy` schon war: ein Dienst,
den ein Skript von uns abschalten kann, ohne dass der Schaden bei uns auftritt.
Zwei Wege führten dorthin, beide in `stellium-tunnel.sh`:

* `sudo stellium-tunnel aus` lief über eine Liste `stellium-tunnel cloudflared`
  und hätte `cloudflared` mit `systemctl disable --now` abgeschaltet.
* `sudo stellium-tunnel fest` ruft `cloudflared service install <token>` auf.
  Das schreibt die Einheit neu und stellt sie auf den Token um — die
  `ingress`-Regeln aus `config.yml` sind danach **wirkungslos**, der Dienst
  läuft aber weiter. Die Seite des Kollegen wäre still verschwunden, ohne dass
  irgendwo ein Dienst auf „failed" steht.

Beide Stellen fragen jetzt vorher `cloudflared_ist_unser_allein` und brechen
ab, sobald in `config.yml` ein Name steht, der nicht auf `127.0.0.1:8787`
(oder unseren HTTP-Port) zeigt. Wer den Chat wirklich aus dem Tunnel nehmen
will, entfernt den `chat.*`-Eintrag von Hand und lädt `cloudflared` neu.

**Nicht anfassen, zusätzlich zum Obigen:** `cloudflared` als Dienst,
`/etc/cloudflared/**`, und `cloudflared service install|uninstall` in jeder
Form. Ein Tunnel, der fremde Namen trägt, wird nicht neu aufgesetzt.

Der Name `/srv/stellium` führt in die Irre — dort liegt **nicht** unsere
Oberfläche, sondern eine eigenständige Seite mit eigenem Analytics, eigenen
Sprachordnern (`de/`, `es/`) und eigener Inhaltsrichtlinie. Unsere
Weboberfläche liefert der Node-Server auf `8787` selbst aus; `nginx` reicht
sie nur durch.

## Zwei Dienste gehören inzwischen BEIDEN

Das stand hier zuerst falsch, und der Irrtum ist gefährlich: Die Seite des
Kollegen läuft nicht über einen Außenweg, sondern über **zwei**.

- **`cloudflared`** trägt `stellium.club` und `www.stellium.club` auf Port 8080
  (Kollege) **und** `chat.stellium.club` auf 8787 (wir).
- **`tailscaled`** trägt den Funnel `raspberrypi/stellium.tail0b188d.ts.net`
  ebenfalls auf Port 8080 (Kollege) — und ist zugleich unser Rückweg.

**Wer einen der beiden für reinen Eigenbedarf hält und abschaltet, nimmt die
Seite des Kollegen mit.** Genau dieser Irrtum steckte schon einmal in
`pi-beschleunigen.sh`, mit einer Begründung, die früher stimmte. Dort greift
inzwischen die Sperrliste `UNANTASTBAR=(caddy cloudflared tailscaled ssh sshd
stellium nginx)` — unabhängig davon, was jemand in die Abschaltliste schreibt.

**`teamviewerd` bleibt ebenfalls stehen.** Er kostet spürbar Rechenzeit, aber
Don erreicht den Pi darüber, wenn kein anderer Weg mehr geht — er hat auf
diesem Weg am 20.08. den SSH-Zugang wiederhergestellt, als die
Router-Weiterleitung ausgelaufen war. Ein Fernzugang, der nur dann gebraucht
wird, wenn alles andere versagt, sieht im Normalbetrieb immer überflüssig aus.

## Was das heißt

**Nicht anfassen:** `caddy` (Dienst, Einheit, Einstellungen), `/srv/**`,
`/etc/caddy/**`, Port `8080`, Port `2019` (Caddys Verwaltungsschnittstelle,
lauscht nur auf 127.0.0.1). Auch `tailscaled` nicht — es beendet die
TLS-Strecke für die Funnel-Adresse.

**Beim Aufräumen:** Läufe, die verwaiste Dateien suchen, dürfen nur unter
`/var/lib/stellium` arbeiten. `ablage.dateienAufraeumen()` hat dafür den
Riegel `darfWeg()` — er verlangt, dass ein Pfad unmittelbar in `uploads/`
oder `storage/` liegt. Wer einen neuen Aufräumlauf baut, braucht dieselbe
Absicherung; ein Pfad aus der Datenbank ist kein Freibrief.

**Beim Ausliefern:** `scripts/ausliefern.mjs` und `veroeffentlichen.mjs`
sprechen ausschließlich über `https://stellium-chat.duckdns.org/api/…` mit
dem Server. ⚠️ **Diese Adresse antwortet seit dem 20.08. nicht mehr** — der
Umzug auf den Tunnel hat die nginx-Seite ausgehängt und das Zertifikat
entfernt. `scripts/web-ausliefern.mjs` ruft sie an drei Stellen (Zeile 47,
48, 51) weiterhin auf und läuft damit ins Leere; die neue Adresse des Chats
ist `https://chat.stellium.club`. Das liegt außerhalb dieses Ordners und ist
hier nur vermerkt, damit es nicht verlorengeht. `web-ausliefern.mjs` startet zusätzlich `stellium` neu — sonst
nichts. Der Auslieferungsweg selbst fasst `caddy` nirgends an. Das soll so
bleiben.

**Ein Skript kannte `caddy` allerdings doch:**
`server-setup/dienste/pi-beschleunigen.sh` führte den Dienst in seiner Liste
entbehrlicher Dienste und hätte ihn mit `systemctl disable --now` abgeschaltet
— mit der Begründung, caddy lausche nur auf seiner Verwaltungsschnittstelle.
Das Skript ist am 19.08. bereits einmal gelaufen (`stellium-takt.service` und
`/etc/sysctl.d/60-stellium.conf` stammen daher, `cups` und `libretranslate`
sind seitdem aus). Die Seite des Kollegen hat das nur überstanden, weil caddy
damals noch nicht lief; inzwischen ist er `enabled`, ein zweiter Durchgang
hätte ihn getroffen. Der Eintrag ist entfernt.

Die Lehre daraus: eine Volltextsuche, deren Ergebnis man nicht liest, ist
keine Prüfung. Wer behauptet, kein Skript kenne `caddy`, soll es vorführen.

**Zwei weitere Minen, gefunden am 20.08.:**

*Port 8080 stand in der Ausweichliste der Einrichtung.*
`stellium-installieren.sh` suchte den HTTP-Port mit `waehle_port 80 8080 8880
8008`. Die Prüfung `port_frei` fragt nur, ob gerade jemand lauscht — läuft
`caddy` im falschen Moment nicht (Neustart, Absturz, Wartung), gilt 8080 als
frei, nginx nimmt ihn, und `caddy` kommt danach nicht mehr hoch. Dieselbe
Bedingung wie beim Beschleunigungslauf: es ging bisher nur gut, weil die
Zeitpunkte zufällig günstig lagen. 8080 ist aus der Liste entfernt, und
`port_frei` weist 8080 und 2019 jetzt grundsätzlich ab, laufe da gerade
etwas oder nicht.

*`ufw --force reset` zog die eigene Rückfahrkarte ein.*
Betrifft nicht den Kollegen, sondern uns — gehört aber in dieselbe Familie.
Die Absicherung setzte die Firewall zurück und öffnete danach `OpenSSH`, also
Port **22**. `sshd` hört auf diesem Pi aber allein auf **2222**
(`sshd -T | grep ^port`). Ein zweiter Lauf der Einrichtung hätte die einzige
Regel gelöscht, über die noch jemand hereinkommt — bei einem Gerät ohne
Bildschirm und ohne Tastatur heißt das: niemand kommt mehr dran. Die Ports
werden jetzt bei `sshd` erfragt statt angenommen, und danach wird nachgesehen,
ob für jeden auch wirklich eine Regel steht.

**Wenn doch einmal etwas an der Grenze nötig wird:** vorher `sudo cp
/etc/caddy/Caddyfile /etc/caddy/Caddyfile.vor-<datum>` und danach `sudo caddy
validate --config /etc/caddy/Caddyfile`. Ein kaputter Caddyfile nimmt die
Seite des Kollegen mit, und er merkt es womöglich erst Stunden später.

## Wie man auf diesen Pi kommt (Stand 20.08.2026)

Am 20.08. ist der Zugang beinahe verlorengegangen, und der Grund lohnt das
Aufschreiben: es gab nur **einen** Weg hinein, und der hing an drei Dingen,
von denen keines uns gehört — der Adresse des Anschlusses, einer
NAT-PMP-Pacht im Router und dem Namen `stellium-chat.duckdns.org`. Beim Umzug
auf den Cloudflare-Tunnel wurden `stellium-duckdns.service` und `.timer`
entfernt. Seither hält **niemand** den Namen aktuell. Zurzeit zeigt er noch
auf die richtige Adresse (`66.58.136.128`, am 20.08. nachgemessen und
übereinstimmend) — wechselt sie, ist der Weg zu, ohne Vorwarnung.

Deshalb drei Wege, die sich keine Ursache teilen:

| Weg | hängt ab von | Stand 20.08. |
|---|---|---|
| `ssh stellium` (DuckDNS:2222) | Anschlussadresse, Router, DuckDNS | geht, aber ungepflegt |
| **Tailscale** `aryan@100.102.168.44:2222` | nur tailscaled | **geht** — `tailscaled` ist `active`/`enabled`, sshd antwortet dort mit Banner |
| **Cloudflare-Tunnel** `ssh.stellium.club` | nur cloudflared | vorbereitet, braucht noch den CNAME |

`tailscaled` und `cloudflared` stehen dafür in `pi-beschleunigen.sh` auf einer
**Sperrliste** (`UNANTASTBAR`) — auch dann, wenn sie jemand versehentlich in
die Abschaltliste einträgt. Erprobt: der Lauf überspringt sie und sagt es.

**Eine Regel im Tunnel hinzufügen kostet den Kollegen eine Lücke.** Die
Einheit hat kein `ExecReload`, und `SIGHUP` beendet `cloudflared` (systemd
startet ihn neu). Am 20.08. gemessen: rund **sieben Sekunden**, in denen
`stellium.club` und `chat.stellium.club` mit 502 antworten. Es gibt hier
keinen unterbrechungsfreien Weg — solche Änderungen gehören in eine ruhige
Stunde, nicht in den Arbeitstag.

## Der Kernel-Sprung ist entschärft (20.08.2026)

Auf dem Pi lief 6.12.47, aber `/boot/firmware/kernel_2712.img` war
byte-identisch mit **6.18.39** — beim nächsten Start wäre also ungeplant ein
Kernel sechs Minorversionen weiter gebootet, auf einem Gerät in Alaska, an das
niemand herankommt. Besonders tückisch: `/var/run/reboot-required` existierte
**nicht**, die Standardprüfung meldete also „kein Neustart nötig".

Das Startabbild zeigt jetzt wieder auf den **bewährten** 6.12.47, der dort seit
fünf Tagen läuft. Ein Stromausfall bootet damit das, was nachweislich
funktioniert, statt etwas Ungeprüftes.

    /boot/firmware/kernel_2712.img.6.18.39-vor-20260820   ← das alte Abbild
    apt-mark hold linux-image-rpi-2712 linux-image-rpi-v8

**Der Sprung auf 6.18.39 ist damit nicht abgesagt, sondern verschoben** — auf
einen Moment, in dem jemand danebensitzt. Dann:

    sudo cp /boot/firmware/kernel_2712.img.6.18.39-vor-20260820 \
            /boot/firmware/kernel_2712.img
    sudo apt-mark unhold linux-image-rpi-2712 linux-image-rpi-v8
    sudo reboot

Kommt er nicht zurück, hilft nur physischer Zugang: SD-Karte in einen anderen
Rechner, `kernel_2712.img` aus der Sicherung zurückspielen.

## noVNC hört nur noch lokal (20.08.2026)

`novnc.service` brückte den VNC-Server auf die **Tailscale-Adresse**, und
dahinter steht `enable_auth=false`. Gemessen: HTTP 200 von außen,
`num_security_types: 1` = *None*. Der Schreibtisch ist per Autologin als
`aryan` angemeldet, und `aryan` hat `NOPASSWD: ALL` — Tailnet-Mitgliedschaft
war damit gleichbedeutend mit root auf dem Pi, ohne ein Kennwort.

Bindet jetzt auf `127.0.0.1:6080`. Wer den Browser-Zugang braucht, tunnelt ihn:

    ssh -L 6080:127.0.0.1:6080 stellium
    # dann http://127.0.0.1:6080/vnc.html im Browser

Sicherung: `/etc/systemd/system/novnc.service.vor-20260820`.
