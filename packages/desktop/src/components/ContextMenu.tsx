import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { sichereRaender } from '../lib/klemmen.js';

/**
 * Kontextmenü für den Rechtsklick.
 *
 * Es positioniert sich am Mauszeiger und dreht sich um, wenn es sonst über den
 * Fensterrand hinausliefe — sonst wären die untersten Einträge unerreichbar.
 *
 * Gezeichnet wird es direkt am <body>, nicht dort, wo es im Baum steht. Grund:
 * die Seitenleiste hat einen backdrop-filter, und ein Filter macht das Element
 * zum Bezugsrahmen für alles darin, was "fixed" positioniert ist. Zusammen mit
 * ihrem overflow: hidden schnitt sie das Menü am eigenen Rand ab — sichtbar
 * blieben nur die Symbole und der erste Buchstabe.
 */

export interface MenuEintrag {
  id: string;
  label: string;
  icon?: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
  /** Trennlinie oberhalb dieses Eintrags. */
  trenner?: boolean;
}

export interface MenuPosition { x: number; y: number }

export function ContextMenu({ position, eintraege, onClose }: {
  position: MenuPosition;
  eintraege: MenuEintrag[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState(position);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const kasten = el.getBoundingClientRect();
    /* Kamera-Aussparung und Home-Leiste mitrechnen — sonst liegt das Menü im
       Querformat unter der Kamera bzw. in der Wischzone. */
    const rand = sichereRaender();
    let { x, y } = position;
    if (x + kasten.width > window.innerWidth - 8 - rand.rechts) {
      x = window.innerWidth - kasten.width - 8 - rand.rechts;
    }
    x = Math.max(8 + rand.links, x);
    if (y + kasten.height > window.innerHeight - 8 - rand.unten) {
      y = Math.max(8 + rand.oben, position.y - kasten.height);
    }
    setOrt({ x, y });
  }, [position]);

  useEffect(() => {
    const schliessen = () => onClose();
    const beiTaste = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    // Im nächsten Tick, sonst schließt der öffnende Klick sofort wieder.
    const timer = window.setTimeout(() => {
      window.addEventListener('click', schliessen);
      window.addEventListener('contextmenu', schliessen);
      window.addEventListener('resize', schliessen);
    }, 0);
    window.addEventListener('keydown', beiTaste, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener('click', schliessen);
      window.removeEventListener('contextmenu', schliessen);
      window.removeEventListener('resize', schliessen);
      window.removeEventListener('keydown', beiTaste, true);
    };
  }, [onClose]);

  return createPortal(
    <motion.div
      ref={ref}
      className="kontextmenue"
      style={{ left: ort.x, top: ort.y }}
      initial={{ opacity: 0, scale: 0.96 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.12, ease: [0.16, 1, 0.3, 1] }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); }}
    >
      {eintraege.map((e) => (
        <div key={e.id}>
          {e.trenner && <div className="kontextmenue__trenner" />}
          <button
            className={`kontextmenue__eintrag${e.danger ? ' kontextmenue__eintrag--danger' : ''}`}
            disabled={e.disabled}
            onClick={() => { if (!e.disabled) { e.onClick(); onClose(); } }}
          >
            <span className="kontextmenue__icon">{e.icon}</span>
            {e.label}
          </button>
        </div>
      ))}
    </motion.div>,
    document.body,
  );
}

/** Zustand für ein Kontextmenü — spart in jeder Komponente drei useState. */
export function useContextMenu<T>() {
  const [zustand, setZustand] = useState<{ position: MenuPosition; ziel: T } | null>(null);
  return {
    zustand,
    oeffnen: (e: React.MouseEvent, ziel: T) => {
      e.preventDefault();
      e.stopPropagation();
      setZustand({ position: { x: e.clientX, y: e.clientY }, ziel });
    },
    schliessen: () => setZustand(null),
  };
}
