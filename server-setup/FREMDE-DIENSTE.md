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
| nach außen | Portweiterleitung auf 443 | **Tailscale Funnel** |

Der Name `/srv/stellium` führt in die Irre — dort liegt **nicht** unsere
Oberfläche, sondern eine eigenständige Seite mit eigenem Analytics, eigenen
Sprachordnern (`de/`, `es/`) und eigener Inhaltsrichtlinie. Unsere
Weboberfläche liefert der Node-Server auf `8787` selbst aus; `nginx` reicht
sie nur durch.

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
dem Server. `web-ausliefern.mjs` startet zusätzlich `stellium` neu — sonst
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

**Wenn doch einmal etwas an der Grenze nötig wird:** vorher `sudo cp
/etc/caddy/Caddyfile /etc/caddy/Caddyfile.vor-<datum>` und danach `sudo caddy
validate --config /etc/caddy/Caddyfile`. Ein kaputter Caddyfile nimmt die
Seite des Kollegen mit, und er merkt es womöglich erst Stunden später.
