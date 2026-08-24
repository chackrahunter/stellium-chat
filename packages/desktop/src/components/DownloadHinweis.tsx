import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Apple, Download, Monitor, Terminal, X } from 'lucide-react';
import { useT } from '../i18n';
import { useStore } from '../state/store.js';
import { eigenstaendig, rechnersystemErkennen, type Rechnersystem } from '../lib/installation.js';
import { imBrowser } from './DownloadPanel.jsx';
import '../styles/download.css';

/**
 * Der Streifen, der einmal darauf hinweist, dass es Stellium auch als
 * eigene App für den Rechner gibt.
 *
 * Das Gegenstück zu Startbildschirm.tsx auf dem Telefon — bewusst aber ohne
 * dessen Zwang: auf dem Telefon läuft die Seite im Browser nur notdürftig
 * (kein Vollbild, keine Benachrichtigungen), deshalb blockiert Startbildschirm
 * dort den Zugang, bis eingerichtet ist. Auf dem Rechner ist die Web-
 * Oberfläche dagegen vollwertig — die App ist ein Angebot, keine Vorausset-
 * zung. Darum kein Vollbild vor der Anmeldung, sondern derselbe wegklickbare
 * Streifen wie bei MeldungBitte (Bitte um Benachrichtigungen): daneben in
 * App.tsx eingehängt, im selben Aussehen, mit derselben Erinnerung im
 * Speicher des Geräts.
 *
 * Der Knopf öffnet dieselbe Ansicht wie der Menüpunkt „App herunterladen"
 * (Rail.tsx) — keine zweite Quelle für Fassungen, Versionen oder Prüfsummen.
 * Dort wählt sich das erkannte System auch von selbst vor; dieser Streifen
 * muss davon nur so viel kennen, wie er zeigt: das Symbol und den Namen.
 */
const SCHLUESSEL = 'stellium.download-hinweis';

const SYSTEME: Record<Rechnersystem, { name: string; symbol: React.ReactNode }> = {
  darwin: { name: 'macOS', symbol: <Apple size={15} /> },
  win32: { name: 'Windows', symbol: <Monitor size={15} /> },
  linux: { name: 'Linux', symbol: <Terminal size={15} /> },
};

export function DownloadHinweis() {
  const t = useT();
  const { setOverlay } = useStore.getState();

  // Einmal berechnet und dann festgehalten: die Kennung des Rechners ändert
  // sich innerhalb einer Sitzung nicht.
  const system = useMemo(rechnersystemErkennen, []);
  const [zeigen, setZeigen] = useState(false);

  useEffect(() => {
    // Kein System erkannt (Telefon, Tablet, Chromebook, unbekannt) — dann
    // gibt es nichts zu bewerben.
    if (!system) return undefined;
    // In der App selbst wäre der Hinweis peinlich: sie hält sich über die
    // Aktualisierung längst selbst auf dem neuesten Stand.
    if (!imBrowser()) return undefined;
    // Läuft die Seite schon als eigene, installierte Web-App, gibt es
    // nichts mehr zu holen.
    if (eigenstaendig()) return undefined;
    // Prüfläufe steuern einen echten Browser fern — sie sollen den Chat
    // testen, nicht auf einen Werbestreifen treffen, den kein Skript erwartet.
    if (navigator.webdriver) return undefined;
    try { if (localStorage.getItem(SCHLUESSEL)) return undefined; } catch { /* ohne Speicher eben jedes Mal */ }

    // Dieselbe kurze Wartezeit wie bei MeldungBitte: direkt nach der
    // Anmeldung baut sich die Oberfläche noch auf, und ein Streifen, der
    // mitten hinein springt, wird weggeklickt, bevor jemand ihn liest.
    const uhr = window.setTimeout(() => setZeigen(true), 4000);
    return () => window.clearTimeout(uhr);
  }, [system]);

  const merken = () => {
    try { localStorage.setItem(SCHLUESSEL, '1'); } catch { /* dann eben nicht */ }
    setZeigen(false);
  };

  if (!system) return null;
  const { name, symbol } = SYSTEME[system];

  return (
    <AnimatePresence>
      {zeigen && (
        <motion.div
          className="download-hinweis"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22 }}
        >
          {symbol}
          <span className="download-hinweis__text">{t('download.hint', { system: name })}</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => { merken(); setOverlay('download'); }}
          >
            <Download size={13} /> {t('download.get')}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={merken}
            title={t('meldung.spaeter')}
            aria-label={t('meldung.spaeter')}
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
