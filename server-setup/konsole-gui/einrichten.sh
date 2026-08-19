#!/usr/bin/env bash
# Legt die grafische Konsole an und macht sie vom Desktop aus startbar.
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Bitte mit sudo starten."; exit 1; }
HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

python3 -c "import tkinter" 2>/dev/null || { apt-get update -qq; apt-get install -y python3-tk; }

install -d -m 755 /usr/local/lib/stellium
install -m 755 "$HIER/konsole.py" /usr/local/lib/stellium/konsole-gui.py

cat > /usr/local/bin/stellium-konsole-gui <<'ENDE'
#!/bin/bash
exec /usr/bin/python3 /usr/local/lib/stellium/konsole-gui.py "$@"
ENDE
chmod 755 /usr/local/bin/stellium-konsole-gui

cat > /usr/share/applications/stellium-konsole.desktop <<'ENDE'
[Desktop Entry]
Type=Application
Name=Stellium Konsole
Comment=Zustand des Stellium-Servers auf einen Blick
Exec=/usr/local/bin/stellium-konsole-gui
Icon=utilities-system-monitor
Terminal=false
Categories=System;Monitor;
StartupNotify=true
ENDE

# Auch als Verknüpfung auf dem Schreibtisch, wenn es einen gibt.
for heim in /home/*; do
  [ -d "$heim/Desktop" ] || continue
  install -m 755 /usr/share/applications/stellium-konsole.desktop "$heim/Desktop/"
  chown "$(basename "$heim")":"$(basename "$heim")" "$heim/Desktop/stellium-konsole.desktop" 2>/dev/null || true
done

echo "Fertig — „Stellium Konsole“ liegt im Startmenü und auf dem Schreibtisch."
