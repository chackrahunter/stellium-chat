#!/usr/bin/env bash
#
# Stellium-Server auf Raspberry Pi OS einrichten — ein Aufruf, sonst nichts.
#
# Aus dem entpackten Paket heraus (der übliche Weg):
#
#   tar xzf stellium-server.tar.gz && cd stellium-server
#   sudo bash server-setup/stellium-installieren.sh
#
# Aus einem öffentlichen Repository heraus:
#
#   curl -fsSL https://raw.githubusercontent.com/.../stellium-installieren.sh | sudo bash
#
# Bei einem privaten Repository einen Zugriffstoken mitgeben:
#
#   sudo STELLIUM_TOKEN=ghp_… bash stellium-installieren.sh
#
# Was danach läuft:
#   • Node 22, nginx, Stellium als systemd-Dienst — startet bei jedem Neustart
#   • HTTPS mit echtem Zertifikat von Let's Encrypt, automatisch verlängert
#   • Firewall, fail2ban, automatische Sicherheitsaktualisierungen
#   • Eine Statuskonsole, die sich beim Anmelden von selbst öffnet
#
# Der Server selbst hört nur auf 127.0.0.1. Von außen kommt man ausschließlich
# durch nginx und damit ausschließlich verschlüsselt.

set -Eeuo pipefail

# ── Aussehen ────────────────────────────────────────────────────
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

trap 'fehler "Abgebrochen in Zeile $LINENO. Nichts ist halb kaputt — der Aufruf lässt sich einfach wiederholen."' ERR

# ── Vorbedingungen ──────────────────────────────────────────────
[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten:  sudo bash $0"
command -v apt-get >/dev/null || fehler "Das hier ist für Raspberry Pi OS und Debian gedacht."

ARCH="$(dpkg --print-architecture)"
case "$ARCH" in
  arm64|armhf|amd64) ;;
  *) fehler "Architektur $ARCH wird nicht unterstützt." ;;
esac

# 32-Bit-Pi: Node 22 gibt es dort nicht mehr von NodeSource.
if [[ "$ARCH" == "armhf" ]]; then
  warn "Du läufst auf einem 32-Bit-System. Stellium braucht Node 22 (für die"
  warn "eingebaute SQLite-Unterstützung), und das gibt es für armhf nicht."
  fehler "Bitte das 64-Bit-Raspberry-Pi-OS aufsetzen."
fi

# ── Eingaben ────────────────────────────────────────────────────
#
# Gefragt wird am Terminal. Läuft das Skript ohne eines — in einer
# Automatisierung etwa —, zählen stattdessen diese Umgebungsvariablen:
#
#   STELLIUM_MODE    1 | 2 | 3
#   STELLIUM_DOMAIN  chat.meinefirma.de       (bei 1)
#   STELLIUM_DUCK    name:token               (bei 2)
#   STELLIUM_MAIL    du@meinefirma.de         (bei 1 und 2)
#   STELLIUM_GROQ    gsk_…                    (leer erlaubt)

# Gibt es ein Terminal, das wirklich antwortet? Ein Test auf die Datei genügt
# nicht — /dev/tty existiert auch dort, wo sich nichts daran öffnen lässt.
TERMINAL=""
if { : < /dev/tty; } 2>/dev/null; then TERMINAL="/dev/tty"; fi

# Alle Antworten landen hier und gelten beim nächsten Lauf als Vorgabe —
# damit man beim Nachbessern nicht alles noch einmal eintippen muss.
GEMERKT="/etc/stellium-einrichtung.conf"
if [[ -r "$GEMERKT" ]]; then
  # shellcheck source=/dev/null
  . "$GEMERKT"
fi

merken() {
  umask 077
  {
    echo "# Von stellium-installieren.sh gemerkt. Enthält Zugangsdaten."
    echo "STELLIUM_MODE=${1:-}"
    echo "STELLIUM_DOMAIN=${2:-}"
    echo "STELLIUM_MAIL=${3:-}"
    echo "STELLIUM_DUCK=${4:-}"
    echo "STELLIUM_PORT_HTTP=${5:-80}"
    echo "STELLIUM_PORT_HTTPS=${6:-443}"
  } > "$GEMERKT"
  chmod 600 "$GEMERKT"
}

frage() {
  local text="$1" vorgabe="${2:-}" antwort=""
  if [[ -n "$TERMINAL" ]]; then
    read -rp "  $text" antwort < "$TERMINAL"
  elif [[ -t 0 ]]; then
    read -rp "  $text" antwort
  else
    antwort="$vorgabe"
  fi
  printf '%s' "$antwort"
}

frage_still() {
  local text="$1" vorgabe="${2:-}" antwort=""
  if [[ -n "$TERMINAL" ]]; then
    read -rsp "  $text" antwort < "$TERMINAL"; echo
  elif [[ -t 0 ]]; then
    read -rsp "  $text" antwort; echo
  else
    antwort="$vorgabe"
  fi
  printf '%s' "$antwort"
}

# Die eigene Adresse im Heimnetz. Mehrere Wege, weil keiner überall geht.
lokale_ip() {
  local ip=""
  ip="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  [[ -z "$ip" ]] && ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')" || true
  [[ -z "$ip" ]] && ip="$(hostname 2>/dev/null)" || true
  printf '%s' "${ip:-dieser-rechner}"
}

# Beim Bauen darf nicht bloß "etwas ist schiefgegangen" herauskommen — die
# letzten Zeilen sagen fast immer sofort, woran es lag.
bau_fehlgeschlagen() {
  printf '\n%s✗ Das Bauen ist fehlgeschlagen. Die letzten Zeilen:%s\n\n' "$ROT$FETT" "$AUS" >&2
  tail -25 "${BAULOG:-/tmp/stellium-bau.log}" 2>/dev/null | sed 's/^/    /' >&2
  printf '\n    %sVollständig:  %s%s\n\n' "$GRAU" "${BAULOG:-/tmp/stellium-bau.log}" "$AUS" >&2
  return 1
}

BENUTZER="stellium"
ZIEL="/opt/stellium"
DATEN="/var/lib/stellium"
REPO="${STELLIUM_REPO:-https://github.com/chackrahunter/stellium-chat.git}"
PORT="8787"

# Bildschirm leeren, aber nur wenn das Terminal das kann. Über eine Pipe oder
# ohne gesetztes TERM scheitert clear — und ohne diese Absicherung bräche das
# ganze Skript an dieser Stelle ab, noch bevor es irgendetwas getan hat.
clear 2>/dev/null || printf '\n\n'

cat <<KOPF

