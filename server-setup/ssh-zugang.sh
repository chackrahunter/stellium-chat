#!/usr/bin/env bash
# Öffnet den SSH-Zugang zum Pi über den Router — ohne Router-Oberfläche.
#
# Der Router spricht NAT-PMP: man darf sich eine Weiterleitung erbitten, statt
# sie in einer Weboberfläche einzutragen. Zwei Haken hat das:
#   1. Jede Zuordnung läuft ab. Ohne Auffrischung ist der Zugang morgen wieder zu.
#   2. Ein belegter äußerer Port lässt den Router ausweichen — dann liegt der
#      Zugang plötzlich woanders.
# Darum räumt dieses Skript zuerst auf, bittet dann um einen festen Port und
# richtet eine Auffrischung ein, die alle 20 Minuten nachlegt.
set -euo pipefail

AUSSEN="${1:-2222}"
INNEN=""   # wird gleich beim Dienst nachgesehen
DIENST=/etc/systemd/system/stellium-ssh-port.service
TIMER=/etc/systemd/system/stellium-ssh-port.timer

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
command -v natpmpc >/dev/null || { apt-get update -qq && apt-get install -y natpmpc; }

echo "→ SSH-Dienst sicherstellen"
# Raspberry Pi OS liefert den SSH-Dienst gesperrt aus: die Einheit ist maskiert,
# bis man ihn ausdrücklich freischaltet. Deshalb reicht "enable --now" allein
# nicht — erst entsperren, notfalls nachinstallieren.
dpkg -s openssh-server >/dev/null 2>&1 || { apt-get update -qq; apt-get install -y openssh-server; }
if command -v raspi-config >/dev/null; then
  raspi-config nonint do_ssh 0 >/dev/null 2>&1 || true
fi
systemctl unmask ssh ssh.socket >/dev/null 2>&1 || true
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd >/dev/null 2>&1 || true
# Neuere Debian-Fassungen starten den Dienst erst bei der ersten Verbindung.
systemctl is-active --quiet ssh || systemctl start ssh.socket >/dev/null 2>&1 || true

# Welchen Port der Dienst wirklich nimmt, sagt er selbst — die 22 ist nur die
# übliche Wahl, nicht die garantierte. Auf diesem Pi ist es die 2222.
port_finden() {
  local p
  p="$(ss -ltnp 2>/dev/null | awk '/sshd/ {split($4,a,":"); print a[length(a)]}' | sort -un | head -1)"
  [ -z "$p" ] && p="$(sshd -T 2>/dev/null | awk '/^port /{print $2; exit}')"
  [ -z "$p" ] && p="$(awk '/^[[:space:]]*Port[[:space:]]+[0-9]+/{print $2; exit}' /etc/ssh/sshd_config /etc/ssh/sshd_config.d/*.conf 2>/dev/null)"
  echo "${p:-22}"
}
for _ in 1 2 3 4 5 6 7 8 9 10; do
  INNEN="$(port_finden)"
  ss -ltn 2>/dev/null | grep -qE "[^0-9]${INNEN}[[:space:]]" && break
  sleep 1
done
if ! ss -ltn 2>/dev/null | grep -qE "[^0-9]${INNEN}[[:space:]]"; then
  echo "FEHLER: der SSH-Dienst lauscht auf keinem Port. Was er sagt:"
  systemctl status ssh --no-pager -l 2>&1 | head -14
  exit 1
fi
echo "  SSH lauscht auf Port $INNEN."
command -v ufw >/dev/null && ufw allow "$INNEN"/tcp >/dev/null 2>&1 || true

echo "→ alte Zuordnungen aufräumen"
for p in 2222 2223 2224; do natpmpc -a "$p" "$p" tcp 0 >/dev/null 2>&1 || true; done
natpmpc -a "$AUSSEN" "$INNEN" tcp 0 >/dev/null 2>&1 || true
sleep 1

echo "→ Weiterleitung erbitten: außen $AUSSEN → innen $INNEN"
ANTWORT="$(natpmpc -a "$AUSSEN" "$INNEN" tcp 3600 2>&1 || true)"
ECHTER="$(echo "$ANTWORT" | sed -n 's/.*public port \([0-9]\{1,\}\).*/\1/p' | tail -1)"
[ -n "$ECHTER" ] || { echo "Der Router hat nichts zugeordnet:"; echo "$ANTWORT"; exit 1; }

cat > "$DIENST" <<DIENSTENDE
[Unit]
Description=Stellium: SSH-Weiterleitung im Router auffrischen
After=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/natpmpc -a $ECHTER $INNEN tcp 3600
DIENSTENDE

cat > "$TIMER" <<TIMERENDE
[Unit]
Description=Stellium: SSH-Weiterleitung alle 20 Minuten auffrischen

[Timer]
OnBootSec=45s
OnUnitActiveSec=20min
Persistent=true

[Install]
WantedBy=timers.target
TIMERENDE

systemctl daemon-reload
systemctl enable --now stellium-ssh-port.timer >/dev/null

echo
echo "════════════════════════════════════════════"
echo "  Zugang steht auf Port  $ECHTER"
echo "  Auffrischung alle 20 Minuten ist aktiv."
echo "════════════════════════════════════════════"
