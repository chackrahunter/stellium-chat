import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowRight, Download, Loader2, RefreshCw, Sparkles, X } from 'lucide-react';
import { useStore } from '../state/store.js';
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
  const t = useT();
  const [stand, setStand] = useState<{ version: string; notes: string | null } | null>(null);

  useEffect(() => {
    void window.stellium?.lastUpdate?.().then((v) => { if (v) setStand(v); });
  }, []);

  if (!stand) return null;

  const punkte = (stand.notes ?? '')
    .split(/\n|(?<=[.!?])\s+(?=[A-ZÄÖÜ])/)
    .map((z) => z.replace(/^[-•*]\s*/, '').trim())
    .filter(Boolean);

  return (
    <div className="scrim scrim--center" onClick={() => setStand(null)}>
      <motion.div
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
