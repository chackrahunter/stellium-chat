#!/usr/bin/env bash
#
# SSH durch den Port, der ohnehin schon offen ist.
#
#   sudo bash stellium-ssh-durch-https.sh 'ssh-ed25519 AAAA... kommentar'
#
# Ohne Zugriff auf den Router lässt sich kein zweiter Port öffnen. Der eine,
# der durchkommt, trägt aber schon TLS — und nginx kann anhand des Namens im
# TLS-Vorspann entscheiden, wohin eine Verbindung geht:
#
#   stellium-chat.duckdns.org      → der Chat wie bisher
#   ssh.stellium-chat.duckdns.org  → der SSH-Dienst auf dem Pi
#
# Beide Namen zeigen auf dieselbe Adresse (DuckDNS beantwortet jede
# Unteradresse gleich), und beide gehen durch denselben offenen Port. Auf dem
# Mac braucht es dafür nichts außer openssl, das dort ohnehin liegt.
#
# Die Verbindung bleibt in TLS eingepackt: von außen sieht niemand, dass dort
# SSH spricht. Angemeldet wird ausschließlich mit Schlüssel.
#
set -Eeuo pipefail

if [[ -t 1 ]]; then
  ROT=$'\e[31m'; GRUEN=$'\e[32m'; GELB=$'\e[33m'; BLAU=$'\e[38;5;99m'
  GRAU=$'\e[90m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else
  ROT=''; GRUEN=''; GELB=''; BLAU=''; GRAU=''; FETT=''; AUS=''
fi
schritt() { printf '\n%s▸ %s%s\n' "$BLAU$FETT" "$*" "$AUS"; }
ok()      { printf '  %s✓%s %s\n' "$GRUEN" "$AUS" "$*"; }
info()    { printf '  %s%s%s\n' "$GRAU" "$*" "$AUS"; }
warn()    { printf '  %s!%s %s\n' "$GELB" "$AUS" "$*"; }
fehler()  { printf '\n%s✗ %s%s\n\n' "$ROT$FETT" "$*" "$AUS" >&2; exit 1; }

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten."
command -v nginx >/dev/null || fehler "nginx ist nicht installiert."

SCHLUESSEL="${1:-}"
KONTO="${SUDO_USER:-$(logname 2>/dev/null || echo pi)}"
HEIM="$(getent passwd "$KONTO" | cut -d: -f6)"

# Woher der Name und der offene Port kommen: aus der bestehenden Einrichtung.
NGINX_DATEI=/etc/nginx/sites-available/stellium
[[ -f "$NGINX_DATEI" ]] || fehler "Keine Stellium-Einrichtung für nginx gefunden."
NAME="$(grep -m1 -oP '(?<=server_name )\S+' "$NGINX_DATEI" | tr -d ';')"
PORT="$(grep -m1 -oP '(?<=listen )\d+(?= ssl)' "$NGINX_DATEI")"
[[ -n "$NAME" && -n "$PORT" ]] || fehler "Name oder Port ließen sich nicht ablesen."

# Ein eigener Port nur im Gerät, hinter dem der bisherige HTTPS-Block sitzt.
INTERN=9444
while ss -ltn 2>/dev/null | grep -q ":$INTERN "; do INTERN=$((INTERN + 1)); done

printf '\n%s✦  SSH durch Port %s%s\n' "$BLAU$FETT" "$PORT" "$AUS"
info "Chat:  $NAME:$PORT"
info "SSH:   ssh.$NAME:$PORT  (derselbe Port, anderer Name im TLS-Vorspann)"

# ── Schlüssel ───────────────────────────────────────────────────
schritt "Schlüssel"
if [[ -n "$SCHLUESSEL" ]]; then
  [[ "$SCHLUESSEL" =~ ^(ssh-ed25519|ssh-rsa|ecdsa-) ]] \
    || fehler "Das sieht nicht nach einem öffentlichen Schlüssel aus."
  install -d -m 700 -o "$KONTO" -g "$KONTO" "$HEIM/.ssh"
  touch "$HEIM/.ssh/authorized_keys"
  grep -qF "$SCHLUESSEL" "$HEIM/.ssh/authorized_keys" \
    || printf '%s\n' "$SCHLUESSEL" >> "$HEIM/.ssh/authorized_keys"
  chown "$KONTO:$KONTO" "$HEIM/.ssh/authorized_keys"
  chmod 600 "$HEIM/.ssh/authorized_keys"
  ok "eingetragen"
elif [[ -s "$HEIM/.ssh/authorized_keys" ]]; then
  info "kein neuer übergeben — die vorhandenen bleiben"
else
  fehler "Kein Schlüssel übergeben und keiner hinterlegt."
fi

# ── SSH selbst absichern ────────────────────────────────────────
schritt "SSH absichern"
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1
install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/stellium.conf <<CONF
# Von stellium-ssh-durch-https.sh angelegt.
# Erreichbar ist der Dienst nur über nginx auf 127.0.0.1 — deshalb hört er
# auch nur dort. Von außen führt kein Weg daran vorbei.
ListenAddress 127.0.0.1
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 20
AllowUsers $KONTO
CONF
sshd -t 2>/dev/null || { rm -f /etc/ssh/sshd_config.d/stellium.conf; fehler "sshd lehnt die Einstellungen ab."; }
systemctl restart ssh 2>/dev/null || systemctl restart sshd
ok "nur Schlüssel, nur über nginx erreichbar"

