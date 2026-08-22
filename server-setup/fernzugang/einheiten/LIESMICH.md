# Die Portfreigabe für SSH

Diese beiden Einheiten halten den SSH-Zugang zum Pi von außen offen. Sie
lagen bis zum 22.08.2026 **nur auf dem Pi** und in keinem Repo — ein
Neuaufsetzen hätte sie verloren, und mit ihnen den Zugang zu einer Maschine
in Alaska, an die niemand hinfahren kann.

Sie stehen hier als Abschrift des laufenden Stands. Angelegt wurden sie
seinerzeit von Hand; `stellium-zugang-melden` schreibt die `ExecStart`-Zeile
des Dienstes um, wenn der Router einen anderen äußeren Port vergibt als
gewünscht.

## Warum es sie überhaupt braucht

NAT-PMP vergibt Weiterleitungen nur auf Zeit — hier 3600 Sekunden. Läuft die
Frist ab, ist der Port zu, obwohl auf dem Pi alles normal aussieht: Dienst
aktiv, `ufw` offen, `ss` zeigt den Lauscher. Der Unterschied ist nur von
außen messbar:

    nc -z <öffentliche IP> 2222

Genau das ist am 22.08.2026 der Fernsteuerung passiert. Für Port 7788 gab es
keinen solchen Timer, obwohl die Doku das behauptete; die Verbindung fiel
nach jeder Stunde still weg. Seitdem gibt es
`server-setup/fernsteuerung/einheiten/stellium-fern-port.timer`.

## Einspielen

    sudo install -m 644 stellium-ssh-port.service /etc/systemd/system/
    sudo install -m 644 stellium-ssh-port.timer   /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now stellium-ssh-port.timer

## Nachsehen, ob es wirkt

    systemctl list-timers stellium-ssh-port.timer --no-pager
    journalctl -u stellium-ssh-port -n 20 --no-pager

**Jeder weitere Port, der von außen erreichbar sein soll, braucht einen
eigenen Timer.** Die Liste in `stellium-zugang` deckt HTTP, HTTPS und SSH ab
— sonst nichts.
