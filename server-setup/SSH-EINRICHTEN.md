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

## 4. Von außen erreichbar — ohne Port 22 zu öffnen

Port 22 ins Internet zu stellen ist eine schlechte Idee: solche Ports werden
rund um die Uhr durchprobiert. Zwei bessere Wege, beide ohne Portfreigabe.

### Weg A: über den Tunnel, den es schon gibt (empfohlen)

Auf dem Pi läuft `cloudflared` bereits für den Chat. Derselbe Tunnel kann SSH
mittragen:

```bash
sudo cloudflared tunnel route dns stellium ssh.deine-domain.de
```

Auf dem Mac in `~/.ssh/config`:

```
Host stellium-fern
  HostName ssh.deine-domain.de
  User aryan
  IdentityFile ~/.ssh/stellium
  ProxyCommand cloudflared access ssh --hostname %h
```

### Weg B: WireGuard zwischen Mac und Pi

Ein kleines eigenes Netz nur für euch beide. Auf dem Pi:

```bash
curl -L https://install.pivpn.io | bash
```

Nach der Einrichtung eine Konfiguration für den Mac erzeugen und dort
importieren. Danach ist der Pi unter seiner internen Adresse erreichbar, als
säße er im selben Raum.

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

## Was ich damit tun kann

Mit `ssh stellium` komme ich an:

* `sudo stellium-update` — den Server von Hand aktualisieren
* `journalctl -u stellium -f` — mitlesen, wenn etwas klemmt
* `/var/lib/stellium/` — Datenbank, Sicherungen, Tresor
* `stellium` — die Statuskonsole

Was ich **nicht** tue: an der Datenbank vorbei Nachrichten lesen, Konten
anlegen oder Geheimnisse anfassen, ohne dass du es weißt.
