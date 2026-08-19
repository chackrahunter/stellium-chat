#!/usr/bin/env bash
# Richtet ein, was auf dem Pi zeigt, wenn jemand über SSH arbeitet.
#
# Drei Teile: die Mitschrift (was geschieht), der Weg in eine eigene Logdatei
# (rsyslog), und das Fenster zum Nachlesen.
#
# Das Fenster geht nicht mehr von selbst auf. Die laufende Mitschrift steht
# dauerhaft unten in der Stellium-Konsole, die den Schreibtisch füllt — dort
# sieht man ohne Zutun, was geschieht. Aufgerufen wird das Fenster nur noch
# von Hand über „Fernzugriff-Protokoll" im Startmenü, um alte Tage nachzulesen.
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
install -m 755 "$HIER/starter.sh"    /usr/local/bin/stellium-ssh-wache
install -m 755 "$HIER/protokoll-oeffnen.sh" /usr/local/bin/stellium-fernzugriff-protokoll
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
if systemctl list-unit-files --no-legend 2>/dev/null | grep -q '^rsyslog.service'; then
  systemctl restart rsyslog || true
else
  # Debian 12 schreibt nur noch ins Journal — das Fenster liest von dort.
  rm -f /etc/rsyslog.d/40-stellium-ssh.conf /etc/logrotate.d/stellium-ssh "$LOG"
  echo "  kein rsyslog — die Mitschrift läuft über das Journal"
fi

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

echo "→ Eintrag im Startmenü"
# Damit man auch später nachlesen kann, was aus der Ferne geschah.
cat > /usr/share/applications/stellium-fernzugriff.desktop <<ENDE
[Desktop Entry]
Type=Application
Name=Fernzugriff-Protokoll
Comment=Zeigt, was über SSH auf diesem Pi geschehen ist
Exec=/usr/local/bin/stellium-fernzugriff-protokoll
Icon=utilities-system-monitor
Terminal=false
Categories=System;Monitor;
ENDE

# Kein Eintrag mehr auf dem Schreibtisch und kein Start mit dem Desktop: die
# Konsole füllt den Schreibtisch und zeigt die Mitschrift schon unten an. Ein
# Wächter, der bei jeder Verbindung ein Fenster hochschiebt, wäre doppelt.
rm -f /etc/xdg/autostart/stellium-ssh-wache.desktop
for heim in /home/*; do
  rm -f "$heim/Desktop/stellium-fernzugriff.desktop" \
        "$heim/.config/autostart/stellium-ssh-wache.desktop" 2>/dev/null || true
done

echo
echo "Fertig."
echo "  · Mitgeschrieben wird ab sofort jede SSH-Sitzung."
echo "  · Zu sehen ist das laufend unten in der Stellium-Konsole."
echo "  · Zum Nachlesen: „Fernzugriff-Protokoll“ im Startmenü."
echo "Mitschrift: $LOG"
