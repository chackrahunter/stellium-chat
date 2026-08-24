import { AnimatePresence, motion } from 'framer-motion';
import { LifeBuoy } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { useStore } from '../state/store.js';
import { useNotzugangUi } from '../state/notzugang.js';
import '../styles/notzugang.css';

/**
 * Der Streifen, der sagt: dein Kontoschlüssel ist noch da, und so kommst du
 * an ihn.
 *
 * WOFÜR ES IHN BRAUCHT — DER WEG EINER AUSGESPERRTEN PERSON
 *
 * Wer sein Passwort vergessen hat und kein angemeldetes Gerät mehr besitzt,
 * bekommt von der Verwaltung ein Einmal-Passwort. Er meldet sich damit an,
 * landet im Einrichtungsschirm (Setup.tsx — mehr zeigt App.tsx in diesem
 * Zustand nicht, und der Einrichtungsriegel in server/index.ts lässt auch
 * sonst nichts durch), setzt sein neues Passwort und steht danach in einer
 * gewöhnlichen, vollständigen Oberfläche. Nur: seine Notizen und sein Tresor
 * sind leer, und NICHTS sagte ihm bisher, warum — oder dass drei von fünf
 * Kolleginnen ihn zurückholen können. Der Weg war vorhanden und unsichtbar,
 * und ein unsichtbarer Weg ist keiner.
 *
 * `notzugangWartet` kommt vom Server (GET /api/konto/schluessel) und nicht
 * aus einer eigenen Rechnung hier: es ist dieselbe Tatsache, mit der der
 * Server drüben einen Ersatzschlüssel abweist (services/kontoschluessel.ts,
 * notzugangWartet()). Zwei Rechnungen für eine Frage laufen auseinander.
 *
 * NICHT WEGKLICKBAR, anders als der Download-Streifen daneben. Der bewirbt
 * eine App; dieser hier ist der einzige Hinweis darauf, dass die eigenen
 * Daten noch zu retten sind. Er geht, wenn die Wiederherstellung durch ist.
 */
export function NotzugangHinweis() {
  const t = useT();
  const wartet = useStore((s) => s.notzugangWartet);
  const self = useStore((s) => s.self);

  return (
    <AnimatePresence>
      {wartet && self && (
        <motion.div
          className="notzugang-hinweis"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22 }}
        >
          <LifeBuoy size={15} />
          <span className="notzugang-hinweis__text">{t('notzugang.wartet')}</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => useNotzugangUi.getState().oeffnen()}
          >
            {t('notzugang.nav')}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
