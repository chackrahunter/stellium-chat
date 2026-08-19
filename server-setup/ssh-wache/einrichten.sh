#!/usr/bin/env bash
# Richtet das Fenster ein, das auf dem Pi zeigt, wenn jemand über SSH arbeitet.
#
# Drei Teile: die Mitschrift (was geschieht), der Weg in eine eigene Logdatei
# (rsyslog), und das Fenster selbst (startet mit dem Desktop).
set -euo pipefail

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ZIEL=/usr/local/lib/stellium
LOG=/var/log/stellium-ssh.log

echo "→ Pakete"
if ! python3 -c "import tkinter" 2>/dev/null; then
  apt-get update -qq && apt-get install -y python3-tk
fi

echo "→ Dateien"
install -d -m 755 "$ZIEL"
install -m 755 "$HIER/wache.py"      "$ZIEL/ssh-wache.py"
install -m 755 "$HIER/mitschrift.sh" /usr/local/bin/stellium-ssh-mitschrift
install -m 644 "$HIER/jeder-befehl.sh" /etc/profile.d/stellium-ssh.sh

echo "→ Logdatei"
cat > /etc/rsyslog.d/40-stellium-ssh.conf <<'ENDE'
# Alles, was das Mitschreib-Skript sendet, kommt in eine eigene Datei.
:programname, isequal, "stellium-ssh"  /var/log/stellium-ssh.log
& stop
ENDE
touch "$LOG"; chmod 644 "$LOG"
cat > /etc/logrotate.d/stellium-ssh <<'ENDE'
/var/log/stellium-ssh.log {
  weekly
  rotate 4
  compress
  missingok
  notifempty
  copytruncate
}
ENDE
systemctl restart rsyslog || true

echo "→ SSH verdrahten"
SICHERUNG="$(mktemp)"
cp -a /etc/ssh/sshd_config "$SICHERUNG"
grep -q '^Include /etc/ssh/sshd_config.d/' /etc/ssh/sshd_config \
  || sed -i '1i Include /etc/ssh/sshd_config.d/*.conf' /etc/ssh/sshd_config
install -d -m 755 /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/40-stellium-mitschrift.conf <<'ENDE'
# Jede Sitzung läuft durch das Mitschreib-Skript, das danach die Shell startet.
ForceCommand /usr/local/bin/stellium-ssh-mitschrift
ENDE

if ! sshd -t 2>/dev/null; then
  echo "FEHLER: die SSH-Einstellungen wären kaputt — nichts geändert."
  rm -f /etc/ssh/sshd_config.d/40-stellium-mitschrift.conf
  cp -a "$SICHERUNG" /etc/ssh/sshd_config
  rm -f "$SICHERUNG"; exit 1
fi
rm -f "$SICHERUNG"
systemctl reload ssh 2>/dev/null || systemctl reload sshd

echo "→ Fenster startet mit dem Desktop"
cat > /etc/xdg/autostart/stellium-ssh-wache.desktop <<ENDE
[Desktop Entry]
Type=Application
Name=Stellium — Fernzugriff
Comment=Zeigt an, wenn jemand über SSH auf diesem Pi arbeitet
Exec=/usr/bin/python3 $ZIEL/ssh-wache.py
Icon=utilities-terminal
Terminal=false
X-GNOME-Autostart-enabled=true
ENDE

# Wenn schon ein Desktop läuft, gleich starten — sonst erst beim nächsten Mal.
NUTZER="$(who 2>/dev/null | awk '$0 ~ /\(:0/ {print $1; exit}')"
[ -z "$NUTZER" ] && NUTZER="$(logname 2>/dev/null || echo '')"
if [ -n "$NUTZER" ] && ! pgrep -f ssh-wache.py >/dev/null; then
  su - "$NUTZER" -c "DISPLAY=:0 nohup python3 $ZIEL/ssh-wache.py >/dev/null 2>&1 &" || true
fi

echo
echo "Fertig. Das Fenster erscheint, sobald sich jemand über SSH verbindet."
echo "Mitschrift: $LOG"
