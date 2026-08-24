import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Setzt die Content-Security-Policy passend zum Modus.
 * Im Build ist sie strikt. Im Dev-Modus muss 'unsafe-inline' erlaubt sein,
 * weil Vite den React-Refresh-Vorspann als Inline-Skript einfügt.
 */
function csp(): Plugin {
  return {
    name: 'stellium-csp',
    transformIndexHtml: {
      order: 'pre',
      handler(html, ctx) {
        const dev = ctx.server !== undefined;
        const script = dev ? "'self' 'unsafe-inline'" : "'self'";
        /*
         * connect-src — enger geht es in der Entwicklung, in der Auslieferung
         * nicht wirklich.
         *
         * ENTWICKLUNG: Der Vite-Dev-Server läuft auf :5173 (siehe
         * `server.port` unten) — 'self' deckt ihn ab, `ws://localhost:5173`
         * daneben ausdrücklich für seinen eigenen HMR-Kanal, statt sich
         * darauf zu verlassen, dass 'self' ein Schema-Upgrade von http auf ws
         * für denselben Rechnernamen automatisch mitmeint (uneinheitlich
         * dokumentiert, hier lieber ausdrücklich als stillschweigend richtig).
         * `serverUrl()` in src/net/api.ts zeigt ohne STELLIUM_ECHT zusätzlich
         * auf einen ZWEITEN, eigenen lokalen Server unter http://localhost:8787
         * — anderer Port, also ein eigener Ursprung, den auch 'self' nicht
         * abdeckt. Mit STELLIUM_ECHT (siehe server.proxy unten) ändert sich
         * daran nichts an der Richtlinie: Vite spiegelt /api und /ws
         * serverseitig auf chat.stellium.club, die Seite selbst ruft dabei
         * immer nur ihren EIGENEN Ursprung (localhost:5173) auf, nie das Ziel
         * direkt. Darum genügt für die Entwicklung 'self' plus die
         * bekannten lokalen Adressen, statt jedes http(s)/ws(s)-Ziel im
         * Internet zu erlauben.
         *
         * Dazu kommt der Loopback auf JEDEM Port — `http://127.0.0.1:*` und
         * `ws://127.0.0.1:*` —, und zwar nicht aus Bequemlichkeit: Die
         * Prüfläufe bringen ihren eigenen Server mit
         * (scripts/probeserver.mjs) und lassen sich dessen Port vom
         * Betriebssystem geben — auf 0 lauschen, Nummer merken, wieder
         * schließen —, damit zwei gleichzeitig laufende Prüfungen nicht nach
         * derselben Nummer greifen. Diese Nummer steht zur Bauzeit der
         * Richtlinie nicht fest; jede feste Liste wäre in dem Augenblick
         * falsch, in dem sie geschrieben wird. Ohne diesen Eintrag lehnt der
         * Browser den Aufruf ab („Refused to connect … because it does not
         * appear in the connect-src directive"), die Seite kommt nicht über
         * die Anmeldung hinaus, und randfarben-pruefen.mjs,
         * scrollen-pruefen.mjs und streifen-pruefen.mjs laufen beim Warten
         * auf `.app` in ihre Frist.
         *
         * `127.0.0.1` steht ausdrücklich NEBEN `localhost`, nicht statt
         * dessen: für einen Browser sind das zwei verschiedene Ursprünge.
         * `http://localhost:*` deckt eine Anfrage an 127.0.0.1 nicht ab —
         * in WebKit wie in Chromium nachgemessen, nicht angenommen. Der
         * Probeserver spricht ausdrücklich 127.0.0.1 (HOST=127.0.0.1 beim
         * Start, `http://127.0.0.1:${port}` in der Adresse, die die Prüfung
         * der Seite hinlegt), also muss genau diese Schreibweise dastehen.
         * Auch der Port-Platzhalter `:*` wurde in beiden Maschinen geprüft
         * statt vorausgesetzt: er erlaubt dort tatsächlich jeden Port und
         * lässt `https://irgendwas` weiterhin auflaufen.
         *
         * Dass die Entwicklungsrichtlinie dadurch weiter wird als nötig, ist
         * Absicht und kostet an dieser Stelle nichts. Sie existiert, um einen
         * versehentlichen Aufruf ins offene Internet auffliegen zu lassen —
         * genau das tut sie weiterhin —, nicht um den Rechner der
         * Entwicklerin gegen sich selbst zu verteidigen. Was auf dem eigenen
         * Loopback lauscht, hat dieselbe Person soeben selbst gestartet.
         *
         * AUSLIEFERUNG: Stellium ist selbst gehostet — die Adresse tippt
         * jede Firma selbst beim Anmelden ein (siehe Login.tsx), es gibt
         * keine, die sich hier vorab eintragen ließe. Diese Richtlinie
         * entsteht einmalig beim Bauen und landet fest im ausgelieferten
         * index.html; zur Bauzeit ist die künftige Serveradresse grundsätzlich
         * nicht bekannt. Eine engere Positivliste lässt sich mit einer
         * statischen, zur Bauzeit erzeugten CSP für "irgendein von der Firma
         * gewählter Server" nicht ausdrücken — dafür bräuchte es eine zur
         * Laufzeit gesetzte Richtlinie (etwa über session.webRequest im
         * Hauptprozess), und das geht über diese Datei hinaus.
         * `http:`/`ws:` bleiben dabei ausdrücklich erlaubt, nicht aus
         * Nachlässigkeit: `serverUrl()` fällt ohne gespeicherte Adresse auf
         * das unverschlüsselte `http://localhost:8787` zurück, und
         * `wsUrl()` bildet `http`→`ws` genauso ab wie `https`→`wss` (beides
         * src/net/api.ts) — Stellium verlangt also nachweislich KEIN TLS,
         * ein eigener Server im Firmennetz ganz ohne Zertifikat ist ein
         * vorgesehener Fall, kein Unfall. Nur `https:`/`wss:` zu erlauben
         * würde genau diesen Fall zerschießen.
         */
        const connect = dev
          ? "'self' ws://localhost:5173 http://localhost:8787 ws://localhost:8787 http://127.0.0.1:* ws://127.0.0.1:*"
          : "'self' ws: wss: http: https:";
        const policy = [
          "default-src 'self'",
          "img-src 'self' data: blob: http: https:",
          "media-src 'self' blob: http: https:",
          "font-src 'self' data:",
          "style-src 'self' 'unsafe-inline'",
          `script-src ${script}`,
          `connect-src ${connect}`,
          "object-src 'none'",
          "base-uri 'none'",
          /* 'self', nicht 'none': das Postfach (PostPanel.tsx) zeigt fremdes
             HTML aus eingehender Post in einem <iframe sandbox="" srcDoc={…}>.
             Ein srcDoc-Rahmen hat keine eigene URL — sein Ursprung ist der des
             Elterndokuments —, und genau dagegen prüft frame-src ihn: 'none'
             verbietet jeden Rahmen, auch diesen rein lokal erzeugten, und die
             Vorschau blieb leer, ganz ohne Meldung an den Benutzer. 'self'
             lässt nur das zu, ohne die Tür für fremde Rahmen zu öffnen — ein
             <iframe src="https://irgendwas"> bliebe weiter blockiert.
             Skripte laufen im Rahmen trotzdem nicht: das erzwingt schon das
             LEERE sandbox-Attribut (kein allow-scripts, kein
             allow-same-origin) unabhängig von jeder Content-Security-Policy,
             und zusätzlich die eigene, strengere Richtlinie im
             Rahmendokument selbst (default-src 'none', siehe htmlDokument()
             in PostPanel.tsx). frame-src entscheidet nur, ob der Rahmen
             überhaupt ENTSTEHEN darf — nicht, was in ihm laufen darf. */
          "frame-src 'self'",
        ].join('; ');
        return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), csp()],
  base: './',
  server: {
    port: 5173,
    strictPort: true,
    /* Am Netz horchen, nicht nur an localhost: nur so lässt sich die
       Oberfläche vom Telefon aus öffnen. Das ist der einzige Weg, eine
       Änderung am Handy zu sehen, ohne die Startbildschirm-App jedes Mal
       von Hand aus dem Umschalter zu werfen — sie hält ihre Seite sonst
       tagelang fest. */
    host: true,
    /* Weiterleitung auf den echten Server — NUR auf ausdrücklichen Zuruf:
     *
     *     STELLIUM_ECHT=1 npm run dev:desktop
     *
     * Gebraucht wird sie, um die Oberfläche vom Telefon aus mit echten Daten
     * zu sehen. Als Voreinstellung wäre sie gefährlich: dann schriebe jeder,
     * der `npm run dev` startet, auf das Livesystem, und `npm run e2e` legt
     * dort Konten an. Ohne die Variable bleibt alles bei localhost:8787. */
    ...(process.env.STELLIUM_ECHT
      ? {
          proxy: {
            '/api': { target: 'https://chat.stellium.club', changeOrigin: true, secure: true },
            '/ws': { target: 'wss://chat.stellium.club', ws: true, changeOrigin: true, secure: true },
          },
        }
      : {}),
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      /* Zweiter Einstiegspunkt für die selbstgezeichnete macOS-Benachrichtigung
         (electron/mac-notify.ts lädt dist/mac-notify.html). Ohne diesen
         Eintrag baut Vite nur die Haupt-index.html — im Dev-Server läuft die
         zweite Seite trotzdem, dort bedient er jede vorhandene .html-Datei
         von selbst; erst der Produktionsbau braucht die Angabe hier. */
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        macNotify: fileURLToPath(new URL('./mac-notify.html', import.meta.url)),
      },
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
