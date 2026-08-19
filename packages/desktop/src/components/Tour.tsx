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

type Seite = 'rechts' | 'links' | 'oben' | 'unten';

/** Alle Ausweichrichtungen. Welche zum Zug kommt, entscheidet der Platz. */
const SEITEN: Seite[] = ['rechts', 'links', 'unten', 'oben'];

interface Schritt {
  id: string;
  /** Ziel in der echten Oberfläche. Fehlt es, steht die Karte mittig. */
  ziel?: string;
  icon: React.ReactNode;
  titel: TranslationKey;
  text: TranslationKey;
  /** Bevorzugte Seite der Sprechblase. */
  seite?: Seite;
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
/* Muss mit der Breite in app.css (.tour__card) übereinstimmen — sonst rechnet
   die Platzsuche mit einer Karte, die es auf dem Schirm nicht gibt.

   Gemessen: bei 340 passten „Überspringen“, „Zurück“ und „Weiter“ auf Deutsch
   in keiner Fenstergröße nebeneinander (nötig 298, vorhanden 302 abzüglich der
   Abstände). Sie brachen deshalb in eine zweite Zeile um, und die Karte wuchs
   von 245 auf 302 Punkte Höhe — genau diese 57 Punkte trugen sie in flachen
   Fenstern wieder aus dem Bild und über den Scheinwerfer. Breiter ist hier
   also nicht Geschmack, sondern das, was die Karte flach hält. */
const KARTE_BREIT = 380;
/** Startwert, bis die Karte einmal gerendert und gemessen wurde. */
const KARTE_HOCH_SCHAETZUNG = 230;

export function Tour({ onClose }: { onClose: () => void }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [ziel, setZiel] = useState<Rechteck | null>(null);
  const [messung, setMessung] = useState(0);
  const [kartenHoehe, setKartenHoehe] = useState(KARTE_HOCH_SCHAETZUNG);
  const karte = useRef<HTMLDivElement | null>(null);

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
     echte Höhe könnte die Karte unten aus dem Fenster rutschen.

     offsetHeight statt des Rechtecks, weil die Karte beim Einblenden noch
     kleingerechnet ist: das Rechteck lieferte die geschrumpfte Höhe, und weil
     das Ende der Animation kein neues Rendern auslöst, blieb dieser zu kleine
     Wert stehen — die Karte rückte dem Ziel dichter auf den Leib als geplant.

     Ein Beobachter statt einer Messung im Effekt, weil die Höhe sich auch
     ohne neues Rendern ändert. Gemessen bei 375×500 auf dem letzten Schritt:
     die Fußzeile bricht auf schmalen Karten in eine zweite Zeile um, die Karte
     wächst dabei von 252 auf 294 Punkte — aber erst, nachdem der vorige
     Schritt ausgeblendet ist. Zu diesem Zeitpunkt kam kein Rendern mehr, in dem
     hätte nachgemessen werden können: die Karte stand mit dem alten Maß
     berechnet 21 Punkte zu tief. Der Beobachter meldet jede solche Änderung,
     auch das Nachladen einer Schrift.

     Als Rückruf am ref und nicht als Effekt mit Abhängigkeit: bei
     AnimatePresence mit „wait“ entsteht der neue Kasten erst, wenn der alte
     ausgeblendet ist. Ein Effekt hätte in diesem Moment noch den alten
     beobachtet. */
  const beobachter = useRef<ResizeObserver | null>(null);
  const karteRef = useCallback((el: HTMLDivElement | null) => {
    karte.current = el;
    beobachter.current?.disconnect();
    beobachter.current = null;
    if (!el) return;
    const messen = () => {
      const h = el.offsetHeight;
      if (h) setKartenHoehe((alt) => (Math.abs(h - alt) > 2 ? h : alt));
    };
    messen();
    beobachter.current = new ResizeObserver(messen);
    beobachter.current.observe(el);
  }, []);

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
          ref={karteRef}
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

          {/* Die Zählung steht bei den Punkten, nicht bei den Knöpfen: sie sagt
              dasselbe wie die Punkte und gehört zum Fortschritt. In der Fußzeile
              nahm sie den Knöpfen die Breite, die diese in langen Sprachen
              brauchen — „Überspringen“, „Zurück“ und „Weiter“ zusammen passten
              dort in keiner Fenstergröße hinein, und „Weiter“ ragte aus der
              Karte heraus. */}
          <div className="tour__dots">
            {schritte.map((s, i) => (
              <button
                key={s.id}
                className={i === index ? 'tour__dot tour__dot--on' : 'tour__dot'}
                onClick={() => setIndex(i)}
                aria-label={t('tour.step', { n: i + 1, total: schritte.length })}
              />
            ))}
            <span className="tour__count">{t('tour.step', { n: index + 1, total: schritte.length })}</span>
          </div>

          <div className="tour__foot">
            <button className="btn btn--ghost" onClick={beenden}>{t('tour.skip')}</button>
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

interface Platz { top: number; left: number }

/**
 * Legt die Karte neben den Scheinwerfer — niemals darüber.
 *
 * Die Karte erklärt, was der Scheinwerfer zeigt. Deckt sie ihn zu, erklärt sie
 * ins Leere: man liest über die Kanalliste und sieht sie dabei nicht. Deshalb
 * entscheidet hier nicht die Wunschseite allein, sondern der freie Platz.
 * Klebt das Ziel am linken Rand, ist rechts davon am meisten Luft, und dorthin
 * geht die Karte; sitzt es oben, geht sie nach unten. Reicht es auf keiner
 * Seite, zieht sie sich in die Ecke zurück, die vom Licht am wenigsten
 * berührt wird.
 *
 * Früher wurde nur geprüft, ob die Karte überhaupt ins Fenster passt, und die
 * fertige Stelle danach in den sichtbaren Bereich geschoben. Genau dieses
 * Schieben trug sie in flachen Fenstern zurück auf das Ziel.
 */
function kartenPosition(
  ziel: Rechteck | null,
  KARTE_HOCH: number,
  seite: Seite = 'rechts',
): Platz {
  const breite = window.innerWidth;
  const hoehe = window.innerHeight;
  const rand = 16;
  /* Auf schmalen Fenstern schrumpft die Karte per CSS mit. Ohne dasselbe
     Maß hier rechneten wir mit einer Breite, die es auf dem Schirm nicht gibt. */
  const kartenBreite = Math.min(KARTE_BREIT, breite - rand * 2);

  const imFensterX = (x: number) => Math.min(Math.max(rand, x), breite - kartenBreite - rand);
  const imFensterY = (y: number) => Math.min(Math.max(rand, y), hoehe - KARTE_HOCH - rand);

  if (!ziel) {
    return { top: Math.max(rand, (hoehe - KARTE_HOCH) / 2), left: (breite - kartenBreite) / 2 };
  }

  /* Der Scheinwerfer ist das Ziel samt der Luft ringsum — Aussparung und Ring
     sind genau so groß gezeichnet. Ausweichen muss die Karte dieser Fläche,
     nicht dem nackten Ziel. */
  const licht = {
    links: ziel.left - LUFT,
    oben: ziel.top - LUFT,
    rechts: ziel.left + ziel.width + LUFT,
    unten: ziel.top + ziel.height + LUFT,
  };
  const mitteX = (licht.links + licht.rechts) / 2;
  const mitteY = (licht.oben + licht.unten) / 2;

  const abstand = 18;
  /* Je Richtung steht eine Achse fest — sie hält die Karte neben dem Licht,
     was auch immer auf der anderen Achse passiert. Die darf dafür gleiten:
     ohne das Gleiten fiele ausgerechnet die fast fensterhohe Kanalliste durch,
     weil eine an ihrer Mitte ausgerichtete Karte oben und unten herausragt,
     obwohl rechts daneben das halbe Fenster frei ist. */
  const kandidaten: Record<Seite, Platz> = {
    rechts: { left: licht.rechts + abstand, top: imFensterY(mitteY - KARTE_HOCH / 2) },
    links: { left: licht.links - abstand - kartenBreite, top: imFensterY(mitteY - KARTE_HOCH / 2) },
    unten: { top: licht.unten + abstand, left: imFensterX(mitteX - kartenBreite / 2) },
    oben: { top: licht.oben - abstand - KARTE_HOCH, left: imFensterX(mitteX - kartenBreite / 2) },
  };

  /* Wie viel Fenster jede Richtung neben dem Licht übrig lässt. */
  const freiraum: Record<Seite, number> = {
    rechts: breite - rand - licht.rechts,
    links: licht.links - rand,
    unten: hoehe - rand - licht.unten,
    oben: licht.oben - rand,
  };

  /* Die feste Achse eines Kandidaten kann aus dem Fenster zeigen; die gleitende
     ist schon eingepasst. Ein halber Pixel Nachsicht, weil die Maße aus
     gebrochenen Rechtecken stammen. */
  const passt = (p: Platz) =>
    p.left >= rand - 0.5 && p.top >= rand - 0.5
    && p.left + kartenBreite <= breite - rand + 0.5
    && p.top + KARTE_HOCH <= hoehe - rand + 0.5;

  const reihenfolge: Seite[] = [
    seite,
    ...SEITEN.filter((s) => s !== seite).sort((a, b) => freiraum[b] - freiraum[a]),
  ];
  const gewaehlt = reihenfolge.map((s) => kandidaten[s]).find(passt);
  if (gewaehlt) return gewaehlt;

  /* Keine Richtung hat Platz — dann in die freieste Ecke. Füllt der
     Scheinwerfer beinahe das ganze Fenster, ist ein Rest Überdeckung nicht zu
     vermeiden; dann soll es wenigstens der kleinstmögliche sein, und bei
     gleicher Überdeckung die Ecke am weitesten weg vom Licht. */
  const ueberdeckung = (p: Platz) =>
    Math.max(0, Math.min(p.left + kartenBreite, licht.rechts) - Math.max(p.left, licht.links))
    * Math.max(0, Math.min(p.top + KARTE_HOCH, licht.unten) - Math.max(p.top, licht.oben));
  const wegVomLicht = (p: Platz) =>
    Math.abs(p.left + kartenBreite / 2 - mitteX) + Math.abs(p.top + KARTE_HOCH / 2 - mitteY);

  const x2 = Math.max(rand, breite - kartenBreite - rand);
  const y2 = Math.max(rand, hoehe - KARTE_HOCH - rand);
  const ecken: Platz[] = [
    { left: rand, top: rand }, { left: x2, top: rand },
    { left: rand, top: y2 }, { left: x2, top: y2 },
  ];
  return ecken.sort((a, b) => ueberdeckung(a) - ueberdeckung(b) || wegVomLicht(b) - wegVomLicht(a))[0];
}
