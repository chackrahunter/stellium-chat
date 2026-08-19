import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Check, Settings } from 'lucide-react';
import type { UserStatus } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { socket } from '../net/socket.js';
import { useT, type TranslationKey } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import '../styles/status.css';

/**
 * Das eigene Profilbild mit Statusmenü.
 *
 * Vorher führte ein Klick auf das eigene Bild in denselben großen
 * Einstellungsdialog wie das Zahnrad daneben — zwei Knöpfe für dieselbe Sache,
 * und für den Status blieb nur der Schrägstrich-Befehl im Eingabefeld, den
 * niemand findet. Jetzt liegt an dieser Stelle das, was man an dieser Stelle
 * erwartet: der eigene Zustand. Der Weg in die Einstellungen bleibt über das
 * Zahnrad und zusätzlich über den letzten Eintrag im Menü, damit die alte
 * Gewohnheit nicht ins Leere greift.
 */

/**
 * Wie lange ein selbst gesetzter Status gilt.
 *
 * Acht Stunden sind ein Arbeitstag. Wer morgens „bitte nicht stören" wählt,
 * findet es nachmittags noch vor — und am nächsten Morgen nicht mehr. Kürzer
 * wäre lästig, weil die Frist mitten in der Besprechung abliefe, für die man
 * sie gesetzt hat. Unbegrenzt wäre schlimmer: ein einmal gesetztes „abwesend"
 * stünde wochenlang, und dann glaubt niemand mehr den Punkten neben den Namen.
 *
 * Die Frist selbst setzt der Server (MANUELL_HAELT_MS in ws/gateway.ts). Die
 * Zahl steht hier nur, um sie im Menü nennen zu können — ändert sie sich dort,
 * muss sie hier mitwandern, sonst verspricht das Menü etwas anderes, als
 * tatsächlich geschieht.
 */
const HALTEDAUER_STUNDEN = 8;

/**
 * Ab wann ohne jede Eingabe von selbst „abwesend" gilt.
 *
 * Fünf Minuten sind die Schwelle, die auch Bildschirmschoner verwenden, und
 * sie fühlt sich richtig an: wer nachdenkt oder eine lange Nachricht liest,
 * bleibt grün; wer den Platz verlässt, ist es nach kurzer Zeit nicht mehr.
 *
 * Dieser Wächter ist der genaue: er sieht echte Eingaben. Der Server hat für
 * Verbindungen, die ihn nicht mitbringen, eine zweite, viel großzügigere
 * Frist — er kennt nur Ereignisse und müsste sonst raten.
 */
const LEERLAUF_MS = 5 * 60_000;

interface Eintrag {
  status: UserStatus;
  name: TranslationKey;
  note: TranslationKey;
}

/**
 * „Unsichtbar" ist kein eigener Wert, sondern der Zustand „offline", während
 * die Verbindung steht. Genau das bedeutet unsichtbar auch: für alle anderen
 * ununterscheidbar von jemandem, der die App geschlossen hat. Dafür braucht es
 * keinen fünften Wert im Protokoll — und einer, den nur der Server kennt und
 * nach außen doch wieder zu „offline" verflachen müsste, wäre eine Falle für
 * jeden, der ihn später versehentlich weiterreicht.
 */
const EINTRAEGE: Eintrag[] = [
  { status: 'online', name: 'status.online', note: 'status.onlineNote' },
  { status: 'away', name: 'status.away', note: 'status.awayNote' },
  /* „Bitte nicht stören" stand als 'user.dnd' schon in allen 22 Sprachen —
     ein zweiter Schlüssel daneben liefe irgendwann auseinander. */
  { status: 'dnd', name: 'user.dnd', note: 'status.dndNote' },
  { status: 'offline', name: 'status.invisible', note: 'status.invisibleNote' },
];

