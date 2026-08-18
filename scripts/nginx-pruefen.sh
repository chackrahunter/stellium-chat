#!/usr/bin/env bash
#
# Prüft die vom Installer erzeugte nginx-Konfiguration gegen ein echtes nginx.
# Baut dazu eine Umgebung nach, wie sie auf Debian aussieht — samt der
# Voreinstellungen, mit denen sich unsere Angaben beißen könnten.
set -Eeuo pipefail

W="${1:-/tmp/nginx-pruefung}"
SKRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/server-setup/stellium-installieren.sh"

rm -rf "$W"; mkdir -p "$W"/{conf.d,snippets,sites-available,sites-enabled,logs,zert}

# Ein selbst ausgestelltes Zertifikat, damit die TLS-Zeilen prüfbar sind.
openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$W/zert/privkey.pem" -out "$W/zert/fullchain.pem" \
  -subj "/CN=chat.beispiel.de" >/dev/null 2>&1
cp "$W/zert/fullchain.pem" "$W/zert/chain.pem"

# Die Funktionen aus dem Installer holen und die Pfade umbiegen.
python3 - "$SKRIPT" "$W" <<'PY'
import sys, pathlib
skript, w = sys.argv[1], sys.argv[2]
s = pathlib.Path(skript).read_text()
teil = s[s.index('# Bausteine, die beide Varianten teilen.'):s.index('ADRESSE=""\n\nif [[ "$WAHL" == "3" ]]')]
teil = (teil.replace('/etc/nginx', w)
            .replace('/var/www/html', f'{w}/www')
            .replace(f'/etc/letsencrypt/live/$NAME', f'{w}/zert')
            .replace('$NAME/fullchain.pem', 'fullchain.pem')
            .replace('$NAME/privkey.pem', 'privkey.pem')
            .replace('$NAME/chain.pem', 'chain.pem'))
pathlib.Path(f'{w}/bausteine.sh').write_text('#!/usr/bin/env bash\nset -Eeuo pipefail\n' + teil)
PY

mkdir -p "$W/www"
# shellcheck source=/dev/null
. "$W/bausteine.sh"
ln -sf "$W/sites-available/stellium" "$W/sites-enabled/stellium"

# Die Ports lassen sich für den Test vorgeben — sonst wählt der Baustein
# selbst, und auf einem Rechner ohne ss kommen immer 80 und 443 heraus.
PORT_HTTP="${3:-80}"
PORT_HTTPS="${4:-443}"

VARIANTE="${2:-tls}"
case "$VARIANTE" in
  tls)  schreibe_mit_tls chat.beispiel.de ;;
  http) schreibe_nur_http ;;
  *)    echo "Unbekannte Variante: $VARIANTE"; exit 1 ;;
esac

# Debians nginx.conf, so weit sie für uns zählt — inklusive server_tokens,
# an dem sich die erste Fassung gestoßen hat.
cat > "$W/nginx.conf" <<CONF
worker_processes 1;
error_log $W/logs/error.log;
pid $W/nginx.pid;
events { worker_connections 128; }
http {
  access_log $W/logs/access.log;
  client_body_temp_path $W/logs;
  proxy_temp_path $W/logs;
  fastcgi_temp_path $W/logs;
  uwsgi_temp_path $W/logs;
  scgi_temp_path $W/logs;

  sendfile on;
  keepalive_timeout 65;
  server_tokens off;

  include $W/conf.d/*.conf;
  include $W/sites-enabled/*;
}
CONF

if AUSGABE="$(nginx -t -c "$W/nginx.conf" -p "$W" 2>&1)"; then
  echo "✓ nginx nimmt die Konfiguration an ($VARIANTE)"
  echo "$AUSGABE" | grep -i warn && echo "  (Warnungen oben — nicht zwingend ein Fehler)" || true
else
  echo "✗ nginx lehnt ab:"
  echo "$AUSGABE"
  exit 1
fi
