# Mitarbeiten

## Aufsetzen

```bash
npm install
cp .env.example .env    # GROQ_API_KEY eintragen
npm run dev
```

Lege das Projekt **nicht** in einen synchronisierten Ordner (iCloud, Dropbox,
OneDrive) — siehe README, Abschnitt „Bekannte Stolpersteine".

## Aufbau

| Paket | Zweck |
|---|---|
| `packages/shared` | Typen, WebSocket-Protokoll, Spracherkennung, Text-Maskierung. Wird von Server **und** Client importiert. |
| `packages/server` | Fastify, SQLite, Übersetzungs-Engine, KI-Dienste, Realtime-Gateway |
| `packages/desktop` | Electron-Hülle plus React-Oberfläche |

Änderst du etwas in `shared`, baue es neu (`npm run build:shared`) — Server und
Client lesen das kompilierte `dist/`.

## Vor dem Commit

```bash
npm run typecheck      # alle drei Pakete
npm run build          # muss durchlaufen
```

Der Produktionsbuild fängt Dinge, die im Dev-Modus durchrutschen — zum Beispiel
Dateien, die `tsc` nicht mit nach `dist/` kopiert.

## Konventionen

- **Kommentare erklären das Warum**, nicht das Was. Deutsch, wie der Rest.
- **Keine neuen Abhängigkeiten ohne Grund.** Auth, Tokens und die SQLite-Anbindung
  kommen bewusst ohne Fremdpakete aus, damit das Projekt überall ohne Build-Tools läuft.
- **Das Original ist die Wahrheit.** Übersetzungen sind ein Cache. Wer den
  Originaltext einer Nachricht überschreibt, macht etwas falsch.
- **Nutzertext wird nie als HTML gerendert.** Der Markdown-Renderer erzeugt
  React-Elemente. Wenn du `dangerouslySetInnerHTML` brauchst, escape vorher
  (siehe `sanitizeSnippet` in `SearchOverlay.tsx`).

## Einen Übersetzungs-Provider ergänzen

1. `packages/server/src/translation/providers/<name>.ts` anlegen und
   `TranslationProvider` implementieren.
2. In `packages/server/src/translation/index.ts` in `build()` eintragen.
3. Kann der Provider auch Chat-Completions, zusätzlich `AssistantProvider`
   implementieren — dann funktionieren Zusammenfassungen und Smart Replies mit.
