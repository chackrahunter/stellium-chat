# Schreibt in einer SSH-Sitzung jeden eingetippten Befehl mit.
# Wird von /etc/profile.d aus geladen, gilt also für alle Konten.
[ -n "${SSH_CONNECTION:-}" ] || return 0
[ -n "${BASH_VERSION:-}" ] || return 0
case $- in *i*) ;; *) return 0 ;; esac

stellium_zuletzt=""
stellium_mitschreiben() {
  local zeile
  zeile=$(history 1 2>/dev/null | sed 's/^ *[0-9]* *//')
  [ -z "$zeile" ] && return 0
  [ "$zeile" = "$stellium_zuletzt" ] && return 0
  stellium_zuletzt="$zeile"
  logger -t stellium-ssh -p local5.info -- "$zeile" 2>/dev/null || true
}
PROMPT_COMMAND="stellium_mitschreiben${PROMPT_COMMAND:+; $PROMPT_COMMAND}"
