import { Bell, Bookmark, Bot, MessageSquare, Settings, ShieldCheck, Sparkles, Star } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';

export function Rail() {
  const t = useT();
  const self = useStore((s) => s.self);
  const states = useStore((s) => s.states);
  const reminders = useStore((s) => s.reminders);
  const { setOverlay } = useStore.getState();

  const totalUnread = Object.values(states).reduce((sum, s) => sum + (s.muted ? 0 : s.unreadCount), 0);
  const totalMentions = Object.values(states).reduce((sum, s) => sum + s.mentionCount, 0);

  return (
    <nav className="rail drag-region">
      <div className="rail__logo no-drag" title="Stellium">
        <Star size={21} color="#fff" fill="#fff" />
      </div>

      <button className="rail-btn no-drag" aria-pressed="true" title={t('nav.chat')}>
        <MessageSquare size={20} />
        {(totalMentions || totalUnread) > 0 && (
          <span className="rail-btn__dot">{totalMentions || (totalUnread > 99 ? '99+' : totalUnread)}</span>
        )}
      </button>

      <button className="rail-btn no-drag" onClick={() => useStore.getState().openAiChat()} title={t('nav.aiChat')}>
        <Bot size={20} />
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('catchup')} title={t('nav.catchup')}>
        <Sparkles size={20} />
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('search')} title={t('nav.saved')}>
        <Bookmark size={20} />
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('reminders')} title={t('nav.reminders')}>
        <Bell size={20} />
        {reminders.length > 0 && <span className="rail-btn__dot">{reminders.length}</span>}
      </button>

      {self?.permissions['user.manage'] && (
        <button className="rail-btn no-drag" onClick={() => setOverlay('team')} title={t('nav.team')}>
          <ShieldCheck size={20} />
        </button>
      )}

      <span className="rail__spacer" />

      <button className="rail-btn no-drag" onClick={() => setOverlay('settings')} title={t('nav.settings')}>
        <Settings size={20} />
      </button>
      <button className="no-drag" onClick={() => setOverlay('settings')} title={self?.displayName}>
        <Avatar user={self} size={34} showPresence />
      </button>
    </nav>
  );
}