${BLAU}${FETT}   ✦  Stellium${AUS}
   ${GRAU}Team-Chat mit Live-Übersetzung — Servereinrichtung${AUS}

   Dieser Aufruf richtet alles ein. Du wirst zweimal etwas gefragt,
   danach läuft es allein.

KOPF

# ── Fragen: erst alles einsammeln, dann arbeiten ────────────────
schritt "Wie soll der Server erreichbar sein?"

cat <<ERKLAERUNG
  In allen Fällen läuft die Verbindung über nginx mit HTTPS. Auf den
  Geräten im Team ist nichts zu installieren außer der Stellium-App.

  ${FETT}1)${AUS} Eigene Domain — ${GRUEN}empfohlen${AUS}
     z.B. chat.meinefirma.de. Echtes Zertifikat von Let's Encrypt,
     automatisch verlängert.

  ${FETT}2)${AUS} Kostenlose Adresse über DuckDNS
     Wenn du keine Domain hast: du bekommst so etwas wie
     meinefirma.duckdns.org, ebenfalls mit echtem Zertifikat.
     Kostet nichts, dauert zwei Minuten.

  ${FETT}3)${AUS} Nur im Heimnetz
     Ohne Verschlüsselung, nur im eigenen WLAN erreichbar.
     ${GELB}Zum Ausprobieren, nicht für echte Gespräche.${AUS}

  ${FETT}4)${AUS} Über einen Tunnel
     Der Pi baut die Verbindung selbst nach außen auf. Kein Port,
     kein Router-Zugang, geht auch hinter CGNAT. Verschlüsselt wird
     außen von Cloudflare. Auf den Geräten im Team ist nichts zu
     installieren.

  ${GRAU}Bei ${AUS}${FETT}2${AUS}${GRAU} läuft die Prüfung von Let's Encrypt über einen
  DNS-Eintrag — dafür muss im Router nichts freigegeben sein.
  Damit euer Team den Pi auch erreicht, sollte trotzdem ein Port
  durchgereicht werden; das Skript sagt dir am Ende welcher.

  Bei ${AUS}${FETT}1${AUS}${GRAU} ruft Let's Encrypt den Pi direkt auf Port 80 auf,
  der muss dafür von außen ankommen.${AUS}

ERKLAERUNG

WAHL=""
DOMAIN=""
MAIL=""
DUCK_NAME=""
DUCK_TOKEN=""
DUCK_VORGABE=""
while [[ -z "$WAHL" ]]; do
  WAHL="$(frage "Deine Wahl [1/2/3/4]: " "${STELLIUM_MODE:-}")"
  case "$WAHL" in
    1)
      while [[ -z "$DOMAIN" ]]; do
        DOMAIN="$(frage "Domain (z.B. chat.meinefirma.de): " "${STELLIUM_DOMAIN:-}")"
        [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]] || {
          warn "Das sieht nicht nach einer Domain aus."; DOMAIN=""; }
      done
      cat <<MAILHINWEIS

  ${GRAU}Let's Encrypt möchte eine Kontaktadresse. Sie steht nicht im
  Zertifikat und ist für niemanden sichtbar — sie dient nur dazu,
  dich zu warnen, falls das Zertifikat abzulaufen droht und die
  automatische Verlängerung einmal nicht geklappt hat.

  Leer lassen geht; dann bekommst du diese Warnung nicht.${AUS}

MAILHINWEIS
      MAIL="$(frage "E-Mail (oder leer): " "${STELLIUM_MAIL:-}")"
      while [[ -n "$MAIL" && "$MAIL" != *@*.* ]]; do
        warn "Das sieht nicht nach einer E-Mail aus. Leer lassen ist auch in Ordnung."
        MAIL="$(frage "E-Mail (oder leer): " "")"
      done
      ;;
    2)
      cat <<DUCK

  ${FETT}So bekommst du die Adresse:${AUS}
    1. duckdns.org öffnen und mit Google oder GitHub anmelden
    2. einen Namen eintragen, z.B. ${FETT}meinefirma${AUS}  →  meinefirma.duckdns.org
    3. oben auf der Seite steht dein ${FETT}token${AUS} — den brauche ich gleich

