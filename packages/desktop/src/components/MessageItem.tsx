import { memo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Bookmark, Check, CornerUpLeft, Languages, MessageSquare,
  MoreHorizontal, Pencil, Pin, RefreshCw, Smile, Sparkles, Trash2, X,
} from 'lucide-react';
import type { Message } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { fileUrl } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { Markdown } from './Markdown.jsx';
import { EmojiPicker } from './EmojiPicker.jsx';
import { clsx, fileSize, languageInfo, timeOfDay } from '../lib/format.js';

interface Props {
  message: Message;
  grouped: boolean;
  inThread?: boolean;
}

const QUICK_EMOJI = ['👍', '🎉', '👀', '❤️', '🚀', '✅'];

export const MessageItem = memo(function MessageItem({ message, grouped, inThread = false }: Props) {
  const self = useStore((s) => s.self);
  const author = useStore((s) => s.users[message.userId]);
  const showOriginal = useStore((s) => s.showOriginal[message.id] ?? false);
  const translating = useStore((s) => s.translating[message.id] ?? false);
  const roundTrip = useStore((s) => s.roundTrips[message.id]);
  const {
    react, toggleOriginal, requestTranslation, requestRoundTrip,
    openThread, deleteMessage, editMessage, pin, save, setLightbox,
  } = useStore.getState();

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(message.text);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  const isMine = self?.id === message.userId;
  const isMention = self ? message.mentionUserIds.includes(self.id) : false;
  const translation = message.translation;
  const hasTranslation = Boolean(translation && translation.text !== message.text);
  const bodyText = hasTranslation && !showOriginal ? translation!.text : message.text;

  if (message.deletedAt) {
    return (
      <div className="msg msg--grouped">
        <div className="msg__gutter" />
        <div className="msg__body muted" style={{ fontStyle: 'italic', fontSize: 13.5 }}>
          Diese Nachricht wurde gelöscht
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
      className={clsx(
        'msg',
        grouped && 'msg--grouped',
        isMention && 'msg--mention',
        message.pending && 'msg--pending',
        message.failed && 'msg--failed',
      )}
    >
      <div className="msg__gutter">
        {grouped
          ? <span className="msg__time-hover">{timeOfDay(message.createdAt)}</span>
          : <Avatar user={author} size={38} showPresence />}
      </div>

      <div style={{ minWidth: 0 }}>
        {!grouped && (
          <div className="msg__head">
            <span className="msg__author">{author?.displayName ?? 'Unbekannt'}</span>
            <span className="msg__time">{timeOfDay(message.createdAt)}</span>
            {message.editedAt && <span className="msg__tag">bearbeitet</span>}
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
              <button className="btn btn--primary" onClick={submitEdit}><Check size={15} /> Speichern</button>
              <button className="btn btn--ghost" onClick={() => { setEditing(false); setDraft(message.text); }}>Abbrechen</button>
              <span className="muted" style={{ fontSize: 12 }}>Enter speichert, Esc bricht ab</span>
            </div>
          </div>
        ) : (
          <div className="msg__body translated">
            <Markdown text={bodyText} selfHandle={self?.handle} />

            {translating && !hasTranslation && (
              <div className="tr-pending">
                <Sparkles size={11} className="spark" />
                <span>übersetze…</span>
                <span className="tr-pending__bar" />
              </div>
            )}

            {hasTranslation && (
              <>
                <button
                  className="translated__meta"
                  onClick={() => toggleOriginal(message.id)}
                  title={showOriginal ? 'Übersetzung anzeigen' : 'Original anzeigen'}
                >
                  <Languages size={11} className="spark" />
                  {showOriginal
                    ? `Original · ${languageInfo(message.sourceLang).native}`
                    : `Übersetzt aus ${languageInfo(message.sourceLang).native} · ${translation!.provider}`}
                </button>

                {showOriginal && (
                  <div className="translated__original">
                    <Markdown text={translation!.text} selfHandle={self?.handle} />
                  </div>
                )}

                {translation!.confidence != null && translation!.confidence < 0.45 && (
                  <div className="confidence-low">
                    <AlertTriangle size={11} />
                    Übersetzung unsicher — im Zweifel nachfragen
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

        {message.attachments.length > 0 && (
          <div className="attachments">
            {message.attachments.map((att) => (
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
            <button className="reaction" onClick={() => setPickerOpen(true)} title="Reaktion hinzufügen">
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
            {message.replyCount} {message.replyCount === 1 ? 'Antwort' : 'Antworten'}
          </button>
        )}
      </div>

      {/* Aktionsleiste beim Überfahren */}
      <div className="msg__actions">
        {QUICK_EMOJI.slice(0, 3).map((emoji) => (
          <button key={emoji} className="icon-btn icon-btn--sm" onClick={() => react(message.id, emoji)} title={`Mit ${emoji} reagieren`}>
            <span style={{ fontSize: 15 }}>{emoji}</span>
          </button>
        ))}
        <button className="icon-btn icon-btn--sm" onClick={() => setPickerOpen(true)} title="Reaktion wählen"><Smile size={15} /></button>
        {!inThread && (
          <button className="icon-btn icon-btn--sm" onClick={() => openThread(message.id)} title="Im Thread antworten"><MessageSquare size={15} /></button>
        )}
        {hasTranslation ? (
          <button className="icon-btn icon-btn--sm" onClick={() => requestRoundTrip(message.id)} title="Rückübersetzung prüfen"><RefreshCw size={15} /></button>
        ) : (
          <button className="icon-btn icon-btn--sm" onClick={() => requestTranslation(message.id)} title="In meine Sprache übersetzen"><Languages size={15} /></button>
        )}
        <button className="icon-btn icon-btn--sm" onClick={() => setMenuOpen((v) => !v)} title="Mehr"><MoreHorizontal size={15} /></button>

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
              <MenuItem icon={<Bookmark size={14} />} label="Für später merken" onClick={() => { save(message.id, true); setMenuOpen(false); }} />
              <MenuItem icon={<Pin size={14} />} label={message.pinned ? 'Nicht mehr anpinnen' : 'Anpinnen'} onClick={() => { pin(message.id, !message.pinned); setMenuOpen(false); }} />
              <MenuItem icon={<CornerUpLeft size={14} />} label="Text kopieren" onClick={() => { void navigator.clipboard.writeText(message.text); setMenuOpen(false); }} />
              {isMine && <MenuItem icon={<Pencil size={14} />} label="Bearbeiten" onClick={() => { setEditing(true); setMenuOpen(false); }} />}
              {isMine && <MenuItem icon={<Trash2 size={14} />} label="Löschen" danger onClick={() => { deleteMessage(message.id); setMenuOpen(false); }} />}
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

function MenuItem({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 9, width: '100%',
        padding: '7px 10px', borderRadius: 'var(--r-xs)',
        fontSize: 13.5, textAlign: 'left',
        color: danger ? 'var(--rose)' : 'var(--tx-mid)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}{label}
    </button>
  );
}
