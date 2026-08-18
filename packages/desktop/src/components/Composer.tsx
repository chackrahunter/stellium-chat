import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AtSign, BarChart3, Clock, Languages, Loader2, Mic, Paperclip, Send, Smile,
  Sparkles, Wand2, X,
} from 'lucide-react';
import type { Attachment, RewriteTone } from '@stellium/shared';
import { normalizeLang } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { api } from '../net/api.js';
import { EmojiPicker } from './EmojiPicker.jsx';
import { Avatar } from './Avatar.jsx';
import { VoiceRecorder } from './VoiceRecorder.jsx';
import { clsx, fileSize, languageInfo } from '../lib/format.js';

interface Props {
  channelId: string;
  parentId?: string | null;
  placeholder?: string;
  autoFocus?: boolean;
}

type PendingAttachment = Pick<Attachment, 'id' | 'name' | 'mime' | 'size'> & { progress: number };

const TONES: { id: RewriteTone; label: string }[] = [
  { id: 'polish', label: 'Korrigieren' },
  { id: 'formal', label: 'Förmlicher' },
  { id: 'friendly', label: 'Freundlicher' },
  { id: 'concise', label: 'Kürzen' },
  { id: 'bullets', label: 'Stichpunkte' },
];

export function Composer({ channelId, parentId = null, placeholder, autoFocus }: Props) {
  const self = useStore((s) => s.self);
  const channel = useStore((s) => s.channels[channelId]);
  const users = useStore((s) => s.users);
  const ai = useStore((s) => s.ai);
  const smartReplies = useStore((s) => s.smartReplies);

  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [focused, setFocused] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [toneOpen, setToneOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [recording, setRecording] = useState(false);

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  /* Höhe automatisch an den Inhalt anpassen */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  }, [text]);

  useEffect(() => { if (autoFocus) inputRef.current?.focus(); }, [autoFocus, channelId]);

  // Beim Kanalwechsel den gespeicherten Entwurf zurückholen.
  useEffect(() => {
    setText(useStore.getState().draftFor(channelId, parentId));
    setPreview(null);
  }, [channelId, parentId]);

  /* Compose-Vorschau: so kommt die Nachricht bei den anderen an */
  const targetLang = channel?.primaryLanguage ? normalizeLang(channel.primaryLanguage) : null;
  const needsPreview = Boolean(
    self?.composeTargetPreview && targetLang && self && normalizeLang(self.language) !== targetLang && ai?.translation,
  );

  useEffect(() => {
    if (!needsPreview || text.trim().length < 12) { setPreview(null); return; }
    const timer = window.setTimeout(() => {
      setPreviewing(true);
      useStore.getState().composePreview(text, targetLang!, channelId)
        .then((result) => setPreview(result))
        .catch(() => setPreview(null))
        .finally(() => setPreviewing(false));
    }, 900);
    return () => clearTimeout(timer);
  }, [text, needsPreview, targetLang, channelId]);

  /* @-Vervollständigung */
  useEffect(() => {
    const el = inputRef.current;
    if (!el) { setMentionQuery(null); return; }
    const upToCaret = text.slice(0, el.selectionStart ?? text.length);
    const m = /(?:^|\s)@([a-zA-Z0-9_.-]*)$/.exec(upToCaret);
    setMentionQuery(m ? m[1].toLowerCase() : null);
    setMentionIndex(0);
  }, [text]);

  const mentionMatches = mentionQuery === null ? [] : Object.values(users)
    .filter((u) => u.id !== self?.id)
    .filter((u) => u.handle.toLowerCase().startsWith(mentionQuery) || u.displayName.toLowerCase().includes(mentionQuery))
    .slice(0, 6);

  const applyMention = (handle: string) => {
    const el = inputRef.current;
    if (!el) return;
    const caret = el.selectionStart ?? text.length;
    const before = text.slice(0, caret).replace(/@[a-zA-Z0-9_.-]*$/, `@${handle} `);
    const next = before + text.slice(caret);
    setText(next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = before.length;
    });
  };

  /* Dateien */
  const uploadFiles = async (files: FileList | File[]) => {
    for (const file of Array.from(files)) {
      const temp: PendingAttachment = { id: `tmp_${Math.random()}`, name: file.name, mime: file.type, size: file.size, progress: 0 };
      setAttachments((prev) => [...prev, temp]);
      try {
        const { attachment } = await api.upload(file, (fraction) => {
          setAttachments((prev) => prev.map((a) => a.id === temp.id ? { ...a, progress: fraction } : a));
        });
        setAttachments((prev) => prev.map((a) => a.id === temp.id ? { ...attachment, progress: 1 } : a));
      } catch (err) {
        setAttachments((prev) => prev.filter((a) => a.id !== temp.id));
        useStore.getState().toast({ kind: 'error', title: 'Upload fehlgeschlagen', body: (err as Error).message });
      }
    }
  };

  const submit = () => {
    const clean = text.trim();
    const ready = attachments.filter((a) => !a.id.startsWith('tmp_'));
    if (!clean && ready.length === 0) return;
    if (attachments.length !== ready.length) {
      useStore.getState().toast({ kind: 'info', title: 'Upload läuft noch', body: 'Einen Moment, dann geht es raus.' });
      return;
    }

    const command = handleSlashCommand(clean, channelId);
    if (command.handled) { setText(''); return; }

    useStore.getState().sendMessage({
      channelId, text: command.replaceWith ?? clean, parentId,
      attachmentIds: ready.map((a) => a.id),
    });
    setText('');
    setAttachments([]);
    setPreview(null);
    useStore.getState().saveDraft(channelId, parentId, '');
    useStore.getState().clearSmartReplies();
  };

  const applyTone = async (tone: RewriteTone) => {
    if (!text.trim()) return;
    setToneOpen(false);
    setRewriting(true);
    try {
      const result = await useStore.getState().rewrite(text, tone);
      setText(result);
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: 'Umformulieren fehlgeschlagen', body: (err as Error).message });
    } finally {
      setRewriting(false);
      inputRef.current?.focus();
    }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionMatches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setMentionIndex((i) => (i + 1) % mentionMatches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setMentionIndex((i) => (i - 1 + mentionMatches.length) % mentionMatches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); applyMention(mentionMatches[mentionIndex].handle); return; }
      if (e.key === 'Escape') { setMentionQuery(null); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  };

  const canSend = text.trim().length > 0 || attachments.length > 0;

  return (
    <div className="composer-wrap">
      <AnimatePresence>
        {smartReplies.length > 0 && !text && (
          <motion.div
            className="smart-replies"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            style={{ padding: '0 0 var(--sp-2)' }}
          >
            {smartReplies.map((reply, i) => (
              <button key={i} className="smart-reply" onClick={() => { setText(reply.text); inputRef.current?.focus(); }}>
                <Sparkles size={12} className="spark" style={{ color: 'var(--violet-soft)' }} />
                {reply.text}
                <span className="smart-reply__tone">{reply.tone}</span>
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>

      {recording && (
        <VoiceRecorder channelId={channelId} parentId={parentId} onDone={() => setRecording(false)} />
      )}

      <div
        className={clsx('composer', focused && 'composer--focus', dragging && 'composer--drag')}
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length) void uploadFiles(e.dataTransfer.files);
        }}
        style={{ position: 'relative', ...(recording ? { display: 'none' } : {}) }}
      >
        {parentId && (
          <div className="composer__reply">
            <span>Antwort im Thread</span>
            <button className="icon-btn icon-btn--sm" style={{ marginLeft: 'auto' }} onClick={() => useStore.getState().openThread(null)}>
              <X size={13} />
            </button>
          </div>
        )}

        {attachments.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: '10px 14px 0' }}>
            {attachments.map((a) => (
              <div key={a.id} className="att-file" style={{ paddingRight: 8 }}>
                <div className="stack" style={{ minWidth: 0 }}>
                  <span className="att-file__name truncate" style={{ maxWidth: 180 }}>{a.name}</span>
                  <span className="att-file__size">
                    {a.progress < 1 ? `${Math.round(a.progress * 100)} %` : fileSize(a.size)}
                  </span>
                </div>
                <button className="icon-btn icon-btn--sm" onClick={() => setAttachments((p) => p.filter((x) => x.id !== a.id))}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        )}

        <textarea
          ref={inputRef}
          className="composer__input"
          rows={1}
          value={text}
          placeholder={placeholder ?? `Nachricht an ${channel?.kind === 'dm'
            ? users[channel.dmPeerId ?? '']?.displayName ?? '…'
            : `#${channel?.name ?? '…'}`}`}
          onChange={(e) => {
            setText(e.target.value);
            useStore.getState().sendTyping(channelId, parentId);
            useStore.getState().saveDraft(channelId, parentId, e.target.value);
          }}
          onKeyDown={onKeyDown}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onPaste={(e) => {
            const files = Array.from(e.clipboardData.files);
            if (files.length) { e.preventDefault(); void uploadFiles(files); }
          }}
        />

        <div className="composer__bar">
          <input
            ref={fileRef}
            type="file"
            multiple
            hidden
            onChange={(e) => { if (e.target.files) void uploadFiles(e.target.files); e.target.value = ''; }}
          />
          <button className="icon-btn icon-btn--sm" onClick={() => fileRef.current?.click()} title="Datei anhängen">
            <Paperclip size={16} />
          </button>
          <button className="icon-btn icon-btn--sm" onClick={() => setPickerOpen(true)} title="Emoji">
            <Smile size={16} />
          </button>
          <button
            className="icon-btn icon-btn--sm"
            onClick={() => { setText((t) => `${t}@`); inputRef.current?.focus(); }}
            title="Jemanden erwähnen"
          >
            <AtSign size={16} />
          </button>
          <button
            className="icon-btn icon-btn--sm"
            onClick={() => setRecording(true)}
            title="Sprachnachricht aufnehmen"
          >
            <Mic size={16} />
          </button>
          {!parentId && (
            <button
              className="icon-btn icon-btn--sm"
              onClick={() => useStore.getState().setOverlay('poll')}
              title="Umfrage starten"
            >
              <BarChart3 size={16} />
            </button>
          )}

          {ai?.assistant && (
            <div style={{ position: 'relative' }}>
              <button
                className="icon-btn icon-btn--sm"
                onClick={() => setToneOpen((v) => !v)}
                disabled={!text.trim() || rewriting}
                title="Text mit KI überarbeiten"
              >
                {rewriting ? <Loader2 size={16} className="spin" /> : <Wand2 size={16} />}
              </button>
              <AnimatePresence>
                {toneOpen && (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                    style={{
                      position: 'absolute', bottom: '100%', left: 0, marginBottom: 6, zIndex: 20,
                      minWidth: 170, padding: 5, borderRadius: 'var(--r-md)',
                      background: 'var(--bg-elevated)', border: '1px solid var(--line)', boxShadow: 'var(--shadow-md)',
                    }}
                    onMouseLeave={() => setToneOpen(false)}
                  >
                    {TONES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => void applyTone(t.id)}
                        style={{ display: 'block', width: '100%', padding: '7px 10px', borderRadius: 6, textAlign: 'left', fontSize: 13.5 }}
                        onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--bg-hover)'; }}
                        onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                      >{t.label}</button>
                    ))}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          )}

          <button
            className="icon-btn icon-btn--sm"
            onClick={() => setScheduleOpen(true)}
            disabled={!canSend}
            title="Später senden"
          >
            <Clock size={16} />
          </button>

          <span className="spacer" />

          {previewing && <Loader2 size={13} className="spin muted" />}
          <span className="muted" style={{ fontSize: 11.5, marginRight: 6 }}>
            {text.length > 0 && `${text.length}`}
          </span>

          <motion.button
            className="send-btn"
            whileTap={{ scale: 0.92 }}
            disabled={!canSend}
            onClick={submit}
            title="Senden (Enter)"
          >
            <Send size={16} />
          </motion.button>
        </div>

        <AnimatePresence>
          {pickerOpen && (
            <EmojiPicker
              onPick={(emoji) => { setText((t) => t + emoji); setPickerOpen(false); inputRef.current?.focus(); }}
              onClose={() => setPickerOpen(false)}
            />
          )}
        </AnimatePresence>

        <AnimatePresence>
          {mentionMatches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
              style={{
                position: 'absolute', bottom: '100%', left: 12, marginBottom: 8, zIndex: 25,
                minWidth: 268, padding: 5, borderRadius: 'var(--r-md)',
                background: 'var(--bg-elevated)', border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-md)',
              }}
            >
              {mentionMatches.map((u, i) => (
                <button
                  key={u.id}
                  className="result"
                  data-active={i === mentionIndex}
                  style={{ padding: '6px 9px' }}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => applyMention(u.handle)}
                >
                  <Avatar user={u} size={26} showPresence />
                  <div className="result__main">
                    <div className="result__title">{u.displayName}</div>
                    <div className="result__sub">@{u.handle} · {languageInfo(u.language).flag}</div>
                  </div>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {preview && needsPreview && (
          <motion.div
            className="composer__preview"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="composer__preview-head">
              <Languages size={11} />
              So kommt es in {languageInfo(targetLang!).native} an
            </div>
            {preview}
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {scheduleOpen && (
          <ScheduleDialog
            onClose={() => setScheduleOpen(false)}
            onPick={(sendAt) => {
              useStore.getState().schedule({ channelId, text: text.trim(), sendAt, parentId });
              setText('');
              setScheduleOpen(false);
              useStore.getState().toast({ kind: 'ok', title: 'Geplant', body: 'Die Nachricht geht zur gewählten Zeit raus.' });
            }}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Slash-Befehle ──────────────────────────────────────────── */

interface SlashResult {
  /** true = der Befehl wurde ausgeführt, es geht keine Nachricht raus. */
  handled: boolean;
  /** Ersetzt den Text, statt ihn als Befehl zu behandeln. */
  replaceWith?: string;
}

function handleSlashCommand(text: string, channelId: string): SlashResult {
  if (!text.startsWith('/')) return { handled: false };
  const [cmd, ...rest] = text.slice(1).split(/\s+/);
  const arg = rest.join(' ').trim();
  const store = useStore.getState();

  switch (cmd.toLowerCase()) {
    case 'lang':
    case 'sprache':
      if (arg) {
        store.updatePrefs({ language: normalizeLang(arg) });
        store.toast({ kind: 'ok', title: 'Sprache geändert', body: `Alles erscheint jetzt auf ${languageInfo(arg).native}.` });
      }
      return { handled: true };
    case 'dnd':
      store.setStatus('dnd', '🔕', arg || 'Bitte nicht stören');
      store.toast({ kind: 'ok', title: 'Bitte nicht stören ist an' });
      return { handled: true };
    case 'aktiv':
    case 'active':
      store.setStatus('online', null, null);
      return { handled: true };
    case 'weg':
    case 'away':
      store.setStatus('away', '🚶', arg || null);
      return { handled: true };
    case 'summary':
    case 'zusammenfassung':
      store.runCatchup(channelId);
      return { handled: true };
    case 'glossar':
    case 'glossary':
      store.setOverlay('glossary');
      return { handled: true };
    case 'shrug':
      return { handled: false, replaceWith: `¯\\_(ツ)_/¯${arg ? ` ${arg}` : ''}` };
    default:
      store.toast({ kind: 'error', title: `Unbekannter Befehl /${cmd}`, body: 'Bekannt: /lang, /dnd, /weg, /aktiv, /summary, /glossar, /shrug' });
      return { handled: true };
  }
}

/* ── Planungsdialog ─────────────────────────────────────────── */

function ScheduleDialog({ onClose, onPick }: { onClose: () => void; onPick: (sendAt: number) => void }) {
  const presets = [
    { label: 'In 30 Minuten', ms: 30 * 60_000 },
    { label: 'In 2 Stunden', ms: 2 * 3600_000 },
    { label: 'Morgen früh, 9:00', ms: msUntilTomorrow(9) },
    { label: 'Montag, 9:00', ms: msUntilNextMonday(9) },
  ];
  const [custom, setCustom] = useState('');

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        className="panel"
        style={{ width: 'min(430px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          <Clock size={18} />
          <h2>Später senden</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={16} /></button>
        </div>
        <div className="panel__body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13 }}>
            Praktisch über Zeitzonen hinweg — die Nachricht erreicht die anderen zur Arbeitszeit.
          </p>
          <div className="stack gap-2">
            {presets.map((p) => (
              <button key={p.label} className="btn btn--block" onClick={() => onPick(Date.now() + p.ms)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
            <label className="field__label">Eigener Zeitpunkt</label>
            <input
              className="input"
              type="datetime-local"
              value={custom}
              onChange={(e) => setCustom(e.target.value)}
            />
          </div>
          <button
            className="btn btn--primary btn--block"
            disabled={!custom}
            onClick={() => {
              const ts = new Date(custom).getTime();
              if (Number.isFinite(ts) && ts > Date.now()) onPick(ts);
            }}
          >
            Planen
          </button>
        </div>
      </motion.div>
    </div>
  );
}

function msUntilTomorrow(hour: number): number {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(hour, 0, 0, 0);
  return d.getTime() - Date.now();
}

function msUntilNextMonday(hour: number): number {
  const d = new Date();
  const days = (8 - d.getDay()) % 7 || 7;
  d.setDate(d.getDate() + days);
  d.setHours(hour, 0, 0, 0);
  return d.getTime() - Date.now();
}