export function StatusMenu() {
  const t = useT();
  const self = useStore((s) => s.self);
  /*
   * Der eigene Punkt darf nicht aus "self" kommen: bei einem presence-Ereignis
   * schreibt der Zustand nur die Nutzerliste fort, nicht das eigene Profil. Aus
   * "self" gelesen zeigte das Bild für immer den Stand der Anmeldung — man
   * setzte „abwesend", alle anderen sähen es, nur man selbst nicht.
   */
  const aktuell = useStore((s) => (s.self ? s.users[s.self.id]?.status ?? s.self.status : 'offline'));
  const [offen, setOffen] = useState(false);
  const ausloeser = useRef<HTMLButtonElement>(null);
  const menue = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number } | null>(null);

  const schliessen = useCallback(() => setOffen(false), []);

  /*
   * Erst messen, dann setzen: die Höhe des Menüs steht erst fest, wenn es im
   * Baum hängt. useLayoutEffect läuft vor dem Zeichnen, deshalb sieht niemand
   * den Zwischenschritt an der Ausgangsstelle.
   */
  useLayoutEffect(() => {
    if (!offen) { setOrt(null); return; }
    const knopf = ausloeser.current;
    const kasten = menue.current;
    if (!knopf || !kasten) return;
    const k = knopf.getBoundingClientRect();
    const m = kasten.getBoundingClientRect();
    /* Rechts neben dem Bild, unten bündig mit ihm — das Menü wächst also nach
       oben, weg vom Fensterrand, an dem das Bild ohnehin schon klebt. */
    const left = Math.min(k.right + 10, window.innerWidth - m.width - 8);
    const top = Math.max(8, Math.min(k.bottom - m.height, window.innerHeight - m.height - 8));
    setOrt({ left, top });
  }, [offen]);

  /* Schließen wie überall sonst: Klick daneben, Escape, Größenänderung. */
  useEffect(() => {
    if (!offen) return;
    const beiTaste = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      schliessen();
      ausloeser.current?.focus();
    };
    // Im nächsten Tick, sonst schließt der öffnende Klick sofort wieder.
    const timer = window.setTimeout(() => {
      window.addEventListener('click', schliessen);
      window.addEventListener('resize', schliessen);
    }, 0);
    window.addEventListener('keydown', beiTaste, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', schliessen);
      window.removeEventListener('resize', schliessen);
      window.removeEventListener('keydown', beiTaste, true);
    };
  }, [offen, schliessen]);

  /*
   * Leerlaufwächter.
   *
   * Ohne ihn bleibt ein vergessener, offener Rechner für immer grün — der
   * häufigste Grund dafür, dass jemand als online erscheint, obwohl er es
   * nicht ist. Er hängt hier, weil diese Komponente in der Leiste steckt und
   * damit von der Anmeldung bis zum Schließen der App durchgehend lebt.
   */
  useEffect(() => {
    if (!self) return;
    let letzteEingabe = Date.now();
    let alsAbwesendGemeldet = false;

    /*
     * Ausdrücklich mit "statusExpiresAt: null". Das ist die Marke für „vom
     * Wächter gemeldet, nicht vom Menschen gewählt": der Server verwirft eine
     * solche Meldung, solange ein selbst gesetzter Status seine Frist noch
     * hat. Über store.setStatus ginge das nicht — dessen Signatur kennt die
     * Frist nicht, und genau das unterscheidet die beiden Wege.
     */
    const melden = (status: UserStatus) => {
      socket.send({ t: 'presence:set', status, statusExpiresAt: null });
    };

    const beruehren = () => {
      letzteEingabe = Date.now();
      if (!alsAbwesendGemeldet) return;
      alsAbwesendGemeldet = false;
      melden('online');
    };

    const pruefen = () => {
      if (alsAbwesendGemeldet) return;
      if (Date.now() - letzteEingabe < LEERLAUF_MS) return;
      alsAbwesendGemeldet = true;
      melden('away');
    };

    /* Ein verstecktes Fenster bekommt gar keine Eingaben mehr — die Uhr läuft
       dann von selbst ab, dafür braucht es keinen Sonderfall. Nur der Weg
       zurück muss gemeldet werden. */
    const events = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'focus'] as const;
    for (const name of events) window.addEventListener(name, beruehren, { passive: true });
    document.addEventListener('visibilitychange', beruehren);
    const takt = window.setInterval(pruefen, 30_000);

    return () => {
      for (const name of events) window.removeEventListener(name, beruehren);
      document.removeEventListener('visibilitychange', beruehren);
      clearInterval(takt);
    };
  }, [self?.id]);

  if (!self) return null;

  /*
   * Selbst gewählt heißt: ohne Angabe einer Frist. Der Server erkennt daran,
   * dass ein Mensch entschieden hat, und legt seine Regelfrist darüber.
   * Zeichen und Text werden dabei bewusst geleert — wer „online" wählt, will
   * nicht, dass ein altes „🔕 in einer Besprechung" daneben stehen bleibt.
   */
  const waehlen = (status: UserStatus) => {
    useStore.getState().setStatus(status, null, null);
    schliessen();
  };

  return (
    <div className="statusmenue__anker">
      <button
        ref={ausloeser}
        className="statusmenue__ausloeser no-drag"
        aria-haspopup="menu"
        aria-expanded={offen}
        aria-label={t('status.title')}
        title={self.displayName}
        onClick={(e) => { e.stopPropagation(); setOffen((v) => !v); }}
      >
        <Avatar user={self} size={34} showPresence status={aktuell} />
      </button>

      {offen && createPortal(
        <motion.div
          ref={menue}
          className="statusmenue"
          role="menu"
          aria-label={t('status.title')}
          style={{ left: ort?.left ?? -9999, top: ort?.top ?? -9999 }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="statusmenue__titel">{t('status.title')}</div>

          {EINTRAEGE.map((e) => {
            const gewaehlt = e.status === aktuell;
            return (
              <button
                key={e.status}
                role="menuitemradio"
                aria-checked={gewaehlt}
                className={`statusmenue__eintrag${gewaehlt ? ' statusmenue__eintrag--aktiv' : ''}`}
                onClick={() => waehlen(e.status)}
              >
                <span className={`statusmenue__punkt presence--${e.status}`} />
                <span className="statusmenue__text">
                  <span className="statusmenue__name">{t(e.name)}</span>
                  <span className="statusmenue__note">{t(e.note)}</span>
                </span>
                {gewaehlt && <Check size={15} className="statusmenue__haken" />}
              </button>
            );
          })}

          <p className="statusmenue__hinweis">
            {t('status.holds', { stunden: HALTEDAUER_STUNDEN })}
          </p>

          <div className="statusmenue__trenner" />
          <button
            role="menuitem"
            className="statusmenue__eintrag statusmenue__eintrag--schlicht"
            onClick={() => { schliessen(); useStore.getState().setOverlay('settings'); }}
          >
            <Settings size={15} className="statusmenue__zahnrad" />
            <span className="statusmenue__name">{t('status.openSettings')}</span>
          </button>
        </motion.div>,
        document.body,
      )}
    </div>
  );
}
