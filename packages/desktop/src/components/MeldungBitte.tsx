import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Bell, X } from 'lucide-react';
import { useT } from '../i18n';
import { erlaubnisHolen, erlaubnisStand } from '../lib/benachrichtigung.js';
import { pushSynchronisieren } from '../state/store.js';

/**
 * Der Streifen, der einmal nach der Erlaubnis für Benachrichtigungen fragt.
 *
 * Warum es ihn braucht: die Frage stand bisher ausschließlich in den
 * Einstellungen, hinter dem Reiter „Benachrichtigungen". Wer dort nie
 * hinsieht — also fast jeder — wurde nie gefragt, und der Browser darf von
 * sich aus nicht fragen. Ergebnis: auf keinem System kam je eine
 * Benachrichtigung an, ohne dass irgendwo ein Fehler zu sehen gewesen wäre.
 *
 * Er fragt NICHT von selbst beim Laden. Browser werten das als aufdringlich
 * und blockieren solche Abfragen inzwischen dauerhaft — und wer ungefragt
 * gefragt wird, sagt Nein. Deshalb erst der Streifen, und die eigentliche
 * Abfrage auf Knopfdruck: eine Bedienhandlung, wie es die Browser verlangen.
 *
 * Weggeklickt bleibt weggeklickt. Das steht im Speicher des Geräts und nicht
 * im Konto: die Erlaubnis gilt je Gerät und Browser, also gehört die
 * Erinnerung daran auch dorthin.
 */
const SCHLUESSEL = 'stellium.meldung-gefragt';

export function MeldungBitte() {
  const t = useT();
  const [zeigen, setZeigen] = useState(false);

  useEffect(() => {
    /* Kurz warten: direkt nach der Anmeldung baut sich die Oberfläche noch
       auf, und ein Streifen, der mitten hinein springt, wird weggeklickt,
       bevor jemand ihn gelesen hat. */
    const uhr = window.setTimeout(() => {
      if (erlaubnisStand() !== 'gefragt-werden') return;
      try { if (localStorage.getItem(SCHLUESSEL)) return; } catch { /* ohne Speicher eben jedes Mal */ }
      setZeigen(true);
    }, 4000);
    return () => window.clearTimeout(uhr);
  }, []);

  const merken = () => {
    try { localStorage.setItem(SCHLUESSEL, '1'); } catch { /* dann eben nicht */ }
    setZeigen(false);
  };

  return (
    <AnimatePresence>
      {zeigen && (
        <motion.div
          className="meldung-bitte"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.22 }}
        >
          <Bell size={15} />
          <span className="meldung-bitte__text">{t('meldung.bitte')}</span>
          <button
            type="button"
            className="btn btn--primary btn--sm"
            onClick={() => {
              // Direkt aus derselben Bedienhandlung heraus anmelden — sonst
              // greift erst wieder das nächste 'ready' beim übernächsten
              // Verbindungsaufbau, und bis dahin bekäme dieses Gerät noch
              // keinen Push, obwohl die Erlaubnis längst erteilt ist.
              void erlaubnisHolen().then((stand) => { merken(); if (stand === 'erlaubt') pushSynchronisieren(); });
            }}
          >
            {t('meldung.erlauben')}
          </button>
          <button
            type="button"
            className="icon-btn icon-btn--sm"
            onClick={merken}
            title={t('meldung.spaeter')}
          >
            <X size={14} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
