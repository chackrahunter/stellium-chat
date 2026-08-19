#!/usr/bin/env bash
# Macht die Oberfläche des Pi flüssiger.
#
# Drei Hebel, alle umkehrbar:
#   1. Der Prozessor darf durchgehend hochtakten statt erst auf Zuruf. Auf
#      einem Rechner, der ohnehin Tag und Nacht läuft, kostet das ein paar
#      Watt und spart genau die Verzögerung, die man als Ruckeln wahrnimmt.
#   2. Der Kern soll seltener auslagern — Arbeitsspeicher ist reichlich da.
#   3. Dienste, die auf diesem Gerät niemand nutzt, hören auf mitzulaufen.
#
# Alles rückgängig: sudo bash pi-beschleunigen.sh zurueck
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }

# Nur Dienste, die auf diesem Gerät nachweislich brachliegen: kein Drucker,
# kein Modem, kein NFS. caddy lauscht allein auf seiner Verwaltungsschnittstelle
# — die Webseite macht nginx. LibreTranslate belegt gut 120 MB, obwohl die
# Übersetzung längst über das lokale Modell läuft.
UNNOETIG=(cups cups-browsed ModemManager nfs-blkmap caddy libretranslate)

if [ "${1:-}" = "zurueck" ]; then
  for d in "${UNNOETIG[@]}"; do systemctl enable --now "$d" >/dev/null 2>&1 || true; done
  rm -f /etc/systemd/system/stellium-takt.service /etc/sysctl.d/60-stellium.conf
  systemctl daemon-reload
  sysctl -p /etc/sysctl.conf >/dev/null 2>&1 || true
  echo "Alles wieder wie vorher."
  exit 0
fi

echo "→ Prozessor: durchgehend voller Takt"
cat > /etc/systemd/system/stellium-takt.service <<'ENDE'
[Unit]
Description=Stellium: Prozessor auf vollen Takt stellen
After=multi-user.target

[Service]
Type=oneshot
RemainAfterExit=yes
# Nicht jeder Kern hat einen Regler — Fehler sind hier kein Grund zum Abbruch.
ExecStart=/bin/bash -c 'for g in /sys/devices/system/cpu/cpu*/cpufreq/scaling_governor; do echo performance > "$g" || true; done'

[Install]
WantedBy=multi-user.target
ENDE
systemctl daemon-reload
systemctl enable --now stellium-takt.service >/dev/null

echo "→ Kern: seltener auslagern"
cat > /etc/sysctl.d/60-stellium.conf <<'ENDE'
# Auslagern erst, wenn es wirklich eng wird — der Pi hat 8 GB.
vm.swappiness = 10
# Verzeichnis- und Dateiwissen länger behalten: spart Plattenzugriffe.
vm.vfs_cache_pressure = 50
ENDE
sysctl -q --system

echo "→ Dienste, die hier niemand braucht"
for d in "${UNNOETIG[@]}"; do
  if systemctl is-enabled "$d" >/dev/null 2>&1; then
    systemctl disable --now "$d" >/dev/null 2>&1 && echo "   aus: $d"
  fi
done

echo
echo "Regler:      $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_governor)"
echo "Takt:        $(( $(cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq) / 1000 )) MHz"
echo "swappiness:  $(cat /proc/sys/vm/swappiness)"
free -h | sed -n '2p'
echo
echo "Rückgängig mit:  sudo bash pi-beschleunigen.sh zurueck"
