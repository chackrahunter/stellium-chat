#!/usr/bin/env bash
#
# Stellium-Server auf Raspberry Pi OS einrichten — ein Aufruf, sonst nichts.
#
#   curl -fsSL https://raw.githubusercontent.com/chackrahunter/stellium-chat/main/server-setup/stellium-installieren.sh | sudo bash
#
# oder, wenn die Datei schon auf dem Pi liegt:
#
#   sudo bash stellium-installieren.sh
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

BENUTZER="stellium"
ZIEL="/opt/stellium"
DATEN="/var/lib/stellium"
REPO="${STELLIUM_REPO:-https://github.com/chackrahunter/stellium-chat.git}"
PORT="8787"

clear
cat <<KOPF

${BLAU}${FETT}   ✦  Stellium${AUS}
   ${GRAU}Team-Chat mit Live-Übersetzung — Servereinrichtung${AUS}

   Dieser Aufruf richtet alles ein. Du wirst zweimal etwas gefragt,
   danach läuft es allein.

KOPF

# ── Fragen: erst alles einsammeln, dann arbeiten ────────────────
schritt "Wie soll der Server erreichbar sein?"

cat <<ERKLAERUNG
  ${FETT}1)${AUS} Mit eigener Domain — ${GRUEN}empfohlen${AUS}
     Echtes Zertifikat von Let's Encrypt, HTTPS von überall.
     Voraussetzung: eine Domain, die auf diesen Anschluss zeigt,
     und Port 80 und 443 im Router auf diesen Pi weitergeleitet.

  ${FETT}2)${AUS} Über Tailscale
     Ein verschlüsseltes privates Netz zwischen euren Geräten.
     Kein Port im Router offen, kein Zertifikat nötig — Tailscale
     liefert eines mit. Gut, wenn du nichts freigeben willst.

  ${FETT}3)${AUS} Nur im Heimnetz
     Ohne Verschlüsselung, nur im eigenen WLAN erreichbar.
     ${GELB}Für den Firmenbetrieb nicht geeignet.${AUS}

ERKLAERUNG

WAHL=""
DOMAIN=""
MAIL=""
while [[ -z "$WAHL" ]]; do
  read -rp "  Deine Wahl [1/2/3]: " WAHL </dev/tty
  case "$WAHL" in
    1)
      while [[ -z "$DOMAIN" ]]; do
        read -rp "  Domain (z.B. chat.meinefirma.de): " DOMAIN </dev/tty
        [[ "$DOMAIN" =~ ^[a-zA-Z0-9]([a-zA-Z0-9.-]*[a-zA-Z0-9])?\.[a-zA-Z]{2,}$ ]] || {
          warn "Das sieht nicht nach einer Domain aus."; DOMAIN=""; }
      done
      while [[ -z "$MAIL" ]]; do
        read -rp "  E-Mail für Let's Encrypt (Warnung vor Ablauf): " MAIL </dev/tty
        [[ "$MAIL" == *@*.* ]] || { warn "Das sieht nicht nach einer E-Mail aus."; MAIL=""; }
      done
      ;;
    2) ;;
    3)
      warn "Ohne Verschlüsselung kann jeder im selben Netz mitlesen."
      read -rp "  Wirklich? [ja/nein]: " SICHER </dev/tty
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
read -rsp "  Schlüssel (bleibt unsichtbar): " GROQ </dev/tty; echo

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
  jq bc >/dev/null
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
if [[ -d "$ZIEL/.git" ]]; then
  git -C "$ZIEL" fetch --quiet origin
  git -C "$ZIEL" reset --hard --quiet origin/HEAD
  info "vorhandene Installation aktualisiert"
else
  rm -rf "$ZIEL"
  git clone --quiet --depth 1 "$REPO" "$ZIEL"
fi

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
  set -a; . "$UMGEBUNG"; set +a
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

