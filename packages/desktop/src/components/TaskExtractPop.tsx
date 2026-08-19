import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Check, ListChecks, Loader2, Undo2 } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';

const BREITE = 300;
const RAND = 10;

/**
 * Rückmeldung der Aufgabenerkennung, direkt unter ihrem Knopf.
 *
 * Früher öffnete sich hier ein Fenster mit Kästchen zum Ankreuzen. Die
 * Aufgaben entstehen jetzt von selbst; hier steht nur noch, was daraus
 * geworden ist — mit einem Weg zurück, falls es daneben lag.
 */
export function TaskExtractPop({ ankerRef, onClose }: {
  ankerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const t = useT();
  const laeuft = useStore((s) => s.extractingTasks);
  const ergebnis = useStore((s) => s.extractErgebnis);
  const ref = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number } | null>(null);

  /* Am Kopfbereich hängt ein backdrop-filter — darin wäre selbst „fixed“
     relativ zum Kopf statt zum Fenster. Darum am <body>, von Hand platziert. */
  useLayoutEffect(() => {
    const anker = ankerRef.current?.getBoundingClientRect();
    if (!anker) return;
    setOrt({
      left: Math.min(window.innerWidth - BREITE - RAND, Math.max(RAND, anker.right - BREITE)),
      top: Math.min(window.innerHeight - 120, anker.bottom + 8),
    });
  }, [ankerRef, laeuft, ergebnis]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey, true);
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  /* Wenn nichts gefunden wurde, muss man das nicht wegklicken. */
  const leer = !laeuft && ergebnis && !ergebnis.erstellt.length;
  useEffect(() => {
    if (!leer) return;
    const timer = window.setTimeout(onClose, 3200);
    return () => clearTimeout(timer);
  }, [leer, onClose]);

  const anzahl = ergebnis?.erstellt.length ?? 0;

  return createPortal(
    <motion.div
      ref={ref}
      className="extract-pop"
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -6 }}
      transition={{ duration: 0.15 }}
      style={{ left: ort?.left ?? -9999, top: ort?.top ?? -9999, width: BREITE }}
    >
      {laeuft && (
        <div className="extract-pop__zeile">
          <Loader2 size={15} className="spin" />
          <span>{t('ai.extractRunning')}</span>
        </div>
      )}

      {!laeuft && ergebnis && (
        <>
          <div className="extract-pop__zeile extract-pop__kopf">
            {anzahl ? <Check size={15} className="ok" /> : <ListChecks size={15} className="muted" />}
            <strong>
              {anzahl
                ? t(anzahl === 1 ? 'ai.extractOneAdded' : 'ai.extractAdded', { n: anzahl })
                : t('ai.extractEmpty')}
            </strong>
          </div>

          {anzahl > 0 && (
            <ul className="extract-pop__liste">
              {ergebnis.erstellt.slice(0, 6).map((a) => (
                <li key={a.id}>{a.title}</li>
              ))}
              {anzahl > 6 && <li className="muted">{t('ai.extractMore', { n: anzahl - 6 })}</li>}
            </ul>
          )}

          {ergebnis.uebersprungen > 0 && (
            <p className="extract-pop__hinweis">{t('ai.extractSkipped', { n: ergebnis.uebersprungen })}</p>
          )}

          {anzahl > 0 && (
            <div className="extract-pop__fuss">
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => { useStore.getState().extractRueckgaengig(); onClose(); }}
              >
                <Undo2 size={13} /> {t('common.undo')}
              </button>
              <button
                className="btn btn--sm"
                onClick={() => { useStore.getState().setOverlay('tasks'); onClose(); }}
              >
                {t('ai.extractOpenBoard')}
              </button>
            </div>
          )}
        </>
      )}
    </motion.div>,
    document.body,
  );
}
