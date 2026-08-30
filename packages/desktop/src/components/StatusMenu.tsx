import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Check, Settings, Smile, X } from 'lucide-react';
import type { UserStatus } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { socket } from '../net/socket.js';
import { useT, type TranslationKey } from '../i18n/index.js';
import { dayLabel, sameDay, timeOfDay } from '../lib/format.js';
import { Avatar } from './Avatar.jsx';
import '../styles/status.css';
import { sichereRaender } from '../lib/klemmen.js';

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
 *
 * Zum Zustand gehört die Meldung daneben. Datenbank, Protokoll und Profilkarte
 * kannten "statusEmoji" und "statusText" von Anfang an — nur setzen konnte sie
 * niemand. Wer sagen wollte, dass er in einer Besprechung sitzt, musste den
 * Punkt auf rot stellen und hoffen, dass das jemand richtig deutet.
 */

/**
 * „Für immer" als Zeitpunkt.
 *
 * Der Server erkennt eine selbst getroffene Wahl ausschließlich daran, dass
 * eine Frist läuft (statusHaelt in ws/gateway.ts). Ohne Frist gilt der Status
 * als beiläufig entstanden: „abwesend" nähme die nächste Mausbewegung zurück,
 * und „unsichtbar" wäre nach dem ersten Netzwackler aufgehoben — genau das,
 * was die Kommentare dort beschreiben.
 *
 * Ein Datum weit jenseits jeder Nutzung ist deshalb die ehrlichere Angabe als
 * gar keins: die Frist läuft nie ab, der Aufräumer im Server findet den Eintrag
 * nie (er sucht status_expires_at <= jetzt), und die Wahl hält, bis ein Mensch
 * sie ändert. Sauberer wäre eine eigene Spalte „von Hand gesetzt" — die
 * bräuchte eine Wanderung der Datenbank und liegt in fremdem Revier.
 *
 * Der 26. Februar 2244. Ein gültiges Datum, keine Zahl an der Grenze des
 * Darstellbaren, und in keiner Anzeige zu verwechseln mit einer echten Frist.
 */
const NIE = 8_640_000_000_000;


/** So lang darf eine Meldung sein — was darüber steht, liest ohnehin niemand. */
const MELDUNG_MAX = 80;

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

/**
 * Wie lange die eigene Wahl gilt.
 *
 * Eine Dauer für alles, nicht eine je Zustand: Zustand, Zeichen und Text sind
 * beim Server ein einziger Eintrag mit einer einzigen Frist. Zwei Auswahlen
 * dafür wären eine Kreuztabelle, die nichts abbildet, was es unten gibt.
 */
type Dauer = '1h' | '8h' | '24h' | 'immer';

const DAUERN: { wert: Dauer; name: TranslationKey; satz: TranslationKey }[] = [
  { wert: '1h', name: 'status.dur1h', satz: 'status.holds1h' },
  { wert: '8h', name: 'status.dur8h', satz: 'status.holds8h' },
  { wert: '24h', name: 'status.dur24h', satz: 'status.holds24h' },
  { wert: 'immer', name: 'status.durForever', satz: 'status.holdsForever' },
];

const STUNDE = 60 * 60_000;

function fristAus(dauer: Dauer): number {
  switch (dauer) {
    case '1h': return Date.now() + STUNDE;
    case '8h': return Date.now() + 8 * STUNDE;
    case '24h': return Date.now() + 24 * STUNDE;
    case 'immer': return NIE;
  }
}

/** Wo die zuletzt gewählte Dauer liegt — wer immer dasselbe nimmt, soll es
 *  nicht jedes Mal neu antippen. Bewusst am Gerät und nicht in den
 *  Servereinstellungen: es ist eine Gewohnheit der Hand, keine des Kontos. */
const DAUER_SPEICHER = 'stellium.statusDauer';

function gemerkteDauer(): Dauer {
  try {
    const roh = localStorage.getItem(DAUER_SPEICHER);
    if (DAUERN.some((d) => d.wert === roh)) return roh as Dauer;
  } catch { /* ohne Speicher eben die Vorgabe */ }
  /* Acht Stunden sind ein Arbeitstag — und das, was vorher fest galt. Wer
     nichts umstellt, merkt keinen Unterschied zu früher. */
  return '8h';
}

