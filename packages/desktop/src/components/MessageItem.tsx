import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Bell, Bookmark, Check, Copy, EyeOff, Forward, Languages,
  MessageSquare, MoreHorizontal, Pencil, Pin, RefreshCw, Smile, Sparkles, Trash2,
} from 'lucide-react';
import {
  DELETE_FOR_ALL_WINDOW_MS, EDIT_WINDOW_MS, minutesLeft,
  withinDeleteWindow, withinEditWindow, type Message,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useT } from '../i18n/index.js';
import { fileUrl } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { Markdown } from './Markdown.jsx';
import { EmojiPicker } from './EmojiPicker.jsx';
import { PollCard } from './PollCard.jsx';
import { VoiceMessage } from './VoiceMessage.jsx';
import { LinkPreviewCard } from './LinkPreviewCard.jsx';
import { clsx, fileSize, languageInfo, timeOfDay } from '../lib/format.js';

interface Props {
  message: Message;
  grouped: boolean;
  inThread?: boolean;
}

const QUICK_EMOJI = ['👍', '🎉', '👀', '❤️', '🚀', '✅'];

export const MessageItem = memo(function MessageItem({ message, grouped, inThread = false }: Props) {
  const t = useT();
  const self = useStore((s) => s.self);
  const author = useStore((s) => s.users[message.userId]);
  const showOriginal = useStore((s) => s.showOriginal[message.id] ?? false);
  const translating = useStore((s) => s.translating[message.id] ?? false);
  const roundTrip = useStore((s) => s.roundTrips[message.id]);
  const highlighted = useStore((s) => s.highlightMessageId === message.id);
  const {
    react, toggleOriginal, requestTranslation, requestRoundTrip,
    openThread, deleteMessage, editMessage, pin, save, setLightbox,
    startForward, startReminder, setProfileUser,
  } = useStore.getState();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const isMine = self?.id === message.userId;
  // Bearbeiten und Zurücknehmen sind zeitlich begrenzt: nach zwei Stunden ist
  // die Nachricht Teil eines Verlaufs, auf den sich andere bezogen haben.
  const darfBearbeiten = isMine && withinEditWindow(message.createdAt) && message.kind !== 'poll';
  const darfFuerAlleLoeschen =
    (isMine && withinDeleteWindow(message.createdAt)) || Boolean(self?.permissions['message.delete_any']);
  const restBearbeiten = minutesLeft(message.createdAt, EDIT_WINDOW_MS);
  const restLoeschen = minutesLeft(message.createdAt, DELETE_FOR_ALL_WINDOW_MS);
  const isMention = self ? message.mentionUserIds.includes(self.id) : false;
  const translation = message.translation;
  const hasTranslation = Boolean(translation && translation.text !== message.text);
  const bodyText = hasTranslation && !showOriginal ? translation!.text : message.text;

  // Für mich ausgeblendet: nur ein dezenter Hinweis, kein Inhalt.
  if (message.hiddenForMe) {
    return (
      <div className="msg msg--grouped" style={{ opacity: 0.45 }}>
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontStyle: 'italic', fontSize: 13 }}>
          {t('msg.hiddenForYou')}
        </div>
      </div>
    );
  }

  if (message.deletedAt) {
    return (
      <div className="msg msg--grouped">
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontStyle: 'italic', fontSize: 13.5 }}>
          {t('msg.deleted')}
        </div>
      </div>
    );
  }

  if (message.systemKind) {
    return (
      <div className="msg msg--grouped" style={{ opacity: 0.7 }}>
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontSize: 13 }}>{message.text}</div>
      </div>
    );
  }

  const submitEdit = () => {
    const clean = draft.trim();
    if (clean && clean !== message.text) editMessage(message.id, clean);
    setEditing(false);
  };

  return (
    <motion.div
      layout="position"
      initial={message.pending ? false : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      data-message-id={message.id}
      className={clsx(
        'msg',
        grouped && 'msg--grouped',
        isMention && 'msg--mention',
        message.pending && 'msg--pending',
        message.failed && 'msg--failed',
        highlighted && 'msg--highlight',
      )}
    >
      <div className="msg__gutter">
        {grouped
          ? <span className="msg__time-hover">{timeOfDay(message.createdAt)}</span>
          : (
            <button onClick={() => setProfileUser(message.userId)} title={`Profil von ${author?.displayName ?? ''}`}>
              <Avatar user={author} size={38} showPresence />
            </button>
          )}
      </div>

      <div style={{ minWidth: 0 }}>
        {message.forwardedFrom && (
          <div className="msg__forwarded">
            <Forward size={11} />
            Weitergeleitet von {useStore.getState().users[message.forwardedFrom.userId]?.displayName ?? 'jemandem'}
          </div>
        )}

        {!grouped && (
          <div className="msg__head">
            <button className="msg__author" onClick={() => setProfileUser(message.userId)}>
              {author?.displayName ?? 'Unbekannt'}
            </button>
            <span className="msg__time">{timeOfDay(message.createdAt)}</span>
            {message.editedAt && <span className="msg__tag">{t('msg.edited')}</span>}
            {message.pinned && <Pin size={12} className="muted" />}
            {message.sourceLang && (
              <span className="msg__tag" title={`Geschrieben auf ${languageInfo(message.sourceLang).native}`}>
                {languageInfo(message.sourceLang).flag} {message.sourceLang.toUpperCase()}
              </span>
            )}
          </div>
        )}

        {editing ? (
          <div className="stack gap-2" style={{ marginTop: 4 }}>
            <textarea
              className="textarea"
              value={draft}
              autoFocus
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitEdit(); }
                if (e.key === 'Escape') { setEditing(false); setDraft(message.text); }
              }}
            />
            <div className="hstack gap-2">
              <button className="btn btn--primary" onClick={submitEdit}><Check size={15} /> {t('msg.saveButton')}</button>
              <button className="btn btn--ghost" onClick={() => { setEditing(false); setDraft(message.text); }}>{t('msg.cancel')}</button>
              <span className="muted" style={{ fontSize: 12 }}>{t('msg.enterSaves')}</span>
            </div>
          </div>
        ) : message.kind === 'voice' && message.voice ? (
          <VoiceMessage
            voice={message.voice}
            messageId={message.id}
            translatedText={hasTranslation ? translation!.text : null}
            showOriginal={showOriginal}
          />
        ) : (
          <div className="msg__body translated">
            {message.kind === 'poll' && message.poll
              ? <PollCard poll={message.poll} />
              : <Markdown text={bodyText} selfHandle={self?.handle} />}

            {translating && !hasTranslation && (
              <div className="tr-pending">
                <Sparkles size={11} className="spark" />
                <span>{t('msg.translating')}</span>
                <span className="tr-pending__bar" />
              </div>
            )}

            {hasTranslation && (
              <>
                <button
                  className="translated__meta"
                  onClick={() => toggleOriginal(message.id)}
                  title={showOriginal ? t('msg.showTranslation') : t('msg.showOriginal')}
                >
                  <Languages size={11} className="spark" />
                  {showOriginal
                    ? t('msg.original')
                    : t('msg.translatedFrom', {
                      language: languageInfo(message.sourceLang).native,
                    })}
                </button>

                {showOriginal && (
                  <div className="translated__original">
                    <Markdown text={translation!.text} selfHandle={self?.handle} />
                  </div>
                )}

                {/* Der Demo-Provider übersetzt gar nicht und meldet darum immer
                    niedrige Konfidenz — die Warnung wäre dort reines Rauschen. */}
                {translation!.provider !== 'demo'
                  && translation!.confidence != null
                  && translation!.confidence < 0.45 && (
                  <div className="confidence-low">
                    <AlertTriangle size={11} />
                    {t('msg.lowConfidence')}
                  </div>
                )}

                {roundTrip && (
                  <div className="translated__original" style={{ borderLeftColor: 'var(--cyan)' }}>
                    <div className="muted" style={{ fontSize: 11, marginBottom: 3 }}>
                      Rückübersetzung · {Math.round(roundTrip.similarity * 100)} % Übereinstimmung
                      {roundTrip.similarity < 0.5 && ' — Bedeutung könnte abweichen'}
                    </div>
                    {roundTrip.backTranslation}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {message.kind === 'voice' && hasTranslation && (
          <button className="translated__meta" onClick={() => toggleOriginal(message.id)}>
            <Languages size={11} className="spark" />
            {showOriginal ? 'Übersetzung anzeigen' : `Original · ${languageInfo(message.sourceLang).native}`}
          </button>
        )}

        {message.links.length > 0 && (
          <div className="link-cards">
            {message.links.map((preview) => <LinkPreviewCard key={preview.url} preview={preview} />)}
          </div>
        )}

        {message.attachments.filter((a) => message.kind !== 'voice' || !a.mime.startsWith('audio/')).length > 0 && (
          <div className="attachments">
            {message.attachments.filter((a) => message.kind !== 'voice' || !a.mime.startsWith('audio/')).map((att) => (
              att.mime.startsWith('image/') ? (
                <img
                  key={att.id}
                  className="att-img"
                  src={fileUrl(att.url)}
                  alt={att.name}
                  loading="lazy"
                  width={att.width ?? undefined}
                  height={att.height ?? undefined}
                  onClick={() => setLightbox(fileUrl(att.url))}
                />
              ) : (
                <a key={att.id} className="att-file" href={fileUrl(att.url)} target="_blank" rel="noreferrer">
                  <div className="stack">
                    <span className="att-file__name">{att.name}</span>
                    <span className="att-file__size">{fileSize(att.size)}</span>
                  </div>
                </a>
              )
            ))}
          </div>
        )}

        {message.reactions.length > 0 && (
          <div className="reactions">
            {message.reactions.map((r) => (
              <motion.button
                key={r.emoji}
                whileTap={{ scale: 0.88 }}
                className={clsx('reaction', self && r.userIds.includes(self.id) && 'reaction--mine')}
                onClick={() => react(message.id, r.emoji)}
                title={r.userIds.map((id) => useStore.getState().users[id]?.displayName ?? '?').join(', ')}
              >
                <span>{r.emoji}</span>
                <span className="reaction__count">{r.userIds.length}</span>
              </motion.button>
            ))}
            <button className="reaction" onClick={() => setPickerOpen(true)} title={t('msg.pickReaction')}>
              <Smile size={13} />
            </button>
          </div>
        )}

        {!inThread && message.replyCount > 0 && (
          <button className="thread-link" onClick={() => openThread(message.id)}>
            <span className="thread-link__faces">
              {message.threadParticipantIds.slice(0, 3).map((id) => (
                <Avatar key={id} user={useStore.getState().users[id]} size={20} />
              ))}
            </span>
            {message.replyCount} {message.replyCount === 1 ? t('msg.reply') : t('msg.replies')}
          </button>
        )}
      </div>

      {/* Aktionsleiste beim Überfahren */}
      <div className="msg__actions">
        {QUICK_EMOJI.slice(0, 3).map((emoji) => (
          <button key={emoji} className="icon-btn icon-btn--sm" onClick={() => react(message.id, emoji)} title={t('msg.reactWith', { emoji })}>
            <span style={{ fontSize: 15 }}>{emoji}</span>
          </button>
        ))}
        <button className="icon-btn icon-btn--sm" onClick={() => setPickerOpen(true)} title={t('msg.pickReaction')}><Smile size={15} /></button>
        {!inThread && (
          <button className="icon-btn icon-btn--sm" onClick={() => openThread(message.id)} title={t('msg.replyInThread')}><MessageSquare size={15} /></button>
        )}
        {hasTranslation ? (
          <button className="icon-btn icon-btn--sm" onClick={() => requestRoundTrip(message.id)} title={t('msg.checkBackTranslation')}><RefreshCw size={15} /></button>
        ) : (
          <button className="icon-btn icon-btn--sm" onClick={() => requestTranslation(message.id)} title={t('msg.translateToMine')}><Languages size={15} /></button>
        )}
        <button className="icon-btn icon-btn--sm" onClick={() => setMenuOpen((v) => !v)} title={t('msg.more')}><MoreHorizontal size={15} /></button>

        <AnimatePresence>
          {menuOpen && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              style={{
                position: 'absolute', top: '100%', right: 0, marginTop: 4, zIndex: 10,
                minWidth: 210, padding: 5, borderRadius: 'var(--r-md)',
                background: 'var(--bg-elevated)', border: '1px solid var(--line)',
                boxShadow: 'var(--shadow-md)',
              }}
              onMouseLeave={() => setMenuOpen(false)}
            >
              <MenuItem icon={<Bookmark size={14} />} label={t('msg.save')} onClick={() => { save(message.id, true); setMenuOpen(false); }} />
              <MenuItem icon={<Bell size={14} />} label={t('msg.remind')} onClick={() => { startReminder(message); setMenuOpen(false); }} />
              <MenuItem icon={<Forward size={14} />} label={t('msg.forward')} onClick={() => { startForward(message); setMenuOpen(false); }} />
              <MenuItem icon={<Pin size={14} />} label={message.pinned ? t('msg.unpin') : t('msg.pin')} onClick={() => { pin(message.id, !message.pinned); setMenuOpen(false); }} />
              <MenuItem icon={<Copy size={14} />} label={t('msg.copy')} onClick={() => { void navigator.clipboard.writeText(message.text); setMenuOpen(false); }} />
              {darfBearbeiten && (
                <MenuItem
                  icon={<Pencil size={14} />}
                  label={`${t('msg.edit')} · ${t('msg.minutesLeft', { n: restBearbeiten })}`}
                  onClick={() => { setEditing(true); setMenuOpen(false); }}
                />
              )}
              {isMine && !darfBearbeiten && (
                <MenuItem icon={<Pencil size={14} />} label={t('msg.editExpired')} disabled onClick={() => {}} />
              )}
              {darfFuerAlleLoeschen && (
                <MenuItem
                  icon={<Trash2 size={14} />}
                  label={isMine && !self?.permissions['message.delete_any']
                    ? `${t('msg.deleteForAll')} · ${t('msg.minutesLeft', { n: restLoeschen })}`
                    : t('msg.deleteForAll')}
                  danger
                  onClick={() => { deleteMessage(message.id, 'all'); setMenuOpen(false); }}
                />
              )}
              <MenuItem
                icon={<EyeOff size={14} />}
                label={t('msg.deleteForMe')}
                onClick={() => { deleteMessage(message.id, 'me'); setMenuOpen(false); }}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {pickerOpen && (
          <EmojiPicker
            onPick={(emoji) => { react(message.id, emoji); setPickerOpen(false); }}
            onClose={() => setPickerOpen(false)}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
});

function MenuItem({ icon, label, onClick, danger, disabled }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        padding: '7px 10px', borderRadius: 'var(--r-xs)',
        fontSize: 13.5, textAlign: 'left',
        color: danger ? 'var(--rose)' : 'var(--tx-mid)',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'default' : 'pointer',
      }}
      onMouseEnter={(e) => { if (!disabled) e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}{label}
    </button>
  );
}
