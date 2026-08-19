# Fernzugriff auf den Pi einrichten

Damit ich (oder du von unterwegs) am Server arbeiten kann, ohne davorzusitzen.
Drei Schritte, zehn Minuten, danach genügt ein `ssh stellium`.

## 1. Auf dem Pi: SSH einschalten

Am Pi selbst, in einem Terminalfenster:

```bash
sudo raspi-config nonint do_ssh 0
sudo systemctl enable --now ssh
```

Das schaltet den Dienst ein und sorgt dafür, dass er nach jedem Neustart
wieder läuft. Prüfen:

```bash
systemctl is-active ssh
```

Muss `active` sagen.

## 2. Auf dem Mac: Schlüssel erzeugen und hinterlegen

**Kein Passwort über die Leitung.** Ein Schlüsselpaar ist bequemer und sicherer:
der geheime Teil bleibt auf dem Mac, der öffentliche darf jeder sehen.

```bash
ssh-keygen -t ed25519 -C "stellium-pi" -f ~/.ssh/stellium
```

Bei der Frage nach einer Passphrase: eine setzen, wenn der Mac auch von anderen
benutzt wird — sonst Enter. Danach den öffentlichen Teil auf den Pi bringen
(einmalig mit Passwort, danach nie wieder):

```bash
ssh-copy-id -i ~/.ssh/stellium.pub aryan@raspberrypi.local
```

Ist der Pi nicht im selben Netz, brauchst du seine Adresse — siehe Schritt 4.

## 3. Auf dem Mac: einen kurzen Namen vergeben

In `~/.ssh/config` eintragen (Datei anlegen, falls es sie nicht gibt):

```
Host stellium
  HostName raspberrypi.local
  User aryan
  IdentityFile ~/.ssh/stellium
  IdentitiesOnly yes
  ServerAliveInterval 30
```

Ab jetzt reicht:

```bash
ssh stellium
```

## 4. Von außen erreichbar — ohne Zusatzsoftware

Auf dem Pi erledigt ein Skript alles, was dort nötig ist:

```bash
sudo bash /opt/stellium/server-setup/stellium-ssh.sh 'ssh-ed25519 AAAA... dein-kommentar'
```

Es trägt den Schlüssel ein, schaltet Passwort-Anmeldung ab, verbietet root,
verlegt SSH auf Port 2222 und stellt fail2ban davor. Die laufende Sitzung
bleibt dabei bestehen — **prüfe die neue Verbindung in einem zweiten Fenster,
bevor du das erste schließt.**

Danach fehlt nur noch eine Zeile im Router, dieselbe Stelle, an der schon
9443 steht:

| | |
|---|---|
| extern | TCP 2222 |
| intern | die lokale Adresse des Pi, Port 2222 |

Vom Mac aus dann:

```bash
ssh -p 2222 aryan@deine-adresse.duckdns.org
```

### Warum Port 2222 und nicht 22

Port 22 wird im Internet rund um die Uhr durchprobiert — ein frisch geöffneter
Port sammelt binnen Minuten die ersten Versuche ein. Ein anderer Port hält das
Grundrauschen fern. Der eigentliche Schutz sind aber die Schlüssel: ohne
Passwort-Anmeldung nützt Durchprobieren gar nichts.

## 5. Absichern

Sobald der Schlüssel funktioniert, Passwörter abschalten:

```bash
sudo sed -i 's/^#\?PasswordAuthentication .*/PasswordAuthentication no/' /etc/ssh/sshd_config
sudo sed -i 's/^#\?PermitRootLogin .*/PermitRootLogin no/' /etc/ssh/sshd_config
sudo systemctl restart ssh
```

**Vorher prüfen, dass die Anmeldung mit Schlüssel wirklich geht** — sonst
sperrst du dich aus. Am besten ein zweites Fenster offen lassen, das schon
verbunden ist.

Dazu noch eine Bremse gegen Durchprobieren:

```bash
sudo apt-get install -y fail2ban
sudo systemctl enable --now fail2ban
```

## Wenn der Port plötzlich nicht mehr stimmt

Die Weiterleitung im Router wird erbeten, nicht fest eingetragen — nach einem
Neustart des Routers kann sie auf einer anderen Portnummer landen. Dagegen
schreibt der Pi laufend auf, wo er gerade zu erreichen ist, und ein Skript
trägt das auf dem Mac ein:

```bash
bash server-setup/fernzugang/mac-ssh-config.sh
```

Alles Weitere dazu — auch der Rückweg über Tailscale, wenn gar nichts mehr
geht — steht in [`fernzugang/LIESMICH.md`](fernzugang/LIESMICH.md).

## Was ich damit tun kann

Mit `ssh stellium` komme ich an:

* `sudo stellium-update` — den Server von Hand aktualisieren
* `journalctl -u stellium -f` — mitlesen, wenn etwas klemmt
* `/var/lib/stellium/` — Datenbank, Sicherungen, Tresor
* `stellium` — die Statuskonsole

Was ich **nicht** tue: an der Datenbank vorbei Nachrichten lesen, Konten
anlegen oder Geheimnisse anfassen, ohne dass du es weißt.
