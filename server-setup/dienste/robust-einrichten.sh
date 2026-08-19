#!/usr/bin/env bash
# Sorgt dafür, dass Stellium jeden Neustart und jeden Absturz übersteht.
#
# Drei Dinge fehlen einer Standardinstallation:
#   1. nginx startet nach einem Absturz nicht von selbst neu.
#   2. systemd gibt nach fünf schnellen Fehlstarts endgültig auf — dann steht
#      der Dienst still, bis jemand von Hand eingreift.
#   3. Ein Dienst kann laufen und trotzdem nichts mehr beantworten. Nur wer
#      wirklich anklopft, merkt das.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }

PORT="${STELLIUM_PORT:-8787}"

echo "→ Stellium: unbegrenzt neu starten"
install -d /etc/systemd/system/stellium.service.d
cat > /etc/systemd/system/stellium.service.d/10-neustart.conf <<'ENDE'
[Unit]
# Ohne Zeitfenster gibt systemd nach fünf schnellen Fehlstarts für immer auf.
# Ein Server, der auf niemanden warten kann, soll es eben weiter versuchen.
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=5
# Sonst bleibt der Dienst nach einem Speichermangel liegen, statt neu zu starten.
OOMPolicy=continue
ENDE

echo "→ nginx: nach Absturz neu starten"
install -d /etc/systemd/system/nginx.service.d
cat > /etc/systemd/system/nginx.service.d/10-neustart.conf <<'ENDE'
[Unit]
StartLimitIntervalSec=0

[Service]
Restart=always
RestartSec=3
ENDE

echo "→ Wächter: prüft die Antwort, nicht nur den Prozess"
cat > /usr/local/bin/stellium-wacht <<ENDE
#!/bin/bash
# Ein laufender Prozess heißt noch nicht, dass jemand eine Antwort bekommt.
# Erst nach drei Fehlversuchen in Folge wird neu gestartet — ein einzelner
# Aussetzer während eines Updates ist kein Grund für einen Neustart.
ZAEHLER=/run/stellium-wacht.zaehler
if curl -fsS --max-time 8 "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; then
  rm -f "\$ZAEHLER"
  exit 0
fi
N=\$(( \$(cat "\$ZAEHLER" 2>/dev/null || echo 0) + 1 ))
echo "\$N" > "\$ZAEHLER"
logger -t stellium-wacht "Antwort ausgeblieben (\$N. Mal)"
if [ "\$N" -ge 3 ]; then
  logger -t stellium-wacht "Starte Stellium neu"
  systemctl restart stellium
  rm -f "\$ZAEHLER"
fi
ENDE
chmod 755 /usr/local/bin/stellium-wacht

cat > /etc/systemd/system/stellium-wacht.service <<'ENDE'
[Unit]
Description=Stellium: nachsehen, ob der Server noch antwortet
After=stellium.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-wacht
ENDE

cat > /etc/systemd/system/stellium-wacht.timer <<'ENDE'
[Unit]
Description=Stellium: alle zwei Minuten nachsehen

[Timer]
OnBootSec=3min
OnUnitActiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
ENDE

systemctl daemon-reload
systemctl enable --now stellium-wacht.timer >/dev/null
systemctl restart stellium nginx

echo
echo "Fertig:"
for d in stellium nginx; do
  printf '  %-10s %s / %s\n' "$d" "$(systemctl is-enabled $d)" "$(systemctl is-active $d)"
done
echo "  Wächter   alle 2 Minuten, Neustart nach 3 Fehlversuchen"
