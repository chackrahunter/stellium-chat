#!/usr/bin/env bash
#
# Stellium auf dem Server aktualisieren — ohne alles neu einzurichten.
#
#   tar xzf stellium-server.tar.gz && cd stellium-server
#   sudo bash server-setup/stellium-aktualisieren.sh
#
# Angefasst wird nur der Programmcode. Datenbank, Konten, Schlüssel, Zertifikat,
# nginx, Firewall und alle Einstellungen bleiben, wie sie sind.
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

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten:  sudo bash $0"

BENUTZER="stellium"
ZIEL="/opt/stellium"
SICHERUNG="/var/lib/stellium/quelltext-vorher"

# Woher kommt der neue Stand? Aus dem Paket, in dem dieses Skript liegt.
QUELLE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
[[ -f "$QUELLE/package.json" && -d "$QUELLE/packages/server" ]] \
  || fehler "Dieses Skript gehört in ein ausgepacktes Stellium-Paket."
[[ "$QUELLE" != "$ZIEL" ]] || fehler "Quelle und Ziel sind dasselbe Verzeichnis."

[[ -d "$ZIEL" ]] || fehler "$ZIEL gibt es nicht. Für die Ersteinrichtung: server-setup/stellium-installieren.sh"

VORHER="$(cd "$ZIEL" && node -p "require('./packages/desktop/package.json').version" 2>/dev/null || echo '?')"
NACHHER="$(node -p "require('$QUELLE/packages/desktop/package.json').version" 2>/dev/null || echo '?')"

printf '\n%s✦  Stellium aktualisieren%s\n   %s%s → %s%s\n' "$BLAU$FETT" "$AUS" "$GRAU" "$VORHER" "$NACHHER" "$AUS"

# ── Zurücklegen können ──────────────────────────────────────────
schritt "Bisherigen Stand sichern"
rm -rf "$SICHERUNG"
mkdir -p "$(dirname "$SICHERUNG")"
# Nur der Quelltext; node_modules wird ohnehin neu aufgebaut.
tar -C "$ZIEL" --exclude=node_modules -cf - . | (mkdir -p "$SICHERUNG" && tar -C "$SICHERUNG" -xf -)
ok "liegt unter $SICHERUNG"

zurueck() {
  warn "Etwas ist schiefgegangen — ich lege den alten Stand zurück."
  rm -rf "$ZIEL"
  mkdir -p "$ZIEL"
  tar -C "$SICHERUNG" -cf - . | tar -C "$ZIEL" -xf -
  chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
  systemctl restart stellium || true
  fehler "Der alte Stand läuft wieder. Nichts ist verloren."
}
trap zurueck ERR

# ── Neuen Stand einspielen ──────────────────────────────────────
schritt "Neuen Stand einspielen"
# node_modules stehen lassen: das spart auf einem Pi mehrere Minuten.
find "$ZIEL" -mindepth 1 -maxdepth 1 ! -name node_modules -exec rm -rf {} +
tar -C "$QUELLE" \
    --exclude=node_modules --exclude=.git --exclude=release \
    --exclude=downloads --exclude=data --exclude=dist \
    -cf - . | tar -C "$ZIEL" -xf -
chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
ok "Quelltext ersetzt"

schritt "Bauen"
cd "$ZIEL"
info "Abhängigkeiten — auf einem Pi kann das ein paar Minuten dauern"
npm ci --omit=optional --no-audit --no-fund >/dev/null 2>&1 \
  || npm install --no-audit --no-fund >/dev/null 2>&1
npm run build >/dev/null 2>&1
chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
ok "gebaut — Server und Oberfläche"

# ── Helfer auffrischen ──────────────────────────────────────────
schritt "Werkzeuge auffrischen"
for werkzeug in stellium-zugang stellium-tunnel; do
  [[ -f "$ZIEL/server-setup/$werkzeug.sh" ]] \
    && install -m 755 "$ZIEL/server-setup/$werkzeug.sh" "/usr/local/bin/$werkzeug"
done
[[ -f "$ZIEL/server-setup/stellium-konsole.mjs" ]] \
  && install -m 755 "$ZIEL/server-setup/stellium-konsole.mjs" /usr/local/lib/stellium/konsole.mjs
install -m 755 "$ZIEL/server-setup/stellium-aktualisieren.sh" /usr/local/bin/stellium-update
ok "stellium, stellium-zugang, stellium-tunnel, stellium-update"

# ── Starten ─────────────────────────────────────────────────────
schritt "Neu starten"
systemctl restart stellium
sleep 5

if ! systemctl is-active --quiet stellium; then
  journalctl -u stellium --no-pager -n 20 | sed 's/^/    /'
  zurueck
fi

# Antwortet er auch wirklich?
PORT="$(grep -oP '(?<=^PORT=)\d+' /etc/stellium.env 2>/dev/null || echo 8787)"
ERREICHBAR=0
for _ in 1 2 3 4 5; do
  if curl -fsS --max-time 4 -o /dev/null "http://127.0.0.1:$PORT/api/health"; then ERREICHBAR=1; break; fi
  sleep 2
done
[[ $ERREICHBAR -eq 1 ]] || zurueck

trap - ERR
ok "läuft und antwortet"

cat <<FERTIG

${GRUEN}${FETT}   ✓  Aktualisiert auf ${NACHHER}.${AUS}

   ${GRAU}Der vorherige Stand liegt unter $SICHERUNG,
   falls du ihn je brauchst.${AUS}

   ${FETT}stellium${AUS}  zeigt, wie es dem Server geht.

FERTIG
