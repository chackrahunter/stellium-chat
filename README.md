# Stellium

Team-Chat für Unternehmen — wie Slack oder Teams, aber mit **Live-Übersetzung**:
jede:r schreibt in der eigenen Sprache, jede:r liest in der eigenen Sprache.
Dazu KI-Funktionen über **Groq**.

Läuft als Desktop-App auf **macOS (Intel + Apple Silicon)**, **Windows** und **Linux**.

---

## Schnellstart

```bash
npm install
cp .env.example .env      # GROQ_API_KEY eintragen
npm run dev
```

Der Befehl startet Server (Port 8787) und Vite-Dev-Server (Port 5173) gleichzeitig.
Für das echte App-Fenster in einem zweiten Terminal:

```bash
npm run dev:electron -w @stellium/desktop
```

Beim ersten Start legt der Server automatisch einen Demo-Arbeitsbereich an.

**Demo-Zugänge** (Passwort für alle: `stellium2024`)

| Benutzer | Sprache | Rolle |
|---|---|---|
| `don` | Deutsch | Owner |
| `sarah` | Englisch | Admin |
| `yuki` | Japanisch | Engineering |
| `marta` | Polnisch | QA |
| `lucas` | Französisch | Design |
| `ana` | Spanisch | Support |

Melde dich in zwei Fenstern mit unterschiedlichen Konten an — dann siehst du die
Übersetzung live in beide Richtungen.

---

## KI einrichten (Groq)

1. Kostenlosen Key holen: <https://console.groq.com/keys>
2. In `.env` eintragen:

```env
AI_PROVIDER=groq
GROQ_API_KEY=gsk_...
GROQ_MODEL=llama-3.3-70b-versatile     # Übersetzung, Zusammenfassungen
GROQ_FAST_MODEL=llama-3.1-8b-instant   # Smart Replies, schnelle Aufgaben
```

Ohne Key startet die App trotzdem — dann läuft der `demo`-Provider, der nur
markiert, wo eine Übersetzung erscheinen würde. Alles andere funktioniert normal.

**Andere Anbieter:** `AI_PROVIDER=deepl` (beste reine Übersetzungsqualität, keine
KI-Features), `AI_PROVIDER=libre` (LibreTranslate, selbst gehostet — Texte
verlassen das Haus nicht), `AI_PROVIDER=openai`.

---

## Was drin ist

### Chat-Grundlagen
- Öffentliche und private Kanäle, Direktnachrichten
- Threads mit Teilnehmer-Avataren und Antwortzähler
- Emoji-Reaktionen, @Erwähnungen, #Kanal-Verweise
- Bearbeiten, Löschen, Anpinnen, „Für später merken"
- Datei-Upload per Drag & Drop, Einfügen aus der Zwischenablage, Bild-Vorschau
- Präsenz (online / abwesend / nicht stören), Tipp-Indikatoren, Lesestände
- Ungelesen-Zähler, native Benachrichtigungen, Dock-/Taskleisten-Badge
- Volltextsuche über Originale **und** Übersetzungen
- Offline-Warteschlange: Nachrichten gehen raus, sobald die Verbindung steht

### Übersetzung
- **Live-Übersetzung** in die Sprache jedes Empfängers, 22 Sprachen
- Das **Original bleibt immer erhalten** — ein Klick blendet es ein
- **Glossar**: Produktnamen und interne Begriffe bleiben unangetastet oder
  bekommen eine feste Übersetzung je Sprache
- **Maskierung**: Codeblöcke, Links, @Erwähnungen und Emojis werden nie übersetzt.
  Verstümmelt ein Modell die Platzhalter, zeigt die App das Original statt Kauderwelsch
- **Compose-Vorschau**: beim Tippen siehst du, wie deine Nachricht in der
  Kanalsprache ankommt — bevor du sendest
- **Rückübersetzung** auf Knopfdruck mit Ähnlichkeitswert: erkennt Übersetzungen,
  die die Bedeutung verdreht haben
- Zwei Cache-Ebenen (pro Nachricht und global pro Phrase) — dieselbe Formulierung
  kostet nie zweimal einen API-Aufruf

### KI (Groq)
- **„Was habe ich verpasst?"** — fasst Ungelesenes zusammen, inklusive
  Entscheidungen und Aufgaben, in deiner Sprache
- **Thread-Zusammenfassung**
- **Smart Replies** — drei passende Antwortvorschläge
- **Schreibhilfe** — korrigieren, förmlicher, freundlicher, kürzen, in Stichpunkte
- **Frage an den Kanal** — beantwortet Fragen aus dem Verlauf und nennt die Quellen

### Weitere Funktionen
- **Später senden** — über Zeitzonen hinweg zur richtigen Uhrzeit
- **Ortszeit der Kolleg:innen** in Kopfzeile und Team-Liste (🌙 = wahrscheinlich Feierabend)
- **Ruhezeiten** — nachts still, direkte Erwähnungen kommen trotzdem durch
- **Schnellsuche** (⌘K / Strg+K) für Kanäle, Menschen und Aktionen
- **Slash-Befehle**: `/lang de`, `/dnd`, `/weg`, `/aktiv`, `/summary`, `/glossar`
- **Kanalsprache** als „Lingua Franca" pro Kanal
- Dunkles und helles Thema, luftige und kompakte Dichte

