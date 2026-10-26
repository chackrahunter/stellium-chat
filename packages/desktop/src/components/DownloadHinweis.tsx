import { useMemo } from 'react';
import { motion } from 'framer-motion';
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

/**
 * Ob das Tor in dieser Sitzung gilt. Einmal gefragt, beim ersten Darstellen
 * der App — keines dieser Merkmale ändert sich mitten in einer Sitzung.
 *
 * Eigene Funktion statt Zustand im Tor selbst: App.tsx muss es VOR der
 * Einführung wissen. Beide gingen beim ersten Anmelden gleichzeitig auf, die
 * Einführung lag oben, und durch ihren Schleier schimmerte die Karte des
 * Tors als dunkler Kasten. Jetzt wartet die Einführung, bis das Tor weg ist.
 */
export function downloadTorGilt(): boolean {
  if (!rechnersystemErkennen()) return false;
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
}

/**
 * Nur die Karte. Ob sie steht, entscheidet App.tsx — dort hängt sie in
 * einem AnimatePresence. Hier drin stand das AnimatePresence vorher UNTER
 * dem `return null`: verschwand das Tor, verschwand es samt Ausblende, und
 * die Ausblende lief nie.
 */
export function DownloadHinweis({ onWeiter }: { onWeiter: () => void }) {
  const t = useT();
  const { setOverlay } = useStore.getState();
  const system = useMemo(rechnersystemErkennen, []);

  // Der Weiter-Knopf schließt für diese Sitzung — sessionStorage merkt sich
  // das für den nächsten Besuch, App.tsx fürs jetzige Rendern.
  const weiter = () => {
    try { sessionStorage.setItem(WEITER_SCHLUESSEL, '1'); } catch { /* dann eben nur für jetzt */ }
    onWeiter();
  };

  if (!system) return null;
  const { name, symbol } = SYSTEME[system];

  return (
    <motion.div
      className="download-tor"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.22 }}
    >
      <motion.div
        className="download-tor__karte"
        initial={{ opacity: 0, scale: 0.96, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 4 }}
        transition={{ type: 'spring', bounce: 0, duration: 0.4 }}
      >
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
      </motion.div>
    </motion.div>
  );
}