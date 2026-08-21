import { motion } from 'framer-motion';
import { Check, Sparkles, Trash2 } from 'lucide-react';
import { useT } from '../i18n/index.js';

/**
 * Der Reiter „Prüfen" — was die KI selbst eingetragen hat.
 *
 * Trägt die KI selbst ein (Einstellung in der Verwaltung), stehen Aufgaben,
 * Ideen und Termine sofort auf den Brettern. Damit daraus kein Wildwuchs
 * wird, sammelt diese Liste alles, was noch niemand angesehen hat: „Passt"
 * macht daraus einen normalen Eintrag, „Weg" löscht ihn.
 *
 * Bewusst dieselbe Liste für alle drei Bretter statt drei ähnlicher: Die
 * Handlung ist dieselbe, und der Unterschied — Titel, Nebenzeile — steckt
 * in den Zeilen, die der Aufrufer mitgibt.
 */
export interface PruefEintrag {
  id: string;
  titel: string;
  /** Kurze Einordnung: Kanal, Zeitpunkt, Zuständigkeit — was zur Sache passt. */
  neben?: string | null;
}

export function PruefListe({ eintraege, onOeffnen, onPasst, onWeg }: {
  eintraege: PruefEintrag[];
  onOeffnen?: (id: string) => void;
  onPasst: (id: string) => void;
  onWeg: (id: string) => void;
}) {
  const t = useT();

  if (!eintraege.length) {
    return (
      <div className="empty-state">
        <Sparkles size={30} className="muted" />
        <p>{t('pruefen.empty')}</p>
      </div>
    );
  }

  return (
    <div className="pruefen">
      <p className="pruefen__hinweis">{t('pruefen.hint')}</p>
      {eintraege.map((e) => (
        <motion.div
          key={e.id}
          className="pruefen__zeile"
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16 }}
        >
          <button
            className="pruefen__text"
            onClick={() => onOeffnen?.(e.id)}
            /* Ohne Öffnen-Weg bleibt die Zeile Text und kein toter Knopf. */
            disabled={!onOeffnen}
          >
            <span className="pruefen__titel">{e.titel}</span>
            {e.neben && <span className="pruefen__neben">{e.neben}</span>}
          </button>
          <div className="pruefen__knoepfe">
            <button className="btn btn--primary btn--sm" onClick={() => onPasst(e.id)}>
              <Check size={13} /> {t('pruefen.ok')}
            </button>
            <button className="icon-btn" onClick={() => onWeg(e.id)} title={t('msg.delete')}>
              <Trash2 size={14} />
            </button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
