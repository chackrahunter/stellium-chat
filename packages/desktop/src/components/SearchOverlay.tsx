import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Bookmark, Filter, Languages, Loader2, Search, X } from 'lucide-react';
import type { Message } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { api } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { dayLabel, timeOfDay } from '../lib/format.js';

export function SearchOverlay({ onClose }: { onClose: () => void }) {
  const t = useT();
  const hits = useStore((s) => s.searchHits);
  const searching = useStore((s) => s.searching);
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);
  const activeChannelId = useStore((s) => s.activeChannelId);

  const [query, setQuery] = useState('');
  const [scopeChannel, setScopeChannel] = useState(false);
  const [tab, setTab] = useState<'search' | 'saved'>('search');
  const [saved, setSaved] = useState<Message[]>([]);

  useEffect(() => {
    if (tab !== 'search') return;
    const timer = window.setTimeout(() => {
      void useStore.getState().runSearch(query, scopeChannel ? activeChannelId : null);
    }, 240);
    return () => clearTimeout(timer);
  }, [query, scopeChannel, activeChannelId, tab]);

  useEffect(() => {
    if (tab !== 'saved') return;
    api.saved().then((r) => setSaved(r.messages)).catch(() => setSaved([]));
  }, [tab]);

  const jumpTo = (channelId: string) => {
    useStore.getState().openChannel(channelId);
    onClose();
  };

  return (
    <div className="scrim" onClick={onClose}>
      <motion.div
        className="panel panel--wide"
        initial={{ opacity: 0, y: -14, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -14, scale: 0.98 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="tabs">
          <button className="tab" aria-selected={tab === 'search'} onClick={() => setTab('search')}>Suche</button>
          <button className="tab" aria-selected={tab === 'saved'} onClick={() => setTab('saved')}>Gemerkt</button>
          <button className="icon-btn" style={{ marginLeft: 'auto', alignSelf: 'center' }} onClick={onClose}><X size={16} /></button>
        </div>

        {tab === 'search' && (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '0 var(--sp-5)' }}>
              <Search size={17} className="muted" />
              <input
                className="omni-input"
                style={{ padding: 'var(--sp-4) 0' }}
                placeholder={t('search.placeholder')}
                value={query}
                autoFocus
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}
              />
              {searching && <Loader2 size={16} className="spin muted" />}
            </div>

            <div style={{ display: 'flex', gap: 8, padding: '0 var(--sp-5) var(--sp-3)' }}>
              <button
                className="pill"
                aria-pressed={scopeChannel}
                onClick={() => setScopeChannel((v) => !v)}
              >
                <Filter size={12} />
                {scopeChannel ? `Nur #${channels[activeChannelId ?? '']?.name ?? 'aktueller Kanal'}` : 'Alle Kanäle'}
              </button>
              <span className="muted" style={{ fontSize: 12, alignSelf: 'center' }}>
                {query.length >= 2 && `${hits.length} Treffer`}
              </span>
            </div>

            <div className="panel__body" style={{ paddingTop: 0 }}>
              {query.length < 2 && (
                <p className="muted" style={{ fontSize: 13.5 }}>
                  {t('search.minChars')}
                </p>
              )}
              {hits.map((hit) => {
                const author = users[hit.message.userId];
                const channel = channels[hit.channelId];
                return (
                  <button key={hit.message.id} className="result" onClick={() => jumpTo(hit.channelId)}>
                    <Avatar user={author} size={30} />
                    <div className="result__main">
                      <div className="result__title">
                        {author?.displayName ?? 'Unbekannt'}
                        <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                          {channel?.kind === 'dm' ? 'DM' : `#${channel?.name}`} · {dayLabel(hit.message.createdAt)} {timeOfDay(hit.message.createdAt)}
                        </span>
                        {hit.matchedTranslation && (
                          <span className="msg__tag" style={{ marginLeft: 8 }}>
                            <Languages size={9} style={{ verticalAlign: -1 }} /> Übersetzung
                          </span>
                        )}
                      </div>
                      <div
                        className="result__sub"
                        style={{ whiteSpace: 'normal' }}
                        dangerouslySetInnerHTML={{ __html: sanitizeSnippet(hit.snippet) }}
                      />
                    </div>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {tab === 'saved' && (
          <div className="panel__body">
            {saved.length === 0 && (
              <p className="muted" style={{ fontSize: 13.5 }}>
                <Bookmark size={14} style={{ verticalAlign: -2 }} /> {t('search.nothingSaved')}
              </p>
            )}
            {saved.map((msg) => {
              const author = users[msg.userId];
              const channel = channels[msg.channelId];
              return (
                <button key={msg.id} className="result" onClick={() => jumpTo(msg.channelId)}>
                  <Avatar user={author} size={30} />
                  <div className="result__main">
                    <div className="result__title">
                      {author?.displayName}
                      <span className="muted" style={{ fontWeight: 400, marginLeft: 8, fontSize: 12 }}>
                        {channel?.kind === 'dm' ? 'DM' : `#${channel?.name}`}
                      </span>
                    </div>
                    <div className="result__sub" style={{ whiteSpace: 'normal' }}>{msg.text.slice(0, 220)}</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </motion.div>
    </div>
  );
}

/**
 * Der Server liefert Snippets mit <em>-Markierungen. Alles andere wird
 * escaped, damit fremder Nachrichtentext niemals als Markup landet.
 */
function sanitizeSnippet(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped.replace(/&lt;em&gt;/g, '<em>').replace(/&lt;\/em&gt;/g, '</em>');
}
