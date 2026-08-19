import { useRef, useState } from 'react';
import {
  Bot, ClipboardList, Hash, Languages, ListChecks, Loader2, Lock, Megaphone, Menu, MessageSquareText,
  Settings2, Sparkles, Users,
} from 'lucide-react';
import { AnimatePresence } from 'framer-motion';
import { LANGUAGES, normalizeLang } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { kanalName, kanalThema, languageInfo, localTimeFor } from '../lib/format.js';
import { useKiKanaele, KI_NAME } from '../lib/ai-channels.js';
import { TaskExtractPop } from './TaskExtractPop.jsx';

export function ChannelHeader({ channelId }: { channelId: string }) {
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const smartRepliesLoading = useStore((s) => s.smartRepliesLoading);
  const { runCatchup, setOverlay, updateChannel, updatePrefs, loadSmartReplies } = useStore.getState();
  const [langOpen, setLangOpen] = useState(false);
  const [extractOffen, setExtractOffen] = useState(false);
  const extractRef = useRef<HTMLButtonElement>(null);
  const { chatId: kiChatId, teamId: kiTeamId } = useKiKanaele();

  if (!channel) return null;

  // Der KI-Bereich ist ein eigener Reiter. Er trägt deshalb weder ein
  // Profilbild noch die Bedienelemente eines Direktchats.
  const kiPrivat = channelId === kiChatId;
  const kiTeam = channelId === kiTeamId;
  const ki = kiPrivat || kiTeam;

  const peer = !ki && channel.kind === 'dm' ? users[channel.dmPeerId ?? ''] : null;
  const peerTime = peer ? localTimeFor(peer.timezone) : null;

  return (
    <header className="header drag-region">
      <div className="header__title no-drag">
        {/* Nur auf schmalen Geräten sichtbar: dort ist die Liste eingeklappt. */}
        <button
          className="header__menue"
          onClick={() => useStore.getState().setSchublade(true)}
          title={t('nav.channels')}
          aria-label={t('nav.channels')}
        >
          <Menu size={18} />
        </button>
        {ki
          ? <span className="ki-badge"><Bot size={16} /></span>
          : channel.kind === 'dm'
            ? <Avatar user={peer} size={28} showPresence />
            : channel.kind === 'private' ? <Lock size={17} className="muted" /> : <Hash size={17} className="muted" />}
        <h1>
          {ki ? KI_NAME : channel.kind === 'dm' ? peer?.displayName ?? 'Direktnachricht' : kanalName(channel)}
        </h1>
        {ki && (
          <span className="header__topic">
            {kiPrivat ? t('ai.tabPrivate') : t('ai.tabTeam')}
          </span>
        )}
        {peer && peerTime?.time && (
          <span className="header__topic" title={`Ortszeit von ${peer.displayName}`}>
            {peerTime.offHours ? '🌙' : '🕒'} {peerTime.time}
            {peer.title ? ` · ${peer.title}` : ''}
          </span>
        )}
        {channel.readOnly && (
          <span className="msg__tag" title={t('channel.readOnlyHint')}>
            <Megaphone size={10} style={{ verticalAlign: -1 }} /> {t('channel.readOnly')}
          </span>
        )}
        {kanalThema(channel) && <span className="header__topic">{kanalThema(channel)}</span>}
      </div>

      <div className="header__actions no-drag">
        {channel.kind !== 'dm' && !kiPrivat && (
          <div style={{ position: 'relative' }}>
            <button
              className="pill"
              onClick={() => setLangOpen((v) => !v)}
              title={t('header.channelLanguage')}
            >
              <Languages size={13} />
              {channel.primaryLanguage ? languageInfo(channel.primaryLanguage).flag : '🌐'}
              {channel.primaryLanguage ? channel.primaryLanguage.toUpperCase() : t('header.auto')}
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
          data-tour="language"
          title={t('header.myLanguage')}
          onClick={() => setOverlay('settings')}
        >
          {languageInfo(self?.language).flag} {self?.language.toUpperCase()}
        </button>

        {ai?.assistant && (
          <button className="pill pill--accent" data-tour="catchup" onClick={() => runCatchup(channelId)} title={t('header.summarize')}>
            <Sparkles size={13} />
            {t('header.missed')}
          </button>
        )}

        {ai?.assistant && (
          <button
            className="icon-btn"
            data-tour="smart"
            onClick={() => loadSmartReplies(channelId)}
            disabled={smartRepliesLoading}
            title={smartRepliesLoading ? t('header.smartRepliesLoading') : t('header.smartReplies')}
          >
            {smartRepliesLoading
              ? <Loader2 size={17} className="spin" />
              : <MessageSquareText size={17} />}
          </button>
        )}

        {ai?.assistant && !kiPrivat && (
          <button className="icon-btn" onClick={() => setOverlay('protocol')} title={t('header.protocol')}>
            <ClipboardList size={17} />
          </button>
        )}

        {ai?.assistant && (
          <>
            <button
              ref={extractRef}
              className="icon-btn"
              onClick={() => {
                // Die Erkennung legt die Aufgaben selbst an; hier daneben
                // steht danach nur noch, was daraus geworden ist.
                useStore.getState().extractTasks(channelId);
                setExtractOffen(true);
              }}
              title={t('ai.extractTasks')}
            >
              <ListChecks size={17} />
            </button>
            <AnimatePresence>
              {extractOffen && (
                <TaskExtractPop
                  ankerRef={extractRef}
                  onClose={() => {
                    setExtractOffen(false);
                    useStore.getState().clearExtractedTasks();
                  }}
                />
              )}
            </AnimatePresence>
          </>
        )}

        {!kiPrivat && (
          <button className="icon-btn" onClick={() => setOverlay('people')} title={t('header.members')}>
            <Users size={17} />
          </button>
        )}

        {!kiPrivat && (
          <button className="icon-btn" onClick={() => setOverlay('channelSettings')} title={t('channel.settingsTitle')}>
            <Settings2 size={17} />
          </button>
        )}
      </div>
    </header>
  );
}
