#!/usr/bin/env bash
#
# Holt neue Serverstände vom eigenen Stellium-Server und spielt sie ein.
#
#   stellium-selbstupdate           nachsehen und, wenn etwas da ist, einspielen
#   stellium-selbstupdate pruefen   nur nachsehen
#
# Läuft stündlich über einen Timer. Eingespielt wird mit derselben
# Rückfallebene wie von Hand: startet der neue Stand nicht, kommt der alte
# zurück.
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

ZIEL="/opt/stellium"
NUR_PRUEFEN="${1:-}"

# Der Server läuft hier auf dem Gerät — der kürzeste Weg zu seiner Auskunft.
PORT="$(grep -oP '(?<=^PORT=)\d+' /etc/stellium.env 2>/dev/null || echo 8787)"
BASIS="http://127.0.0.1:$PORT"

# Für den Abruf braucht es eine Anmeldung. Ein eigener Zugang für diese
# Aufgabe, damit kein persönliches Passwort im Dateisystem liegt.
ZUGANG="/etc/stellium-update.env"
if [[ -r "$ZUGANG" ]]; then
  # shellcheck source=/dev/null
  . "$ZUGANG"
fi

if [[ -z "${STELLIUM_UPDATE_LOGIN:-}" || -z "${STELLIUM_UPDATE_PASSWORT:-}" ]]; then
  fehler "$(cat <<HINWEIS
Für die Selbstaktualisierung fehlt ein Zugang.

Lege in der App unter ${FETT}Team verwalten${AUS} ein Konto an — etwa
${FETT}serverupdate${AUS} mit der Rolle Administrator — und trage es hier ein:

    ${GRAU}sudo tee /etc/stellium-update.env >/dev/null <<'ENDE'
STELLIUM_UPDATE_LOGIN=serverupdate
STELLIUM_UPDATE_PASSWORT=das-passwort
ENDE
    sudo chmod 600 /etc/stellium-update.env${AUS}
HINWEIS
)"
fi

anmelden() {
  curl -fsS --max-time 15 -X POST "$BASIS/api/auth/login" \
    -H 'content-type: application/json' \
    -d "$(printf '{"login":%s,"password":%s}' \
        "$(printf '%s' "$STELLIUM_UPDATE_LOGIN" | jq -Rs .)" \
        "$(printf '%s' "$STELLIUM_UPDATE_PASSWORT" | jq -Rs .)")" \
    | jq -r '.token // empty'
}

schritt "Nachsehen"
TOKEN="$(anmelden)"
[[ -n "$TOKEN" ]] || fehler "Anmeldung am eigenen Server fehlgeschlagen. Stimmen die Angaben in $ZUGANG?"

HIER="$(node -p "require('$ZIEL/packages/desktop/package.json').version" 2>/dev/null || echo '0.0.0')"
ANTWORT="$(curl -fsS --max-time 15 -H "authorization: Bearer $TOKEN" \
  "$BASIS/api/releases/check?platform=server&version=$HIER" || echo '{}')"
NEU="$(printf '%s' "$ANTWORT" | jq -r '.update.version // empty')"

if [[ -z "$NEU" ]]; then
  ok "$HIER ist der neueste Stand"
  exit 0
fi

SUMME="$(printf '%s' "$ANTWORT" | jq -r '.update.sha256')"
NOTIZ="$(printf '%s' "$ANTWORT" | jq -r '.update.notes // empty')"
info "Neu verfügbar: ${FETT}$NEU${AUS}  ${GRAU}(hier: $HIER)${AUS}"
[[ -n "$NOTIZ" ]] && printf '  %s%s%s\n' "$GRAU" "$NOTIZ" "$AUS"

[[ "$NUR_PRUEFEN" == "pruefen" ]] && exit 0

schritt "Holen"
ARBEIT="$(mktemp -d /tmp/stellium-selbstupdate-XXXX)"
trap 'rm -rf "$ARBEIT"' EXIT
PAKET="$ARBEIT/stellium-server.tar.gz"

curl -fsS --max-time 900 -H "authorization: Bearer $TOKEN" \
  -o "$PAKET" "$BASIS/releases/server/download" \
  || fehler "Der Stand ließ sich nicht laden."

GEMESSEN="$(sha256sum "$PAKET" | awk '{print $1}')"
[[ "$GEMESSEN" == "$SUMME" ]] \
  || fehler "Prüfsumme stimmt nicht. Der Stand wird verworfen."
ok "geladen und geprüft ($(du -h "$PAKET" | cut -f1))"

schritt "Auspacken"
tar -C "$ARBEIT" -xzf "$PAKET"
QUELLE="$(find "$ARBEIT" -maxdepth 2 -name 'stellium-aktualisieren.sh' -print -quit)"
[[ -n "$QUELLE" ]] || fehler "Im Paket fehlt das Aktualisierungsskript."
ok "bereit"

schritt "Einspielen"
# Von hier an übernimmt das mitgelieferte Skript — samt Sicherung und
# Rückfall, falls der neue Stand nicht startet.
bash "$QUELLE"
