#!/usr/bin/env bash
# Rechnet einmal in der Woche jeden Block nach und schreibt Funde ins Journal.
#
# Warum es diesen Lauf braucht: die Sicherung des Blockspeichers arbeitet mit
# Hardlinks. Ein Hardlink ist ein zweiter Name auf dieselben Bytes — er schützt
# davor, dass ein Block verschwindet, weil der Server ihn freigibt, aber nicht
# davor, dass sich die Bytes an Ort und Stelle verändern. Kippt ein Bit auf der
# Karte, kippt es in beiden Namen zugleich, und die Sicherung ist ebenso kaputt
# wie das Original.
#
# Gegen diesen einen Fall hilft nur Nachrechnen: der Name eines Blocks ist der
# Fingerabdruck seines Inhalts. Passen beide nicht mehr zusammen, sagt es dieser
# Lauf — und zwar bevor jemand herunterladen will. Ein geteilter Block steckt in
# mehreren Dateien; ein unbemerkter Schaden verbreitet sich still.
#
# Der Lauf ändert nichts. Er liest, rechnet und meldet.
#
# Einrichten:   sudo bash blockpruefung-einrichten.sh
# Entfernen:    sudo bash blockpruefung-einrichten.sh zurueck
# Sofort sehen: sudo systemctl start stellium-blockpruefung.service
#               journalctl -u stellium-blockpruefung -n 50 --no-pager
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }

QUELLE="${STELLIUM_QUELLE:-/opt/stellium}"
DATEN="${STELLIUM_DATA:-/var/lib/stellium}"
BENUTZER="${STELLIUM_USER:-stellium}"

if [ "${1:-}" = "zurueck" ]; then
  systemctl disable --now stellium-blockpruefung.timer >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/stellium-blockpruefung.timer \
        /etc/systemd/system/stellium-blockpruefung.service \
        /usr/local/bin/stellium-blockpruefung
  systemctl daemon-reload
  echo "Zeitgeber entfernt."
  exit 0
fi

echo "→ Startbefehl"
cat > /usr/local/bin/stellium-blockpruefung <<ENDE
#!/bin/bash
# Ruft die Tiefenprüfung auf. Steht der Bauteil dafür noch nicht bereit, ist
# das kein Fehler, sondern ein Stand vor der nächsten Auslieferung: dann eine
# Zeile ins Journal und ohne Beanstandung beenden. Ein Zeitgeber, der jede
# Woche rot leuchtet, weil noch nichts zu prüfen ist, wird nicht mehr gelesen.
QUELLE="$QUELLE"
DATEN="$DATEN"
ENDE
cat >> /usr/local/bin/stellium-blockpruefung <<'ENDE'
PRUEFER="$QUELLE/scripts/bloecke-pruefen.mjs"
GEBAUT="$QUELLE/packages/server/dist/services/bloecke.js"

if [[ ! -f "$PRUEFER" || ! -f "$GEBAUT" ]]; then
  echo "Noch nichts zu prüfen: $PRUEFER oder der gebaute Server fehlt."
  exit 0
fi
if ! grep -q 'pruefeBlock' "$GEBAUT"; then
  echo "Der ausgelieferte Server kennt die Blockprüfung noch nicht — übersprungen."
  exit 0
fi

cd "$QUELLE"
exec /usr/bin/node "$PRUEFER" --daten "$DATEN"
ENDE
chmod 755 /usr/local/bin/stellium-blockpruefung

echo "→ Dienst"
cat > /etc/systemd/system/stellium-blockpruefung.service <<ENDE
[Unit]
Description=Stellium: Blockspeicher nachrechnen
Documentation=file://$QUELLE/scripts/bloecke-pruefen.mjs
After=stellium.service

[Service]
Type=oneshot
User=$BENUTZER
Group=$BENUTZER
WorkingDirectory=$QUELLE
ExecStart=/usr/local/bin/stellium-blockpruefung

# Der Chat hat Vorrang: die Prüfung liest den ganzen Blockspeicher und darf
# dabei niemandem die Karte wegnehmen.
Nice=10
IOSchedulingClass=idle

# Ohne eigenes /tmp — der Lauf schreibt nichts, und PrivateTmp würde nur
# verdecken, was er wirklich anfasst.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATEN
ENDE

echo "→ Zeitgeber (wöchentlich)"
cat > /etc/systemd/system/stellium-blockpruefung.timer <<'ENDE'
[Unit]
Description=Stellium: Blockspeicher wöchentlich nachrechnen

[Timer]
# Sonntagnacht: dann arbeitet niemand, und ein Fund liegt Montagfrüh vor.
OnCalendar=Sun 03:30
# War der Pi zum Termin aus, wird der Lauf nachgeholt statt übersprungen.
Persistent=true
RandomizedDelaySec=15min
Unit=stellium-blockpruefung.service

[Install]
WantedBy=timers.target
ENDE

systemctl daemon-reload
systemctl enable --now stellium-blockpruefung.timer >/dev/null

echo
systemctl list-timers stellium-blockpruefung.timer --no-pager
echo
echo "Sofort prüfen:  sudo systemctl start stellium-blockpruefung.service"
echo "Bericht lesen:  journalctl -u stellium-blockpruefung -n 50 --no-pager"
echo "Entfernen:      sudo bash $(basename "$0") zurueck"
