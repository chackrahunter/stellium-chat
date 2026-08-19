#!/bin/bash
# Holt das Fenster mit dem Protokoll des Fernzugriffs auf den Schirm.
#
# Läuft schon eines, genügt ein Klingeln — es kommt dann nach vorn, statt dass
# ein zweites daneben aufgeht. Sonst wird es gestartet.
if pgrep -f "^/usr/bin/python3 /usr/local/lib/stellium/ssh-wache.py" >/dev/null; then
  touch /tmp/stellium-wache-zeigen 2>/dev/null
else
  setsid /usr/local/bin/stellium-ssh-wache >/dev/null 2>&1 < /dev/null &
fi
