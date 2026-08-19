#!/usr/bin/env bash
#
# Holt vom Pi den Zettel mit Adresse und Port und trägt ihn auf diesem Mac in
# ~/.ssh/config ein. Danach stimmt `ssh stellium` wieder — auch wenn der Router
# zwischendurch einen anderen äußeren Port vergeben hat.
#
#   bash server-setup/fernzugang/mac-ssh-config.sh
#   bash server-setup/fernzugang/mac-ssh-config.sh --host meine.adresse.org
#   bash server-setup/fernzugang/mac-ssh-config.sh --tailscale
#   bash server-setup/fernzugang/mac-ssh-config.sh --zeigen     nur nachsehen
#
# Warum überhaupt ein Skript und nicht von Hand: die Portnummer ändert sich
# selten, aber immer zum ungünstigsten Zeitpunkt — nämlich dann, wenn man
# gerade nicht vor dem Pi sitzt und ihn deshalb auch nicht fragen kann.
#
# Was aus dem Netz kommt, wird geprüft, bevor es in eine Konfigurationsdatei
# wandert: eine Adresse darf nur aus Buchstaben, Ziffern, Punkt und Bindestrich
# bestehen, ein Port muss eine Zahl zwischen 1 und 65535 sein. Sonst könnte
# eine untergeschobene Antwort beliebige Zeilen in ~/.ssh/config schreiben.
#
set -Eeuo pipefail

if [[ -t 1 ]]; then
  ROT=$'\e[31m'; GRUEN=$'\e[32m'; GELB=$'\e[33m'; BLAU=$'\e[38;5;99m'
  GRAU=$'\e[90m'; FETT=$'\e[1m'; AUS=$'\e[0m'
else
  ROT=''; GRUEN=''; GELB=''; BLAU=''; GRAU=''; FETT=''; AUS=''
fi
schritt() { printf '\n%s▸ %s%s\n' "$BLAU$FETT" "$*" "$AUS"; }
info()    { printf '  %s\n' "$*"; }
ok()      { printf '  %s✓%s %s\n' "$GRUEN" "$AUS" "$*"; }
warn()    { printf '  %s!%s %s\n' "$GELB" "$AUS" "$*"; }
fehler()  { printf '\n%s✗ %s%s\n\n' "$ROT$FETT" "$*" "$AUS" >&2; exit 1; }

# Die Adresse im Tailnet. Sie ändert sich nie, braucht keine Freigabe im Router
# und ist der Rückweg, wenn über die Weiterleitung gar nichts mehr geht.
TAILSCALE_IP="100.102.168.44"

EINTRAG="stellium"
CONFIG="$HOME/.ssh/config"
HOST_VORGABE=""
NUR_ZEIGEN=0
UEBER_TAILSCALE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host)      HOST_VORGABE="${2:-}"; shift 2 ;;
    --eintrag)   EINTRAG="${2:-}"; shift 2 ;;
    --zeigen)    NUR_ZEIGEN=1; shift ;;
    --tailscale) UEBER_TAILSCALE=1; shift ;;
    -h|--hilfe|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) fehler "Unbekannte Angabe: $1" ;;
  esac
done

# ── Was steht heute in der Konfiguration? ───────────────────────
#
# Der bisherige Eintrag ist die beste Ausgangsvermutung: unter welcher Adresse
# der Pi zu finden ist, hat sich nicht geändert — nur der Port dahinter.
block_lesen() {
  [[ -f "$CONFIG" ]] || return 0
  awk -v name="$EINTRAG" '
    { kopf = tolower($1) }
    kopf == "host" || kopf == "match" {
      drin = 0
      if (kopf == "host") for (i = 2; i <= NF; i++) if ($i == name) drin = 1
      next
    }
    drin { print }
  ' "$CONFIG"
}
ALTER_HOST="$(block_lesen | awk 'tolower($1) == "hostname" { print $2; exit }')"
ALTER_PORT="$(block_lesen | awk 'tolower($1) == "port" { print $2; exit }')"
NUTZER="$(block_lesen | awk 'tolower($1) == "user" { print $2; exit }')"
SCHLUESSEL="$(block_lesen | awk 'tolower($1) == "identityfile" { print $2; exit }')"
NUTZER="${NUTZER:-aryan}"
SCHLUESSEL="${SCHLUESSEL:-~/.ssh/stellium}"

if [[ $UEBER_TAILSCALE -eq 1 ]]; then
  # Im Tailnet gibt es keine Weiterleitung und keinen verlegten Port — der Pi
  # ist dort unter seiner eigenen Adresse und dem inneren SSH-Port zu Hause.
  HOST="$TAILSCALE_IP"
  PORT="${ALTER_PORT:-2222}"
  ZEIT=""
  schritt "Über Tailscale"
  info "$HOST:$PORT — kein Zettel nötig, diese Adresse wandert nicht."
