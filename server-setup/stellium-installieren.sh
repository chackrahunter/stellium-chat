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

  ${GRAU}Für 1 und 2 müssen Port 80 und 443 im Router auf diesen Pi
  weitergeleitet sein — sonst kann Let's Encrypt nicht prüfen,
  dass die Adresse wirklich dir gehört.${AUS}

ERKLAERUNG

WAHL=""
DOMAIN=""
MAIL=""
DUCK_NAME=""
DUCK_TOKEN=""
DUCK_VORGABE=""
while [[ -z "$WAHL" ]]; do
  WAHL="$(frage "Deine Wahl [1/2/3]: " "${STELLIUM_MODE:-}")"
  case "$WAHL" in
    1)
      while [[ -z "$DOMAIN" ]]; do
        DOMAIN="$(frage "Domain (z.B. chat.meinefirma.de): " "${STELLIUM_DOMAIN:-}")"
        [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]] || {
          warn "Das sieht nicht nach einer Domain aus."; DOMAIN=""; }
      done
      while [[ -z "$MAIL" ]]; do
        MAIL="$(frage "E-Mail für Let's Encrypt (Warnung vor Ablauf): " "${STELLIUM_MAIL:-}")"
        [[ "$MAIL" == *@*.* ]] || { warn "Das sieht nicht nach einer E-Mail aus."; MAIL=""; }
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
      while [[ -z "$MAIL" ]]; do
        MAIL="$(frage "E-Mail für Let's Encrypt (Warnung vor Ablauf): " "${STELLIUM_MAIL:-}")"
        [[ "$MAIL" == *@*.* ]] || { warn "Das sieht nicht nach einer E-Mail aus."; MAIL=""; }
      done
      ;;
    3)
      warn "Ohne Verschlüsselung kann jeder im selben Netz mitlesen."
      SICHER="$(frage "Wirklich? [ja/nein]: " "ja")"
      [[ "$SICHER" == "ja" ]] || WAHL=""
      ;;
    *) warn "Bitte 1, 2 oder 3."; WAHL="" ;;
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
  jq bc miniupnpc natpmpc >/dev/null 2>&1 \
  || apt-get install -y -qq curl ca-certificates gnupg git build-essential \
       nginx ufw fail2ban unattended-upgrades apt-listchanges jq bc >/dev/null
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
npm ci --omit=optional --no-audit --no-fund >/dev/null 2>&1 \
  || npm install --no-audit --no-fund >/dev/null 2>&1
npm run build:shared >/dev/null 2>&1
npm run build -w @stellium/server >/dev/null 2>&1
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
  printf '%s\n' "$GROQ" | sudo -u "$BENUTZER" \
    env STELLIUM_MASTER_PASSPHRASE="$STELLIUM_MASTER_PASSPHRASE" DATA_DIR="$DATEN" \
    npx --yes tsx "$ZIEL/packages/server/src/cli/secret.ts" setzen groq >/dev/null 2>&1 \
    && ok "Groq-Schlüssel verschlüsselt abgelegt" \
    || warn "Groq-Schlüssel konnte nicht abgelegt werden — später nachholbar"
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

# Versionsnummer verrät nur Angreifern etwas.
cat > /etc/nginx/conf.d/stellium-tokens.conf <<'TOK'
server_tokens off;
TOK

mkdir -p /var/www/html/.well-known/acme-challenge
rm -f /etc/nginx/sites-enabled/default

schreibe_nur_http() {
  cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name ${1:-_};

  include snippets/stellium-sicherheit.conf;

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
}

schreibe_mit_tls() {
  local NAME="$1"
  cat > /etc/nginx/sites-available/stellium <<NGINX
# Alles Unverschlüsselte geht nach oben — außer der Prüfung von Let's Encrypt,
# die muss über Port 80 laufen.
server {
  listen 80;
  listen [::]:80;
  server_name $NAME;

  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\$host\$request_uri; }
}

server {
  listen 443 ssl;
  listen [::]:443 ssl;
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

  location / {
    include snippets/stellium-proxy.conf;
  }
}
NGINX
}

ADRESSE=""

