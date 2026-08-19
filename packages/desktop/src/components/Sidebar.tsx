import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Archive, Bell, BellOff, Bot, ChevronDown, EyeOff, Hash, Lock, LogOut, Plus,
  Search, Settings2, Sparkles, Star, StarOff, Trash2, Users, UsersRound,
} from 'lucide-react';
import type { Channel } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { ContextMenu, useContextMenu, type MenuEintrag } from './ContextMenu.jsx';
import { clsx, kanalName, languageInfo, localTimeFor } from '../lib/format.js';
import { useKiKanaele } from '../lib/ai-channels.js';

export function Sidebar() {
  const t = useT();
  const self = useStore((s) => s.self);
  const channels = useStore((s) => s.channels);
  const states = useStore((s) => s.states);
  const users = useStore((s) => s.users);
  const activeId = useStore((s) => s.activeChannelId);
  const ai = useStore((s) => s.ai);
  const { openChannel, setOverlay, openDm } = useStore.getState();
  const menue = useContextMenu<string>();

  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const toggle = (key: string) => setCollapsed((c) => ({ ...c, [key]: !c[key] }));

  const { chatId: kiChatId, teamId: kiTeamId, alleKiChats } = useKiKanaele();

  const { publicChannels, privateChannels, dms } = useMemo(() => {
    const list = Object.values(channels).filter((c) => !c.archived);
    // Angeheftetes zuerst, dann alphabetisch.
    const sortieren = (a: Channel, b: Channel) => {
      const aFest = states[a.id]?.starred ? 0 : 1;
      const bFest = states[b.id]?.starred ? 0 : 1;
      return aFest - bFest || kanalName(a).localeCompare(kanalName(b));
    };
    return {
      publicChannels: list.filter((c) => c.kind === 'public' && c.id !== kiTeamId).sort(sortieren),
      privateChannels: list.filter((c) => c.kind === 'private').sort(sortieren),
      // Direktchats mit gelöschten oder gesperrten Konten verstecken —
      // sie führen nur ins Leere.
      dms: list.filter((c) => c.kind === 'dm' && !alleKiChats.has(c.id)
        && !users[c.dmPeerId ?? '']?.disabled),
    };
  }, [channels, users, states, alleKiChats, kiTeamId]);

  // Wer noch keinen Direktchat hat, erscheint darunter zum Anfangen. Die KI
  // gehört nicht dazu — sie hat oben ihren eigenen Platz und wäre hier ein
  // zweiter Zugang zum selben Gespräch.
  const otherUsers = Object.values(users).filter(
    (u) => u.id !== self?.id && !u.disabled && u.role !== 'bot',
  );
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
        onContextMenu={(e) => menue.oeffnen(e, channel.id)}
      >
        {channel.kind === 'dm'
          ? <Avatar user={peer} size={20} showPresence />
          : channel.kind === 'private'
            ? <Lock size={15} className="chan__icon" />
            : <Hash size={15} className="chan__icon" />}
        <span className="chan__name">{channel.kind === 'dm' ? peer?.displayName ?? 'Direktnachricht' : kanalName(channel)}</span>
        {channel.kind !== 'dm' && channel.primaryLanguage && (
          <span className="chan__lang" title={`Kanalsprache: ${languageInfo(channel.primaryLanguage).native}`}>
            {languageInfo(channel.primaryLanguage).flag}
          </span>
        )}
        {state?.starred && <Star size={11} className="chan__lang" style={{ color: 'var(--amber)' }} />}
        {state?.muted && <BellOff size={11} className="chan__lang" />}
        {mentions > 0
          ? <span className="chan__badge">@{mentions}</span>
          : unread > 0 && !state?.muted ? <span className="chan__badge">{unread > 99 ? '99+' : unread}</span> : null}
      </button>
    );
  };

  const menueEintraege = (channelId: string): MenuEintrag[] => {
    const ch = channels[channelId];
    if (!ch) return [];
    const st = states[channelId];
    const istDm = ch.kind === 'dm';
    const store = useStore.getState();
    const p = self?.permissions;

    const eintraege: MenuEintrag[] = [
      { id: 'oeffnen', label: t('ctx.open'), icon: <Hash size={14} />, onClick: () => openChannel(channelId) },
      {
        id: 'stumm', trenner: true,
        label: st?.muted ? t('ctx.unmute') : t('ctx.mute'),
        icon: st?.muted ? <Bell size={14} /> : <BellOff size={14} />,
        onClick: () => store.muteChannel(channelId, !st?.muted),
      },
      {
        id: 'anheften',
        label: st?.starred ? t('ctx.unstar') : t('ctx.star'),
        icon: st?.starred ? <StarOff size={14} /> : <Star size={14} />,
        onClick: () => store.starChannel(channelId, !st?.starred),
      },
      {
        id: 'einstellungen', trenner: true,
        label: t('channel.settingsTitle'), icon: <Settings2 size={14} />,
        onClick: () => { openChannel(channelId); setOverlay('channelSettings'); },
      },
    ];

    if (istDm) {
      eintraege.push({
        id: 'ausblenden', trenner: true, danger: true,
        label: t('channel.hideDm'), icon: <EyeOff size={14} />,
        onClick: () => store.hideChannel(channelId),
      });
    } else {
      if (p?.['channel.archive']) {
        eintraege.push({
          id: 'archivieren', trenner: true,
          label: t('channel.archive'), icon: <Archive size={14} />,
          onClick: () => store.updateChannel(channelId, { archived: true }),
        });
      }
      eintraege.push({
        id: 'verlassen', trenner: !p?.['channel.archive'],
        label: t('channel.leave'), icon: <LogOut size={14} />,
        onClick: () => store.leaveChannel(channelId),
      });
      if (p?.['channel.delete']) {
        eintraege.push({
          id: 'loeschen', danger: true,
          label: t('channel.delete'), icon: <Trash2 size={14} />,
          onClick: () => { openChannel(channelId); setOverlay('channelSettings'); },
        });
      }
    }
    return eintraege;
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
        <button className="search-trigger no-drag" data-tour="search" onClick={() => setOverlay('quick')}>
          <Search size={14} />
          {t('nav.jumpTo')}
          <kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Strg'} K</kbd>
        </button>
      </div>

      <div className="sidebar__scroll" data-tour="channels">
        {ai?.assistant && (
          <div className="group">
            <button
              className={clsx('chan', (states[kiChatId ?? '']?.unreadCount ?? 0) > 0 && 'chan--unread')}
              aria-current={activeId === kiChatId}
              // Ist der Kanal schon bekannt, sofort hin — sonst hinge der
              // Klick an einer Antwort des Servers und sähe aus, als täte er
              // nichts.
              onClick={() => (kiChatId ? openChannel(kiChatId) : useStore.getState().openAiChat())}
              onContextMenu={(e) => { if (kiChatId) menue.oeffnen(e, kiChatId); }}
            >
              <Bot size={15} className="chan__icon" style={{ color: 'var(--violet-soft)', opacity: 1 }} />
              <span className="chan__name">{t('nav.aiChat')}</span>
              {(states[kiChatId ?? '']?.unreadCount ?? 0) > 0 && (
                <span className="chan__badge">{states[kiChatId ?? '']!.unreadCount}</span>
              )}
            </button>
            <button
              className={clsx('chan', (states[kiTeamId ?? '']?.unreadCount ?? 0) > 0 && 'chan--unread')}
              aria-current={activeId === kiTeamId}
              onClick={() => (kiTeamId ? openChannel(kiTeamId) : useStore.getState().openAiTeamChannel())}
              onContextMenu={(e) => { if (kiTeamId) menue.oeffnen(e, kiTeamId); }}
            >
              <UsersRound size={15} className="chan__icon" style={{ color: 'var(--cyan)', opacity: 1 }} />
              <span className="chan__name">{t('nav.aiTeamChat')}</span>
              {(states[kiTeamId ?? '']?.unreadCount ?? 0) > 0 && (
                <span className="chan__badge">{states[kiTeamId ?? '']!.unreadCount}</span>
              )}
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
              <button key={u.id} className="chan" onClick={() => openDm(u.id)} style={{ opacity: 0.72 }}
                onContextMenu={(e) => { e.preventDefault(); openDm(u.id); }}>
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

      {menue.zustand && (
        <ContextMenu
          position={menue.zustand.position}
          eintraege={menueEintraege(menue.zustand.ziel)}
          onClose={menue.schliessen}
        />
      )}
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