# Gemeinsamer Teil für alle drei Varianten. Der Server hört nur auf 127.0.0.1;
# alles von außen läuft durch nginx.
cat > /etc/nginx/snippets/stellium-proxy.conf <<'PROXY'
# Nach innen weiterreichen, mit allem was der Server über den Aufrufer
# wissen muss — sonst hält er jede Verbindung für lokal.
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

# Dateien bis 200 MB durchlassen.
client_max_body_size 200m;
proxy_request_buffering off;
PROXY

cat > /etc/nginx/conf.d/stellium-upgrade.conf <<'MAP'
# "Connection: upgrade" nur dann, wenn der Aufrufer das auch will.
map $http_upgrade $connection_upgrade {
  default upgrade;
  ''      close;
}
MAP

cat > /etc/nginx/snippets/stellium-sicherheit.conf <<'SICHER'
# Der Browser soll nichts anderes zulassen, als was die App wirklich braucht.
add_header X-Content-Type-Options    "nosniff"        always;
add_header X-Frame-Options           "DENY"           always;
add_header Referrer-Policy           "no-referrer"    always;
add_header Permissions-Policy        "geolocation=(), camera=(), microphone=(self), payment=()" always;
add_header Cross-Origin-Opener-Policy "same-origin"   always;

# Versionsnummer verrät nur Angreifern etwas.
server_tokens off;
SICHER

if [[ "$WAHL" == "1" ]]; then
  # Erst ohne TLS aufsetzen, damit certbot die Domain überhaupt prüfen kann.
  cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen 80;
  listen [::]:80;
  server_name $DOMAIN;

  location /.well-known/acme-challenge/ { root /var/www/html; }
  location / { return 301 https://\$host\$request_uri; }
}
NGINX
else
  cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen 80 default_server;
  listen [::]:80 default_server;
  server_name _;

  include snippets/stellium-sicherheit.conf;

  location / {
    proxy_pass http://127.0.0.1:$PORT;
    include snippets/stellium-proxy.conf;
  }
}
NGINX
fi

rm -f /etc/nginx/sites-enabled/default
ln -sf /etc/nginx/sites-available/stellium /etc/nginx/sites-enabled/stellium
nginx -t >/dev/null 2>&1 || fehler "nginx-Konfiguration fehlerhaft — siehe: nginx -t"
systemctl restart nginx
systemctl enable --quiet nginx
ok "nginx läuft"

# ── Verschlüsselung ─────────────────────────────────────────────
ADRESSE=""
case "$WAHL" in
  1)
    schritt "Zertifikat von Let's Encrypt"
    apt-get install -y -qq certbot python3-certbot-nginx >/dev/null

    if certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "$MAIL" \
         --redirect --hsts --staple-ocsp >/dev/null 2>&1; then
      ok "Zertifikat für $DOMAIN ausgestellt"
    else
      warn "Das Zertifikat konnte nicht ausgestellt werden."
      warn "Fast immer liegt es an einem davon:"
      warn "  • $DOMAIN zeigt noch nicht auf diesen Anschluss"
      warn "  • Port 80 und 443 sind im Router nicht auf diesen Pi weitergeleitet"
      warn "Nachholen mit:  sudo certbot --nginx -d $DOMAIN"
    fi

    # certbot schreibt die Weiterleitung selbst; der eigentliche Durchgriff
    # muss noch hinein.
    if ! grep -q "stellium-proxy" /etc/nginx/sites-available/stellium; then
      python3 - "$DOMAIN" "$PORT" <<'PYNGINX'
import re, sys
pfad = '/etc/nginx/sites-available/stellium'
domain, port = sys.argv[1], sys.argv[2]
text = open(pfad).read()
block = f"""
  include snippets/stellium-sicherheit.conf;
  add_header Strict-Transport-Security "max-age=63072000; includeSubDomains" always;

  location / {{
    proxy_pass http://127.0.0.1:{port};
    include snippets/stellium-proxy.conf;
  }}
"""
# In den 443-Block hinein, den certbot angelegt hat.
stelle = text.find('listen 443')
if stelle != -1:
    ende = text.find('}', text.rfind('server {', 0, stelle))
    text = text[:ende] + block + text[ende:]
    open(pfad, 'w').write(text)
