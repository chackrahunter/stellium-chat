import { Bell, Bookmark, MessageSquare, Settings, Sparkles, Star } from 'lucide-react';
import { useStore } from '../state/store.js';
import { Avatar } from './Avatar.jsx';

export function Rail() {
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

      <button className="rail-btn no-drag" aria-pressed="true" title="Chat">
        <MessageSquare size={20} />
        {(totalMentions || totalUnread) > 0 && (
          <span className="rail-btn__dot">{totalMentions || (totalUnread > 99 ? '99+' : totalUnread)}</span>
        )}
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('catchup')} title="Was habe ich verpasst?">
        <Sparkles size={20} />
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('search')} title="Gemerkte Nachrichten">
        <Bookmark size={20} />
      </button>

      <button className="rail-btn no-drag" onClick={() => setOverlay('reminders')} title="Erinnerungen">
        <Bell size={20} />
        {reminders.length > 0 && <span className="rail-btn__dot">{reminders.length}</span>}
      </button>

      <span className="rail__spacer" />

      <button className="rail-btn no-drag" onClick={() => setOverlay('settings')} title="Einstellungen">
        <Settings size={20} />
      </button>
      <button className="no-drag" onClick={() => setOverlay('settings')} title={self?.displayName}>
        <Avatar user={self} size={34} showPresence />
      </button>
    </nav>
  );
}