DUCK
      # Erst in eine eigene Variable holen: mit set -u bricht jede Kürzung an
      # einer nie gesetzten Variablen das ganze Skript ab.
      DUCK_VORGABE="${STELLIUM_DUCK:-}"
      while [[ -z "$DUCK_NAME" ]]; do
        DUCK_NAME="$(frage "Dein DuckDNS-Name (ohne .duckdns.org): " "${DUCK_VORGABE%%:*}")"
        DUCK_NAME="${DUCK_NAME%%.duckdns.org}"
        [[ "$DUCK_NAME" =~ ^[a-z0-9-]+$ ]] || { warn "Nur Kleinbuchstaben, Ziffern und Bindestriche."; DUCK_NAME=""; }
      done
      while [[ -z "$DUCK_TOKEN" ]]; do
        DUCK_TOKEN="$(frage "Dein DuckDNS-Token: " "${DUCK_VORGABE#*:}")"
        [[ ${#DUCK_TOKEN} -ge 20 ]] || { warn "Das sieht zu kurz aus."; DUCK_TOKEN=""; }
      done
      DOMAIN="$DUCK_NAME.duckdns.org"
      cat <<MAILHINWEIS

  ${GRAU}Let's Encrypt möchte eine Kontaktadresse. Sie steht nicht im
  Zertifikat und ist für niemanden sichtbar — sie dient nur dazu,
  dich zu warnen, falls das Zertifikat abzulaufen droht und die
  automatische Verlängerung einmal nicht geklappt hat.

  Leer lassen geht; dann bekommst du diese Warnung nicht.${AUS}

MAILHINWEIS
      MAIL="$(frage "E-Mail (oder leer): " "${STELLIUM_MAIL:-}")"
      while [[ -n "$MAIL" && "$MAIL" != *@*.* ]]; do
        warn "Das sieht nicht nach einer E-Mail aus. Leer lassen ist auch in Ordnung."
        MAIL="$(frage "E-Mail (oder leer): " "")"
      done
      ;;
    4) ;;
    3)
      warn "Ohne Verschlüsselung kann jeder im selben Netz mitlesen."
      SICHER="$(frage "Wirklich? [ja/nein]: " "ja")"
      [[ "$SICHER" == "ja" ]] || WAHL=""
      ;;
    *) warn "Bitte 1, 2, 3 oder 4."; WAHL="" ;;
  esac
done

schritt "Groq-Schlüssel"
cat <<ERKLAERUNG
  Für Übersetzung und StelliumAI. Der Schlüssel wird verschlüsselt
  auf diesem Pi abgelegt — kein Gerät im Team trägt ihn je ein.
  Holen kannst du ihn auf console.groq.com/keys.

  Leer lassen geht auch; Chat, Aufgaben, Kalender, Dateien und das
  Ideenboard laufen dann ganz normal, nur ohne KI.

ERKLAERUNG
GROQ="$(frage_still "Schlüssel (bleibt unsichtbar): " "${STELLIUM_GROQ:-}")"

# Die Antworten festhalten, bevor irgendetwas schiefgehen kann.
merken "$WAHL" "$DOMAIN" "$MAIL" "${DUCK_NAME:+$DUCK_NAME:$DUCK_TOKEN}"

# ── Ab hier ohne Rückfragen ─────────────────────────────────────
schritt "System aktualisieren"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get upgrade -y -qq
ok "Paketliste und Aktualisierungen"

schritt "Grundlagen installieren"
apt-get install -y -qq \
  curl ca-certificates gnupg git build-essential \
  nginx ufw fail2ban unattended-upgrades apt-listchanges \
  jq bc iproute2 >/dev/null
ok "nginx, Firewall, fail2ban, Werkzeuge"

schritt "Node 22"
if ! command -v node >/dev/null || [[ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null 2>&1
  apt-get install -y -qq nodejs >/dev/null
fi
ok "Node $(node -v)"

schritt "Benutzerkonto für den Dienst"
# Ein eigenes Konto ohne Anmeldemöglichkeit: fällt der Dienst je aus der Rolle,
# kommt er an nichts heran, was ihn nichts angeht.
id -u "$BENUTZER" >/dev/null 2>&1 || useradd --system --home "$DATEN" --shell /usr/sbin/nologin "$BENUTZER"
mkdir -p "$DATEN" "$ZIEL"
chown -R "$BENUTZER:$BENUTZER" "$DATEN"
chmod 750 "$DATEN"
ok "Konto $BENUTZER, Daten in $DATEN"

schritt "Stellium holen und bauen"

# Drei Wege, in dieser Reihenfolge:
#   1. Das Skript liegt in einem entpackten Paket — dann von dort kopieren.
#      Das braucht kein Netz und funktioniert auch bei privatem Repository.
#   2. Es gibt schon eine Installation — dann aktualisieren.
#   3. Sonst klonen, notfalls mit Token.
QUELLE=""
if [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  MOEGLICH="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." 2>/dev/null && pwd || true)"
  if [[ -n "$MOEGLICH" && -f "$MOEGLICH/package.json" && -d "$MOEGLICH/packages/server" ]]; then
    QUELLE="$MOEGLICH"
  fi
fi

if [[ -n "$QUELLE" && "$QUELLE" != "$ZIEL" ]]; then
  info "aus dem mitgelieferten Paket: $QUELLE"
  mkdir -p "$ZIEL"
  # node_modules und fertige Pakete bleiben draußen — die entstehen hier neu.
  tar -C "$QUELLE" \
      --exclude=node_modules --exclude=.git --exclude=release \
      --exclude=downloads --exclude=data --exclude=dist \
      -cf - . | tar -C "$ZIEL" -xf -
elif [[ -d "$ZIEL/.git" ]]; then
  info "vorhandene Installation aktualisieren"
  git -C "$ZIEL" fetch --quiet origin 2>/dev/null \
    && git -C "$ZIEL" reset --hard --quiet origin/HEAD \
    || warn "Konnte nicht aktualisieren — der bestehende Stand wird neu gebaut"
elif [[ -n "$QUELLE" ]]; then
  info "aus der bestehenden Installation"
else
  ADR="$REPO"
  [[ -n "${STELLIUM_TOKEN:-}" ]] && ADR="${REPO/https:\/\//https:\/\/$STELLIUM_TOKEN@}"
  rm -rf "$ZIEL"
  if ! git clone --quiet --depth 1 "$ADR" "$ZIEL" 2>/dev/null; then
    fehler "$(cat <<HINWEIS
Konnte das Repository nicht holen.

Bei einem privaten Repository gibt es zwei Wege:

  ${FETT}a)${AUS} Das Paket auf den Pi kopieren und von dort starten:
       ${GRAU}scp stellium-server.tar.gz pi@$(hostname):~${AUS}
       ${GRAU}tar xzf stellium-server.tar.gz && cd stellium-server${AUS}
       ${GRAU}sudo bash server-setup/stellium-installieren.sh${AUS}

  ${FETT}b)${AUS} Mit einem Zugriffstoken starten:
       ${GRAU}sudo STELLIUM_TOKEN=ghp_… bash stellium-installieren.sh${AUS}
HINWEIS
)"
  fi
fi

# Wenn hier nichts liegt, ging beim Holen etwas schief. Ein nacktes
# "cd: no such file or directory" hilft niemandem weiter.
[[ -f "$ZIEL/package.json" ]] || fehler "In $ZIEL liegt kein Quelltext. Das Holen ist fehlgeschlagen."

cd "$ZIEL"
info "Abhängigkeiten — das dauert auf einem Pi ein paar Minuten"
# Der Server braucht kein Electron. Dessen Binärpaket ist über 100 MB groß und
# bringt die Einrichtung auf einem Pi regelmäßig zu Fall.
export ELECTRON_SKIP_BINARY_DOWNLOAD=1
export npm_config_electron_skip_binary_download=1

BAULOG="/tmp/stellium-bau.log"
# Optionale Abhängigkeiten müssen mit. Rollup — das Werkzeug hinter dem Bau
# der Oberfläche — liefert seine Maschinencode-Datei je Architektur genau als
# solche aus. Ohne sie bricht "vite build" mit einem MODULE_NOT_FOUND ab, das
# nach einem kaputten Paket aussieht und keines ist.
if ! npm ci --no-audit --no-fund > "$BAULOG" 2>&1; then
  npm install --no-audit --no-fund >> "$BAULOG" 2>&1 || bau_fehlgeschlagen
fi
npm run build:server >> "$BAULOG" 2>&1 || bau_fehlgeschlagen
chown -R "$BENUTZER:$BENUTZER" "$ZIEL"
ok "gebaut"

schritt "Schlüssel sicher ablegen"
# Auf dem Pi gibt es keine Keychain. Das Masterpasswort landet in einer Datei,
# die nur root schreiben und nur der Dienst lesen darf.
UMGEBUNG="/etc/stellium.env"
if [[ -f "$UMGEBUNG" ]] && grep -q STELLIUM_MASTER_PASSPHRASE "$UMGEBUNG"; then
  info "Masterpasswort besteht bereits — bleibt unverändert"
else
  MASTER="$(head -c 32 /dev/urandom | base64 | tr -d '=+/' | head -c 43)"
  cat > "$UMGEBUNG" <<ENV
