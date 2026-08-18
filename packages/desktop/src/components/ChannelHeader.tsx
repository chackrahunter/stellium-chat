import { useState } from 'react';
import {
  Hash, Info, Languages, Lock, MessageSquareText, Pin, Sparkles, Users, X,
} from 'lucide-react';
import { LANGUAGES, normalizeLang } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo, localTimeFor } from '../lib/format.js';

export function ChannelHeader({ channelId }: { channelId: string }) {
  const channel = useStore((s) => s.channels[channelId]);
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const { runCatchup, setOverlay, updateChannel, updatePrefs, loadSmartReplies } = useStore.getState();
  const [langOpen, setLangOpen] = useState(false);

  if (!channel) return null;

  const peer = channel.kind === 'dm' ? users[channel.dmPeerId ?? ''] : null;
  const peerTime = peer ? localTimeFor(peer.timezone) : null;

  return (
    <header className="header drag-region">
      <div className="header__title no-drag">
        {channel.kind === 'dm'
          ? <Avatar user={peer} size={28} showPresence />
          : channel.kind === 'private' ? <Lock size={17} className="muted" /> : <Hash size={17} className="muted" />}
        <h1>{channel.kind === 'dm' ? peer?.displayName ?? 'Direktnachricht' : channel.name}</h1>
        {peer && peerTime?.time && (
          <span className="header__topic" title={`Ortszeit von ${peer.displayName}`}>
            {peerTime.offHours ? '🌙' : '🕒'} {peerTime.time}
            {peer.title ? ` · ${peer.title}` : ''}
          </span>
        )}
        {channel.topic && <span className="header__topic">{channel.topic}</span>}
      </div>

      <div className="header__actions no-drag">
        {channel.kind !== 'dm' && (
          <div style={{ position: 'relative' }}>
            <button
              className="pill"
              onClick={() => setLangOpen((v) => !v)}
              title="Kanalsprache — Basis für die Vorschau beim Schreiben"
            >
              <Languages size={13} />
              {channel.primaryLanguage ? languageInfo(channel.primaryLanguage).flag : '🌐'}
              {channel.primaryLanguage ? channel.primaryLanguage.toUpperCase() : 'Auto'}
            </button>
            {langOpen && (
              <div
                style={{
                  position: 'absolute', top: '100%', right: 0, marginTop: 6, zIndex: 30,
                  width: 216, maxHeight: 300, overflowY: 'auto', padding: 5,
                  borderRadius: 'var(--r-md)', background: 'var(--bg-elevated)',
                  border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-md)',
                }}
                onMouseLeave={() => setLangOpen(false)}
              >
                <button
                  className="result" style={{ padding: '6px 9px' }}
                  onClick={() => { updateChannel(channelId, { primaryLanguage: null }); setLangOpen(false); }}
                >🌐 Automatisch</button>
                {LANGUAGES.map((l) => (
                  <button
                    key={l.code}
                    className="result"
                    style={{ padding: '6px 9px' }}
                    onClick={() => { updateChannel(channelId, { primaryLanguage: l.code }); setLangOpen(false); }}
                  >
                    {l.flag} {l.native}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          className="pill"
          title="Meine Anzeigesprache umstellen"
          onClick={() => setOverlay('settings')}
        >
          {languageInfo(self?.language).flag} {self?.language.toUpperCase()}
        </button>

        {ai?.assistant && (
          <button className="pill pill--accent" onClick={() => runCatchup(channelId)} title="Ungelesenes zusammenfassen">
            <Sparkles size={13} />
            Verpasst?
          </button>
        )}

        {ai?.assistant && (
          <button
            className="icon-btn"
            onClick={() => loadSmartReplies(channelId)}
            title="Antwortvorschläge holen"
          >
            <MessageSquareText size={17} />
          </button>
        )}

        <button className="icon-btn" onClick={() => setOverlay('people')} title="Mitglieder">
          <Users size={17} />
        </button>
      </div>
    </header>
  );
}
