# Stellium

Team-Chat für Unternehmen. Alle schreiben in ihrer eigenen Sprache und lesen
in ihrer eigenen Sprache — dazwischen übersetzt ein Sprachmodell in Echtzeit.

Desktop-App für **macOS** (Intel und Apple Silicon), **Windows** und **Linux**.

---

## In einem Satz

Du schreibst auf Deutsch, Yuki liest es auf Japanisch, Ana auf Spanisch — und
das Original ist für alle einen Klick entfernt.

---

## Schnellstart

```bash
npm install
npm run secret -w @stellium/server -- setzen groq   # Groq-Schlüssel verschlüsselt ablegen
npm run dev
```

Beim ersten Start legt der Server ein Owner-Konto an und zeigt ein
**Einmal-Passwort** im Log. Damit meldest du dich an und setzt eigene
Zugangsdaten. Weitere Konten legst du danach in der App an.

Das App-Fenster startest du in einem zweiten Terminal:

```bash
npm run dev:electron -w @stellium/desktop
```

Fertige Installationsdateien liegen unter
[Releases](https://github.com/chackrahunter/stellium-chat/releases).

---

## Was drin ist

### Übersetzung

Der Kern. Jede Nachricht wird für jede Person in ihre Sprache gebracht — 22
Sprachen.

- Das **Original ist die Wahrheit**: gespeichert wird immer der Ausgangstext,
  Übersetzungen liegen als Cache daneben und verfallen bei Änderungen
- **Maskierung**: Codeblöcke, Links, @Erwähnungen und Glossarbegriffe werden
  vor der Übersetzung ausgeklammert. Verstümmelt das Modell die Platzhalter,
  zeigt die App lieber das Original als sinnentstellten Text
- **Glossar** für Produktnamen und interne Begriffe — entweder unangetastet
  oder mit fester Übersetzung je Sprache
- **Vorschau beim Tippen**: du siehst, wie deine Nachricht in der Kanalsprache
  ankommt, bevor du sie abschickst
- **Rückübersetzung** auf Knopfdruck mit Ähnlichkeitswert — erkennt
  Übersetzungen, die die Bedeutung verdreht haben
- Zwei Cache-Ebenen: dieselbe Formulierung kostet nie zweimal einen API-Aufruf
- **Suche über Originale und Übersetzungen**: ein deutsches Suchwort findet
  auch, was auf Englisch geschrieben wurde

### KI-Assistent

Ein eigenes Konto mit der Rolle „bot". Dadurch laufen seine Antworten durch die
normale Übersetzung und landen in der Suche.

- **Privater Chat** — nur du siehst ihn
- **Gemeinsamer Kanal** `#ki-team`, in dem das ganze Team mit ihm spricht
- Pro Kanal einstellbar: schweigt, antwortet auf `@ki`, oder antwortet immer
- **Was habe ich verpasst?** — fasst Ungelesenes zusammen, mit Entscheidungen
  und Aufgaben
- **Antwortvorschläge**, **Umformulieren** (korrigieren, förmlicher, kürzen,
  Stichpunkte), **Frage an den Kanal** mit Quellenangabe

**Er erfindet nichts.** Sein gesamtes Firmenwissen stammt aus dem sichtbaren
Kanalverlauf. Fragt man nach einem Projekt, das dort nicht vorkommt, sagt er
das und fragt nach — statt eine plausible Antwort zu bauen. Das ist geprüft:
`scripts/` enthält die Testfälle.

### Sprachnachrichten

Aufnehmen, senden. **Groqs Whisper** transkribiert, das Transkript wird zum
Text der Nachricht — und damit automatisch übersetzt und durchsuchbar. Eine
japanische Sprachnachricht liest du auf Deutsch.

### Chat-Grundlagen

Öffentliche und private Kanäle, Direktnachrichten, Threads, Reaktionen,
@Erwähnungen, `#`-Kanalverweise (beide mit Vervollständigung), Datei-Upload per
Drag & Drop, Präsenz, Tipp-Indikatoren, Lesestände, Volltextsuche, native
Benachrichtigungen, Offline-Warteschlange.

**Bearbeiten und Löschen sind zeitlich begrenzt.** Zwei Stunden nach dem Senden
lässt sich eine Nachricht ändern oder für alle zurücknehmen. Danach bleibt das
Ausblenden für einen selbst — sonst entstünden Lücken in einem Verlauf, auf den
sich andere schon bezogen haben.

### Kanäle verwalten

Umbenennen, Thema und Zweck setzen, Kanalsprache wählen, Mitglieder hinzufügen
und entfernen, stummschalten, anheften, als **Ankündigungskanal** sperren (nur
die Verwaltung schreibt), archivieren, löschen. Direktnachrichten lassen sich
ausblenden, ohne sie für die andere Seite anzutasten.

### Konten und Rechte

Keine Selbstregistrierung. Die Team-Leitung legt Konten an und gibt ein
**Einmal-Passwort** weiter; beim ersten Login setzt die Person eigenes
Passwort, Benutzernamen und E-Mail.

**Neun Rollen** als Vorlage:

| Rolle | Rechte |
|---|---|
| Inhaber | 27 von 27 |
| Administrator | 24 |
| Moderation | 23 |
| Teamleitung | 21 |
| Mitglied | 15 |
| Mitwirkend | 11 |
| Bot | 6 |
| Gast | 5 |
| Nur lesen | 1 |

**27 einzelne Rechte** lassen sich pro Person abweichend setzen — vom Senden
über Erwähnen und Dateien bis zur Kontoverwaltung. Durchgesetzt wird alles auf
dem Server.

### Weitere Funktionen

Umfragen (einfach, mehrfach, anonym), Link-Vorschauen, Weiterleiten mit
Kommentar, Erinnerungen an Nachrichten, Entwürfe über Neustarts hinweg,
Profilkarten mit Ortszeit, Status mit Ablaufzeit, Später-senden über Zeitzonen,
Ruhezeiten, Schnellsuche (⌘K), Slash-Befehle, helles und dunkles Thema.

**Einführung beim ersten Login** führt durch alle Funktionen — überspringbar
und aus den Einstellungen jederzeit neu startbar.

Die Oberfläche gibt es auf **Deutsch und Englisch**, umschaltbar und getrennt
von der Sprache, in die Nachrichten übersetzt werden.

---

## Sicherheit

### Was verschlüsselt ist

| Was | Wie |
|---|---|
| API-Schlüssel | AES-256-GCM + ChaCha20-Poly1305 in Kaskade, Schlüssel aus scrypt |
| E-Mails, Benutzernamen | AES-256-GCM, dazu HMAC-Blind-Index fürs Anmelden |
| Passwörter | scrypt-Hash — **absichtlich nicht** verschlüsselt |

Ein `strings` über die Datenbankdatei findet keine E-Mail und keinen
Benutzernamen im Klartext.

**Warum Passwörter gehasht statt verschlüsselt sind:** Verschlüsselung ist
umkehrbar. Wer den Schlüssel hat, hätte alle Passwörter im Klartext. Gehasht
kann sie niemand auslesen — auch die Team-Leitung nicht. Zurücksetzen
funktioniert trotzdem, es erzeugt ein neues Einmal-Passwort.

### Das Masterpasswort

Liegt in der macOS-Keychain (an dein Login gebunden) oder als
`STELLIUM_MASTER_PASSPHRASE` in der Umgebung — **nie** auf der Platte neben dem
Chiffrat. Ein Rateversuch kostet durch scrypt rund 200 ms, also etwa fünf
Versuche pro Sekunde und Kern statt Millionen.

```bash
npm run secret -w @stellium/server -- setzen groq      # ablegen
npm run secret -w @stellium/server -- liste            # Namen, nie Werte
npm run secret -w @stellium/server -- passwort-neu     # Masterpasswort erneuern
```

### Was das schützt — und was nicht

Geschützt: gestohlene Backups, kopierte Festplatten, versehentlich geteilte
`data/`-Verzeichnisse, Kolleg:innen mit Leserechten auf dem Server.

Nicht geschützt: wer Code **als der Serverbenutzer** ausführen kann. Der Server
muss Nachrichten im Klartext an das Übersetzungsmodell schicken, hat sie also
zur Laufzeit im Speicher. Das ist keine Nachlässigkeit, sondern liegt in der
Natur einer Anwendung, die Inhalte übersetzt.

### Keine Ende-zu-Ende-Verschlüsselung

Bewusst nicht. Bei echtem E2EE könnte der Server die Nachrichten nicht lesen —
und damit fielen Übersetzung, KI-Assistent, Volltextsuche, Transkription und
Zusammenfassungen weg. Das ist praktisch der gesamte Zweck dieser Anwendung.

Wer beides braucht, müsste einzelne Unterhaltungen als „vertraulich" markieren
und dort auf all das verzichten. Siehe `docs/ende-zu-ende.md`.

### Sonstiges

Nutzertext wird nie als HTML gerendert — der Markdown-Renderer erzeugt
React-Elemente. Link-Vorschauen prüfen per DNS, dass das Ziel nicht im internen
Netz liegt. Im Renderer sind `contextIsolation` an und `nodeIntegration` aus.

---

## KI einrichten

Schlüssel holen: <https://console.groq.com/keys>, dann:

```bash
npm run secret -w @stellium/server -- setzen groq
```

**Die Modelle sucht der Server sich selbst.** Beim Start fragt er Groqs Liste
ab, sortiert alles aus, was keine Chat-Anfragen beantwortet (Whisper, TTS,
Guard-Klassifikatoren, zu kleines Kontextfenster) und wählt das größte
brauchbare Modell zum Übersetzen sowie ein kleines für Antwortvorschläge. Alle
sechs Stunden sieht er nach, ob es etwas Neues gibt. Fällt ein Modell im
Betrieb aus, holt er die Liste nach und wechselt.

Welche Modelle laufen, steht im Server-Log und in den Einstellungen unter
*KI-Modell*, wo die Team-Leitung sie auch festlegen kann.

**Andere Anbieter:** `AI_PROVIDER=deepl` (beste reine Übersetzung, keine
KI-Funktionen), `libre` (LibreTranslate, selbst gehostet — Texte verlassen das
Haus nicht), `openai`. Ohne Schlüssel startet die App mit einem
Demo-Provider, der nur markiert, wo eine Übersetzung erschiene.

---

## Tastenkürzel

| Kürzel | Funktion |
|---|---|
| `⌘K` / `Strg+K` | Schnellsuche |
| `⌘F` / `Strg+F` | Nachrichten durchsuchen |
| `⌘,` / `Strg+,` | Einstellungen |
| `⌘⇧N` | Neuer Kanal |
| `⌘⇧U` | Was habe ich verpasst? |
| `Enter` | Senden · `Shift+Enter` neue Zeile |
| `@` / `#` | Person bzw. Kanal vervollständigen |
| `Esc` | Overlay oder Thread schließen |

---

## Bauen

```bash
npm run build              # alles kompilieren

npm run dist:mac           # arm64: .dmg und .zip
npm run dist:mac:universal # Intel + Apple Silicon in einem Paket
npm run dist:win           # NSIS-Installer für x64 und arm64
npm run dist:linux         # AppImage und .deb für x64 und arm64
```

Windows-Installer lassen sich auch auf macOS bauen — electron-builder bringt
sein eigenes Wine mit. Für `.rpm` braucht es zusätzlich `brew install rpm`.

Kein Paket ist signiert. Für die Verteilung außerhalb des eigenen Teams
solltest du signieren: macOS mit Entwicklerzertifikat und Notarisierung,
Windows mit Code-Signing-Zertifikat.

---

## Tests

```bash
npm run e2e          # 29 Prüfungen durch die echte Oberfläche
npm run e2e:sichtbar # dasselbe mit sichtbarem Browserfenster
node scripts/e2e-admin.mjs <einmal-passwort>   # 9 Prüfungen der Kontoverwaltung
```

Die Suite fährt einen echten Chromium hoch und klickt sich durch: Anmeldung,
Layout, Senden, Reaktionen, Erwähnungen, Antwortvorschläge, Umformulieren,
Live-Übersetzung, Umfragen, Suche, Profilkarten, Weiterleiten, Erinnerungen,
Threads, Einstellungen, Modellwahl, Themawechsel. Fehlschläge landen als
Screenshot in `scripts/screenshots/`.

Sie legt sich ihre Testdaten selbst an — es gibt keine Demo-Konten.

---

## Architektur

```
packages/
├── shared/    Typen, WebSocket-Protokoll, Spracherkennung, Maskierung, Rechte
├── server/    Fastify, SQLite über node:sqlite, Übersetzung, KI, Realtime
└── desktop/   Electron + React + Vite + Zustand + Framer Motion
```

**Wie eine Nachricht ihren Weg nimmt**

1. Die Ausgangssprache wird lokal erkannt — Stoppwörter, Schriftsystem und im
   Deutschen die Großschreibung der Substantive. Bei Unsicherheit bleibt sie
   offen und das Modell entscheidet später
2. Der Server speichert **immer das Original** und verteilt es sofort. Niemand
   wartet auf die Übersetzung
3. Er sammelt die Zielsprachen aller Empfänger und übersetzt **einmal pro
   Sprache**, nicht einmal pro Person
4. Fertige Übersetzungen kommen als eigenes Ereignis nach, die Oberfläche
   tauscht den Text weich aus
5. Alles landet im Cache

**Datenhaltung.** Eine SQLite-Datei unter `packages/server/data/`. Kein
natives Modul nötig — `node:sqlite` ist in Node eingebaut, inklusive
FTS5-Volltextsuche.

---

## Server betreiben

```bash
npm run build
cd packages/server
STELLIUM_MASTER_PASSPHRASE=… PORT=8787 npm start
```

In der App unter *Einstellungen → Server* die Adresse eintragen. Für den
Zugriff von außen einen Reverse Proxy mit TLS davorsetzen und das
WebSocket-Upgrade auf `/ws` durchreichen.

## Umgebungsvariablen

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8787` | Server-Port |
| `DATA_DIR` | `./data` | Datenbank, Uploads, Tresor |
| `OWNER_HANDLE` | Systembenutzer | Erstes Konto beim Erststart |
| `OWNER_NAME` | daraus abgeleitet | Anzeigename dazu |
| `AI_PROVIDER` | `groq` | `groq` · `openai` · `deepl` · `libre` · `demo` |
| `GROQ_MODEL` | leer | Leer = der Server wählt selbst |
| `STELLIUM_MASTER_PASSPHRASE` | Keychain | Masterpasswort für den Tresor |
| `MAX_UPLOAD_MB` | `50` | Maximale Dateigröße |

Vollständig in `.env.example`.

---

## Noch nicht fertig

Ehrlich benannt statt versteckt:

- **Aufgabenverwaltung** — Datenbank, Typen und Dienst stehen (Status,
  Zuweisung, Fälligkeit, Änderungsverlauf), Protokoll und Oberfläche fehlen
- **Team-Kalender** — Datenbank und Typen stehen, alles Weitere fehlt
- **Dateiablage** — Datenbank und Typen stehen, alles Weitere fehlt
- **RPM-Paket** — braucht `rpmbuild` auf dem bauenden Rechner
- **Code-Signatur** für macOS und Windows
