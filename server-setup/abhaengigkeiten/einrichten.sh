#!/usr/bin/env bash
#
# Richtet die tägliche Abhängigkeitsprüfung ein — und die automatischen
# Sicherheitsaktualisierungen für das Betriebssystem gleich mit.
#
#   sudo bash server-setup/abhaengigkeiten/einrichten.sh
#
# Zwei Ebenen, zwei Werkzeuge:
#
#   · Die Pakete von Stellium (npm) übernimmt stellium-abhaengigkeiten. Dort
#     ist ein Fehlschlag teuer — er kann den Dienst umwerfen — also wird nach
#     jedem Einspielen geprüft und im Zweifel zurückgerollt.
#
#   · Das Betriebssystem übernimmt unattended-upgrades, das dafür gemachte
#     Werkzeug von Debian. Es holt nur Sicherheitsaktualisierungen und nur aus
#     den Quellen der Distribution. Selbst etwas zu bauen wäre hier schlechter
#     als das, was ohnehin mitgeliefert wird.
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

[[ $EUID -eq 0 ]] || fehler "Bitte mit sudo starten."

HIER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Prüfskript ablegen ──────────────────────────────────────────
schritt "Prüfskript ablegen"
install -m 755 "$HIER/pruefen.sh" /usr/local/bin/stellium-abhaengigkeiten
ok "/usr/local/bin/stellium-abhaengigkeiten"

# ── Timer ───────────────────────────────────────────────────────
#
# 4:30 nachts: die Sicherung läuft um 23:00, der Selbstupdate alle 30 Minuten.
# Um halb fünf ist nichts anderes unterwegs, und der Neustart am Ende fällt in
# eine Stunde, in der ohnehin niemand schreibt. Persistent, damit ein Pi, der
# nachts aus war, den Lauf nachholt statt ihn zu überspringen.
schritt "Täglichen Lauf einrichten"
cat > /etc/systemd/system/stellium-abhaengigkeiten.service <<'DIENST'
[Unit]
Description=Stellium: Abhängigkeiten prüfen und gefahrlose Stände einspielen
After=network-online.target stellium.service
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/local/bin/stellium-abhaengigkeiten
# Bauen und Prüfen dauern auf einem Pi ein paar Minuten. Ohne eigene Grenze
# griffe irgendwann die vorgegebene und risse mitten im Einspielen ab.
TimeoutStartSec=45min
DIENST

cat > /etc/systemd/system/stellium-abhaengigkeiten.timer <<'TIMER'
[Unit]
Description=Stellium: jede Nacht nach neuen Paketständen sehen

[Timer]
OnCalendar=*-*-* 04:30:00
RandomizedDelaySec=20min
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now stellium-abhaengigkeiten.timer >/dev/null
ok "jede Nacht um 4:30"

# ── Systempakete ────────────────────────────────────────────────
schritt "Sicherheitsaktualisierungen des Systems"
if ! dpkg -s unattended-upgrades >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq unattended-upgrades
fi

# Die beiden Zeilen sind der eigentliche Schalter: ohne sie ist das Paket zwar
# installiert, läuft aber nie.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'ENDE'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
ENDE

# Eigene Datei statt Änderungen an 50unattended-upgrades: die gehört dem Paket
# und wird bei jeder Aktualisierung wieder zur Frage. Eine 60er daneben gewinnt
# und übersteht das.
cat > /etc/apt/apt.conf.d/60stellium-unattended <<'ENDE'
// Von Stellium gesetzt.

// Nur Sicherheitsquellen. Gewöhnliche Aktualisierungen können auf einem Pi,
// der einen Chat-Server trägt, warten, bis jemand hinsieht — Sicherheitslücken
// nicht.
//
// Das #clear ist keine Bemerkung, sondern eine Anweisung an apt und der
// entscheidende Griff: Listen aus mehreren Dateien werden ANGEHÄNGT, nicht
// ersetzt. Ohne diese Zeile stünde die Vorgabe aus 50unattended-upgrades —
// darunter die gewöhnliche Debian-Quelle — weiterhin mit in der Liste, und
// "nur Sicherheitsaktualisierungen" wäre schlicht nicht wahr.
#clear "Unattended-Upgrade::Origins-Pattern";
Unattended-Upgrade::Origins-Pattern {
    "origin=Debian,codename=${distro_codename},label=Debian-Security";
    "origin=Debian,codename=${distro_codename}-security,label=Debian-Security";
    "origin=Raspbian,codename=${distro_codename},label=Raspbian-Security";
    "origin=Raspberry Pi Foundation,codename=${distro_codename},label=Raspberry Pi Foundation";
};

// Der Kernel bleibt außen vor. Ein neuer Kernel wirkt erst nach einem
// Neustart, und einen Neustart entscheidet hier ein Mensch.
Unattended-Upgrade::Package-Blacklist {
    "linux-image-*";
    "raspberrypi-kernel";
    "raspberrypi-bootloader";
};

// Aufräumen, damit die Platte nicht langsam volläuft.
Unattended-Upgrade::Remove-Unused-Kernel-Packages "true";
Unattended-Upgrade::Remove-Unused-Dependencies "true";

// Nicht von selbst neu starten. Der Server soll nicht um drei Uhr nachts
// verschwinden, weil ein Paket es für nötig hielt.
Unattended-Upgrade::Automatic-Reboot "false";

// Ein abgebrochener Lauf soll beim nächsten Mal zu Ende geführt werden, statt
// dpkg halb fertig liegen zu lassen.
Unattended-Upgrade::AutoFixInterruptedDpkg "true";
Unattended-Upgrade::MinimalSteps "true";
ENDE

systemctl enable --now unattended-upgrades >/dev/null 2>&1 || true

# --dry-run fasst nichts an und sagt trotzdem, ob die Regeln greifen. Besser
# jetzt merken, dass eine Quelle nicht passt, als in drei Monaten.
if unattended-upgrade --dry-run --debug >/tmp/stellium-uu-probe.log 2>&1; then
  ok "unattended-upgrades läuft — nur Sicherheitsquellen, ohne Neustart"
  grep -m3 -E 'Allowed origins are|Packages that will be upgraded' /tmp/stellium-uu-probe.log \
    | sed 's/^/    /' || true
else
  warn "unattended-upgrade meldet ein Problem — siehe /tmp/stellium-uu-probe.log"
fi

# ── Fertig ──────────────────────────────────────────────────────
printf '\n%s✓ Eingerichtet.%s\n\n' "$GRUEN$FETT" "$AUS"
cat <<HINWEIS
  ${FETT}Von Hand starten${AUS}
    ${GRAU}sudo stellium-abhaengigkeiten pruefen${AUS}    nur nachsehen
    ${GRAU}sudo stellium-abhaengigkeiten${AUS}            nachsehen und einspielen

  ${FETT}Ergebnis${AUS}
    ${GRAU}cat /var/lib/stellium/abhaengigkeiten.json${AUS}
    ${GRAU}journalctl -u stellium-abhaengigkeiten -n 60${AUS}

HINWEIS
