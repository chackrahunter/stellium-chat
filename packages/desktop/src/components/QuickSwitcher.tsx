import { useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { Hash, Lock, Search, Sparkles } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { useT, t } from '../i18n/index.js';
import { kanalName } from '../lib/format.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo } from '../lib/format.js';

interface Item {
  id: string;
  kind: 'channel' | 'user' | 'action';
  title: string;
  sub: string;
  icon: React.ReactNode;
  run: () => void;
}

export function QuickSwitcher({ onClose }: { onClose: () => void }) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<Item[]>(() => {
    const store = useStore.getState();
    const out: Item[] = [];

    for (const c of Object.values(channels)) {
      if (c.kind === 'dm') continue;
      out.push({
        id: c.id, kind: 'channel', title: `#${kanalName(c)}`,
        sub: c.topic ?? (c.kind === 'private' ? t('channel.privateOne') : t('channel.publicOne')),
        icon: c.kind === 'private' ? <Lock size={16} className="muted" /> : <Hash size={16} className="muted" />,
        run: () => { store.openChannel(c.id); onClose(); },
      });
    }

    for (const u of Object.values(users)) {
      if (u.id === self?.id || u.disabled) continue;
      out.push({
        id: u.id, kind: 'user', title: u.displayName,
        sub: `@${u.handle} · ${languageInfo(u.language).native}${u.title ? ` · ${u.title}` : ''}`,
        icon: <Avatar user={u} size={24} showPresence />,
        run: () => { store.openDm(u.id); onClose(); },
      });
    }

    out.push(
      {
        id: 'act:catchup', kind: 'action', title: t('quick.catchup'),
        sub: t('quick.catchupHint'),
        icon: <Sparkles size={16} style={{ color: 'var(--violet-soft)' }} />,
        run: () => { if (activeChannelId) store.runCatchup(activeChannelId); onClose(); },
      },
      {
        id: 'act:search', kind: 'action', title: t('quick.search'),
        sub: t('quick.searchHint'),
        icon: <Search size={16} className="muted" />,
        run: () => { store.setOverlay('search'); },
      },
      {
        id: 'act:glossary', kind: 'action', title: t('quick.glossary'),
        sub: t('quick.glossaryHint'),
        icon: <Sparkles size={16} className="muted" />,
        run: () => { store.setOverlay('glossary'); },
      },
    );

    return out;
  }, [channels, users, self, activeChannelId, onClose]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^[#@]/, '');
    if (!q) return items.slice(0, 12);
    return items
      .map((item) => ({ item, score: score(item, q) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 14)
      .map((x) => x.item);
  }, [items, query]);

  useEffect(() => setIndex(0), [query]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [index]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => (i + 1) % Math.max(1, filtered.length)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => (i - 1 + filtered.length) % Math.max(1, filtered.length)); }
    if (e.key === 'Enter') { e.preventDefault(); filtered[index]?.run(); }
    if (e.key === 'Escape') onClose();
  };

  return (
    <div className="scrim" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={t('quick.placeholder')}
        className="panel"
        style={{ width: 'min(600px, 100%)' }}
        initial={{ opacity: 0, y: -14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -14, scale: 0.98 }}
        transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          className="omni-input"
          placeholder={t('quick.placeholder')}
          value={query}
          autoFocus
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="panel__body" ref={listRef} style={{ paddingTop: 0 }}>
          {filtered.length === 0 && <p className="muted" style={{ padding: 'var(--sp-4)' }}>{t('quick.nothingFound')}</p>}
          {filtered.map((item, i) => (
            <button
              key={item.id}
              className="result"
              data-active={i === index}
              onMouseEnter={() => setIndex(i)}
              onClick={item.run}
            >
              {item.icon}
              <div className="result__main">
                <div className="result__title">{item.title}</div>
                <div className="result__sub">{item.sub}</div>
              </div>
            </button>
          ))}
        </div>
        <div className="panel__foot">
          <span>{t('quick.navigate')}</span><span>·</span><span>{t('quick.open')}</span><span>·</span><span>{t('quick.close')}</span>
        </div>
      </motion.div>
    </div>
  );
}

/** Einfaches Fuzzy-Scoring: Präfix schlägt Wortanfang schlägt Teiltreffer. */
function score(item: Item, q: string): number {
  const title = item.title.toLowerCase().replace(/^[#@]/, '');
  const sub = item.sub.toLowerCase();
  if (title === q) return 100;
  if (title.startsWith(q)) return 80;
  if (title.split(/[\s-]/).some((w) => w.startsWith(q))) return 60;
  if (title.includes(q)) return 40;
  if (sub.includes(q)) return 20;
  return 0;
}
