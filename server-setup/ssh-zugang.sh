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
INNEN=22
DIENST=/etc/systemd/system/stellium-ssh-port.service
TIMER=/etc/systemd/system/stellium-ssh-port.timer

[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
command -v natpmpc >/dev/null || { apt-get update -qq && apt-get install -y natpmpc; }

echo "→ SSH-Dienst sicherstellen"
systemctl enable --now ssh >/dev/null 2>&1 || systemctl enable --now sshd
ss -ltn | grep -q ":$INNEN " || { echo "FEHLER: auf Port $INNEN lauscht nichts."; exit 1; }
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
