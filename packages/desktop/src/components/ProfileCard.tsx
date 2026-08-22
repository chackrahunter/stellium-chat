import { useRef } from 'react';
import { OnlineZeit } from './OnlineZeit.jsx';
import { motion } from 'framer-motion';
import { AtSign, Clock, Languages, MessageSquare, X } from 'lucide-react';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { useT, spracheName } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo, localTimeFor, relativeTime } from '../lib/format.js';

/** Kleine Karte mit dem Wichtigsten über eine Person. */
export function ProfileCard({ userId, onClose }: { userId: string; onClose: () => void }) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  /* Reaktiv statt des Modul-t aus i18n/index.js: das lief bisher nur beim
     Laden des Moduls an den Zustand an. Alle Hooks vor dem frühen "return
     null" unten, wie es die Regeln für Hooks verlangen. */
  const t = useT();
  const user = useStore((s) => s.users[userId]);
  const self = useStore((s) => s.self);
  const { openDm } = useStore.getState();
  if (!user) return null;

  const { time, offHours } = localTimeFor(user.timezone);
  const isSelf = user.id === self?.id;

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={user.displayName}
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
              {/* spracheName() statt languageInfo(...).native für den Namen:
                  der Eigenname ("Deutsch") gehört in eine Auswahlliste, nicht
                  in einen Fließtext über eine andere Person. Die Flagge bleibt
                  wie sie ist, sie ist kein übersetzbarer Text. */}
              <span>{languageInfo(user.language).flag} {spracheName(user.language)}</span>
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

          {/* Die eigene Zeit sieht jeder, die von anderen nur, wer Konten
              verwaltet — das entscheidet der Server, hier wird es nur
              angefragt. Schlägt es fehl, zeigt die Komponente den Grund
              statt zu verschwinden. */}
          <OnlineZeit userId={isSelf ? 'ich' : user.id} />

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
