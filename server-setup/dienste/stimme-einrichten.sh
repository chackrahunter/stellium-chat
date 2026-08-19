#!/usr/bin/env bash
# Richtet den Sprachdienst ein: Sprachnachrichten werden auf diesem Rechner
# abgetippt, nicht bei einem fremden Anbieter.
#
# Warum es den Dienst gibt: bis hierher ging jede Aufnahme an Groqs Whisper.
# Das Textmodell läuft längst im eigenen Netz — die Sprachnachricht war das
# letzte, was das Haus noch verließ, und ausgerechnet die trägt eine Stimme.
# Der Dienst hier schließt diese Lücke: whisper.cpp hört zu, der Chat-Server
# fragt ihn über 127.0.0.1, und die Aufnahme bleibt, wo sie ist.
#
# Was eingerichtet wird:
#   1. whisper.cpp wird aus der Quelle gebaut (es gibt kein Paket für ARM64).
#   2. Ein Modell wird geladen und unter /var/lib/stellium-stimme abgelegt.
#   3. Ein Dienst, der beim Hochfahren startet und nach jedem Fehler wieder.
#   4. STIMME_URL kommt in /etc/stellium.env, damit der Chat ihn findet.
#
# Der Chat behält Vorrang. Der Dienst rechnet auf drei der vier Kerne, der
# vierte bleibt frei, und unter Last bekommt er weniger Rechenzeit zugeteilt
# als der Chat. Das ist keine Feinheit: eine Abschrift, die den Chat für eine
# halbe Minute zäh macht, wäre schlimmer als gar keine.
#
# Einrichten:   sudo bash stimme-einrichten.sh
#               sudo bash stimme-einrichten.sh --modell small
# Entfernen:    sudo bash stimme-einrichten.sh zurueck
# Nachsehen:    systemctl status stellium-stimme
#               journalctl -u stellium-stimme -n 50 --no-pager
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }

BENUTZER="${STIMME_USER:-stellium-stimme}"
HEIM="${STIMME_HOME:-/var/lib/stellium-stimme}"
PORT="${STIMME_PORT:-8788}"
UMGEBUNG="${STELLIUM_ENV:-/etc/stellium.env}"

# base ist die Vorgabe. Auf einem Pi 5 tippt es eine halbe Minute Aufnahme in
# gut einer Viertelminute ab und trifft Deutsch und Englisch verlässlich.
# small ist deutlich genauer und ungefähr dreimal so langsam — wer lieber
# wartet als nachbessert, nimmt "--modell small".
MODELL="${STIMME_MODELL:-base}"
# Drei von vier Kernen. Gemessen ist das nicht nur rücksichtsvoller, sondern
# schneller als vier: der vierte Kern streitet sonst mit dem Chat, und beide
# verlieren dabei mehr, als der zusätzliche Kern einbringt.
FAEDEN="${STIMME_FAEDEN:-3}"

while [ $# -gt 0 ]; do
  case "$1" in
    zurueck) ZURUECK=1 ;;
    --modell) shift; MODELL="${1:-base}" ;;
    --port) shift; PORT="${1:-8788}" ;;
    --faeden) shift; FAEDEN="${1:-3}" ;;
    *) echo "Unbekannt: $1"; exit 1 ;;
  esac
  shift
done

# ── Entfernen ───────────────────────────────────────────────────
if [ "${ZURUECK:-0}" = "1" ]; then
  systemctl disable --now stellium-stimme.service >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/stellium-stimme.service
  rm -rf /etc/systemd/system/stellium-stimme.service.d
  systemctl daemon-reload

  # Die Zeile aus der Umgebung nehmen, sonst sucht der Chat weiter einen
  # Dienst, den es nicht mehr gibt, und wartet bei jeder Sprachnachricht.
  if [ -f "$UMGEBUNG" ]; then
    sed -i '/^# ── Sprachdienst/d;/^STIMME_URL=/d;/^STIMME_MODELL=/d' "$UMGEBUNG"
    systemctl restart stellium >/dev/null 2>&1 || true
  fi

  echo "Dienst entfernt."
  echo "Modelle und Programm liegen noch unter $HEIM — löschen mit:"
  echo "  sudo rm -rf $HEIM && sudo userdel $BENUTZER"
  exit 0
fi