/**
 * Fertige Meldungen — auf dem Telefon ein Griff statt eines getippten Satzes.
 *
 * Sie füllen nur das Feld und das Zeichen. Zustand und Dauer bleiben, was oben
 * steht: sonst änderte ein Tippen auf „Urlaub" drei Dinge auf einmal, von denen
 * zwei nirgends zu sehen wären.
 */
const VORSCHLAEGE: { emoji: string; text: TranslationKey }[] = [
  { emoji: '📅', text: 'status.tipMeeting' },
  { emoji: '🍽️', text: 'status.tipLunch' },
  { emoji: '🎧', text: 'status.tipFocus' },
  { emoji: '🚋', text: 'status.tipCommute' },
  { emoji: '🤒', text: 'status.tipSick' },
  { emoji: '🌴', text: 'status.tipVacation' },
];

/**
 * Kleine Auswahl statt der großen aus dem Eingabefeld: hier zählt ein Griff.
 *
 * Genau siebzehn — zusammen mit dem Feld zum Abwählen füllen sie drei Reihen zu
 * sechs. Eines mehr, und in der vierten Reihe steht ein einzelnes Zeichen.
 */
const ZEICHEN = [
  '📅', '🍽️', '🎧', '🚋', '🤒', '🌴',
  '💻', '☕', '📞', '🧠', '🏠', '✈️',
  '🎯', '🛠️', '📚', '🌙', '🎉',
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
  const meinZeichen = useStore((s) => (s.self ? s.users[s.self.id]?.statusEmoji ?? null : null));
  const meinText = useStore((s) => (s.self ? s.users[s.self.id]?.statusText ?? null : null));
  /*
   * Die Frist kommt nur aus der ersten Bestandsaufnahme; presence-Ereignisse
   * lassen sie fallen (siehe Bericht zu state/store.ts). Was in dieser Sitzung
   * selbst gesetzt wurde, merkt sich deshalb die Komponente — sonst stünde
   * unter der gerade eingetragenen Meldung kein Ende, obwohl der Server eines
   * kennt.
   */
  const serverFrist = useStore((s) => (s.self ? s.users[s.self.id]?.statusExpiresAt ?? null : null));
  const [eigeneFrist, setEigeneFrist] = useState<number | null | undefined>(undefined);
  const frist = eigeneFrist === undefined ? serverFrist : eigeneFrist;

  const [offen, setOffen] = useState(false);
  const ausloeser = useRef<HTMLButtonElement>(null);
  const menue = useRef<HTMLDivElement>(null);
  const feld = useRef<HTMLInputElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  const [entwurf, setEntwurf] = useState('');
  const [zeichen, setZeichen] = useState<string | null>(null);
  const [dauer, setDauer] = useState<Dauer>(gemerkteDauer);
  const [zeichenOffen, setZeichenOffen] = useState(false);

  const dauerWaehlen = (wert: Dauer) => {
    setDauer(wert);
    try { localStorage.setItem(DAUER_SPEICHER, wert); } catch { /* nicht schlimm */ }
  };

  const schliessen = useCallback(() => setOffen(false), []);

  /*
   * Erst messen, dann setzen: die Höhe des Menüs steht erst fest, wenn es im
   * Baum hängt. useLayoutEffect läuft vor dem Zeichnen, deshalb sieht niemand
   * den Zwischenschritt an der Ausgangsstelle.
   */
  const orten = useCallback(() => {
    const knopf = ausloeser.current;
    const kasten = menue.current;
    if (!knopf || !kasten) return;
    const k = knopf.getBoundingClientRect();
    /*
     * offsetWidth/offsetHeight statt getBoundingClientRect: das Menü fährt mit
     * scale 0.96 auf, und der Rahmen misst die verkleinerte Fassung. Danach
     * gesetzt, saß es fünf Pixel unter dem Fensterrand, sobald die Bewegung
     * fertig war — sichtbar nur als abgeschnittener letzter Eintrag. Die
     * Größe aus dem Layout kennt die Verkleinerung nicht.
     */
    const mBreite = kasten.offsetWidth;
    const mHoehe = kasten.offsetHeight;
    /* Auf dem Telefon schiebt die Tastatur den sichtbaren Ausschnitt zusammen,
       ohne dass sich das Fenster ändert. Ohne visualViewport rechnete das Menü
       mit einer Höhe, die zur Hälfte hinter der Tastatur liegt. */
    const sicht = window.visualViewport;
    const breite = sicht?.width ?? window.innerWidth;
    const hoehe = sicht?.height ?? window.innerHeight;
    const oben = sicht?.offsetTop ?? 0;

    const maxHeight = Math.max(180, hoehe - 16);
    const h = Math.min(mHoehe, maxHeight);
    /*
     * Neben das Bild, auf der dem Fensterrand abgewandten Seite — und unten
     * bündig mit ihm, das Menü wächst also nach oben, weg von der Kante, an
     * der das Bild ohnehin schon klebt.
     *
     * Auf Arabisch liegt die Leiste rechts. Ohne diese Unterscheidung schob
     * die Klemmung das Menü zwar ins Bild, aber quer über die Leiste — man
     * sah die Symbole darunter durchscheinen.
     */
    const vonRechts = getComputedStyle(document.documentElement).direction === 'rtl';
    const gewuenscht = vonRechts ? k.left - mBreite - 10 : k.right + 10;
    /* Zusätzlich zu Fensterrand und Tastatur: die Geräteränder (Kamera im
       Querformat, Home-Leiste) — frei positioniert hilft die CSS-Polsterung
       des Rahmens hier nicht. */
    const rand = sichereRaender();
    const left = Math.max(8 + rand.links, Math.min(gewuenscht, breite - mBreite - 8 - rand.rechts));
    const top = Math.max(oben + 8 + rand.oben, Math.min(k.bottom - h, oben + hoehe - h - 8 - rand.unten));
    setOrt({ left, top, maxHeight });
  }, []);

  useLayoutEffect(() => {
    if (!offen) { setOrt(null); return; }
    orten();
  }, [offen, orten]);

  /*
   * Nachmessen statt schließen.
   *
   * Vorher schloss jede Größenänderung das Menü. Auf dem Telefon ist das
   * Antippen des Eingabefelds eine Größenänderung — die Tastatur fährt hoch —,
   * und damit war die Meldung nicht zu tippen: das Menü verschwand mit dem
   * ersten Tipp. Auch das Ausklappen der Zeichen ändert die Höhe; deshalb
   * hängt hier ein ResizeObserver am Menü selbst.
   */
  useEffect(() => {
    if (!offen) return;
    const beobachter = new ResizeObserver(() => orten());
    if (menue.current) beobachter.observe(menue.current);
    window.addEventListener('resize', orten);
    window.visualViewport?.addEventListener('resize', orten);
    window.visualViewport?.addEventListener('scroll', orten);
    /* Auf schmalen Geräten rollt die Symbolleiste selbst — das Menü hängt am
       <body> und bliebe sonst stehen, während das Bild darunter wegwandert. */
    window.addEventListener('scroll', orten, true);
    return () => {
      beobachter.disconnect();
      window.removeEventListener('resize', orten);
      window.visualViewport?.removeEventListener('resize', orten);
      window.visualViewport?.removeEventListener('scroll', orten);
      window.removeEventListener('scroll', orten, true);
    };
  }, [offen, orten]);

  /* Schließen wie überall sonst: Klick daneben, Escape. */
  useEffect(() => {
    if (!offen) return;
    const beiTaste = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      /* Erst die Zeichenauswahl, dann das Menü — sonst nimmt ein Escape beides
         auf einmal weg und man ist weiter, als man wollte. */
      if (zeichenOffen) { setZeichenOffen(false); return; }
      schliessen();
      ausloeser.current?.focus();
    };
    // Im nächsten Tick, sonst schließt der öffnende Klick sofort wieder.
    const timer = window.setTimeout(() => window.addEventListener('click', schliessen), 0);
    window.addEventListener('keydown', beiTaste, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', schliessen);
      window.removeEventListener('keydown', beiTaste, true);
    };
  }, [offen, schliessen, zeichenOffen]);

  /* Beim Öffnen steht im Feld, was gerade gilt — sonst wäre jede Änderung ein
     Neuschreiben von vorn. `meinText`/`meinZeichen` deshalb absichtlich NICHT
     in der Abhängigkeitsliste: sie kommen aus dem Zustand-Store und können
     sich ändern, während das Menü offen ist (z. B. wenn dasselbe Konto auf
     einem anderen Gerät den Status ändert). Stünden sie hier, würde jede
     solche fremde Änderung mitten in der eigenen Eingabe das Feld
     überschreiben — genau das will dieser Effekt verhindern, siehe Kommentar
     oben. */
  useEffect(() => {
    if (!offen) return;
    setEntwurf(meinText ?? '');
    setZeichen(meinZeichen);
    setZeichenOffen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- meinText/meinZeichen bewusst draußen, siehe Kommentar oben
  }, [offen]);

  /*
   * Der Status folgt dem Fenster.
   *
   * Vorher hing er an einer Leerlaufuhr: alle 30 Sekunden nachsehen, ob seit
   * einer Weile nichts getippt wurde, und dann auf abwesend gehen. Das hatte
   * zwei Fehler. Der eine war die Unregelmäßigkeit — bis zu 30 Sekunden
   * Verzug, und weil der Server dieselbe Regel noch einmal für sich anwandte,
   * sprang der Status scheinbar willkürlich um. Der andere stand eine Zeile
   * tiefer: `visibilitychange` rief `beruehren()`, und das meldet ONLINE.
   * Wegklicken setzte die Leerlaufuhr also zurück, statt auf abwesend zu
   * gehen — genau verkehrt herum.
   *
   * Jetzt zählt nur noch, ob das Fenster vorn ist: vorn heißt online, weg
   * heißt sofort abwesend. Das ist die Regel, die jeder erwartet, und sie
   * braucht keine Uhr.
   *
   * Der kurze Aufschub ist kein Zögern, sondern nötig: beim Umschalten
   * zwischen Fenstern verliert das eigene für Sekundenbruchteile den Fokus,
   * bevor es ihn zurückbekommt. Ohne ihn flackerte der Status für alle
   * anderen sichtbar.
   */
  const autoStatus = self?.autoStatus !== false;
  useEffect(() => {
    if (!self || !autoStatus) return;

    /* Ausdrücklich mit "statusExpiresAt: null" — die Marke für „vom Wächter
       gemeldet, nicht vom Menschen gewählt". Der Server verwirft eine solche
       Meldung, solange ein selbst gesetzter Status seine Frist noch hat. */
    const melden = (status: UserStatus) => {
      socket.send({ t: 'presence:set', status, statusExpiresAt: null });
    };

    const vorn = () => document.visibilityState === 'visible' && document.hasFocus();
    let gemeldet: UserStatus | null = null;
    let aufschub = 0;

    const pruefen = () => {
      const soll: UserStatus = vorn() ? 'online' : 'away';
      if (soll === gemeldet) return;
      gemeldet = soll;
      melden(soll);
    };

    const spaeter = () => {
      window.clearTimeout(aufschub);
      aufschub = window.setTimeout(pruefen, 400);
    };

    for (const name of ['focus', 'blur'] as const) window.addEventListener(name, spaeter);
    document.addEventListener('visibilitychange', spaeter);
    pruefen();

    /*
     * Lebenszeichen, solange das Fenster vorn ist.
     *
     * Der Server hat eine eigene Leerlaufregel und schiebt nach einer Weile
     * ohne Nachricht auf abwesend. Ohne dieses Zeichen fiele jemand, der eine
     * lange Unterhaltung nur LIEST, nach ein paar Minuten auf abwesend —
     * obwohl er direkt davorsitzt. Eine Minute ist reichlich unter jeder
     * Leerlaufgrenze und kostet eine winzige Nachricht.
     */
    const puls = window.setInterval(() => { if (vorn()) melden('online'); }, 60_000);

    return () => {
      window.clearTimeout(aufschub);
      window.clearInterval(puls);
      for (const name of ['focus', 'blur'] as const) window.removeEventListener(name, spaeter);
      document.removeEventListener('visibilitychange', spaeter);
    };
  }, [self, autoStatus]);

  /* Wann endet, was gerade gilt? Nur anzeigen, solange es in der Zukunft liegt —
     eine abgelaufene Frist räumt der Server ohnehin gleich ab, und „für immer"
     ist kein Datum, das jemand lesen möchte. Der Tag steht nur dabei, wenn es
     ein anderer ist: „Endet 14:30" liest sich besser als „Endet Heute, 14:30". */
  const endet = useMemo(() => {
    if (!frist || frist >= NIE || frist <= Date.now()) return null;
    return sameDay(frist, Date.now())
      ? timeOfDay(frist)
      : `${dayLabel(frist)}, ${timeOfDay(frist)}`;
  }, [frist]);

  if (!self) return null;

  /**
   * Alles in einem Zug senden — Zustand, Zeichen, Text und Frist.
   *
   * Der Weg geht bewusst an store.setStatus vorbei: dessen Signatur kennt die
   * Frist nicht, und ohne sie legte der Server stumm seine eigene Regelfrist
   * darüber. Wer „1 Stunde" wählt, bekäme dann acht.
   */
  const senden = (
    status: UserStatus,
    emoji: string | null,
    text: string | null,
    bis: number | null,
  ) => {
    /* Ohne Frist gar kein Feld schicken: der Server unterscheidet "fehlt"
       (Mensch hat gewählt) von "null" (der Leerlaufwächter meldet). Eine
       ausdrückliche null hier hieße also das Gegenteil. */
    socket.send(bis === null
      ? { t: 'presence:set', status, statusEmoji: emoji, statusText: text }
      : { t: 'presence:set', status, statusEmoji: emoji, statusText: text, statusExpiresAt: bis });
    setEigeneFrist(bis);
  };

  /*
   * „Online" bekommt nie eine Frist.
   *
   * Es ist der Zustand, in den alles von selbst zurückfällt — ein Ablaufdatum
   * darauf hieße nur, den Leerlaufwächter für diese Zeit abzuschalten. Genau
   * so entsteht der Fehler, dass jemand grün leuchtet, während der Rechner
   * längst allein im Büro steht. Für alle anderen gilt die gewählte Dauer.
   */
  const fristFuer = (status: UserStatus) => (status === 'online' ? null : fristAus(dauer));

  /*
   * Ein Zustand — mit dem, was gerade im Feld darunter steht.
   *
   * Der Knopf ist damit auch der Absendeknopf: Vorschlag antippen, Zustand
   * antippen, fertig. Fasst niemand das Feld an, steht dort noch die bisherige
   * Meldung, und die bleibt dann unverändert stehen. Nur „online" räumt sie
   * ab — wer wieder erreichbar ist, will nicht, dass „📅 Besprechung" daneben
   * stehen bleibt.
   */
  const waehlen = (status: UserStatus) => {
    if (status === 'online') {
      setEntwurf('');
      setZeichen(null);
      senden(status, null, null, null);
    } else {
      senden(status, zeichen, entwurf.trim().slice(0, MELDUNG_MAX) || null, fristFuer(status));
    }
    schliessen();
  };

  const meldungSpeichern = () => {
    const text = entwurf.trim().slice(0, MELDUNG_MAX);
    if (!text && !zeichen) return;
    senden(aktuell, zeichen, text || null, fristFuer(aktuell));
    schliessen();
  };

  const meldungLoeschen = () => {
    setEntwurf('');
    setZeichen(null);
    senden(aktuell, null, null, fristFuer(aktuell));
    schliessen();
  };

  /* Nur füllen, nicht senden: was gleich hinausgeht, soll vorher im Menü
     stehen. Der Griff danach ist ein Zustand oben oder „übernehmen". */
  const vorschlagNehmen = (v: (typeof VORSCHLAEGE)[number]) => {
    setZeichen(v.emoji);
    setEntwurf(t(v.text));
    setZeichenOffen(false);
    feld.current?.focus();
  };

  return (
    <div className="statusmenue__anker">
      <button
        ref={ausloeser}
        className="statusmenue__ausloeser no-drag"
        aria-haspopup="menu"
        aria-expanded={offen}
        aria-label={t('status.title')}
        title={meinText ? `${meinZeichen ?? ''} ${meinText}`.trim() : self.displayName}
        onClick={(e) => { e.stopPropagation(); setOffen((v) => !v); }}
      >
        <Avatar user={self} size={34} showPresence status={aktuell} />
        {/* Ein Zeichen am Bild sagt schon von außen, dass eine Meldung steht —
            sonst müsste man das Menü öffnen, um es zu erfahren. */}
        {meinZeichen && <span className="statusmenue__marke" aria-hidden="true">{meinZeichen}</span>}
      </button>

      {offen && createPortal(
        <motion.div
          ref={menue}
          className="statusmenue"
          role="menu"
          aria-label={t('status.title')}
          style={{ left: ort?.left ?? -9999, top: ort?.top ?? -9999, maxHeight: ort?.maxHeight }}
          initial={{ opacity: 0, scale: 0.96 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="statusmenue__titel">{t('status.title')}</div>

          {/*
            Die Dauer steht über den Zuständen, nicht darunter: ein Griff auf
            einen Zustand schickt ihn sofort ab. Stünde die Wahl darunter, käme
            sie immer zu spät — man hätte schon gesendet, bevor man sie sieht.
          */}
          <label className="statusmenue__zeile statusmenue__dauer">
            <span className="statusmenue__dauername">{t('status.msgFor')}</span>
            <select
              className="select statusmenue__auswahl"
              value={dauer}
              onChange={(e) => dauerWaehlen(e.target.value as Dauer)}
            >
              {DAUERN.map((d) => <option key={d.wert} value={d.wert}>{t(d.name)}</option>)}
            </select>
          </label>

          {/* Direkt unter der Auswahl, die er erklärt — und ohne sie wörtlich zu
              wiederholen: über ihm steht schon „Gilt · 8 Stunden". */}
          <p className="statusmenue__hinweis">
            {t(DAUERN.find((d) => d.wert === dauer)?.satz ?? 'status.holds8h')}
          </p>

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

          <div className="statusmenue__trenner" />

          <div className="statusmenue__titel">{t('status.msgTitle')}</div>

          <div className="statusmenue__zeile">
            <button
              className="statusmenue__zeichenknopf"
              aria-label={t('status.msgEmoji')}
              aria-expanded={zeichenOffen}
              title={t('status.msgEmoji')}
              onClick={() => setZeichenOffen((v) => !v)}
            >
              {zeichen ?? <Smile size={16} />}
            </button>
            <input
              ref={feld}
              className="input statusmenue__feld"
              value={entwurf}
              maxLength={MELDUNG_MAX}
              placeholder={t('status.msgPlaceholder')}
              aria-label={t('status.msgTitle')}
              onChange={(e) => setEntwurf(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); meldungSpeichern(); } }}
            />
            {(entwurf || zeichen) && (
              <button
                className="statusmenue__zeichenknopf statusmenue__zeichenknopf--weg"
                aria-label={t('status.msgClear')}
                title={t('status.msgClear')}
                onClick={meldungLoeschen}
              ><X size={15} /></button>
            )}
          </div>

          {zeichenOffen && (
            <div className="statusmenue__zeichen" role="group" aria-label={t('status.msgEmoji')}>
              <button
                className="statusmenue__zeichenfeld"
                aria-label={t('status.msgNoEmoji')}
                title={t('status.msgNoEmoji')}
                onClick={() => { setZeichen(null); setZeichenOffen(false); }}
              ><X size={14} /></button>
              {ZEICHEN.map((z) => (
                <button
                  key={z}
                  className={`statusmenue__zeichenfeld${z === zeichen ? ' statusmenue__zeichenfeld--aktiv' : ''}`}
                  onClick={() => { setZeichen(z); setZeichenOffen(false); feld.current?.focus(); }}
                >{z}</button>
              ))}
            </div>
          )}

          <div className="statusmenue__vorschlaege">
            {VORSCHLAEGE.map((v) => (
              <button key={v.text} className="statusmenue__vorschlag" onClick={() => vorschlagNehmen(v)}>
                <span aria-hidden="true">{v.emoji}</span>
                <span>{t(v.text)}</span>
              </button>
            ))}
          </div>

          <div className="statusmenue__zeile">
            <button
              className="btn btn--primary statusmenue__uebernehmen"
              disabled={!entwurf.trim() && !zeichen}
              onClick={meldungSpeichern}
            >{t('status.msgSave')}</button>
          </div>

          {endet && <p className="statusmenue__hinweis">{t('status.msgEnds', { zeit: endet })}</p>}

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
