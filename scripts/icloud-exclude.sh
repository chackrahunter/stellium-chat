#!/usr/bin/env bash
# Nimmt node_modules aus dem iCloud-Sync heraus.
#
# Hintergrund: Dieses Projekt liegt unter ~/Documents und wird damit von iCloud
# Drive synchronisiert. node_modules besteht aus hunderttausenden kleinen Dateien —
# iCloud versucht, jede einzelne hochzuladen. Ergebnis: Builds dauern Minuten
# statt Sekunden, und iCloud kann Dateien auslagern, während npm sie noch braucht.
#
# iCloud ignoriert alles, was auf ".nosync" endet. Das Skript verschiebt die
# node_modules-Verzeichnisse dorthin und setzt Symlinks zurück — npm und node
# merken davon nichts.
#
# Aufruf:  bash scripts/icloud-exclude.sh
# Rückgängig: bash scripts/icloud-exclude.sh --undo

set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

DIRS=(
  "node_modules"
  "packages/shared/node_modules"
  "packages/server/node_modules"
  "packages/desktop/node_modules"
  "packages/desktop/dist"
  "packages/desktop/dist-electron"
  "packages/desktop/release"
)

if [[ "${1:-}" == "--undo" ]]; then
  for d in "${DIRS[@]}"; do
    if [[ -L "$ROOT/$d" && -d "$ROOT/$d.nosync" ]]; then
      rm "$ROOT/$d"
      mv "$ROOT/$d.nosync" "$ROOT/$d"
      echo "zurückgesetzt: $d"
    fi
  done
  echo "Fertig. node_modules wird wieder synchronisiert."
  exit 0
fi

for d in "${DIRS[@]}"; do
  target="$ROOT/$d"
  [[ -e "$target" || -L "$target" ]] || continue
  if [[ -L "$target" ]]; then
    echo "übersprungen (schon ausgelagert): $d"
    continue
  fi
  echo "lagere aus: $d"
  mv "$target" "$target.nosync"
  ln -s "$(basename "$d").nosync" "$target"
done

echo
echo "Fertig. iCloud überspringt diese Ordner ab jetzt."
echo "Prüfen mit:  ls -la node_modules"
