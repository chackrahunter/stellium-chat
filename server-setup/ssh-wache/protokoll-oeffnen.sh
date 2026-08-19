#!/bin/bash
# Holt das Fernzugriff-Fenster auf den Schirm — auch wenn gerade niemand
# verbunden ist. Läuft die Wache schon, genügt ein Klingeln; sonst wird sie
# gestartet und klingelt sich selbst.
touch /tmp/stellium-wache-zeigen 2>/dev/null
if ! pgrep -f "^/usr/bin/python3 /usr/local/lib/stellium/ssh-wache.py" >/dev/null; then
  setsid /usr/local/bin/stellium-ssh-wache >/dev/null 2>&1 < /dev/null &
fi