# ── Werkzeug ────────────────────────────────────────────────────
echo "→ Werkzeug prüfen"
FEHLT=()
for w in git cmake g++ make ffmpeg curl; do command -v "$w" >/dev/null || FEHLT+=("$w"); done
if [ ${#FEHLT[@]} -gt 0 ]; then
  echo "   nachinstallieren: ${FEHLT[*]}"
  apt-get update -qq
  # ffmpeg heißt als Paket genauso, g++/make/cmake liegen in build-essential.
  apt-get install -y git cmake build-essential ffmpeg curl >/dev/null
fi

# ── Benutzer und Ablage ─────────────────────────────────────────
echo "→ Benutzer $BENUTZER"
id -u "$BENUTZER" >/dev/null 2>&1 || useradd --system --home "$HEIM" --shell /usr/sbin/nologin "$BENUTZER"
install -d -o "$BENUTZER" -g "$BENUTZER" -m 750 "$HEIM" "$HEIM/modelle" "$HEIM/tmp"

# ── Bauen ───────────────────────────────────────────────────────
# Es gibt kein fertiges Paket für ARM64, und ein selbst gebautes Programm
# nutzt die Befehlssätze dieses Prozessors — das ist hier kein Feinschliff,
# sondern der Unterschied zwischen brauchbar und unbrauchbar.
QUELLE="$HEIM/whisper.cpp"
echo "→ whisper.cpp holen und bauen (dauert ein paar Minuten)"
if [ -d "$QUELLE/.git" ]; then
  git -C "$QUELLE" fetch --depth 1 origin >/dev/null 2>&1 || true
  git -C "$QUELLE" reset --hard origin/HEAD >/dev/null 2>&1 || true
else
  rm -rf "$QUELLE"
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git "$QUELLE" >/dev/null
fi

cmake -S "$QUELLE" -B "$QUELLE/build" \
  -DCMAKE_BUILD_TYPE=Release -DGGML_NATIVE=ON \
  -DWHISPER_BUILD_TESTS=OFF -DWHISPER_BUILD_EXAMPLES=ON >/dev/null
cmake --build "$QUELLE/build" -j"$(nproc)" --target whisper-server >/dev/null

[ -x "$QUELLE/build/bin/whisper-server" ] || { echo "Der Bau hat kein whisper-server erzeugt."; exit 1; }

# ── Modell ──────────────────────────────────────────────────────
GEWICHTE="$HEIM/modelle/ggml-$MODELL.bin"
if [ -f "$GEWICHTE" ]; then
  echo "→ Modell $MODELL liegt schon da"
else
  echo "→ Modell $MODELL laden"
  # Bewusst das mehrsprachige Modell: Stellium ist eine Übersetzungs-App.
  # Die ".en"-Fassungen sind schneller und können nur Englisch — das wäre
  # hier der falsche Handel.
  case "$MODELL" in
    *.en) echo "   \"$MODELL\" kann nur Englisch. Stellium spricht 22 Sprachen — bitte ohne \".en\"."; exit 1 ;;
  esac
  curl -fL --progress-bar -o "$GEWICHTE.teil" \
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-$MODELL.bin"
  mv "$GEWICHTE.teil" "$GEWICHTE"
fi
chown "$BENUTZER:$BENUTZER" "$GEWICHTE"

# ── Dienst ──────────────────────────────────────────────────────
echo "→ Dienst"
cat > /etc/systemd/system/stellium-stimme.service <<ENDE
[Unit]
Description=Stellium — Sprachnachrichten abtippen (whisper.cpp)
Documentation=file://$QUELLE/README.md
After=network.target
# Der Chat kommt zuerst hoch. Der Sprachdienst darf nachkommen: bis er da ist,
# bleibt eine Sprachnachricht eben kurz ohne Abschrift, und der Chat merkt es
# von selbst — er sieht alle halbe Minute nach.
Before=stellium.service

[Service]
Type=simple
User=$BENUTZER
Group=$BENUTZER
WorkingDirectory=$HEIM
ExecStart=$QUELLE/build/bin/whisper-server \\
  --model $GEWICHTE \\
  --host 127.0.0.1 --port $PORT \\
  --threads $FAEDEN \\
  --convert --tmp-dir $HEIM/tmp \\
  --no-language-probabilities
# --convert schickt webm und mp4 durch ffmpeg; ohne das nimmt whisper.cpp nur
# wav, mp3, ogg und flac — und der Browser nimmt in keinem davon auf.
# --no-language-probabilities spart eine zweite Durchsicht der Aufnahme, die
# nur dazu diente, die Wahrscheinlichkeit jeder der 99 Sprachen zu melden.
# Welche erkannt wurde, steht auch ohne das in der Antwort.

Restart=always
RestartSec=5

# ── Der Chat hat Vorrang ────────────────────────────────────────
# Drei von vier Kernen; der vierte bleibt dem Chat und der Oberfläche. Ohne
# diese Grenze zieht das Abtippen alle vier Kerne auf Anschlag, und die
# Oberfläche auf dem Pi fängt an zu haken.
CPUAffinity=1 2 3
# Unter Last bekommt der Chat rund fünfmal so viel Rechenzeit zugeteilt.
CPUWeight=20
Nice=5
IOSchedulingClass=idle

# Ein Modell, das mehr Speicher will als hier steht, soll scheitern statt den
# Pi ins Auslagern zu treiben. 2 GB reichen für alles bis "small" reichlich.
MemoryHigh=1500M
MemoryMax=2G
OOMPolicy=continue

# ── Der Dienst braucht nichts vom übrigen System ────────────────
# Er nimmt Audio über 127.0.0.1 entgegen und gibt Text zurück. Von der
# Chat-Datenbank, den Anhängen oder den Schlüsseln sieht er nichts.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_UNIX
RestrictNamespaces=true
LockPersonality=true
ReadWritePaths=$HEIM

StandardOutput=journal
StandardError=journal
SyslogIdentifier=stellium-stimme

[Install]
WantedBy=multi-user.target
ENDE

install -d /etc/systemd/system/stellium-stimme.service.d
cat > /etc/systemd/system/stellium-stimme.service.d/10-neustart.conf <<'ENDE'
[Unit]
# Ohne Zeitfenster gibt systemd nach fünf schnellen Fehlstarts für immer auf.
# Derselbe Grund wie beim Chat: es soll niemand von Hand nachhelfen müssen.
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=5
ENDE

systemctl daemon-reload
systemctl enable stellium-stimme.service >/dev/null
# Ausdrücklich neu starten und nicht nur "enable --now": läuft der Dienst schon,
# tut --now nichts, und ein Wechsel des Modells bliebe folgenlos — der Dienst
# meldete sich weiter gesund, nur eben mit den alten Gewichten. Das sieht man
# ihm von außen nicht an.
systemctl restart stellium-stimme.service

# ── Warten, bis das Modell geladen ist ──────────────────────────
echo -n "→ Modell wird geladen "
BIS=$((SECONDS + 120))
BEREIT=0
while [ $SECONDS -lt $BIS ]; do
  if curl -fsS --max-time 3 "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q '"ok"'; then
    BEREIT=1; break
  fi
  echo -n "."
  sleep 2
done
echo
[ "$BEREIT" = "1" ] || { echo "Der Dienst meldet sich nicht. journalctl -u stellium-stimme -n 40"; exit 1; }

# ── Dem Chat sagen, wo er fragen soll ───────────────────────────
echo "→ $UMGEBUNG ergänzen"
if [ -f "$UMGEBUNG" ]; then
  sed -i '/^# ── Sprachdienst/d;/^STIMME_URL=/d;/^STIMME_MODELL=/d' "$UMGEBUNG"
  cat >> "$UMGEBUNG" <<ENDE
# ── Sprachdienst (stimme-einrichten.sh) ─────────────────────────
STIMME_URL=http://127.0.0.1:$PORT
STIMME_MODELL=whisper-$MODELL
ENDE
  systemctl restart stellium >/dev/null 2>&1 || true
else
  echo "   $UMGEBUNG gibt es nicht — bitte von Hand eintragen:"
  echo "   STIMME_URL=http://127.0.0.1:$PORT"
fi

echo
echo "Fertig."
printf '  %-12s %s / %s\n' "Dienst" "$(systemctl is-enabled stellium-stimme)" "$(systemctl is-active stellium-stimme)"
printf '  %-12s %s\n' "Modell" "$MODELL ($(du -h "$GEWICHTE" | cut -f1))"
printf '  %-12s %s\n' "Adresse" "http://127.0.0.1:$PORT"
printf '  %-12s %s\n' "Kerne" "1 2 3 von 0-$(($(nproc) - 1)), $FAEDEN Fäden"
echo
echo "Nachsehen:      journalctl -u stellium-stimme -n 50 --no-pager"
echo "Prüfen:         node scripts/e2e-stimme.mjs"
echo "Entfernen:      sudo bash $(basename "$0") zurueck"
