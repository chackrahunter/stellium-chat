import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { currentUiLanguage, useT } from '../i18n/index.js';
import { motion } from 'framer-motion';
import { Search, Sparkles, X } from 'lucide-react';
import { emojiSuchen, useEmojiKatalog } from '../emoji/katalog.js';

const GROUPS: { name: string; emoji: string[] }[] = [
  { name: 'emoji.frequent', emoji: ['👍', '🎉', '❤️', '😂', '👀', '🚀', '✅', '🔥', '🙏', '💡', '👏', '🤝'] },
  { name: 'emoji.faces', emoji: ['😀','😄','😊','🙂','😉','😍','🤔','😅','😬','😴','🥳','😎','🤯','😭','😤','🤗','🙃','😇'] },
  { name: 'emoji.gestures', emoji: ['👍','👎','👌','✌️','🤞','🙌','👋','🤙','💪','🫶','🤌','✍️'] },
  { name: 'emoji.work', emoji: ['💻','📱','📊','📈','📉','🗓️','📌','📎','✏️','🔧','⚙️','🧪','🐛','🚧','📦','🔍'] },
  { name: 'emoji.symbols', emoji: ['⭐','✨','💫','🌟','⚡','🔥','💧','🌈','🎯','🏆','🥇','💯','❗','❓','✔️','❌'] },
];

/** Was ein Klick auf "KI fragen" in der Auswahl anbietet — siehe MessageItem.tsx. */
interface KiNachfrage {
  /** null = noch nicht gefragt. Leeres Array = gefragt, nichts Passendes gefunden. */
  emojis: string[] | null;
  laeuft: boolean;
  anfordern: () => void;
}

interface Props {
  onPick: (emoji: string) => void;
  onClose: () => void;
  /** Element, an dem die Auswahl hängen soll — meist der Emoji-Knopf. */
  ankerRef?: React.RefObject<HTMLElement | null>;
  /**
   * Örtlich gefundene Vorschläge für die Nachricht, an der die Auswahl hängt
   * (siehe emoji/katalog.ts, emojiVorschlaege() — von MessageItem.tsx schon
   * berechnet und nur durchgereicht, damit es hier nicht zweimal passiert).
   * Ohne Nachrichtenbezug (z.B. eine künftige Auswahl im Composer) bleibt das
   * einfach weg — dann zeigt sich nur die gewohnte Liste.
   */
  vorschlaege?: string[];
  /** Auf Wunsch bei der KI nachfragen — nur gesetzt, wenn das überhaupt in Frage kommt (Recht vorhanden, Kanal nicht vertraulich). */
  kiNachfrage?: KiNachfrage;
}

const BREITE = 306;
const RAND = 10;

export function EmojiPicker({ onPick, onClose, ankerRef, vorschlaege, kiNachfrage }: Props) {
  const t = useT();
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const [ort, setOrt] = useState<{ left: number; top: number; hoehe: number } | null>(null);
  const katalog = useEmojiKatalog(currentUiLanguage());

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

  /*
   * Wirklich filtern, statt nur so zu tun: solange der Bestand für die
   * eingestellte Sprache noch nachlädt (erster Aufruf in dieser Sitzung,
   * dauert normalerweise nur wenige Millisekunden), bleibt die Liste
   * ungefiltert sichtbar — besser ein kurzer Moment mit zu vielen Treffern
   * als einer mit "nichts gefunden", obwohl gerade nur die Datei unterwegs
   * ist. emojiSuchen() selbst gleicht ohne Rücksicht auf Groß-/
   * Kleinschreibung, Umlaute und Akzente ab (siehe katalog.ts,
   * normalizeSuche) — "grussen" findet damit auch "grüßen".
   */
  const treffer = query.trim() && katalog ? emojiSuchen(katalog, query) : null;
  const groups = query.trim()
    ? [{
        name: 'emoji.hits',
        emoji: [...new Set(GROUPS.flatMap((g) => g.emoji))].filter((e) => !treffer || treffer.has(e)),
      }]
    : GROUPS;

  /*
   * Die Vorschlagszeile: örtliche Treffer zuerst, die (seltene) KI-Antwort
   * nur, wenn örtlich nichts da war. Nur außerhalb einer laufenden Suche —
   * wer schon tippt, sucht etwas Bestimmtes, keine Vorschläge zum Überfliegen.
   */
  const zeigeVorschlaege = !query.trim() && Boolean(vorschlaege?.length);
  const kiEmojis = kiNachfrage?.emojis;
  const zeigeKiErgebnis = !query.trim() && !vorschlaege?.length && Boolean(kiEmojis?.length);
  const zeigeKiKnopf = !query.trim() && !vorschlaege?.length && kiEmojis == null && Boolean(kiNachfrage);

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
          placeholder={t('emoji.search')}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
        />
        <button className="icon-btn icon-btn--sm" onClick={onClose} aria-label={t('common.close')}><X size={14} /></button>
      </div>

      {(zeigeVorschlaege || zeigeKiErgebnis || zeigeKiKnopf) && (
        <div style={{ marginBottom: 8 }}>
          <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', margin: '4px 2px' }}>
            {t('emoji.vorschlaege')}
          </div>
          {(zeigeVorschlaege || zeigeKiErgebnis) ? (
            <div style={{ display: 'flex', gap: 3 }}>
              {(zeigeVorschlaege ? vorschlaege! : kiEmojis!).map((e) => (
                <button
                  key={e}
                  onClick={() => onPick(e)}
                  style={{ fontSize: 22, padding: 6, borderRadius: 8, lineHeight: 1 }}
                  onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--bg-hover)'; }}
                  onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
                >{e}</button>
              ))}
            </div>
          ) : (
            /* Örtlich nichts gefunden — auf Wunsch (ein Klick, nie von selbst)
               die KI fragen. Nur eingeblendet, wenn der Aufrufer das anbietet:
               Recht vorhanden, Kanal nicht vertraulich (siehe MessageItem.tsx). */
            <button
              className="muted"
              style={{ fontSize: 12, padding: '4px 2px', display: 'flex', alignItems: 'center', gap: 5 }}
              disabled={kiNachfrage!.laeuft}
              onClick={kiNachfrage!.anfordern}
            >
              <Sparkles size={12} className={kiNachfrage!.laeuft ? 'spark' : undefined} />
              {kiNachfrage!.laeuft ? t('emoji.kiLaeuft') : t('emoji.kiFragen')}
            </button>
          )}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {groups.map((g) => (
          <div key={g.name} style={{ marginBottom: 8 }}>
            <div className="muted" style={{ fontSize: 10.5, fontWeight: 700, letterSpacing: '.07em', textTransform: 'uppercase', margin: '4px 2px' }}>
              {t(g.name as never)}
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