---

## Tastenkürzel

| Kürzel | Funktion |
|---|---|
| `⌘K` / `Strg+K` | Schnellsuche |
| `⌘F` / `Strg+F` | Nachrichten durchsuchen |
| `⌘,` / `Strg+,` | Einstellungen |
| `⌘⇧N` / `Strg+Shift+N` | Neuer Kanal |
| `⌘⇧U` / `Strg+Shift+U` | Was habe ich verpasst? |
| `Enter` | Senden · `Shift+Enter` neue Zeile |
| `Esc` | Overlay / Thread schließen |

---

## Apps bauen

```bash
npm run build          # alles kompilieren

npm run dist:mac       # .dmg + .zip, Universal (Intel + Apple Silicon)
npm run dist:win       # NSIS-Installer (x64 + arm64) und portable .exe
npm run dist:linux     # AppImage, .deb (x64 + arm64), .rpm
```

Die Pakete landen in `packages/desktop/release/`.

**macOS Universal** enthält beide Architekturen in einem Binary — dieselbe
`.dmg` läuft auf Intel-Macs und auf M1/M2/M3/M4.

**Hinweise zum Signieren:** Ohne Apple-Entwicklerzertifikat ist der Build
unsigniert; beim ersten Start ist dann Rechtsklick → „Öffnen" nötig. Für die
Verteilung im Unternehmen `CSC_LINK` und `CSC_KEY_PASSWORD` setzen und
Notarisierung über `APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` / `APPLE_TEAM_ID`
aktivieren.

---

## Architektur

```
packages/
├── shared/    Typen, WebSocket-Protokoll, Spracherkennung, Text-Maskierung
├── server/    Node + Fastify + SQLite (node:sqlite, kein nativer Build)
└── desktop/   Electron + React + Vite + Zustand + Framer Motion
```

**Wie die Übersetzung abläuft**

1. Absender schickt die Nachricht — die Ausgangssprache wird lokal per Heuristik erkannt
2. Der Server speichert **immer das Original** und verteilt es sofort an alle.
   Niemand wartet auf die Übersetzung
3. Der Server sammelt die Zielsprachen aller Empfänger und übersetzt **einmal pro
   Sprache**, nicht einmal pro Person
4. Fertige Übersetzungen werden per `translation`-Ereignis nachgeschoben; die
   Oberfläche tauscht den Text weich aus
5. Alles landet im Cache — beim nächsten Öffnen ist es sofort da

**Datenhaltung.** Eine SQLite-Datei unter `packages/server/data/stellium.db`.
Für den Produktivbetrieb reicht ein kleiner Server; sichere das `data/`-Verzeichnis.

**Sicherheit.** Passwörter mit scrypt gehasht, Tokens HMAC-signiert.
Im Renderer sind `contextIsolation` an und `nodeIntegration` aus; Markdown wird
als React-Elemente gerendert, nie als HTML — Nachrichtentext kann also kein
Markup einschleusen. Externe Links öffnen immer im Systembrowser.

---

## Server separat betreiben

```bash
npm run build
cd packages/server
PORT=8787 JWT_SECRET=<langer-zufallsstring> GROQ_API_KEY=gsk_... npm start
```

Im Client unter *Einstellungen → Server* die Adresse eintragen.
Für den Zugriff von außen einen Reverse Proxy mit TLS davorsetzen
(WebSocket-Upgrade auf `/ws` durchreichen).

## Umgebungsvariablen

Siehe `.env.example`. Die wichtigsten:

| Variable | Standard | Bedeutung |
|---|---|---|
| `PORT` | `8787` | Server-Port |
| `JWT_SECRET` | generiert | Token-Signatur — im Produktivbetrieb selbst setzen |
| `DATA_DIR` | `./data` | Datenbank und Uploads |
| `MAX_UPLOAD_MB` | `50` | Maximale Dateigröße |
| `AI_PROVIDER` | `groq` | `groq` · `openai` · `deepl` · `libre` · `demo` |
| `GROQ_API_KEY` | — | ohne diesen Key läuft der Demo-Provider |

---

## Bekannte Stolpersteine

### Nicht in einem Cloud-synchronisierten Ordner entwickeln

`node_modules` besteht aus hunderttausenden winzigen Dateien. Liegt das Projekt in
iCloud Drive, Dropbox oder OneDrive, versucht der Sync-Dienst jede einzelne davon
hochzuladen — Builds gehen dann von Sekunden auf Minuten hoch.

Gemessen an genau diesem Projekt:

| Ort | `npm install` | kompletter Build |
|---|---|---|
| `~/Documents` (iCloud-Sync) | ~7 min | > 8 min, abgebrochen |
| `~/Developer` (kein Sync) | **6 s** | **4,7 s** |

Muss das Projekt doch in einem synchronisierten Ordner liegen, nimmt
`bash scripts/icloud-exclude.sh` wenigstens `node_modules` aus dem Sync
(iCloud ignoriert alles, was auf `.nosync` endet). Rückgängig mit `--undo`.

### Speicherplatz für Electron-Builds

`electron-builder` lädt pro Zielplattform eine eigene Electron-Distribution
(~250 MB) und packt die Ergebnisse zusätzlich. Für `dist:mac` mit
Universal-Binary solltest du **6–8 GB frei** haben.