if [[ "$WAHL" == "3" ]]; then
  schreibe_nur_http
  ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
  nginx -t >/dev/null 2>&1 || fehler "nginx-Konfiguration fehlerhaft — nginx -t zeigt warum"
  systemctl enable --quiet nginx
  systemctl restart nginx
  ADRESSE="http://$(lokale_ip)"
  warn "Unverschlüsselt. Nur im Heimnetz benutzen."

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
  nginx -t >/dev/null 2>&1 || fehler "nginx-Konfiguration fehlerhaft — nginx -t zeigt warum"
  systemctl enable --quiet nginx
  systemctl restart nginx

  # ── Ports ───────────────────────────────────────────────────
  schritt "Ports prüfen"

  # Kommt eine Anfrage von außen wirklich hier an?
  von_aussen_erreichbar() {
    local probe="stellium-$RANDOM$RANDOM"
    echo "$probe" > "/var/www/html/.well-known/acme-challenge/$probe"
    local antwort
    antwort="$(curl -fsS --max-time 12 "http://$DOMAIN/.well-known/acme-challenge/$probe" 2>/dev/null || true)"
    rm -f "/var/www/html/.well-known/acme-challenge/$probe"
    [[ "$antwort" == "$probe" ]]
  }

  # Den Router bitten, die Ports weiterzuleiten. Die meisten Heimrouter
  # können das über UPnP oder NAT-PMP, sofern es nicht abgeschaltet ist.
  ports_erbitten() {
    local ip; ip="$(lokale_ip)"
    local gelungen=0

    if command -v upnpc >/dev/null; then
      for port in 80 443; do
        if upnpc -e "Stellium" -a "$ip" "$port" "$port" TCP 86400 >/dev/null 2>&1 \
           || upnpc -e "Stellium" -a "$ip" "$port" "$port" TCP >/dev/null 2>&1; then
          gelungen=1
        fi
      done
      [[ $gelungen -eq 1 ]] && info "Router über UPnP gebeten, 80 und 443 weiterzuleiten"
    fi

    if [[ $gelungen -eq 0 ]] && command -v natpmpc >/dev/null; then
      for port in 80 443; do
        natpmpc -a "$port" "$port" tcp 86400 >/dev/null 2>&1 && gelungen=1
      done
      [[ $gelungen -eq 1 ]] && info "Router über NAT-PMP gebeten, 80 und 443 weiterzuleiten"
    fi

    return $(( gelungen == 1 ? 0 : 1 ))
  }

  if von_aussen_erreichbar; then
    ok "$DOMAIN ist von außen erreichbar"
  else
    info "noch nicht erreichbar — ich versuche, die Ports selbst zu öffnen"

    if ports_erbitten; then
      # Der Router braucht einen Moment, bis die Regel greift.
      for _ in 1 2 3; do
        sleep 6
        if von_aussen_erreichbar; then
          ok "$DOMAIN ist jetzt erreichbar — der Router hat die Ports geöffnet"
          PORTS_AUTOMATISCH=1
          break
        fi
      done
    fi

    if [[ "${PORTS_AUTOMATISCH:-0}" != "1" ]]; then
      OEFFENTLICH="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null || echo 'deine öffentliche IP')"
      fehler "$(cat <<HINWEIS
$DOMAIN ist von außen auf Port 80 nicht erreichbar, und der Router
lässt sich nicht automatisch dazu bewegen.

${FETT}Das musst du einmal im Router eintragen:${AUS}

    Port ${FETT}80${AUS}   →  ${FETT}$(lokale_ip)${AUS}   Port 80   (TCP)
    Port ${FETT}443${AUS}  →  ${FETT}$(lokale_ip)${AUS}   Port 443  (TCP)

  Bei einer FRITZ!Box: Internet → Freigaben → Portfreigaben → Gerät
  für Freigaben hinzufügen. Bei anderen Routern heißt es meist
  "Portweiterleitung", "Port Forwarding" oder "Virtual Server".

${FETT}Falls du UPnP im Router einschalten kannst${AUS}, geht es auch von selbst —
  dann dieses Skript einfach noch einmal starten.

${GRAU}Zur Kontrolle: dein Anschluss ist von außen $OEFFENTLICH,
  und $DOMAIN sollte genau darauf zeigen.${AUS}

Alles bisher Eingerichtete bleibt bestehen. Nach der Freigabe einfach
dieses Skript noch einmal ausführen.
HINWEIS
)"
    fi
  fi

  # UPnP-Freigaben laufen ab. Ein Timer erneuert sie, solange sie gebraucht werden.
  if [[ "${PORTS_AUTOMATISCH:-0}" == "1" ]]; then
    cat > /usr/local/bin/stellium-ports <<'PORTS'