else
  HOST_ABFRAGE="${HOST_VORGABE:-${ALTER_HOST:-stellium-chat.duckdns.org}}"

  # ── Zettel holen ──────────────────────────────────────────────
  #
  # Zwei Ports, weil HTTPS auf diesem Pi auf 9443 liegt und zusätzlich auf 443
  # erreichbar ist. Welcher gerade geht, weiß man vorher nicht.
  schritt "Zettel holen"
  ZETTEL=""
  for URL in "https://$HOST_ABFRAGE/zugang.json" "https://$HOST_ABFRAGE:9443/zugang.json"; do
    info "$URL"
    if ZETTEL="$(curl -fsS --max-time 12 "$URL" 2>/dev/null)" && [[ -n "$ZETTEL" ]]; then
      ok "gefunden"
      break
    fi
    ZETTEL=""
  done

  if [[ -z "$ZETTEL" ]]; then
    cat >&2 <<HINWEIS

  ${GELB}${FETT}Der Zettel war nicht abrufbar.${AUS}

  Dann ist entweder der Pi aus, oder auch die HTTPS-Weiterleitung im Router
  ist verrutscht. Der Rückweg führt über Tailscale — der ändert sich nie:

      ${GRAU}bash $0 --tailscale${AUS}
      ${GRAU}ssh -p 2222 $NUTZER@$TAILSCALE_IP${AUS}

  Läuft auf diesem Mac kein Tailscale, hilft nur der Weg über einen Bildschirm
  am Pi selbst.

HINWEIS
    exit 1
  fi

  HOST="$(printf '%s' "$ZETTEL" | sed -n 's/.*"host"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  PORT="$(printf '%s' "$ZETTEL" | sed -n 's/.*"port"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' | head -1)"
  ZEIT="$(printf '%s' "$ZETTEL" | sed -n 's/.*"zeit"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)"
  STEMPEL="$(printf '%s' "$ZETTEL" | sed -n 's/.*"zeitStempel"[[:space:]]*:[[:space:]]*\([0-9]\{1,\}\).*/\1/p' | head -1)"

  [[ "$HOST" =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] \
    || fehler "Die Adresse im Zettel sieht nicht aus wie eine Adresse: ${HOST:-（leer）}"
  [[ "$PORT" =~ ^[0-9]{1,5}$ ]] && (( PORT >= 1 && PORT <= 65535 )) \
    || fehler "Die Portnummer im Zettel ist keine: ${PORT:-（leer）}"

  # Ein alter Zettel ist kein Fehler, aber ein Hinweis: dann hat der Pi seit
  # einer Weile nichts mehr aufgeschrieben und die Angabe könnte überholt sein.
  if [[ -n "$STEMPEL" ]]; then
    ALTER=$(( ($(date +%s) - STEMPEL / 1000) / 60 ))
    if (( ALTER > 60 )); then
      warn "Der Zettel ist $ALTER Minuten alt — der Pi meldet sich gerade nicht."
    fi
  fi
fi

printf '\n  %s%s:%s%s   %s%s%s\n' "$FETT" "$HOST" "$PORT" "$AUS" "$GRAU" "${ZEIT:+aufgeschrieben $ZEIT}" "$AUS"

if [[ $NUR_ZEIGEN -eq 1 ]]; then
  exit 0
fi

if [[ "$HOST" == "$ALTER_HOST" && "$PORT" == "$ALTER_PORT" ]]; then
  ok "~/.ssh/config stimmt bereits"
else
  # ── Eintragen ─────────────────────────────────────────────────
  schritt "~/.ssh/config anpassen"
  mkdir -p "$HOME/.ssh"; chmod 700 "$HOME/.ssh"
  touch "$CONFIG"; chmod 600 "$CONFIG"
  cp -a "$CONFIG" "$CONFIG.stellium-vorher"

  NEU="$(awk -v name="$EINTRAG" -v host="$HOST" -v port="$PORT" \
             -v nutzer="$NUTZER" -v schluessel="$SCHLUESSEL" '
    { kopf = tolower($1) }
    kopf == "host" || kopf == "match" {
      drin = 0
      if (kopf == "host") for (i = 2; i <= NF; i++) if ($i == name) drin = 1
      print
      # Adresse und Port kommen neu und sofort; die alten Zeilen fallen unten
      # weg. Alles andere im Block — User, Schlüssel, Optionen — bleibt, wie
      # es ist. Dieses Skript darf nur zwei Angaben anfassen.
      if (drin) { print "  HostName " host; print "  Port " port; getan = 1 }
      next
    }
    drin && (kopf == "hostname" || kopf == "port") { next }
    { print }
    END {
      if (!getan) {
        print ""
        print "Host " name
        print "  HostName " host
        print "  Port " port
        print "  User " nutzer
        print "  IdentityFile " schluessel
        print "  IdentitiesOnly yes"
        print "  ServerAliveInterval 30"
      }
    }
  ' "$CONFIG")"

  printf '%s\n' "$NEU" > "$CONFIG"
  chmod 600 "$CONFIG"
  ok "Host $EINTRAG → $HOST:$PORT   ${GRAU}(vorher: $CONFIG.stellium-vorher)${AUS}"
fi

# ── Nachsehen, ob es wirklich geht ──────────────────────────────
schritt "Verbindung prüfen"
if ssh -o BatchMode=yes -o ConnectTimeout=12 -o StrictHostKeyChecking=accept-new \
       "$EINTRAG" true 2>/dev/null; then
  ok "ssh $EINTRAG geht"
else
  warn "ssh $EINTRAG kommt nicht durch."
  info "Der Zettel kann stimmen und die Weiterleitung trotzdem noch nicht greifen —"
  info "in zwei Minuten noch einmal probieren. Sonst über Tailscale:"
  info "  ${GRAU}bash $0 --tailscale${AUS}"
  exit 1
fi
