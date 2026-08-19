#!/usr/bin/env bash
#
# Richtet den selbstheilenden Fernzugang ein.
#
#   sudo bash server-setup/fernzugang/einrichten.sh
#
# Danach schreibt der Pi alle zehn Minuten auf, unter welcher Adresse und
# welchem Port er gerade von außen erreichbar ist, und liefert diesen Zettel
# über HTTPS aus. Der Mac holt ihn sich mit mac-ssh-config.sh und trägt das
# Ergebnis in ~/.ssh/config ein.
#
# Warum nginx den Zettel ausliefert und nicht der Anwendungsserver: der
# Anwendungsserver sucht sich seine auslieferbaren Dateien beim Start einmal
# zusammen. Eine Datei, die danach entsteht, kennt er nicht — sie käme erst
# nach dem nächsten Neustart heraus. Ausgerechnet der Zettel, der gebraucht
# wird, wenn etwas klemmt, wäre damit der letzte, der aktuell ist. nginx sieht
# jedes Mal frisch auf die Platte.
#
set -Eeuo pipefail

if [[ -t 1 ]]; then
  ROT=$'\e[31m'; GRUEN=$'\e[32m'; GELB=$'\e[33m'; BLAU=$'\e[38;5;99m'
  GRAU=$'\e[90m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else
  ROT=''; GRUEN=''; GELB=''; BLAU=''; GRAU=''; FETT=''; AUS=''
fi
schritt() { printf '\n%s▸ %s%s\n' "$BLAU$FETT" "$*" "$AUS"; }
info()    { printf '  %s\n' "$*"; }
ok()      { printf '  %s✓%s %s\n' "$GRUEN" "$AUS" "$*"; }
warn()    { printf '  %s!%s %s\n' "$GELB" "$AUS" "$*"; }
fehler()  { printf '\n%s✗ %s%s\n\n' "$ROT$FETT" "$*" "$AUS" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten."

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OBERFLAECHE="${STELLIUM_WEB_DIR:-/opt/stellium/packages/desktop/dist}"
SITE=/etc/nginx/sites-available/stellium
SCHNIPSEL=/etc/nginx/snippets/stellium-zugang.conf

command -v natpmpc >/dev/null || { apt-get update -qq && apt-get install -y -qq natpmpc; }

# ── Das Meldeskript an seinen Platz ─────────────────────────────
schritt "Meldeskript ablegen"
install -m 755 "$HIER/melden.sh" /usr/local/bin/stellium-zugang-melden
ok "/usr/local/bin/stellium-zugang-melden"

# ── Timer ───────────────────────────────────────────────────────
#
# Zehn Minuten, also doppelt so oft wie die Auffrischung der Weiterleitung.
# Der Zettel soll nie länger falsch sein als die Weiterleitung selbst — und
# nach einem Update, das die Oberfläche neu baut, soll er schnell wieder da
# sein.
schritt "Timer einrichten"
cat > /etc/systemd/system/stellium-zugang-melden.service <<'DIENST'
[Unit]
Description=Stellium: Adresse und äußeren Port aufschreiben
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-zugang-melden
DIENST

cat > /etc/systemd/system/stellium-zugang-melden.timer <<'TIMER'
[Unit]
Description=Stellium: alle zehn Minuten aufschreiben, wo der Pi erreichbar ist

[Timer]
OnBootSec=60s
OnUnitActiveSec=10min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now stellium-zugang-melden.timer >/dev/null
ok "alle zehn Minuten, und einmal kurz nach jedem Start"

# ── nginx: den Zettel ausliefern ────────────────────────────────
schritt "Auslieferung über HTTPS"
cat > "$SCHNIPSEL" <<SCHNIPSELENDE
# Der Zettel mit Adresse und Port kommt direkt von der Platte. Bewusst an
# der Anwendung vorbei: er wird gerade dann gebraucht, wenn etwas nicht
# stimmt — dann soll er auch dann noch herauskommen, wenn der Anwendungs-
# server gerade nicht antwortet.
location = /zugang.json {
  alias $OBERFLAECHE/zugang.json;
  default_type application/json;
  # Nicht zwischenspeichern: ein zehn Minuten alter Port ist hier wertlos.
  add_header Cache-Control "no-store" always;
  # add_header an dieser Stelle setzt die Kopfzeilen des Server-Blocks außer
  # Kraft, deshalb stehen sie hier noch einmal.
  include snippets/stellium-sicherheit.conf;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;
}
SCHNIPSELENDE
ok "$SCHNIPSEL"

if [[ ! -f "$SITE" ]]; then
  warn "$SITE gibt es nicht — die Auslieferung über nginx wird übersprungen."
elif grep -q 'snippets/stellium-zugang.conf' "$SITE"; then
  ok "in der nginx-Konfiguration bereits eingetragen"
else
  # Anker ist ssl_trusted_certificate: die Zeile steht genau einmal und nur im
  # HTTPS-Block. Damit landet der Zettel nicht versehentlich auch auf Port 80,
  # wo sonst nur die Weiterleitung nach oben steht.
  if ! grep -q '^\s*ssl_trusted_certificate' "$SITE"; then
    warn "Kein HTTPS-Block gefunden — die Auslieferung über nginx wird übersprungen."
  else
    SICHERUNG="$(mktemp)"
    cp -a "$SITE" "$SICHERUNG"
    awk '
      { print }
      !getan && /^[[:space:]]*ssl_trusted_certificate/ {
        print "  include snippets/stellium-zugang.conf;"
        getan = 1
      }
    ' "$SICHERUNG" > "$SITE"

    if nginx -t >/dev/null 2>&1; then
      systemctl reload nginx
      ok "nginx liefert /zugang.json aus"
    else
      cp -a "$SICHERUNG" "$SITE"
      warn "nginx lehnt die Änderung ab — der alte Stand ist zurückgelegt:"
      nginx -t 2>&1 | sed 's/^/    /' >&2
    fi
    rm -f "$SICHERUNG"
  fi
fi

# ── Einmal ausführen und nachsehen ──────────────────────────────
schritt "Probelauf"
/usr/local/bin/stellium-zugang-melden

DATEN="${STELLIUM_DATA:-/var/lib/stellium}"
if [[ -s "$DATEN/zugang.json" ]]; then
  sed 's/^/    /' "$DATEN/zugang.json"
else
  fehler "Es ist kein Zettel entstanden. Sagt der Router etwas? natpmpc -a 2222 2222 tcp 3600"
fi

HOST="$(sed -n 's/.*"host": *"\([^"]*\)".*/\1/p' "$DATEN/zugang.json")"
PORT_HTTPS=443
if [[ -r /etc/stellium-einrichtung.conf ]]; then
  PORT_HTTPS="$(. /etc/stellium-einrichtung.conf 2>/dev/null; printf '%s' "${STELLIUM_PORT_HTTPS:-443}")"
fi
URL="https://$HOST"
[[ "$PORT_HTTPS" != "443" ]] && URL="https://$HOST:$PORT_HTTPS"

if curl -fsS --max-time 15 "$URL/zugang.json" >/dev/null 2>&1; then
  ok "$URL/zugang.json ist von außen abrufbar"
else
  warn "$URL/zugang.json war von hier aus nicht abrufbar — vom Mac aus noch einmal prüfen."
fi

printf '\n  %sAuf dem Mac:%s  %sbash server-setup/fernzugang/mac-ssh-config.sh%s\n\n' \
  "$FETT" "$AUS" "$GRAU" "$AUS"