PYNGINX
      nginx -t >/dev/null 2>&1 && systemctl reload nginx
    fi

    # Verlängerung: certbot bringt einen Timer mit, wir prüfen nur, dass er läuft.
    systemctl enable --quiet certbot.timer 2>/dev/null || true
    systemctl start certbot.timer 2>/dev/null || true
    ok "Verlängerung läuft automatisch (certbot.timer)"
    ADRESSE="https://$DOMAIN"
    ;;

  2)
    schritt "Tailscale einrichten"
    if ! command -v tailscale >/dev/null; then
      curl -fsSL https://tailscale.com/install.sh | sh >/dev/null 2>&1
    fi
    systemctl enable --quiet tailscaled
    systemctl start tailscaled
    ok "Tailscale installiert"
    info ""
    info "  Zwei Befehle fehlen noch — sie brauchen deine Anmeldung im Browser:"
    info ""
    info "    ${FETT}sudo tailscale up${AUS}"
    info "    ${FETT}sudo tailscale cert \$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')${AUS}"
    info ""
    info "  Danach ${FETT}sudo stellium-tailscale-tls${AUS} — das trägt das Zertifikat ein."
    ADRESSE="(nach tailscale up sichtbar)"
    ;;

  3)
    ADRESSE="http://$(hostname -I | awk '{print $1}')"
    warn "Unverschlüsselt. Nur im Heimnetz benutzen."
    ;;
esac

# Kleines Werkzeug, das Tailscales Zertifikat in nginx einträgt.
cat > /usr/local/bin/stellium-tailscale-tls <<'TSTLS'
#!/usr/bin/env bash
set -Eeuo pipefail
[[ $EUID -eq 0 ]] || { echo "Bitte mit sudo."; exit 1; }
NAME="$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
[[ -n "$NAME" && "$NAME" != "null" ]] || { echo "Tailscale ist noch nicht angemeldet. Erst: sudo tailscale up"; exit 1; }
tailscale cert "$NAME"
cat > /etc/nginx/sites-available/stellium <<NGINX
server {
  listen 80;
  server_name $NAME;
  return 301 https://\$host\$request_uri;
}
server {
  listen 443 ssl;
  http2 on;
  server_name $NAME;

  ssl_certificate     /var/lib/tailscale/certs/$NAME.crt;
  ssl_certificate_key /var/lib/tailscale/certs/$NAME.key;
  ssl_protocols TLSv1.2 TLSv1.3;
  ssl_prefer_server_ciphers off;

  include snippets/stellium-sicherheit.conf;
  add_header Strict-Transport-Security "max-age=63072000" always;

  location / {
    proxy_pass http://127.0.0.1:8787;
    include snippets/stellium-proxy.conf;
  }
}
NGINX
nginx -t && systemctl reload nginx
echo "Fertig. Erreichbar unter: https://$NAME"
TSTLS
chmod 755 /usr/local/bin/stellium-tailscale-tls

# ── Absichern ───────────────────────────────────────────────────
schritt "Firewall und Einbruchsschutz"

ufw --force reset >/dev/null 2>&1
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow OpenSSH >/dev/null
if [[ "$WAHL" == "2" ]]; then
  ufw allow in on tailscale0 >/dev/null 2>&1 || true
  info "Nur SSH und Tailscale offen — kein Port aus dem Internet erreichbar"
else
  ufw allow 80/tcp  >/dev/null
  ufw allow 443/tcp >/dev/null
  info "Offen: SSH, 80, 443 — sonst nichts"
fi
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

# Damit die Konsole Dinge zeigen darf, die sonst nur root sieht.
cat > /etc/sudoers.d/stellium-konsole <<'SUDO'
%sudo ALL=(root) NOPASSWD: /usr/bin/systemctl is-active stellium, /usr/bin/systemctl is-active nginx
SUDO
chmod 440 /etc/sudoers.d/stellium-konsole

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
LOKAL="http://$(hostname -I | awk '{print $1}')"

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
