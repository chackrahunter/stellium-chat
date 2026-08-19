# Stellium — für die Arbeit an diesem Projekt

Firmen-Chat mit Live-Übersetzung. Server auf einem Raspberry Pi, Apps für
macOS, Windows und Linux, dazu die Oberfläche im Browser.

## Eine Änderung ausliefern

**Nicht von Hand bauen und hochladen.** Dafür gibt es ein Werkzeug:

```bash
node scripts/ausliefern.mjs "Was neu ist — eine Zeile je Punkt"
```

Version hochzählen, prüfen, bauen, auf den Server hochladen (damit laufen die
OTA-Updates an), GitHub-Release, committen, schieben, lokal installieren —
alles darin. Einzelheiten und Schalter: [AUSLIEFERN.md](AUSLIEFERN.md).

## Aufbau

```
packages/shared    Typen, WS-Protokoll, Sprachlisten
packages/server    Fastify + node:sqlite, WebSocket-Gateway, Übersetzung, KI
packages/desktop   Electron + React; src/ ist auch die Browser-Oberfläche
server-setup       Ein-Klick-Installer und Werkzeuge für den Raspberry Pi
scripts            Prüfläufe (e2e-*), Wörterbücher, Ausliefern
```

## Zwei Dinge, die man leicht übersieht

**Alle Texte kommen aus dem Wörterbuch.** Nichts Lesbares gehört fest in den
Code — die Oberfläche liegt in 22 Sprachen vor. Prüfen mit:

```bash
node scripts/deutsch-finden.mjs      # findet fest verdrahtete Texte
node scripts/woerterbuecher-erzeugen.mjs --neue   # fehlende Einträge ergänzen
```

Englisch ist Vorlage wie Deutsch und wird vom Generator **nicht** gefüllt —
neue Schlüssel dort von Hand nachtragen.

**Nachrichten liegen verschlüsselt in der Datenbank.** Wer eine neue Spalte
mit lesbarem Inhalt anlegt, muss sie durch `crypto/nachrichten.ts` schicken
und in `db/migrate.ts` in die Nachrüstung aufnehmen. Der Volltextindex trägt
Fingerabdrücke, keine Wörter.

## Prüfläufe

Brauchen `npm run dev` in einem zweiten Fenster (Server auf 8787, Oberfläche
auf 5173) und ein Konto `don`. Für Prüfungen, die Rechte brauchen
(Nutzerverwaltung, Ideen-Status, Anbieterwahl), muss das Konto owner oder
admin sein — sonst kommen 403er, die keine echten Fehler sind.

```bash
node scripts/e2e-neu.mjs             # Grundfunktionen
node scripts/e2e-dialoge.mjs         # jedes Fenster in drei Fenstergrößen
node scripts/e2e-handy.mjs           # Telefonansicht
node scripts/e2e-thread.mjs          # Thread-Layout über alle Breiten
node scripts/e2e-verschluesselung.mjs
node scripts/e2e-upload.mjs
```

## Sprache im Code

Deutsch: Bezeichner, Kommentare, Commit-Nachrichten. Kommentare erklären das
**Warum** — was der Code tut, steht im Code.
