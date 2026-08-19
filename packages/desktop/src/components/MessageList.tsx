import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Message } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT, t } from '../i18n/index.js';
import { socket } from '../net/socket.js';
import { MessageItem } from './MessageItem.jsx';
import { dayLabel, kanalThema, sameDay } from '../lib/format.js';

interface Props {
  channelId: string;
}

/** Nachrichten desselben Autors innerhalb von 5 Minuten werden gruppiert. */
const GROUP_WINDOW_MS = 5 * 60_000;

/**
 * Wie viele Nachrichten gleichzeitig im Dokument stehen.
 *
 * Jede Nachricht ist ein gutes Dutzend Knoten — mit Bild, Reaktionen, Umfrage
 * oder Vorschau schnell fünfzig. Bei tausend Nachrichten sind das
 * zehntausende, und der Browser trägt sie alle mit: Speicher, Layout,
 * Neuzeichnen. Sichtbar sind davon nie mehr als zwanzig.
 *
 * Deshalb ein Fenster: gezeigt wird das jüngste Stück, beim Hochscrollen
 * wächst es. Wer wirklich weit zurückgeht, bekommt mehr — wer nur mitliest,
 * zahlt nichts dafür.
 */
const FENSTER_ANFANG = 80;
const FENSTER_SCHRITT = 80;

