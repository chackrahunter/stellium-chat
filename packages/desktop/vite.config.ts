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
        const connect = dev
          ? "'self' ws: wss: http: https:"
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
