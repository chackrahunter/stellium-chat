# Ausliefern

Eine Änderung geht mit **einem Befehl** raus:

```bash
node scripts/ausliefern.mjs "Was neu ist — eine Zeile je Punkt"
```

Das erledigt der Reihe nach:

1. **Prüfen** — Typen von shared, server und desktop; ob der Server auf einer
   **alten** Datenbank hochkommt (`scripts/e2e-nachruesten.mjs`); dazu ein
   Hinweis, wenn noch Texte fest im Code stehen (`scripts/deutsch-finden.mjs`)
2. **Version** hochzählen (Patch; `--minor`, `--major` oder `1.3.0` direkt)
3. **Bauen** — macOS universal, Windows, Linux, dazu das Serverpaket
4. **Hochladen** auf den Stellium-Server → die OTA-Updates laufen damit an:
   Apps zeigen den Hinweis sofort, der Server holt sich seins innerhalb von
   30 Minuten und kündigt die Auszeit 15 Minuten vorher an
5. **Server einspielen** — der Pi wird angestoßen und dabei zugesehen; danach
   wird nachgefragt, welche Fassung dort wirklich läuft (`/api/health`)
6. **GitHub** — Release `vX.Y.Z` mit allen Paketen und der Änderungsliste
7. **Git** — Quelltextstand committen und schieben
8. **Lokal** — die neue Fassung auf diesem Mac installieren und starten

## Einzelne Schritte weglassen

```bash
--ohne-github     kein Release auf GitHub
--ohne-server     Serverpaket nicht mitschicken (dann kein Server-Update)
--ohne-hier       nicht auf diesem Mac installieren
--ohne-git        nicht committen und schieben
--nur-mac         nur macOS bauen (schneller beim Ausprobieren)
--probe           alles bauen, aber nichts senden
--notizen=DATEI   Änderungsliste aus einer Datei
```

## Zugang einmal einrichten

Das Skript braucht ein Konto auf dem Stellium-Server mit dem Recht
„Konten anlegen" (`user.manage`). Es sucht in dieser Reihenfolge:

1. `STELLIUM_LOGIN` und `STELLIUM_PASSWORT` aus der Umgebung
2. den Schlüsselbund, Dienst `stellium-veroeffentlichen`
3. `~/.stellium-veroeffentlichen` — Zeile 1 Benutzername, Zeile 2 Passwort

Empfohlen ist der Schlüsselbund, weil dort nichts im Klartext auf der Platte
liegt. Einmalig, das Passwort wird dabei nicht angezeigt:

```bash
security add-generic-password -U -s stellium-veroeffentlichen -a claude -w
```

Die Serveradresse steht bewusst nicht im Quelltext — das Repository ist
öffentlich. Sie kommt aus `STELLIUM_SERVER`, aus dem Schlüsselbund
(`stellium-server`) oder aus Zeile 3 von `~/.stellium-veroeffentlichen`:

```bash
security add-generic-password -U -s stellium-server -w https://dein-server:9443
```

## Wenn etwas schiefgeht

* **Das DMG scheitert an `hdiutil detach`** — kommt vor, wenn noch ein Abbild
  gemountet ist. Das Skript versucht es von selbst ein zweites Mal.
* **Ein Upload bricht mit `ERANGE` ab** — dieselbe Sache, drei Versuche je Datei.
* **Cloudflare lehnt mit 413 ab** (Tunnel deckelt bei 100 MB) — das Skript
  weicht von selbst auf SSH aus: Paket auf den Pi geschoben, dort über
  localhost eingespielt. Reißt die Leitung dabei ab, setzt die Übertragung an
  der Bruchstelle wieder auf statt von vorn zu beginnen, und zwar so lange,
  wie sie vorankommt — aufgegeben wird erst nach vier Anläufen ohne jeden
  Fortschritt. Braucht den SSH-Alias `stellium`
  (siehe server-setup/SSH-EINRICHTEN.md; übersteuerbar per `STELLIUM_SSH`).
* **„Das Paket ist unterwegs beschädigt worden"** — die Prüfsumme hier und die
  des Servers gehen auseinander. Einfach noch einmal ausliefern: die
  Übertragung setzt an der Bruchstelle auf.
* **„Der Server hat die neue Fassung NICHT übernommen"** — die Apps haben ihre
  Fassung bekommen, der Pi ist beim Einspielen gescheitert und auf den alten
  Stand zurückgefallen (das ist der eingebaute Rückweg, es geht nichts
  verloren). Der Grund steht daneben und ausführlich hier:
  `ssh stellium journalctl -u stellium-selbstupdate -n 60 --no-pager`.
  Häufigster Fall: eine neue Datenbankspalte wird in `schema.sql` schon
  benutzt, angelegt aber erst in `migrate.ts` — `node scripts/e2e-nachruesten.mjs`
  findet genau das.
* **GitHub oder Git schlagen fehl** — das Skript warnt und macht weiter; die
  Auslieferung an die Clients ist davon nicht betroffen.
* **Nichts kommt an** — nachsehen, ob der Pi läuft:
  `curl -sI "$STELLIUM_SERVER/api/releases"`

## Prüfläufe

Vor dem Ausliefern lohnt sich ein Durchlauf gegen den Entwicklungsserver
(`npm run dev` in einem zweiten Fenster):

```bash
for s in e2e-neu e2e-dialoge e2e-handy e2e-thread e2e-verschluesselung \
         e2e-upload e2e-vorschau e2e-verpasst e2e-aufgabenerkennung; do
  node scripts/$s.mjs
done
```
