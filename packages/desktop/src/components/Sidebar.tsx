import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bot, ChevronDown, Hash, Lock, Plus, Search, Sparkles, Users, UsersRound,
} from 'lucide-react';
import type { Channel } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { clsx, languageInfo, localTimeFor } from '../lib/format.js';

export function Sidebar() {
  const t = useT();
  const self = useStore((s) => s.self);
  const channels = useStore((s) => s.channels);
  const states = useStore((s) => s.states);
  const users = useStore((s) => s.users);
  const activeId = useStore((s) => s.activeChannelId);
  const ai = useStore((s) => s.ai);
  const { openChannel, setOverlay, openDm } = useStore.getState();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  const { publicChannels, privateChannels, dms } = useMemo(() => {
    const list = Object.values(channels).filter((c) => !c.archived);
    const sortByActivity = (a: Channel, b: Channel) => a.name.localeCompare(b.name, 'de');
    return {
      publicChannels: list.filter((c) => c.kind === 'public').sort(sortByActivity),
      privateChannels: list.filter((c) => c.kind === 'private').sort(sortByActivity),
      dms: list.filter((c) => c.kind === 'dm'),
    };
  }, [channels]);

  const otherUsers = Object.values(users).filter((u) => u.id !== self?.id && !u.disabled);
  const dmPeerIds = new Set(dms.map((c) => c.dmPeerId).filter(Boolean) as string[]);

  const renderChannel = (channel: Channel) => {
    const state = states[channel.id];
    const unread = state?.unreadCount ?? 0;
    const mentions = state?.mentionCount ?? 0;
    const peer = channel.kind === 'dm' ? users[channel.dmPeerId ?? ''] : null;

    return (
      <button
        key={channel.id}
        className={clsx('chan', unread > 0 && 'chan--unread')}
        aria-current={activeId === channel.id}
        onClick={() => openChannel(channel.id)}
      >
        {channel.kind === 'dm'
          ? <Avatar user={peer} size={20} showPresence />
          : channel.kind === 'private'
            ? <Lock size={15} className="chan__icon" />
            : <Hash size={15} className="chan__icon" />}
        <span className="chan__name">{channel.kind === 'dm' ? peer?.displayName ?? 'Direktnachricht' : channel.name}</span>
        {channel.kind !== 'dm' && channel.primaryLanguage && (
          <span className="chan__lang" title={`Kanalsprache: ${languageInfo(channel.primaryLanguage).native}`}>
            {languageInfo(channel.primaryLanguage).flag}
          </span>
        )}
        {mentions > 0
          ? <span className="chan__badge">@{mentions}</span>
          : unread > 0 ? <span className="chan__badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>
    );
  };

  return (
    <aside className="sidebar">
      <div className="sidebar__head drag-region">
        <div className="sidebar__title no-drag">
          <span>Stellium</span>
        </div>
        <div className="sidebar__sub">
          {self ? `${self.displayName} · ${languageInfo(self.language).flag} ${languageInfo(self.language).native}` : ''}
        </div>
        <button className="search-trigger no-drag" onClick={() => setOverlay('quick')}>
          <Search size={14} />
          {t('nav.jumpTo')}
          <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Strg'} K</kbd>
        </button>
      </div>

      <div className="sidebar__scroll">
        {ai?.assistant && (
          <div className="group">
            <button className="chan" onClick={() => useStore.getState().openAiChat()}>
              <Bot size={15} className="chan__icon" style={{ color: 'var(--violet-soft)', opacity: 1 }} />
              <span className="chan__name">{t('nav.aiChat')}</span>
            </button>
            <button className="chan" onClick={() => useStore.getState().openAiTeamChannel()}>
              <UsersRound size={15} className="chan__icon" style={{ color: 'var(--cyan)', opacity: 1 }} />
              <span className="chan__name">{t('nav.aiTeamChat')}</span>
            </button>
          </div>
        )}

        <div className="group">
          <button className="chan" onClick={() => setOverlay('search')}>
            <Search size={15} className="chan__icon" />
            <span className="chan__name">{t('nav.search')}</span>
          </button>
          <button className="chan" onClick={() => setOverlay('people')}>
            <Users size={15} className="chan__icon" />
            <span className="chan__name">{t('nav.people')}</span>
          </button>
          <button className="chan" onClick={() => setOverlay('glossary')}>
            <Sparkles size={15} className="chan__icon" />
            <span className="chan__name">{t('nav.glossary')}</span>
          </button>
        </div>

        <Group
          title={t('nav.channels')}
          count={publicChannels.length}
          collapsed={collapsed.public}
          onToggle={() => toggle('public')}
          onAdd={() => setOverlay('newChannel')}
        >
          {publicChannels.map(renderChannel)}
        </Group>

        {privateChannels.length > 0 && (
          <Group
            title={t('nav.private')}
            count={privateChannels.length}
            collapsed={collapsed.private}
            onToggle={() => toggle('private')}
          >
            {privateChannels.map(renderChannel)}
          </Group>
        )}

        <Group
          title={t('nav.directMessages')}
          count={dms.length}
          collapsed={collapsed.dms}
          onToggle={() => toggle('dms')}
        >
          {dms.map(renderChannel)}
          {otherUsers.filter((u) => !dmPeerIds.has(u.id)).map((u) => {
            const { time, offHours } = localTimeFor(u.timezone);
            return (
              <button key={u.id} className="chan" onClick={() => openDm(u.id)} style={{ opacity: 0.72 }}>
                <Avatar user={u} size={20} showPresence />
                <span className="chan__name">{u.displayName}</span>
                <span className="chan__lang" title={offHours ? `Ortszeit ${time} — vermutlich Feierabend` : `Ortszeit ${time}`}>
                  {offHours ? '🌙' : languageInfo(u.language).flag}
                </span>
              </button>
            );
          })}
        </Group>
      </div>
    </aside>
  );
}

interface GroupProps {
  title: string;
  count: number;
  collapsed?: boolean;
  onToggle: () => void;
  onAdd?: () => void;
  children: React.ReactNode;
}

function Group({ title, count, collapsed, onToggle, onAdd, children }: GroupProps) {
  return (
    <div className="group">
      <div style={{ display: 'flex', alignItems: 'center' }}>
        <button className="group__head" aria-expanded={!collapsed} onClick={onToggle} style={{ flex: 1 }}>
          <ChevronDown size={13} className="chev" />
          {title}
          <span style={{ opacity: 0.6, fontWeight: 600 }}>{count}</span>
        </button>
        {onAdd && (
          <button className="icon-btn icon-btn--sm group__add" onClick={onAdd} title={`${title} hinzufügen`}>
            <Plus size={14} />
          </button>
        )}
      </div>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            style={{ overflow: 'hidden' }}
          >
            {children}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