export function MessageList({ channelId }: Props) {
  const imSpeicher = useStore((s) => s.messages[channelId]) ?? EMPTY;
  const [fenster, setFenster] = useState(FENSTER_ANFANG);
  /* Antworten in einem Thread gehören in den Thread-Bereich, nicht hierher.
     Der Speicher hält sie schon nicht mehr in dieser Liste — dieser Filter ist
     der zweite Riegel: in den Verlauf schreiben mehrere Ereignisse hinein, und
     ein einziges übersehenes davon reichte, damit eine Antwort wieder doppelt
     erschiene. Was der Server im Kanalverlauf ausschließt, schließt die
     Anzeige auch aus. */
  const alle = useMemo(() => imSpeicher.filter((m) => !m.parentId), [imSpeicher]);
  const messages = useMemo(
    () => (alle.length > fenster ? alle.slice(-fenster) : alle),
    [alle, fenster],
  );
  const mehrImSpeicher = alle.length > messages.length;
  const hasMore = useStore((s) => s.hasMore[channelId] ?? false);
  const readMarker = useStore((s) => s.readMarkers[channelId] ?? null);
  const selfId = useStore((s) => s.self?.id ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);
  const [atBottom, setAtBottom] = useState(true);
  const prevHeight = useRef(0);
  const prevCount = useRef(0);

  // Beim Kanalwechsel ans Ende springen.
  useLayoutEffect(() => {
    stickToBottom.current = true;
    setAtBottom(true);
    prevCount.current = 0;
    setFenster(FENSTER_ANFANG);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    // Bilder und Vorschaukarten laden nachträglich und ändern die Höhe —
    // deshalb kurz danach noch einmal nachfassen.
    const settle = window.setTimeout(() => {
      const node = scrollRef.current;
      if (node && stickToBottom.current) node.scrollTop = node.scrollHeight;
    }, 120);
    return () => clearTimeout(settle);
  }, [channelId]);

  // Nachladende Inhalte (Bilder, Link-Vorschauen, Transkripte) verschieben
  // die Höhe. Solange der Blick unten hängt, bleibt er unten.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [channelId, messages.length]);

  // Neue Nachrichten: nur nachscrollen, wenn der Nutzer unten steht.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grewAtTop = messages.length > prevCount.current && prevCount.current > 0
      && el.scrollTop < 200 && el.scrollHeight > prevHeight.current + 200;

    if (grewAtTop) {
      // Ältere Seite geladen — Position halten, statt zu springen.
      el.scrollTop = el.scrollHeight - prevHeight.current;
    } else if (stickToBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
    prevHeight.current = el.scrollHeight;
    prevCount.current = messages.length;
  }, [messages]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      const near = distance < 120;
      stickToBottom.current = near;
      setAtBottom((prev) => (prev === near ? prev : near));
      if (el.scrollTop < 300) {
        // Erst das Fenster öffnen — was schon im Speicher liegt, muss nicht
        // noch einmal über die Leitung.
        if (mehrImSpeicher) setFenster((f) => f + FENSTER_SCHRITT);
        else if (hasMore) useStore.getState().loadOlder(channelId);
      }
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [channelId, hasMore]);

  // Gelesen melden, sobald das Fenster den Fokus hat.
  useEffect(() => {
    const last = messages[messages.length - 1];
    if (!last || !document.hasFocus()) return;
    const timer = window.setTimeout(() => {
      socket.send({ t: 'read', channelId, lastMessageId: last.id });
    }, 400);
    return () => clearTimeout(timer);
  }, [messages, channelId]);

  const jumpDown = () => {
    stickToBottom.current = true;
    setAtBottom(true);
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  };

  return (
    <div
      className="stream"
      ref={scrollRef}
      /* Auf dem Telefon nimmt die Tastatur die halbe Höhe ein und lässt sich
         nur über die Systemgeste schließen. Wer den Verlauf anfasst, will
         lesen — also fährt sie dabei ein, wie in jeder Nachrichten-App. */
      onTouchStart={() => {
        const el = document.activeElement as HTMLElement | null;
        if (el && (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT')) el.blur();
      }}
    >
      {mehrImSpeicher && (
        <div style={{ textAlign: 'center', padding: 'var(--sp-3)' }}>
          <button
            className="btn btn--ghost"
            style={{ fontSize: 12 }}
            onClick={() => setFenster((f) => f + FENSTER_SCHRITT)}
          >
            {t('msg.showOlder')}
          </button>
        </div>
      )}
      {!mehrImSpeicher && hasMore && (
        <div style={{ textAlign: 'center', padding: 'var(--sp-3)' }}>
          <span className="muted" style={{ fontSize: 12 }}>{t('msg.loadingOlder')}</span>
        </div>
      )}
      {!mehrImSpeicher && !hasMore && messages.length > 0 && <ChannelIntro channelId={channelId} />}

      {messages.map((msg, i) => {
        const prev = messages[i - 1];
        const showDay = !prev || !sameDay(prev.createdAt, msg.createdAt);
        /* Die eigene Nachricht ist für einen selbst nie neu. Vorher zog der
           Strich „NEU" auch unter das, was man gerade eben getippt hatte —
           der Lesestand rückt erst nach, wenn der Server ihn bestätigt. */
        const showUnread = readMarker != null && prev?.id === readMarker
          && msg.userId !== selfId;
        const grouped = Boolean(
          prev && !showDay && !showUnread &&
          prev.userId === msg.userId &&
          !prev.systemKind && !msg.systemKind &&
          msg.createdAt - prev.createdAt < GROUP_WINDOW_MS,
        );

        return (
          <div key={msg.id}>
            {showDay && <div className="daybar"><span>{dayLabel(msg.createdAt)}</span></div>}
            {showUnread && <div className="unread-line"><span>{t('msg.unreadLine')}</span></div>}
            <MessageItem message={msg} grouped={grouped} />
          </div>
        );
      })}

      <div ref={bottomRef} style={{ height: 1 }} />

      <AnimatePresence>
        {!atBottom && messages.length > 0 && (
          <motion.button
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.85 }}
            className="icon-btn"
            onClick={jumpDown}
            title={t('chat.toBottom')}
            /* Klebt am unteren Rand der Liste, nicht am Hauptbereich.
               Vorher maß `bottom: 130` vom Fuß des gesamten Bereichs — der
               Knopf lag damit über dem Eingabefeld und fing dort Klicks ab. */
            style={{
              position: 'sticky', alignSelf: 'flex-end', bottom: 12,
              marginInlineEnd: 26, marginTop: -38, zIndex: 6,
              width: 38, height: 38, flex: '0 0 auto',
              background: 'var(--bg-elevated)', border: '1px solid var(--line-strong)',
              boxShadow: 'var(--shadow-md)',
            }}
          >
            <ArrowDown size={17} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}

const EMPTY: Message[] = [];

function ChannelIntro({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId]);
  const users = useStore((s) => s.users);
  if (!channel) return null;

  const title = channel.kind === 'dm'
    ? users[channel.dmPeerId ?? '']?.displayName ?? 'Direktnachricht'
    : `#${channel.name}`;

  return (
    <div style={{ padding: 'var(--sp-6) var(--sp-5) var(--sp-4)' }}>
      <div
        style={{
          width: 54, height: 54, borderRadius: 17, marginBottom: 'var(--sp-3)',
          background: 'var(--grad-nebula)', display: 'grid', placeItems: 'center',
          boxShadow: 'var(--glow)',
        }}
      >
        <Sparkles size={24} color="#fff" />
      </div>
      <h2 style={{ margin: '0 0 6px', fontSize: 23, fontWeight: 800, letterSpacing: '-.03em' }}>
        {channel.kind === 'dm' ? title : t('chat.welcomeTo', { kanal: title })}
      </h2>
      <p className="muted" style={{ margin: 0, maxWidth: '62ch', fontSize: 14 }}>
        {channel.kind === 'dm'
          ? t('chat.dmStart')
          : kanalThema(channel) || t('chat.channelStart')}
      </p>
    </div>
  );
}
