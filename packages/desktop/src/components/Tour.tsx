import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft, ArrowRight, Bell, Bot, CalendarDays, Check, FolderOpen, Hash,
  Languages, Lightbulb, ListChecks, Search, Settings2, ShieldCheck, Sparkles, Star, X,
} from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import type { TranslationKey } from '../i18n/index.js';

/**
 * Geführte Einführung — direkt in der echten Oberfläche.
 *
 * Jeder Schritt zeigt auf ein tatsächlich vorhandenes Bedienelement: der Rest
 * des Fensters wird abgedunkelt, das Ziel bleibt hell und bekommt einen
 * pulsierenden Ring. So lernt man die Stellen kennen, an denen die Funktionen
 * später wirklich sitzen, statt eine nachgebaute Vorführung zu sehen.
 *
 * Schritte, deren Ziel gerade nicht existiert (etwa der Team-Knopf ohne
 * Verwaltungsrecht), werden übersprungen — die Tour bricht nie ins Leere.
 */

const SPEICHER = 'stellium.tourGesehen';

export function tourBereitsGesehen(): boolean {
  return localStorage.getItem(SPEICHER) === 'ja';
}

export function tourAlsGesehenMerken(): void {
  localStorage.setItem(SPEICHER, 'ja');
}

export function tourZuruecksetzen(): void {
  localStorage.removeItem(SPEICHER);
}

interface Schritt {
  id: string;
  /** Ziel in der echten Oberfläche. Fehlt es, steht die Karte mittig. */
  ziel?: string;
  icon: React.ReactNode;
  titel: TranslationKey;
  text: TranslationKey;
  /** Bevorzugte Seite der Sprechblase. */
  seite?: 'rechts' | 'links' | 'oben' | 'unten';
}

const SCHRITTE: Schritt[] = [
  { id: 'start', icon: <Star size={22} />, titel: 'tour.welcomeTitle', text: 'tour.welcomeText' },
  { id: 'channels', ziel: '[data-tour="channels"]', seite: 'rechts',
    icon: <Hash size={20} />, titel: 'tour.channelsTitle', text: 'tour.channelsText' },
  { id: 'composer', ziel: '[data-tour="composer"]', seite: 'oben',
    icon: <Languages size={20} />, titel: 'tour.translateTitle', text: 'tour.translateText' },
  { id: 'language', ziel: '[data-tour="language"]', seite: 'unten',
    icon: <Languages size={20} />, titel: 'tour.languageTitle', text: 'tour.languageText' },
  { id: 'catchup', ziel: '[data-tour="catchup"]', seite: 'unten',
    icon: <Sparkles size={20} />, titel: 'tour.catchupTitle', text: 'tour.catchupText' },
  { id: 'smart', ziel: '[data-tour="smart"]', seite: 'unten',
    icon: <Sparkles size={20} />, titel: 'tour.smartTitle', text: 'tour.smartText' },
  { id: 'ai', ziel: '[data-tour="ai"]', seite: 'rechts',
    icon: <Bot size={20} />, titel: 'tour.aiTitle', text: 'tour.aiText' },
  { id: 'tasks', ziel: '[data-tour="tasks"]', seite: 'rechts',
    icon: <ListChecks size={20} />, titel: 'tour.tasksTitle', text: 'tour.tasksText' },
  { id: 'calendar', ziel: '[data-tour="calendar"]', seite: 'rechts',
    icon: <CalendarDays size={20} />, titel: 'tour.calendarTitle', text: 'tour.calendarText' },
  { id: 'files', ziel: '[data-tour="files"]', seite: 'rechts',
    icon: <FolderOpen size={20} />, titel: 'tour.filesTitle', text: 'tour.filesText' },
  { id: 'ideas', ziel: '[data-tour="ideas"]', seite: 'rechts',
    icon: <Lightbulb size={20} />, titel: 'tour.ideasTitle', text: 'tour.ideasText' },
  { id: 'reminders', ziel: '[data-tour="reminders"]', seite: 'rechts',
    icon: <Bell size={20} />, titel: 'tour.remindersTitle', text: 'tour.remindersText' },
  { id: 'search', ziel: '[data-tour="search"]', seite: 'unten',
    icon: <Search size={20} />, titel: 'tour.searchTitle', text: 'tour.searchText' },
  { id: 'team', ziel: '[data-tour="team"]', seite: 'rechts',
    icon: <ShieldCheck size={20} />, titel: 'tour.teamTitle', text: 'tour.teamText' },
  { id: 'settings', ziel: '[data-tour="settings"]', seite: 'rechts',
    icon: <Settings2 size={20} />, titel: 'tour.settingsTitle', text: 'tour.settingsText' },
  { id: 'ende', icon: <Check size={22} />, titel: 'tour.doneTitle', text: 'tour.doneText' },
];

