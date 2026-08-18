import { useEffect, useRef, useState } from 'react';
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
}

export function EmojiPicker({ onPick, onClose }: Props) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);

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

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -6 }}
      transition={{ duration: 0.15 }}
      style={{
        position: 'absolute', top: 4, right: 'var(--sp-5)', zIndex: 20,
        width: 306, padding: 10, borderRadius: 'var(--r-lg)',
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
      <div style={{ maxHeight: 236, overflowY: 'auto' }}>
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
    </motion.div>
  );
}