# Von stellium-installieren.sh erzeugt. Nicht ins Netz stellen.
STELLIUM_MASTER_PASSPHRASE=$MASTER
DATA_DIR=$DATEN
PORT=$PORT
HOST=127.0.0.1
ENV
fi
chown root:"$BENUTZER" "$UMGEBUNG"
chmod 640 "$UMGEBUNG"
ok "Masterpasswort in $UMGEBUNG (nur root und $BENUTZER)"

if [[ -n "${GROQ:-}" ]]; then
  # Über das mitgelieferte Werkzeug, damit der Schlüssel verschlüsselt im
  # Tresor landet und nicht im Klartext irgendwo herumliegt.
  set -a
  # shellcheck source=/dev/null
  . "$UMGEBUNG"
  set +a

  # Gegen das gebaute dist/, nicht über tsx: auf dem Pi soll dafür nichts
  # nachgeladen werden. Der Wert geht über die Standardeingabe und taucht
  # damit nie in der Prozessliste auf.
  if AUSGABE="$(printf '%s' "$GROQ" | sudo -u "$BENUTZER" \
       env STELLIUM_MASTER_PASSPHRASE="$STELLIUM_MASTER_PASSPHRASE" DATA_DIR="$DATEN" \
       node "$ZIEL/server-setup/schluessel-ablegen.mjs" groq 2>&1)"; then
    ok "Groq-Schlüssel verschlüsselt abgelegt"
  else
    warn "Groq-Schlüssel konnte nicht abgelegt werden:"
    printf '    %s\n' "$AUSGABE" | head -4
    warn "Nachholbar mit:  sudo bash $0"
  fi
  unset GROQ
else
  info "Kein Groq-Schlüssel — KI bleibt aus, alles andere läuft"
fi

schritt "Dienst einrichten"
cat > /etc/systemd/system/stellium.service <<DIENST
[Unit]
Description=Stellium — Team-Chat mit Live-Übersetzung
Documentation=https://github.com/chackrahunter/stellium-chat
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$BENUTZER
Group=$BENUTZER
WorkingDirectory=$ZIEL/packages/server
EnvironmentFile=$UMGEBUNG
ExecStart=/usr/bin/node $ZIEL/packages/server/dist/index.js
Restart=always
RestartSec=5

# Der Dienst braucht nichts vom übrigen System.
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=true
LockPersonality=true
MemoryDenyWriteExecute=false
ReadWritePaths=$DATEN

StandardOutput=journal
StandardError=journal
SyslogIdentifier=stellium

[Install]
WantedBy=multi-user.target
DIENST

systemctl daemon-reload
systemctl enable --quiet stellium
systemctl restart stellium
sleep 4
systemctl is-active --quiet stellium && ok "Dienst läuft und startet bei jedem Neustart mit" \
  || fehler "Der Dienst startet nicht. Sieh nach mit: journalctl -u stellium -n 50"

# ── nginx ───────────────────────────────────────────────────────
schritt "nginx einrichten"

# Bausteine, die beide Varianten teilen.
cat > /etc/nginx/conf.d/stellium-upgrade.conf <<'MAP'
# "Connection: upgrade" nur dann, wenn der Aufrufer das auch will.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
MAP

# Die Serveransicht gehört nicht ins Netz. Der Dienst selbst weist Fremde
# schon ab; das hier ist die zweite Tür davor.
cat > /etc/nginx/snippets/stellium-nurhier.conf <<'NURHIER'
location /konsole    { return 404; }
location /api/system { return 404; }
NURHIER

cat > /etc/nginx/snippets/stellium-proxy.conf <<'PROXY'
proxy_pass http://127.0.0.1:8787;

proxy_http_version 1.1;
proxy_set_header Host              $host;
proxy_set_header X-Real-IP         $remote_addr;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;

# Der Chat hängt an einer WebSocket-Verbindung. Ohne diese beiden Zeilen
# lädt die Oberfläche und bleibt danach still.
proxy_set_header Upgrade    $http_upgrade;
proxy_set_header Connection $connection_upgrade;

# Eine offene Verbindung darf lange still sein, ohne gekappt zu werden.
proxy_read_timeout  7d;
proxy_send_timeout  7d;

client_max_body_size 200m;
proxy_request_buffering off;
PROXY

cat > /etc/nginx/snippets/stellium-sicherheit.conf <<'SICHER'
# Der Browser soll nichts zulassen, was die App nicht braucht.
add_header X-Content-Type-Options     "nosniff"     always;
add_header X-Frame-Options            "DENY"        always;
add_header Referrer-Policy            "no-referrer" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Permissions-Policy         "geolocation=(), camera=(), microphone=(self), payment=()" always;

# Versionsnummer verrät nur Angreifern etwas. Bewusst hier im Server-Block:
# Debian setzt server_tokens bereits im http-Block, und zweimal im selben
# Zusammenhang lehnt nginx rundheraus ab.
server_tokens off;
SICHER

cat > /etc/nginx/snippets/stellium-tls.conf <<'TLS'
# Nur noch das, was als sicher gilt. TLS 1.0 und 1.1 sind seit Jahren gebrochen.
ssl_protocols             TLSv1.2 TLSv1.3;
ssl_ciphers               ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305;
ssl_prefer_server_ciphers off;
ssl_session_timeout       1d;
ssl_session_cache         shared:StelliumTLS:10m;
ssl_session_tickets       off;
ssl_stapling              on;
ssl_stapling_verify       on;
TLS

# Aus einer früheren Fassung: die Datei setzte server_tokens ein zweites Mal
# im http-Block, was nginx als Duplikat ablehnt.
rm -f /etc/nginx/conf.d/stellium-tokens.conf

mkdir -p /var/www/html/.well-known/acme-challenge
rm -f /etc/nginx/sites-enabled/default

# Bei einem Fehler nicht auf nginx -t verweisen, sondern gleich zeigen, was
# es sagt — sonst muss man den Befehl selbst noch einmal von Hand tippen.
pruefe_nginx() {
  local ausgabe
  if ! ausgabe="$(nginx -t 2>&1)"; then
    fehler "$(printf 'nginx lehnt die Konfiguration ab:\n\n%s' "$ausgabe")"
  fi
}

schreibe_nur_http() {
  cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen $PORT_HTTP default_server;
  listen [::]:$PORT_HTTP default_server;
  server_name ${1:-_};

  include snippets/stellium-sicherheit.conf;
  include snippets/stellium-nurhier.conf;

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
}