interface Rechteck { top: number; left: number; width: number; height: number }

const LUFT = 8;
const KARTE_BREIT = 340;
/** Startwert, bis die Karte einmal gerendert und gemessen wurde. */
const KARTE_HOCH_SCHAETZUNG = 230;

export function Tour({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [ziel, setZiel] = useState<Rechteck | null>(null);
  const [messung, setMessung] = useState(0);
  const [kartenHoehe, setKartenHoehe] = useState(KARTE_HOCH_SCHAETZUNG);
  const karte = useRef<HTMLDivElement>(null);

  // Nur Schritte, deren Ziel es in dieser Oberfläche wirklich gibt.
  const [schritte, setSchritte] = useState<Schritt[]>(SCHRITTE);
  useEffect(() => {
    setSchritte(SCHRITTE.filter((s) => !s.ziel || document.querySelector(s.ziel)));
  }, []);

  const aktuell = schritte[Math.min(index, schritte.length - 1)];
  const letzter = index >= schritte.length - 1;

  const beenden = useCallback(() => { tourAlsGesehenMerken(); onClose(); }, [onClose]);
  const weiter = useCallback(() => {
    if (letzter) beenden(); else setIndex((i) => i + 1);
  }, [letzter, beenden]);
  const zurueck = useCallback(() => setIndex((i) => Math.max(0, i - 1)), []);

  /* Höhe der Karte messen. Die Texte sind unterschiedlich lang; ohne die
     echte Höhe könnte die Karte unten aus dem Fenster rutschen. Bewusst in
     einem Effekt statt im ref-Aufruf — sonst liefe ein setState mitten in
     der Darstellungsphase einer anderen Komponente. */
  useLayoutEffect(() => {
    const h = karte.current?.getBoundingClientRect().height;
    if (h && Math.abs(h - kartenHoehe) > 2) setKartenHoehe(h);
  });

  /* Zielrechteck messen — auch nach Größenänderung des Fensters. */
  useLayoutEffect(() => {
    if (!aktuell?.ziel) { setZiel(null); return; }
    const el = document.querySelector(aktuell.ziel);
    if (!el) { setZiel(null); return; }
    const r = el.getBoundingClientRect();
    setZiel({ top: r.top, left: r.left, width: r.width, height: r.height });
  }, [aktuell, messung]);

  useEffect(() => {
    const neu = () => setMessung((m) => m + 1);
    window.addEventListener('resize', neu);
    // Auch Scrollen innerhalb der Seitenleiste verschiebt Ziele.
    window.addEventListener('scroll', neu, true);
    return () => {
      window.removeEventListener('resize', neu);
      window.removeEventListener('scroll', neu, true);
    };
  }, []);

  /* Tastatur: vor, zurück, abbrechen. */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); beenden(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); weiter(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); zurueck(); }
    };
    // Capture, damit die Tour vor den übrigen Tastenkürzeln drankommt.
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [beenden, weiter, zurueck]);

  if (!aktuell) return null;

  const platz = kartenPosition(ziel, kartenHoehe, aktuell.seite);

  return (
    <div className="tour" role="dialog" aria-modal="true" aria-label={t(aktuell.titel)}>
      {/* Abdunklung mit Aussparung: vier Flächen um das Ziel herum.
          Ein einzelnes Element mit box-shadow würde die Ecken nicht runden. */}
      {ziel ? (
        <motion.div
          className="tour__cut"
          initial={false}
          animate={{
            top: ziel.top - LUFT,
            left: ziel.left - LUFT,
            width: ziel.width + LUFT * 2,
            height: ziel.height + LUFT * 2,
          }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        />
      ) : (
        <div className="tour__cut tour__cut--none" />
      )}

      {ziel && (
        <motion.div
          className="tour__ring"
          initial={false}
          animate={{
            top: ziel.top - LUFT,
            left: ziel.left - LUFT,
            width: ziel.width + LUFT * 2,
            height: ziel.height + LUFT * 2,
          }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        />
      )}

      <AnimatePresence mode="wait">
        <motion.div
          key={aktuell.id}
          ref={karte}
          className="tour__card"
          style={{ top: platz.top, left: platz.left }}
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.97, y: -6 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        >
          <button className="tour__close" onClick={beenden} title={t('tour.skip')}>
            <X size={15} />
          </button>

          <motion.span
            className="tour__icon"
            initial={{ rotate: -12, scale: 0.8 }}
            animate={{ rotate: 0, scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 18 }}
          >
            {aktuell.icon}
          </motion.span>

          <h2 className="tour__title">{t(aktuell.titel)}</h2>
          <p className="tour__text">{t(aktuell.text)}</p>

          <div className="tour__dots">
            {schritte.map((s, i) => (
              <button
                key={s.id}
                className={i === index ? 'tour__dot tour__dot--on' : 'tour__dot'}
                onClick={() => setIndex(i)}
                aria-label={t('tour.step', { n: i + 1, total: schritte.length })}
              />
            ))}
          </div>

          <div className="tour__foot">
            <button className="btn btn--ghost" onClick={beenden}>{t('tour.skip')}</button>
            <span className="tour__count">{t('tour.step', { n: index + 1, total: schritte.length })}</span>
            {index > 0 && (
              <button className="btn" onClick={zurueck}><ArrowLeft size={14} /> {t('tour.back')}</button>
            )}
            <button className="btn btn--primary" onClick={weiter}>
              {letzter ? t('tour.done') : t('tour.next')}
              {!letzter && <ArrowRight size={14} />}
            </button>
          </div>
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

/**
 * Legt die Karte neben das Ziel — und dreht sie um, wenn sie sonst aus dem
 * Fenster ragen würde. Ohne Ziel steht sie mittig.
 */
function kartenPosition(
  ziel: Rechteck | null,
  KARTE_HOCH: number,
  seite: Schritt['seite'] = 'rechts',
): { top: number; left: number } {
  const breite = window.innerWidth;
  const hoehe = window.innerHeight;
  const rand = 16;

  if (!ziel) {
    return { top: Math.max(rand, (hoehe - KARTE_HOCH) / 2), left: (breite - KARTE_BREIT) / 2 };
  }

  const abstand = 18;
  const kandidaten: Record<string, { top: number; left: number }> = {
    rechts: { top: ziel.top + ziel.height / 2 - KARTE_HOCH / 2, left: ziel.left + ziel.width + abstand },
    links: { top: ziel.top + ziel.height / 2 - KARTE_HOCH / 2, left: ziel.left - KARTE_BREIT - abstand },
    unten: { top: ziel.top + ziel.height + abstand, left: ziel.left + ziel.width / 2 - KARTE_BREIT / 2 },
    oben: { top: ziel.top - KARTE_HOCH - abstand, left: ziel.left + ziel.width / 2 - KARTE_BREIT / 2 },
  };

  const gegenteil: Record<string, string> = { rechts: 'links', links: 'rechts', oben: 'unten', unten: 'oben' };
  const passt = (p: { top: number; left: number }) =>
    p.left >= rand && p.top >= rand
    && p.left + KARTE_BREIT <= breite - rand
    && p.top + KARTE_HOCH <= hoehe - rand;

  const gewaehlt = passt(kandidaten[seite])
    ? kandidaten[seite]
    : passt(kandidaten[gegenteil[seite]])
      ? kandidaten[gegenteil[seite]]
      : Object.values(kandidaten).find(passt) ?? kandidaten[seite];

  // Auch der Notfall darf nicht aus dem Bild laufen.
  return {
    top: Math.min(Math.max(rand, gewaehlt.top), hoehe - KARTE_HOCH - rand),
    left: Math.min(Math.max(rand, gewaehlt.left), breite - KARTE_BREIT - rand),
  };
}
