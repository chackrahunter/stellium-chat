import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import { Search, X } from 'lucide-react';

const GROUPS: { name: string; emoji: string[] }[] = [
  { name: 'Häufig', emoji: ['👍', '🎉', '❤️', '😂', '👀', '🚀', '✅', '🔥', '🙏', '💡', '👏', '🤝'] },
  { name: 'Gesichter', emoji: ['😀','😄','😊','🙂','😉','😍','🤔','😅','😬','😴','🥳','😎','🤯','😭','😤','🤗','🙃','😇'] },
  { name: 'Gesten', emoji: ['👍','👎','👌','✌️','🤞','🙌','👋','🤙','💪','🫶','🤌','✍️'] },
  { name: 'Arbeit', emoji: ['💻','📱','📊','📈','📉','🗓️','📌','📎','✏️','🔧','⚙️','🧪','🐛','🚧','📦','🔍'] },
  { name: 'Symbole', emoji: ['⭐','✨','💫','🌟','⚡','🔥','💧','🌈','🎯','🏆','🥇','💯','❗','❓','✔️','❌'] },
];

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Element, an dem die Auswahl hängen soll — meist der Emoji-Knopf. */
  ankerRef?: React.RefObject<HTMLElement | null>;
}

const BREITE = 306;
const RAND = 10;

export function EmojiPicker({ onPick, onClose, ankerRef }: Props) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number; hoehe: number } | null>(null);

  /* Am Anker ausrichten und dabei im Fenster bleiben.
     Vorher hing die Auswahl absolut im Eingabebereich und lief unten aus dem
     Bild — sichtbar war dann nur die erste Reihe. */
  useLayoutEffect(() => {
    const anker = ankerRef?.current?.getBoundingClientRect();
    const fensterH = window.innerHeight;
    const fensterB = window.innerWidth;

    // Über dem Knopf ist fast immer mehr Platz als darunter: die Leiste sitzt
    // am unteren Rand.
    const obenFrei = (anker?.top ?? fensterH) - RAND * 2;
    const untenFrei = fensterH - (anker?.bottom ?? 0) - RAND * 2;
    const nachOben = obenFrei >= Math.min(340, untenFrei) || obenFrei > untenFrei;

    const hoehe = Math.max(180, Math.min(380, nachOben ? obenFrei : untenFrei));
    const top = nachOben
      ? Math.max(RAND, (anker?.top ?? fensterH) - hoehe - 8)
      : Math.min(fensterH - hoehe - RAND, (anker?.bottom ?? 0) + 8);

    const links = anker
      ? Math.min(fensterB - BREITE - RAND, Math.max(RAND, anker.left - BREITE / 2 + anker.width / 2))
      : (fensterB - BREITE) / 2;

    setOrt({ left: links, top, hoehe });
  }, [ankerRef]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('keydown', onKey);
    // Im nächsten Tick, sonst schließt der eigene Öffnen-Klick sofort wieder.
    const timer = window.setTimeout(() => document.addEventListener('mousedown', onClick), 0);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
      clearTimeout(timer);
    };
  }, [onClose]);

  const groups = query.trim()
    ? [{ name: 'Treffer', emoji: GROUPS.flatMap((g) => g.emoji) }]
    : GROUPS;

  // Am <body>, nicht dort wo es im Baum steht: der Eingabebereich hat einen
  // backdrop-filter, und der macht jede feste Positionierung darin zunichte.
  return createPortal(
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.96, y: 6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: 6 }}
      transition={{ duration: 0.15 }}
      style={{
        position: 'fixed',
        left: ort?.left ?? -9999,
        top: ort?.top ?? -9999,
        zIndex: 90,
        width: BREITE, padding: 10, borderRadius: 'var(--r-lg)',
        display: 'flex', flexDirection: 'column',
        maxHeight: ort?.hoehe ?? 340,
        background: 'var(--bg-elevated)', border: '1px solid var(--line-strong)',
        boxShadow: 'var(--shadow-lg)', backdropFilter: 'blur(24px)',
      }}
    >
      <div className="hstack gap-2" style={{ marginBottom: 8 }}>
        <Search size={14} className="muted" />
        <input
          className="input"
          style={{ padding: '5px 9px', fontSize: 13 }}
          placeholder="Emoji suchen…"
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="icon-btn icon-btn--sm" onClick={onClose}><X size={14} /></button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {groups.map((g) => (
          <div key={g.name} style={{ marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', margin: '4px 2px' }}>
              {g.name}
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(8, 1fr)', gap: 2 }}>
              {g.emoji.map((e) => (
                <button
                  key={e}
                  onClick={() => onPick(e)}
                  style={{ fontSize: 19, padding: 5, borderRadius: 8, lineHeight: 1 }}
                  onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
                >{e}</button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </motion.div>,
    document.body,
  );
}