# ── nginx umbauen ───────────────────────────────────────────────
schritt "nginx"
SICHERUNG="/var/lib/stellium/nginx-vor-ssh-$(date +%Y%m%d-%H%M)"
mkdir -p "$(dirname "$SICHERUNG")"
cp -a /etc/nginx "$SICHERUNG"
info "Sicherung: $SICHERUNG"

zurueck() {
  warn "Etwas stimmte nicht — der alte Stand kommt zurück."
  rm -rf /etc/nginx
  cp -a "$SICHERUNG" /etc/nginx
  systemctl reload nginx 2>/dev/null || systemctl restart nginx
  fehler "nginx blieb unverändert."
}

# Der bisherige HTTPS-Block hört künftig nur noch im Gerät — davor sitzt die
# Weiche. proxy_protocol sorgt dafür, dass die echte Herkunft erhalten bleibt:
# ohne das käme jede Anfrage scheinbar von 127.0.0.1, und die Serveransicht,
# die nur von hier erreichbar sein soll, stünde plötzlich allen offen.
sed -i "s/^  listen $PORT ssl;/  listen 127.0.0.1:$INTERN ssl proxy_protocol;/" "$NGINX_DATEI"
sed -i "/^  listen \[::\]:$PORT ssl;/d" "$NGINX_DATEI"
# Der Anker ist die Zeile mit dem Zertifikat, nicht die mit http2: "http2 on;"
# steht nur in der Konfiguration, die ein nginx ab 1.25.1 bekommt — auf
# Bookworm fehlt sie, und das sed liefe still ins Leere. Genau das wäre hier
# gefährlich: ohne set_real_ip_from käme jede Anfrage scheinbar von 127.0.0.1,
# und die Serveransicht stünde allen offen, ohne dass jemand etwas merkt.
# "^  ssl_certificate " trifft genau einmal (ssl_certificate_key und
# ssl_trusted_certificate haben andere Namen) und nur im HTTPS-Block.
grep -q 'set_real_ip_from' "$NGINX_DATEI" || sed -i "/^  ssl_certificate /a\\
  set_real_ip_from 127.0.0.1;\\
  real_ip_header proxy_protocol;" "$NGINX_DATEI"
# Und danach nachsehen, ob es wirklich drinsteht. Ein sed, das nichts findet,
# meldet keinen Fehler — dieser Griff macht aus dem stillen Nichtstun einen
# sichtbaren Abbruch mit Rückfall.
grep -q 'set_real_ip_from' "$NGINX_DATEI" || zurueck

# Die Weiche selbst. Sie steht in einer eigenen Datei, weil der stream-Teil
# nicht in den http-Teil gehört.
cat > /etc/nginx/modules-enabled/60-stellium-weiche.conf <<WEICHE
# Von stellium-ssh-durch-https.sh angelegt.
#
# Eine Weiche vor dem TLS: sie liest nur den Namen aus dem Vorspann und
# entscheidet danach, wohin die Verbindung geht. Entschlüsselt wird hier
# nichts — das bleibt Sache des Blocks dahinter.
stream {
  map \$ssl_preread_server_name \$stellium_ziel {
    ssh.$NAME  127.0.0.1:22;
    default    127.0.0.1:$INTERN;
  }

  # Nur die Weiche gibt die Herkunft weiter; alles andere bliebe sonst blind.
  server {
    listen $PORT;
    listen [::]:$PORT;
    ssl_preread on;
    proxy_pass \$stellium_ziel;
    proxy_protocol on;
    proxy_timeout 7d;
  }
}
WEICHE

nginx -t 2>/dev/null || zurueck
systemctl reload nginx 2>/dev/null || systemctl restart nginx || zurueck
sleep 1

# Läuft der Chat noch? Sonst sofort zurück.
if ! curl -skf --max-time 10 "https://$NAME:$PORT/" -o /dev/null; then
  zurueck
fi
ok "Weiche steht, der Chat läuft weiter"

# ── Bremse ──────────────────────────────────────────────────────
schritt "Bremse"
if ! command -v fail2ban-server >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq fail2ban >/dev/null 2>&1 || true
fi
if command -v fail2ban-server >/dev/null 2>&1; then
  cat > /etc/fail2ban/jail.d/stellium-ssh.conf <<'JAIL'
[sshd]
enabled = true
maxretry = 4
findtime = 600
bantime  = 3600
JAIL
  systemctl restart fail2ban >/dev/null 2>&1 || true
  ok "vier Fehlversuche, dann eine Stunde Pause"
fi

cat <<ENDE

${GRUEN}${FETT}   Fertig. Kein neuer Port, keine Zusatzsoftware.${AUS}

   ${FETT}Auf dem Mac einmal in ~/.ssh/config eintragen:${AUS}

     ${GRAU}Host stellium
       HostName $NAME
       User $KONTO
       IdentityFile ~/.ssh/stellium
       IdentitiesOnly yes
       ProxyCommand openssl s_client -quiet -verify_quiet -connect %h:$PORT -servername ssh.%h${AUS}

   ${FETT}Danach:${AUS}  ${BLAU}ssh stellium${AUS}

   Zurücknehmen lässt sich alles mit:
     ${GRAU}sudo rm /etc/nginx/modules-enabled/60-stellium-weiche.conf
     sudo cp -a $SICHERUNG/. /etc/nginx/ && sudo systemctl reload nginx${AUS}

ENDE
