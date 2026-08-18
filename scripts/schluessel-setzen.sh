#!/usr/bin/env bash
#
# Nimmt einen neuen Groq-Schlüssel entgegen, legt ihn verschlüsselt ab,
# startet den Server neu und prüft, ob er damit arbeiten kann.
#
#   bash scripts/schluessel-setzen.sh
#
set -uo pipefail
cd "$(dirname "$0")/.."

blau=$'\033[38;5;105m'; gruen=$'\033[38;5;77m'; rot=$'\033[38;5;203m'
grau=$'\033[38;5;245m'; fett=$'\033[1m'; aus=$'\033[0m'

linie() { printf '%s%s%s\n' "$grau" "──────────────────────────────────────────────────────────" "$aus"; }

printf '\n%s%s  Stellium — Groq-Schlüssel hinterlegen%s\n' "$fett" "$blau" "$aus"
linie
printf '%sHol dir einen neuen Schlüssel auf https://console.groq.com/keys%s\n' "$grau" "$aus"
printf '%sund füge ihn unten ein. Die Eingabe bleibt unsichtbar — das ist normal.%s\n\n' "$grau" "$aus"

if ! npm run --silent secret -w @stellium/server -- setzen groq; then
  printf '\n%sAbgebrochen. Der bisherige Schlüssel bleibt unverändert.%s\n\n' "$rot" "$aus"
  exit 1
fi

linie
printf '%sServer neu starten, damit er den neuen Schlüssel liest…%s\n' "$grau" "$aus"

PLIST="$HOME/Library/LaunchAgents/com.stellium.server.plist"
if [ -f "$PLIST" ]; then
  launchctl unload "$PLIST" 2>/dev/null
  sleep 1
  launchctl load "$PLIST"
else
  pkill -f "stellium.*dist/index.js" 2>/dev/null
  ( cd packages/server && node --experimental-sqlite dist/index.js >/dev/null 2>&1 & )
fi

for i in $(seq 1 30); do
  curl -s --max-time 2 http://localhost:8787/api/health >/dev/null 2>&1 && break
  sleep 1
done

antwort=$(curl -s --max-time 4 http://localhost:8787/api/health 2>/dev/null)
if [ -z "$antwort" ]; then
  printf '\n%sServer antwortet nicht. Log: ~/Library/Logs/Stellium/server.log%s\n\n' "$rot" "$aus"
  exit 1
fi

linie
python3 - "$antwort" <<'PY'
import json, sys
d = json.loads(sys.argv[1])
a = d['ai']
gruen = '\033[38;5;77m'; rot = '\033[38;5;203m'; grau = '\033[38;5;245m'; aus = '\033[0m'
ok = a['translation'] and a['assistant']
print(f"  Anbieter        {a['provider']}")
print(f"  Modell          {a['model'] or '—'}")
print(f"  Schnellmodell   {a['fastModel'] or '—'}")
print(f"  Sprachnachricht {a['transcriptionModel'] or '—'}")
print()
if ok:
    print(f"{gruen}  ✓ Übersetzung und KI laufen mit dem neuen Schlüssel.{aus}")
    print(f"{grau}    Er liegt verschlüsselt in packages/server/data/secrets.enc,")
    print(f"    das Masterpasswort in deiner macOS-Keychain.{aus}")
else:
    print(f"{rot}  ✗ Der Schlüssel wird nicht angenommen.{aus}")
    if a.get('note'):
        print(f"{grau}    {a['note']}{aus}")
PY
printf '\n'
linie
printf '%sFenster kann geschlossen werden.%s\n\n' "$grau" "$aus"
