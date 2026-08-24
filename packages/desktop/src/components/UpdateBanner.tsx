import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Download, Loader2, RefreshCw, Server, Sparkles, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { useT } from '../i18n/index.js';

/**
 * Hinweis auf eine neue Version — sichtbar, sobald jemand eine hochgeladen
 * hat, und nicht erst beim nächsten Blick in die Einstellungen.
 *
 * Bewusst als schmaler Streifen über dem Chat statt als Fenster in der Mitte:
 * ein Update ist wichtig, aber nie so wichtig wie das Gespräch, in dem gerade
 * jemand steckt.
 */
/** "4:37" statt "277 Sekunden" — das liest sich nebenbei. */
function restZeit(sekunden: number): string {
  const m = Math.floor(sekunden / 60);
  const s = sekunden % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s} s`;
}

export function UpdateBanner() {
  const t = useT();
  const update = useStore((s) => s.update);
  const { installUpdate, postponeUpdate } = useStore.getState();
  const [weggeklickt, setWeggeklickt] = useState<string | null>(null);

  // Eine neuere Version bringt den Hinweis zurück, auch wenn die vorige
  // weggeklickt wurde.
  useEffect(() => {
    if (update.version && weggeklickt && update.version !== weggeklickt) setWeggeklickt(null);
  }, [update.version, weggeklickt]);

  // Läuft die Uhr, bleibt der Hinweis stehen — man soll nicht überrascht
  // werden, wenn die App gleich neu startet. Wer ihn loswerden will, drückt
  // "Später"; dann verschwindet er, und installiert wird beim Beenden.
  const zeigen = (update.zustand === 'gefunden' || update.zustand === 'laedt'
    || update.zustand === 'installiert'
    || (update.zustand === 'bereit' && (!!update.restSekunden || update.version !== weggeklickt)));

  return (
    <AnimatePresence>
      {zeigen && (
        <motion.div
          className="update-band"
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        >
          <div className="update-band__inner">
            <motion.span
              className="update-band__icon"
              animate={update.zustand === 'bereit' ? { rotate: [0, 12, -12, 0] } : {}}
              transition={{ duration: 2.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              {update.zustand === 'laedt' ? <Download size={15} />
                : update.zustand === 'installiert' ? <Loader2 size={15} className="spin" />
                  : update.zustand === 'bereit' ? <Sparkles size={15} />
                    : <RefreshCw size={15} />}
            </motion.span>

            <span className="update-band__text">
              {update.zustand === 'gefunden' && t('update.bandFound', { version: update.version ?? '' })}
              {update.zustand === 'laedt' && t('update.bandLoading', {
                version: update.version ?? '', prozent: Math.round((update.anteil ?? 0) * 100),
              })}
              {update.zustand === 'bereit' && (
                update.restSekunden
                  ? t('update.bandCountdown', {
                    version: update.version ?? '',
                    zeit: restZeit(update.restSekunden),
                  })
                  : update.verschoben
                    ? t('update.bandPostponed', { version: update.version ?? '' })
                    : t('update.bandReady', { version: update.version ?? '' })
              )}
              {update.zustand === 'installiert' && t('update.bandInstalling')}
              {update.notes && update.zustand === 'bereit' && (
                <span className="update-band__notes"> — {update.notes}</span>
              )}
            </span>

            {update.zustand === 'laedt' && (
              <span className="update-band__bar">
                <motion.span
                  animate={{ width: `${(update.anteil ?? 0) * 100}%` }}
                  transition={{ duration: 0.3 }}
                />
              </span>
            )}

            {update.zustand === 'bereit' && (
              <>
                {!update.verschoben && (
                  <button className="btn btn--sm" onClick={postponeUpdate}>
                    {t('update.bandPostpone')}
                  </button>
                )}
                <button className="btn btn--primary btn--sm" onClick={installUpdate}>
                  {t('update.bandInstall')} <ArrowRight size={13} />
                </button>
              </>
            )}

            {update.zustand !== 'installiert' && (
              <button
                className="icon-btn icon-btn--sm"
                title={t('update.bandLater')}
                aria-label={t('update.bandLater')}
                onClick={() => setWeggeklickt(update.version ?? null)}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Was sich mit dem letzten Update geändert hat — einmalig nach dem Neustart.
 * Der Vermerk wird beim Abholen gelöscht, deshalb erscheint er genau einmal.
 */
export function UpdateWillkommen() {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, () => setStand(null));
  const t = useT();
  const [stand, setStand] = useState<{ version: string; notes: string | null } | null>(null);

  useEffect(() => {
    // Zwei getrennte Fälle, nicht einer — beide sahen vorher gleich aus
    // (gar nichts passierte), waren es aber nicht:
    //
    // 1) Die Brücke fehlt (`lastUpdate` ist `undefined` — reiner
    //    Browser-Build ohne window.stellium, oder eine ältere App-Fassung,
    //    die diesen Aufruf noch nicht kannte). `?.` an DIESER Stelle kürzt
    //    dann die GESAMTE restliche Kette ab, einschließlich eines
    //    angehängten `.then()` — ein `.catch()` danach würde nie erreicht,
    //    weil die Kette schon vorher als `undefined` ausgewertet wird und
    //    gar nicht erst bei `.then()`/`.catch()` ankommt. Deshalb hier vorab
    //    geprüft und mit `return` beendet, statt auf ein Catch zu hoffen,
    //    das nie zum Zug käme.
    // 2) Die Brücke ist da, aber der Aufruf schlägt fehl (IPC-Problem im
    //    Hauptprozess). Das ist ein echter Fehlschlag und verdient ein
    //    `.catch()` — vorher war er unbehandelt, eine Ablehnung sah exakt
    //    wie "nichts Neues zu zeigen" aus.
    const lastUpdate = window.stellium?.lastUpdate;
    if (!lastUpdate) return; // Fall 1 — kein Fehler, nur nichts zu holen.
    void lastUpdate()
      .then((v) => { if (v) setStand(v); })
      .catch((fehler) => {
        // Still bleibt hier trotzdem richtig: diese Karte ist eine
        // Kür ("was hat sich getan"), keine Pflicht — niemand wartet aktiv
        // auf sie, und ein Toast für ihr Ausbleiben wäre lauter als ihr
        // Inhalt. console.warn reicht, damit es beim Entwickeln auffällt
        // (dieselbe Bauart wie lib/benachrichtigung.ts, `pushAbonnieren()`).
        console.warn('[update] letzter Update-Stand nicht abrufbar:', (fehler as Error).message);
      });
  }, []);

  if (!stand) return null;

  const punkte = (stand.notes ?? '')
    .split(/\n|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/)
    .map((z) => z.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

  return (
    <div className="scrim scrim--center" onClick={() => setStand(null)}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={t('update.welcomeTitle', { version: stand.version })}
        className="panel"
        style={{ width: 'min(480px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96 }}
        transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="neu">
          <motion.span
            className="neu__stern"
            initial={{ scale: 0.4, rotate: -30 }}
            animate={{ scale: 1, rotate: 0 }}
            transition={{ type: 'spring', stiffness: 260, damping: 16 }}
          >
            <Sparkles size={26} />
          </motion.span>

          <h2 className="neu__titel">{t('update.welcomeTitle', { version: stand.version })}</h2>
          <p className="neu__text">{t('update.welcomeText')}</p>

          {punkte.length > 0 && (
            <ul className="neu__liste">
              {punkte.map((p, i) => (
                <motion.li
                  key={i}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: 0.08 + i * 0.06 }}
                >{p}</motion.li>
              ))}
            </ul>
          )}

          <button className="btn btn--primary btn--block" onClick={() => setStand(null)}>
            {t('update.welcomeOk')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/**
 * Der Server aktualisiert sich gleich — sichtbar für alle, mit derselben Uhr.
 *
 * Bewusst nicht wegklickbar: anders als bei einem Update der eigenen App kann
 * hier niemand etwas entscheiden. Es passiert, und wer gerade schreibt, soll
 * es vorher wissen statt mitten im Satz die Verbindung zu verlieren.
 */
export function ServerWartung() {
  const t = useT();
  const wartung = useStore((s) => s.serverUpdate);
  const [jetzt, setJetzt] = useState(Date.now());

  useEffect(() => {
    if (!wartung) return undefined;
    const uhr = setInterval(() => setJetzt(Date.now()), 1000);
    return () => clearInterval(uhr);
  }, [wartung]);

  if (!wartung) return null;

  const bisStart = Math.max(0, wartung.startetUm - jetzt);
  const laeuft = bisStart === 0;
  const vorbei = jetzt > wartung.startetUm + wartung.dauertEtwa;
  if (vorbei) return null;

  const minuten = Math.floor(bisStart / 60000);
  const sekunden = Math.floor((bisStart % 60000) / 1000);
  const zeit = minuten > 0 ? `${minuten}:${String(sekunden).padStart(2, '0')}` : `${sekunden} s`;
  const dauer = Math.max(1, Math.round(wartung.dauertEtwa / 60000));

  return (
    <motion.div
      className="wartung"
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
    >
      <div className="wartung__inner">
        <motion.span
          className="wartung__icon"
          animate={laeuft ? { rotate: 360 } : { scale: [1, 1.08, 1] }}
          transition={laeuft
            ? { duration: 1.6, repeat: Infinity, ease: 'linear' }
            : { duration: 2.2, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Server size={15} />
        </motion.span>

        <span className="wartung__text">
          {laeuft
            ? t('wartung.laeuft', { dauer })
            : t('wartung.countdown', { zeit, dauer })}
          {wartung.notes && <span className="wartung__notes"> — {wartung.notes.split('\n')[0]}</span>}
        </span>

        {/* Ein Balken, der zur vollen Länge zusammenläuft: man sieht auf einen
            Blick, wie viel Zeit noch bleibt, ohne die Zahl zu lesen. */}
        {!laeuft && (
          <span className="wartung__bar">
            <span style={{ width: `${Math.min(100, (1 - bisStart / (15 * 60000)) * 100)}%` }} />
          </span>
        )}
      </div>
    </motion.div>
  );
}
