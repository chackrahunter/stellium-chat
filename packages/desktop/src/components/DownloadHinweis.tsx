import { useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Apple, Download, Monitor, Terminal } from 'lucide-react';
import { useT } from '../i18n';
import { useStore } from '../state/store.js';
import { eigenstaendig, rechnersystemErkennen, type Rechnersystem } from '../lib/installation.js';
import { imBrowser } from './DownloadPanel.jsx';
import '../styles/download.css';

/**
 * Das Tor für Rechner-Browser: wer Stellium auf macOS, Windows oder Linux
 * im Browser öffnet, sieht zuerst diese Seite — mit dem klaren Hinweis,
 * dass es die App herunterzuladen gilt.
 *
 * Das Gegenstück zu Startbildschirm.tsx auf dem Telefon: dort blockiert die
 * Einrichtungsseite den Zugang, bis die App eingerichtet ist. Auf dem
 * Rechner ist die Web-Oberfläche zwar vollwertig, aber der Wunsch ist
 * derselbe — die eigene App soll der Weg sein, nicht die Ausnahme. Deshalb
 * steht hier zuerst das Herunterladen im Vordergrund; ein kleiner
 * Weiter-Knopf unten lässt trotzdem hinein, gilt aber nur für DIESE
 * Sitzung (sessionStorage): beim nächsten Besuch fragt das Tor wieder.
 *
 * Der Knopf öffnet dieselbe Ansicht wie der Menüpunkt „App herunterladen"
 * (Rail.tsx) — keine zweite Quelle für Fassungen, Versionen oder Prüfsummen.
 * Dort wählt sich das erkannte System auch von selbst vor; dieses Tor muss
 * davon nur so viel kennen, wie es zeigt: das Symbol und den Namen.
 */
const WEITER_SCHLUESSEL = 'stellium.download-tor-weiter';

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
  // Ebenfalls einmal: ob dieses Tor überhaupt gelten darf. Keines dieser
  // Merkmale ändert sich mitten in einer Sitzung.
  const [torGilt] = useState(() => {
    if (!system) return false;
    // In der App selbst wäre das Tor lächerlich: sie hält sich über die
    // Aktualisierung längst selbst auf dem neuesten Stand.
    if (!imBrowser()) return false;
    // Läuft die Seite schon als eigene, installierte Web-App, gibt es
    // nichts mehr zu holen.
    if (eigenstaendig()) return false;
    // Prüfläufe steuern einen echten Browser fern — sie sollen den Chat
    // testen, nicht auf ein Tor treffen, das kein Skript erwartet.
    if (navigator.webdriver) return false;
    try { if (sessionStorage.getItem(WEITER_SCHLUESSEL)) return false; } catch { /* ohne Speicher eben immer */ }
    return true;
  });
  // Der Weiter-Knopf schließt für diese Sitzung — sessionStorage merkt sich
  // das für den nächsten Besuch, der Zustand hier fürs jetzige Rendern.
  const [weg, setWeg] = useState(false);

  const weiter = () => {
    try { sessionStorage.setItem(WEITER_SCHLUESSEL, '1'); } catch { /* dann eben nur für jetzt */ }
    setWeg(true);
  };

  if (!system || !torGilt || weg) return null;
  const { name, symbol } = SYSTEME[system];

  return (
    <AnimatePresence>
      <motion.div
        className="download-tor"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.22 }}
      >
        <div className="download-tor__karte">
          <div className="download-tor__marke" aria-hidden="true">{symbol}</div>
          <h1 className="download-tor__titel">{t('download.gateTitle', { system: name })}</h1>
          <p className="download-tor__text">{t('download.gateText')}</p>
          <button
            type="button"
            className="btn btn--primary btn--block download-tor__knopf"
            onClick={() => { weiter(); setOverlay('download'); }}
          >
            <Download size={16} /> {t('download.get')}
          </button>
          <button type="button" className="btn btn--ghost btn--block" onClick={weiter}>
            {t('download.gateWeiter')}
          </button>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}