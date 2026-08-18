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
          "frame-src 'none'",
        ].join('; ');
        return html.replace('<!--CSP-->', `<meta http-equiv="Content-Security-Policy" content="${policy}" />`);
      },
    },
  };
}

export default defineConfig({
  plugins: [react(), csp()],
  base: './',
  server: { port: 5173, strictPort: true },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['framer-motion'],
        },
      },
    },
  },
});