schreibe_mit_tls() {
  local NAME="$1"
  # Nur wenn HTTPS woanders läuft, gehört der Port in die Weiterleitung.
  local SUFFIX=""
  [[ "$PORT_HTTPS" != "443" ]] && SUFFIX=":$PORT_HTTPS"
  cat > /etc/nginx/sites-available/stellium <<NGINX
# Alles Unverschlüsselte geht nach oben — außer der Prüfung von Let's Encrypt,
# die muss über Port 80 laufen.
server {
  listen $PORT_HTTP;
  listen [::]:$PORT_HTTP;
  server_name $NAME;

  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\$host$SUFFIX\$request_uri; }
}

server {
  listen $PORT_HTTPS ssl;
  listen [::]:$PORT_HTTPS ssl;
  http2 on;
  server_name $NAME;

  ssl_certificate     /etc/letsencrypt/live/$NAME/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/$NAME/privkey.pem;
  ssl_trusted_certificate /etc/letsencrypt/live/$NAME/chain.pem;
  include snippets/stellium-tls.conf;

  include snippets/stellium-sicherheit.conf;
  # Zwei Jahre. Ein Browser, der Stellium einmal gesehen hat, fragt danach
  # nie wieder unverschlüsselt — auch nicht, wenn jemand ihn dazu überredet.
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

  location /.well-known/acme-challenge/ { root /var/www/html; }
  include snippets/stellium-nurhier.conf;

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
}

# ── Ports wählen ────────────────────────────────────────────────
#
# 80 und 443 sind die Wunschports: nur dort steht die Adresse ohne Anhängsel.
# Sind sie belegt oder kommt von außen nichts an, weicht die Einrichtung auf
# die nächsten freien aus, statt an einem verschlossenen Router zu scheitern.

