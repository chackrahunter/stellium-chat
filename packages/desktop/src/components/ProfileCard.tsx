import { motion } from 'framer-motion';
import { AtSign, Clock, Languages, MessageSquare, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import { t } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo, localTimeFor, relativeTime } from '../lib/format.js';

/** Kleine Karte mit dem Wichtigsten über eine Person. */
export function ProfileCard({ userId, onClose }: { userId: string; onClose: () => void }) {
  const user = useStore((s) => s.users[userId]);
  const self = useStore((s) => s.self);
  const { openDm } = useStore.getState();
  if (!user) return null;

  const { time, offHours } = localTimeFor(user.timezone);
  const isSelf = user.id === self?.id;

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        className="profile"
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="profile__banner">
          <button className="icon-btn profile__close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="profile__avatar">
          <Avatar user={user} size={84} showPresence />
        </div>

        <div className="profile__body">
          <h2>{user.displayName}</h2>
          {user.title && <div className="profile__title">{user.title}</div>}
          {user.statusText && (
            <div className="profile__status">
              {user.statusEmoji && <span>{user.statusEmoji}</span>}
              {user.statusText}
            </div>
          )}

          <div className="profile__facts">
            <div className="profile__fact">
              <AtSign size={13} />
              <span>{user.handle}</span>
            </div>
            <div className="profile__fact">
              <Languages size={13} />
              <span>{languageInfo(user.language).flag} {languageInfo(user.language).native}</span>
            </div>
            {time && (
              <div className="profile__fact">
                <Clock size={13} />
                <span>
                  {t('profile.localTime', { zeit: time })}
                  {offHours && <span className="muted"> · {t('profile.offHours')}</span>}
                </span>
              </div>
            )}
            {user.status === 'offline' && user.lastSeenAt && (
              <div className="profile__fact muted">
                <span style={{ width: 13 }} />
                <span>{t('profile.lastSeen', { zeit: relativeTime(user.lastSeenAt) })}</span>
              </div>
            )}
          </div>

          {!isSelf && (
            <button className="btn btn--primary btn--block" onClick={() => { openDm(user.id); onClose(); }}>
              <MessageSquare size={15} /> {t('profile.message')}
            </button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
