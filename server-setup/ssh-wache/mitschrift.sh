#!/bin/bash
# Läuft bei jeder SSH-Sitzung als erstes und schreibt mit, was geschieht.
#
# Absichtlich zahm: keine Zeile darf dazu führen, dass die Sitzung scheitert —
# wer sich aus seinem eigenen Pi aussperrt, hat nichts gewonnen. Deshalb endet
# jeder Schritt mit einem "|| true", und am Ende steht immer die Shell.
notiz() { logger -t stellium-ssh -p local5.info -- "$*" 2>/dev/null || true; }
herkunft="${SSH_CONNECTION%% *}"
[ -n "$herkunft" ] || herkunft="unbekannt"

befehl="${SSH_ORIGINAL_COMMAND:-}"

# Dateiübertragung durchreichen, sonst wären scp und sftp kaputt.
case "$befehl" in
  sftp|internal-sftp|*sftp-server*)
    notiz "DATEIEN $USER von $herkunft"
    for pfad in /usr/lib/openssh/sftp-server /usr/libexec/sftp-server /usr/lib/ssh/sftp-server; do
      [ -x "$pfad" ] && exec "$pfad"
    done
    exec /usr/lib/openssh/sftp-server
    ;;
esac

if [ -n "$befehl" ]; then
  notiz "ÖFFNET $USER von $herkunft"
  notiz "$befehl"
  "${SHELL:-/bin/bash}" -c "$befehl"
  stand=$?
  notiz "SCHLIESST $USER von $herkunft"
  exit $stand
fi

notiz "ÖFFNET $USER von $herkunft (Sitzung)"
"${SHELL:-/bin/bash}" -l
stand=$?
notiz "SCHLIESST $USER von $herkunft"
exit $stand