port_frei() {
  ! ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

waehle_port() {
  local wunsch="$1"; shift
  for kandidat in "$wunsch" "$@"; do
    port_frei "$kandidat" && { printf '%s' "$kandidat"; return 0; }
  done
  printf '%s' "$wunsch"
}

PORT_HTTP="$(waehle_port 80 8080 8880 8008)"
PORT_HTTPS="$(waehle_port 443 8443 9443 4443)"

if [[ "$PORT_HTTP" != "80" || "$PORT_HTTPS" != "443" ]]; then
  schritt "Ports"
  [[ "$PORT_HTTP"  != "80"  ]] && info "Port 80 ist belegt — nehme $PORT_HTTP"
  [[ "$PORT_HTTPS" != "443" ]] && info "Port 443 ist belegt — nehme $PORT_HTTPS"
fi

ADRESSE=""

if [[ "$WAHL" == "4" ]]; then
  # Der Tunnel spricht nginx auf dem Pi selbst an; nach außen geht nichts
  # direkt. Eingerichtet wird er gleich, nach dem Rest.
  schreibe_nur_http
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  pruefe_nginx
  systemctl enable --quiet nginx
  systemctl restart nginx
  ADRESSE="(wird beim Tunnel vergeben)"
  ok "nginx bereit für den Tunnel"

elif [[ "$WAHL" == "3" ]]; then
  schreibe_nur_http
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  pruefe_nginx
  systemctl enable --quiet nginx
  systemctl restart nginx
  if [[ "$PORT_HTTP" == "80" ]]; then ADRESSE="http://$(lokale_ip)"
  else ADRESSE="http://$(lokale_ip):$PORT_HTTP"; fi
  warn "Unverschlüsselt. Nur im Heimnetz benutzen."

elif [[ "$WAHL" == "4" ]]; then
  : # nichts weiter — der Tunnel bringt die Verschlüsselung mit

else
  # ── DuckDNS: Adresse aktuell halten ─────────────────────────
  if [[ "$WAHL" == "2" ]]; then
    schritt "DuckDNS"
    cat > /etc/stellium-duckdns <<DUCK
DUCK_NAME=$DUCK_NAME
DUCK_TOKEN=$DUCK_TOKEN
DUCK
    chmod 600 /etc/stellium-duckdns

    cat > /usr/local/bin/stellium-duckdns <<'DUCKSKRIPT'
#!/usr/bin/env bash
# Sagt DuckDNS, welche Adresse dieser Anschluss gerade hat.
set -Eeuo pipefail
. /etc/stellium-duckdns
ANTWORT="$(curl -fsS "https://www.duckdns.org/update?domains=$DUCK_NAME&token=$DUCK_TOKEN&ip=")"
[[ "$ANTWORT" == "OK" ]] || { echo "DuckDNS antwortet: $ANTWORT" >&2; exit 1; }
DUCKSKRIPT
    chmod 755 /usr/local/bin/stellium-duckdns

    cat > /etc/systemd/system/stellium-duckdns.service <<'D1'
[Unit]
Description=DuckDNS-Adresse aktualisieren
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-duckdns
D1
    cat > /etc/systemd/system/stellium-duckdns.timer <<'D2'
[Unit]
Description=DuckDNS alle fünf Minuten aktualisieren
[Timer]
OnBootSec=45
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
D2
    systemctl daemon-reload
    systemctl enable --quiet stellium-duckdns.timer
    systemctl start stellium-duckdns.timer

    if /usr/local/bin/stellium-duckdns; then
      ok "$DOMAIN zeigt auf diesen Anschluss und bleibt aktuell"
    else
      fehler "DuckDNS hat den Namen abgelehnt. Stimmen Name und Token?"
    fi
    # Der Name braucht einen Moment, bis ihn alle kennen.
    info "kurz warten, damit die Adresse überall bekannt ist"
    sleep 20
  fi

  # ── Zertifikat ──────────────────────────────────────────────
  schritt "Zertifikat von Let's Encrypt"
  apt-get install -y -qq certbot >/dev/null

  # Zuerst nur Port 80 — sonst verweist die Konfiguration auf ein Zertifikat,
  # das es noch gar nicht gibt, und nginx startet nicht.
  schreibe_nur_http "$DOMAIN"
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  pruefe_nginx
  systemctl enable --quiet nginx
  systemctl restart nginx

  # ── Zertifikat besorgen ─────────────────────────────────────
  #
  # Zwei Wege, und der erste braucht keinen offenen Port:
  #
  #   DuckDNS  → Let's Encrypt fragt einen DNS-Eintrag ab, den wir setzen.
  #              Der Router muss dafür gar nichts durchlassen.
  #   Domain   → Let's Encrypt ruft Port 80 auf. Der muss erreichbar sein.

  von_aussen_erreichbar() {
    local probe="stellium-$RANDOM$RANDOM"
    echo "$probe" > "/var/www/html/.well-known/acme-challenge/$probe"
    local antwort
    antwort="$(curl -fsS --max-time 12 "http://$DOMAIN:$PORT_HTTP/.well-known/acme-challenge/$probe" 2>/dev/null || true)"
    rm -f "/var/www/html/.well-known/acme-challenge/$probe"
    [[ "$antwort" == "$probe" ]]
  }

  if [[ "$WAHL" == "2" ]]; then
    # DuckDNS beantwortet die Prüfung über einen TXT-Eintrag. Zwei kleine
    # Skripte setzen und räumen ihn wieder weg; certbot ruft sie selbst auf.
    cat > /usr/local/bin/stellium-duckdns-txt <<'TXT'
#!/usr/bin/env bash
# Setzt oder löscht den Prüfeintrag bei DuckDNS.
set -Eeuo pipefail
. /etc/stellium-duckdns
if [[ "${1:-setzen}" == "loeschen" ]]; then
  curl -fsS "https://www.duckdns.org/update?domains=$DUCK_NAME&token=$DUCK_TOKEN&txt=geloescht&clear=true" >/dev/null
else
  [[ -n "${CERTBOT_VALIDATION:-}" ]] || { echo "CERTBOT_VALIDATION fehlt — certbot ruft dieses Skript selbst auf." >&2; exit 1; }
  curl -fsS "https://www.duckdns.org/update?domains=$DUCK_NAME&token=$DUCK_TOKEN&txt=$CERTBOT_VALIDATION" >/dev/null
  # Der Eintrag braucht einen Moment, bis Let's Encrypt ihn sieht.
  sleep 35
fi
TXT
    chmod 755 /usr/local/bin/stellium-duckdns-txt
  fi

  if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    info "Zertifikat besteht bereits"
  elif [[ "$WAHL" == "2" ]]; then
    info "über einen DNS-Eintrag bei DuckDNS — dafür muss kein Port offen sein"
    if [[ -n "$MAIL" ]]; then MAIL_ARG=(-m "$MAIL" --no-eff-email)
    else MAIL_ARG=(--register-unsafely-without-email); fi

    certbot certonly --manual --preferred-challenges dns \
      --manual-auth-hook "/usr/local/bin/stellium-duckdns-txt setzen" \
      --manual-cleanup-hook "/usr/local/bin/stellium-duckdns-txt loeschen" \
      -d "$DOMAIN" --non-interactive --agree-tos "${MAIL_ARG[@]}" >/dev/null 2>&1 \
      || fehler "$(printf 'Let'"'"'s Encrypt hat kein Zertifikat ausgestellt.\n\nGenauer nachsehen:\n  sudo certbot certonly --manual --preferred-challenges dns \\\n    --manual-auth-hook "/usr/local/bin/stellium-duckdns-txt setzen" \\\n    --manual-cleanup-hook "/usr/local/bin/stellium-duckdns-txt loeschen" -d %s' "$DOMAIN")"
  else
    certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
      --non-interactive --agree-tos "${MAIL_ARG[@]}" >/dev/null 2>&1 \
      || fehler "Let's Encrypt hat kein Zertifikat ausgestellt. Genauer:  certbot certonly --webroot -w /var/www/html -d $DOMAIN"
  fi
  ok "Zertifikat für $DOMAIN"

  merken "$WAHL" "$DOMAIN" "$MAIL" "${DUCK_NAME:+$DUCK_NAME:$DUCK_TOKEN}" "$PORT_HTTP" "$PORT_HTTPS"

  # Jetzt die vollständige Konfiguration mit TLS.
  schreibe_mit_tls "$DOMAIN"
  pruefe_nginx
  systemctl reload nginx
  ok "nginx nimmt HTTPS entgegen und reicht nach innen weiter"

  # Verlängerung läuft automatisch; nginx muss danach neu laden.
  mkdir -p /etc/letsencrypt/renewal-hooks/deploy
  cat > /etc/letsencrypt/renewal-hooks/deploy/stellium-nginx.sh <<'HOOK'
#!/usr/bin/env bash
systemctl reload nginx
HOOK
  chmod 755 /etc/letsencrypt/renewal-hooks/deploy/stellium-nginx.sh
  systemctl enable --quiet certbot.timer 2>/dev/null || true
  systemctl start certbot.timer 2>/dev/null || true
  ok "Verlängerung läuft automatisch"

  if [[ "$PORT_HTTPS" == "443" ]]; then ADRESSE="https://$DOMAIN"
  else ADRESSE="https://$DOMAIN:$PORT_HTTPS"; fi
fi

# ── Absichern ───────────────────────────────────────────────────
schritt "Firewall und Einbruchsschutz"

ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow "$PORT_HTTP/tcp"  >/dev/null
ufw allow "$PORT_HTTPS/tcp" >/dev/null
info "Offen: SSH, $PORT_HTTP, $PORT_HTTPS — sonst nichts"
ufw --force enable >/dev/null
ok "Firewall aktiv"

# Der Chat-Port selbst ist von außen ohnehin nicht erreichbar: der Dienst
# hört auf 127.0.0.1. Die Firewall ist die zweite Linie, nicht die erste.

cat > /etc/fail2ban/jail.d/stellium.conf <<'JAIL'
[nginx-http-auth]
enabled = true

[nginx-limit-req]
enabled = true

[sshd]
enabled  = true
maxretry = 4
bantime  = 1h
JAIL
systemctl enable --quiet fail2ban
systemctl restart fail2ban
ok "fail2ban wacht über SSH und nginx"

# Sicherheitsaktualisierungen von selbst, inklusive Neustart nachts um vier
# falls einer nötig wird.
cat > /etc/apt/apt.conf.d/51stellium-unattended <<'AUTO'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:00";
Unattended-Upgrade::Remove-Unused-Dependencies "true";
AUTO
systemctl enable --quiet unattended-upgrades
systemctl restart unattended-upgrades
ok "Sicherheitsaktualisierungen laufen automatisch"

# ── Statuskonsole ───────────────────────────────────────────────
schritt "Statuskonsole"

install -o "$BENUTZER" -g "$BENUTZER" -m 755 -d /usr/local/lib/stellium
cp "$ZIEL/server-setup/stellium-konsole.mjs" /usr/local/lib/stellium/konsole.mjs
chmod 755 /usr/local/lib/stellium/konsole.mjs

install -m 755 "$ZIEL/server-setup/stellium-zugang.sh" /usr/local/bin/stellium-zugang
install -m 755 "$ZIEL/server-setup/stellium-tunnel.sh" /usr/local/bin/stellium-tunnel
# "stellium-update" ist der Befehl, den man von Hand aufruft: er holt den
# neuen Stand vom Server. Der Teil, der im entpackten Paket arbeitet, liegt
# daneben und wird von dort aufgerufen — von Hand war er nur verwirrend.
install -m 755 "$ZIEL/server-setup/stellium-selbstupdate.sh" /usr/local/bin/stellium-update
install -m 755 "$ZIEL/server-setup/stellium-aktualisieren.sh" /usr/local/bin/stellium-einspielen
install -m 755 "$ZIEL/server-setup/stellium-selbstupdate.sh" /usr/local/bin/stellium-selbstupdate

# Die Knöpfe der Serveransicht brauchen genau drei Dinge — sonst nichts.
cat > /etc/sudoers.d/stellium-konsole <<SUDO
$BENUTZER ALL=(root) NOPASSWD: /usr/bin/systemctl restart stellium, /usr/local/bin/stellium-sichern, /usr/local/bin/stellium-selbstupdate pruefen
SUDO
chmod 440 /etc/sudoers.d/stellium-konsole
ok "stellium-zugang, stellium-tunnel, stellium-update, stellium-einspielen"

# Alle dreißig Minuten nach einem neuen Serverstand sehen. Ohne hinterlegten
# Zugang meldet das Skript sich mit einem Hinweis und tut sonst nichts.
cat > /etc/systemd/system/stellium-selbstupdate.service <<'SU1'
[Unit]
Description=Stellium: nach einem neuen Serverstand sehen
After=network-online.target stellium.service
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-selbstupdate
SU1
cat > /etc/systemd/system/stellium-selbstupdate.timer <<'SU2'
[Unit]
Description=Alle 30 Minuten nach einem neuen Serverstand sehen
[Timer]
OnBootSec=5min
OnUnitActiveSec=30min
RandomizedDelaySec=3min
[Install]
WantedBy=timers.target
SU2
systemctl daemon-reload
systemctl enable --quiet stellium-selbstupdate.timer
systemctl start stellium-selbstupdate.timer
ok "sieht alle 30 Minuten nach neuen Serverständen"

cat > /usr/local/bin/stellium <<KONSOLE
#!/usr/bin/env bash
# Statuskonsole. Ohne Argument läuft sie fortlaufend, mit "einmal" nur einmal.
exec /usr/bin/node /usr/local/lib/stellium/konsole.mjs "\$@"
KONSOLE
chmod 755 /usr/local/bin/stellium

# Beim Anmelden von selbst öffnen.
BROWSER=""
for kandidat in chromium-browser chromium google-chrome firefox; do
  command -v "$kandidat" >/dev/null 2>&1 && { BROWSER="$kandidat"; break; }
done

if [[ -d /etc/xdg/autostart && -n "$BROWSER" ]]; then
  # Mit Desktop: ein eigenes Fenster mit der Serveransicht. Kein Terminal —
  # eine Übersicht mit Knöpfen liest sich schlicht besser als Textausgabe.
  if [[ "$BROWSER" == firefox ]]; then
    START="$BROWSER --new-window http://127.0.0.1:$PORT/konsole"
  else
    START="$BROWSER --app=http://127.0.0.1:$PORT/konsole --window-size=1240,860 --disable-features=TranslateUI"
  fi

  cat > /etc/xdg/autostart/stellium-konsole.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Stellium — Server
Comment=Übersicht und Bedienung des Chat-Servers
Exec=$START
Icon=utilities-system-monitor
Terminal=false
X-GNOME-Autostart-Delay=12
DESKTOP

  # Auch im Startmenü, damit man es nach dem Schließen wiederfindet.
  install -d /usr/share/applications
  cat > /usr/share/applications/stellium-konsole.desktop <<DESKTOP
[Desktop Entry]
Type=Application
Name=Stellium — Server
Comment=Übersicht und Bedienung des Chat-Servers
Exec=$START
Icon=utilities-system-monitor
Terminal=false
Categories=System;Monitor;
DESKTOP

  ok "Öffnet sich beim Anmelden als eigenes Fenster ($BROWSER)"
elif [[ -d /etc/xdg/autostart ]]; then
  warn "Kein Browser gefunden — die Ansicht gibt es unter http://127.0.0.1:$PORT/konsole"
else
  # Ohne Desktop: einmalige Übersicht bei jeder Anmeldung an der Konsole.
  cat > /etc/profile.d/zz-stellium.sh <<'PROFIL'
# Beim Anmelden kurz zeigen, wie es dem Server geht.
# Nur bei einer echten Sitzung am Terminal, nicht bei jedem Skript.
if [[ $- == *i* ]] && [[ -z "${STELLIUM_STILL:-}" ]] && command -v stellium >/dev/null; then
  stellium einmal
fi
PROFIL
  chmod 644 /etc/profile.d/zz-stellium.sh
  ok "Zeigt sich bei jeder Anmeldung an der Konsole"
fi

# ── Sicherung ───────────────────────────────────────────────────
schritt "Nächtliche Sicherung"

cat > /usr/local/bin/stellium-sichern <<'SICHERUNG'
#!/usr/bin/env bash
# Kopie der Datenbank, ohne den Dienst anzuhalten.
set -Eeuo pipefail
ZIEL="/var/lib/stellium/sicherungen"
mkdir -p "$ZIEL"
STAND="$(date +%Y%m%d-%H%M)"
# .backup statt cp: eine laufende Datenbank lässt sich nicht einfach kopieren.
sqlite3 /var/lib/stellium/stellium.db ".backup '$ZIEL/stellium-$STAND.db'" 2>/dev/null \
  || cp /var/lib/stellium/stellium.db "$ZIEL/stellium-$STAND.db"
gzip -f "$ZIEL/stellium-$STAND.db"

# Der Tresor gehört dazu: ohne ihn fehlt nach einer Wiederherstellung der
# Groq-Schlüssel. Er ist selbst verschlüsselt und darf hier liegen.
[[ -f /var/lib/stellium/secrets.enc ]] && cp -f /var/lib/stellium/secrets.enc "$ZIEL/secrets.enc"

# Der Hinweis, ohne den eine Sicherung wertlos wäre.
cat > "$ZIEL/LIESMICH.txt" <<'HINWEIS'
Diese Sicherungen enthalten die Datenbank — die Nachrichten darin sind
verschlüsselt.

Zum Wiederherstellen braucht es zusätzlich das Masterpasswort aus

    /etc/stellium.env      (Zeile STELLIUM_MASTER_PASSPHRASE=...)

Ohne dieses Passwort lässt sich keine Nachricht mehr lesen — auch nicht
mit Zugriff auf die Datenbankdatei. Bewahre es getrennt von den
Sicherungen auf, zum Beispiel im Passwortmanager der Firma.

Wiederherstellen:
    sudo systemctl stop stellium
    gunzip -c stellium-JJJJMMTT-HHMM.db.gz > /var/lib/stellium/stellium.db
    sudo chown stellium:stellium /var/lib/stellium/stellium.db
    sudo systemctl start stellium
HINWEIS

# Vierzehn Stände reichen; ältere weg.
ls -1t "$ZIEL"/stellium-*.db.gz 2>/dev/null | tail -n +15 | xargs -r rm -f
SICHERUNG
chmod 755 /usr/local/bin/stellium-sichern
apt-get install -y -qq sqlite3 >/dev/null

cat > /etc/systemd/system/stellium-sicherung.service <<'DIENST'
[Unit]
Description=Stellium sichern
[Service]
Type=oneshot
User=stellium
ExecStart=/usr/local/bin/stellium-sichern
DIENST

cat > /etc/systemd/system/stellium-sicherung.timer <<'TIMER'
[Unit]
Description=Stellium jede Nacht sichern
[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --quiet stellium-sicherung.timer
systemctl start stellium-sicherung.timer
ok "Jede Nacht um 3:30, vierzehn Stände werden aufgehoben"

# ── Fertig ──────────────────────────────────────────────────────
sleep 2
EINMAL="$(journalctl -u stellium --no-pager -n 200 2>/dev/null | grep -oE '[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}' | tail -1 || true)"
KONTO="$(journalctl -u stellium --no-pager -n 200 2>/dev/null | grep -A1 'Benutzername' | tail -1 | awk '{print $NF}' || true)"
if [[ "$PORT_HTTP" == "80" ]]; then LOKAL="http://$(lokale_ip)"
else LOKAL="http://$(lokale_ip):$PORT_HTTP"; fi

if [[ "$WAHL" == "4" ]]; then
  schritt "Tunnel einrichten"
  /usr/local/bin/stellium-tunnel || warn "Der Tunnel wurde nicht fertig eingerichtet — nachholbar mit: sudo stellium-tunnel"
  [[ -r "$DATEN/tunnel-adresse" ]] && ADRESSE="$(cat "$DATEN/tunnel-adresse")"
fi

# Erreicht euch das Team wirklich? Das Zertifikat allein genügt nicht — die
# Verbindung muss auch durch den Router kommen.
VON_AUSSEN_DA=0
if [[ "$WAHL" != "3" && "$WAHL" != "4" ]]; then
  if curl -fsS --max-time 10 -o /dev/null "$ADRESSE/api/health" 2>/dev/null; then
    VON_AUSSEN_DA=1
  fi
fi

cat <<ENDE

${GRUEN}${FETT}   ✓  Fertig.${AUS}

   ${FETT}Verbinden${AUS}
     Von außen   ${BLAU}${ADRESSE}${AUS}
     Im Heimnetz ${GRAU}${LOKAL}${AUS}

     In der App unter ${FETT}Einstellungen → Server${AUS} eintragen.

ENDE

if [[ "$WAHL" != "3" && "$WAHL" != "4" && "$VON_AUSSEN_DA" == "0" ]]; then
  # Erst selbst versuchen, den Router zu überreden — dafür braucht es keinen
  # Zugang zu seiner Oberfläche, sofern UPnP dort nicht abgeschaltet ist.
  schritt "Von außen erreichbar machen"
  if /usr/local/bin/stellium-zugang; then
    VON_AUSSEN_DA=1
  else
    cat <<OFFEN

   ${GELB}${FETT}Von außen kommt noch nichts an.${AUS}

   Das Zertifikat steht und im Heimnetz läuft alles. Es fehlt nur der
   Weg durch den Router — ${FETT}ein${AUS} Port genügt:

       Port ${FETT}${PORT_HTTPS}${AUS}  →  ${FETT}$(lokale_ip)${AUS}   Port ${PORT_HTTPS}   (TCP)

   Bei einer FRITZ!Box: Internet → Freigaben → Portfreigaben →
   Gerät für Freigaben hinzufügen. Sonst heißt es meist
   "Portweiterleitung" oder "Port Forwarding".

   ${GRAU}Kommst du an den Router nicht heran, versuch es später noch
   einmal mit  sudo stellium-zugang  — oder frag nach einem Tunnel,
   dann baut der Pi die Verbindung selbst nach außen auf.

   Im Heimnetz funktioniert Stellium schon jetzt über ${LOKAL}.${AUS}

OFFEN
  fi
fi

if [[ -n "$EINMAL" ]]; then
cat <<ZUGANG
   ${FETT}Erster Zugang${AUS}
     Benutzername    ${FETT}${KONTO:-siehe unten}${AUS}
     Einmal-Passwort ${FETT}${EINMAL}${AUS}

     Beim ersten Anmelden legst du eigenes Passwort, Benutzernamen
     und E-Mail fest. Danach ist dieses Passwort ungültig.

ZUGANG
else
cat <<ZUGANG
   ${FETT}Erster Zugang${AUS}
     ${GRAU}sudo journalctl -u stellium | grep -A6 Einmal${AUS}

ZUGANG
fi

cat <<BEFEHLE
   ${FETT}Befehle${AUS}
     ${BLAU}stellium${AUS}                        Statuskonsole
     ${GRAU}sudo stellium-zugang${AUS}            Ports ohne Router-Zugang öffnen
     ${GRAU}sudo stellium-tunnel${AUS}            Weg nach außen ohne Portfreigabe
     ${GRAU}sudo stellium-update${AUS}            neuen Stand holen und einspielen
     ${GRAU}sudo systemctl restart stellium${AUS} neu starten
     ${GRAU}sudo journalctl -u stellium -f${AUS}  mitlesen
     ${GRAU}sudo stellium-sichern${AUS}           sofort sichern

   Der Server startet bei jedem Neustart von selbst mit.

BEFEHLE

cat <<SCHLUESSEL
   ${FETT}Masterpasswort${AUS}
     Nachrichten liegen verschlüsselt in der Datenbank. Der Schlüssel
     dazu steht in ${FETT}/etc/stellium.env${AUS}.

     ${GELB}Schreibe ihn dir weg — ohne ihn ist keine Sicherung lesbar.${AUS}
     ${GRAU}sudo grep MASTER /etc/stellium.env${AUS}

SCHLUESSEL

if [[ "$WAHL" == "3" ]]; then
  printf '   %s! Diese Einrichtung ist unverschlüsselt. Für den Firmenbetrieb%s\n' "$GELB" "$AUS"
  printf '   %s  später auf Variante 1 oder 2 wechseln — einfach dieses Skript%s\n' "$GELB" "$AUS"
  printf '   %s  noch einmal ausführen.%s\n\n' "$GELB" "$AUS"
fi
