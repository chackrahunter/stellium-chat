import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ArrowDown, Sparkles } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import type { Message } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { socket } from '../net/socket.js';
import { MessageItem } from './MessageItem.jsx';
import { dayLabel, sameDay } from '../lib/format.js';

interface Props {
  channelId: string;
}

/** Nachrichten desselben Autors innerhalb von 5 Minuten werden gruppiert. */
const GROUP_WINDOW_MS = 5 * 60_000;

export function MessageList({ channelId }: Props) {
  const messages = useStore((s) => s.messages[channelId]) ?? EMPTY;
  const hasMore = useStore((s) => s.hasMore[channelId] ?? false);
  const readMarker = useStore((s) => s.readMarkers[channelId] ?? null);
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
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [channelId]);

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
      if (el.scrollTop < 300 && hasMore) useStore.getState().loadOlder(channelId);
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
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <div className="stream" ref={scrollRef}>
      {hasMore && (
        <div style={{ textAlign: 'center', padding: 'var(--sp-3)' }}>
          <span className="muted" style={{ fontSize: 12 }}>Ältere Nachrichten werden geladen…</span>
        </div>
      )}
      {!hasMore && messages.length > 0 && <ChannelIntro channelId={channelId} />}

      {messages.map((msg, i) => {
        const prev = messages[i - 1];
        const showDay = !prev || !sameDay(prev.createdAt, msg.createdAt);
        const showUnread = readMarker != null && prev?.id === readMarker;
        const grouped = Boolean(
          prev && !showDay && !showUnread &&
          prev.userId === msg.userId &&
          !prev.systemKind && !msg.systemKind &&
          msg.createdAt - prev.createdAt < GROUP_WINDOW_MS,
        );

        return (
          <div key={msg.id}>
            {showDay && <div className="daybar"><span>{dayLabel(msg.createdAt)}</span></div>}
            {showUnread && <div className="unread-line"><span>Neu</span></div>}
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
            title="Zum Ende springen"
            style={{
              position: 'absolute', right: 26, bottom: 130, zIndex: 6,
              width: 38, height: 38,
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
        {channel.kind === 'dm' ? title : `Willkommen in ${title}`}
      </h2>
      <p className="muted" style={{ margin: 0, maxWidth: '62ch', fontSize: 14 }}>
        {channel.kind === 'dm'
          ? 'Das ist der Anfang eurer direkten Unterhaltung. Alles hier bleibt zwischen euch beiden.'
          : channel.topic || 'Hier beginnt der Kanal. Schreib die erste Nachricht — sie wird für alle automatisch in ihre Sprache übersetzt.'}
      </p>
    </div>
  );
}