#!/usr/bin/env bash
# Erneuert die Portfreigabe im Router. UPnP-Regeln laufen nach Stunden ab.
set -Eeuo pipefail
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[[ -n "$IP" ]] || exit 0
for PORT in 80 443; do
  if command -v upnpc >/dev/null; then
    upnpc -e "Stellium" -a "$IP" "$PORT" "$PORT" TCP 86400 >/dev/null 2>&1 && continue
  fi
  command -v natpmpc >/dev/null && natpmpc -a "$PORT" "$PORT" tcp 86400 >/dev/null 2>&1 || true
done
PORTS
    chmod 755 /usr/local/bin/stellium-ports

    cat > /etc/systemd/system/stellium-ports.service <<'P1'
[Unit]
Description=Portfreigabe im Router erneuern
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-ports
P1
    cat > /etc/systemd/system/stellium-ports.timer <<'P2'
[Unit]
Description=Portfreigabe stündlich erneuern
[Timer]
OnBootSec=60
OnUnitActiveSec=1h
[Install]
WantedBy=timers.target
P2
    systemctl daemon-reload
    systemctl enable --quiet stellium-ports.timer
    systemctl start stellium-ports.timer
    ok "Freigabe wird stündlich erneuert, damit sie nicht abläuft"
  fi

  if [[ -d "/etc/letsencrypt/live/$DOMAIN" ]]; then
    info "Zertifikat besteht bereits"
  else
    certbot certonly --webroot -w /var/www/html -d "$DOMAIN" \
      --non-interactive --agree-tos -m "$MAIL" --no-eff-email >/dev/null 2>&1 \
      || fehler "Let's Encrypt hat kein Zertifikat ausgestellt. Genauer:  certbot certonly --webroot -w /var/www/html -d $DOMAIN"
  fi
  ok "Zertifikat für $DOMAIN"

  # Jetzt die vollständige Konfiguration mit TLS.
  schreibe_mit_tls "$DOMAIN"
  nginx -t >/dev/null 2>&1 || fehler "nginx-Konfiguration fehlerhaft — nginx -t zeigt warum"
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

  ADRESSE="https://$DOMAIN"
fi

# ── Absichern ───────────────────────────────────────────────────
schritt "Firewall und Einbruchsschutz"

ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp  >/dev/null
ufw allow 443/tcp >/dev/null
info "Offen: SSH, 80, 443 — sonst nichts"
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

cat > /usr/local/bin/stellium <<KONSOLE
#!/usr/bin/env bash
# Statuskonsole. Ohne Argument läuft sie fortlaufend, mit "einmal" nur einmal.
exec /usr/bin/node /usr/local/lib/stellium/konsole.mjs "\$@"
KONSOLE
chmod 755 /usr/local/bin/stellium

# Beim Anmelden von selbst öffnen.
if [[ -d /etc/xdg/autostart ]] && command -v lxterminal >/dev/null 2>&1; then
  # Mit Desktop: eigenes Terminalfenster.
  cat > /etc/xdg/autostart/stellium-konsole.desktop <<'DESKTOP'
[Desktop Entry]
Type=Application
Name=Stellium — Serverstatus
Comment=Zeigt, wie es dem Chat-Server geht
Exec=lxterminal --title="Stellium" --geometry=94x34 -e /usr/local/bin/stellium
Terminal=false
X-GNOME-Autostart-Delay=8
DESKTOP
  ok "Öffnet sich beim Anmelden in einem eigenen Fenster"
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
LOKAL="http://$(lokale_ip)"

cat <<ENDE

${GRUEN}${FETT}   ✓  Fertig.${AUS}

   ${FETT}Verbinden${AUS}
     Von außen   ${BLAU}${ADRESSE}${AUS}
     Im Heimnetz ${GRAU}${LOKAL}${AUS}

     In der App unter ${FETT}Einstellungen → Server${AUS} eintragen.

ENDE

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
     ${BLAU}stellium${AUS}                    Statuskonsole
     ${GRAU}sudo systemctl restart stellium${AUS}   neu starten
     ${GRAU}sudo journalctl -u stellium -f${AUS}    mitlesen
     ${GRAU}sudo stellium-sichern${AUS}             sofort sichern

   Der Server startet bei jedem Neustart von selbst mit.

BEFEHLE

if [[ "$WAHL" == "3" ]]; then
  printf '   %s! Diese Einrichtung ist unverschlüsselt. Für den Firmenbetrieb%s\n' "$GELB" "$AUS"
  printf '   %s  später auf Variante 1 oder 2 wechseln — einfach dieses Skript%s\n' "$GELB" "$AUS"
  printf '   %s  noch einmal ausführen.%s\n\n' "$GELB" "$AUS"
fi
