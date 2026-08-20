import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion } from 'framer-motion';
import {
  CheckCircle2, Hash, Loader2, Lock, Plus, Sparkles, Trash2, Users, X,
} from 'lucide-react';
import { LANGUAGES, type GlossaryEntry } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { api } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { t } from '../i18n/index.js';
import { kanalName, languageInfo, localTimeFor, relativeTime } from '../lib/format.js';

/* ── Neuer Kanal ────────────────────────────────────────────── */

export function NewChannelDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [topic, setTopic] = useState('');
  const [kind, setKind] = useState<'public' | 'private'>('public');
  const [lang, setLang] = useState('');

  const submit = () => {
    if (!name.trim()) return;
    useStore.getState().createChannel({
      kind, name: name.trim(), topic: topic.trim() || undefined,
      primaryLanguage: lang || null,
    });
  };

  return (
    <Shell title={t('channel.newTitle')} icon={<Hash size={18} />} onClose={onClose} width={480}>
      <div className="field">
        <label className="field__label">{t('channel.name')}</label>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder={t('channel.namePlaceholder')}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <p className="field__hint">{t('channel.nameHint')}</p>
      </div>

      <div className="field">
        <label className="field__label">{t('channel.topicOptional')}</label>
        <input className="input" value={topic} placeholder={t('channel.topicPlaceholder')} onChange={(e) => setTopic(e.target.value)} />
      </div>

      <div className="field">
        <label className="field__label">{t('channel.language')}</label>
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="">{t('channel.autoDetect')}</option>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
        </select>
        <p className="field__hint">{t('channel.languageHint')}</p>
      </div>

      <div className="field">
        <label className="field__label">{t('channel.visibility')}</label>
        <div className="hstack gap-2">
          <button className={`btn${kind === 'public' ? ' btn--primary' : ''}`} onClick={() => setKind('public')}>
            <Hash size={14} /> {t('channel.public')}
          </button>
          <button className={`btn${kind === 'private' ? ' btn--primary' : ''}`} onClick={() => setKind('private')}>
            <Lock size={14} /> {t('channel.private')}
          </button>
        </div>
      </div>

      <button className="btn btn--primary btn--block" onClick={submit} disabled={!name.trim()}>
        {t('channel.create')}
      </button>
    </Shell>
  );
}

/* ── Team ───────────────────────────────────────────────────── */

export function PeoplePanel({ onClose }: { onClose: () => void }) {
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const { openDm } = useStore.getState();

  const list = Object.values(users)
    .filter((u) => !u.disabled || u.id === self?.id)
    .sort((a, b) => {
    const rank = (s: string) => (s === 'online' ? 0 : s === 'away' ? 1 : s === 'dnd' ? 2 : 3);
    return rank(a.status) - rank(b.status) || a.displayName.localeCompare(b.displayName, 'de');
  });

  return (
    <Shell title={t('people.title')} icon={<Users size={18} />} onClose={onClose} width={560}>
      {list.map((u) => {
        const { time, offHours } = localTimeFor(u.timezone);
        return (
          <button
            key={u.id}
            className="result"
            onClick={() => { if (u.id !== self?.id) openDm(u.id); }}
          >
            <Avatar user={u} size={38} showPresence />
            <div className="result__main">
              <div className="result__title">
                {u.displayName}
                {u.id === self?.id && <span className="msg__tag" style={{ marginLeft: 8 }}>{t('common.you')}</span>}
                {u.statusEmoji && <span style={{ marginLeft: 8 }}>{u.statusEmoji}</span>}
              </div>
              {/* Die Meldung selbst, nicht nur ihr Zeichen. Ein 🍽️ allein neben
                  dem Namen sagt niemandem „Mittagspause" — und genau dafür
                  schreibt man sie. Ausgeschrieben stand sie bisher nur in der
                  Profilkarte, die man erst öffnen muss. */}
              {u.statusText && <div className="result__sub">{u.statusText}</div>}
              <div className="result__sub">
                @{u.handle}{u.title ? ` · ${u.title}` : ''} · {languageInfo(u.language).flag} {languageInfo(u.language).native}
                {time && ` · ${offHours ? '🌙' : '🕒'} ${time}`}
              </div>
            </div>
            {u.status === 'offline' && u.lastSeenAt && (
              <span className="muted" style={{ fontSize: 11.5 }}>{relativeTime(u.lastSeenAt)}</span>
            )}
          </button>
        );
      })}
    </Shell>
  );
}

/* ── Glossar ────────────────────────────────────────────────── */

export function GlossaryPanel({ onClose }: { onClose: () => void }) {
  const [entries, setEntries] = useState<GlossaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [term, setTerm] = useState('');
  const [note, setNote] = useState('');
  const [keepAsIs, setKeepAsIs] = useState(true);
  const [translations, setTranslations] = useState<Record<string, string>>({});

  useEffect(() => {
    api.glossary()
      .then((r) => setEntries(r.entries))
      .catch(() => useStore.getState().toast({ kind: 'error', title: t('glossary.loadFailed') }))
      .finally(() => setLoading(false));
  }, []);

  const add = async () => {
    if (!term.trim()) return;
    try {
      const { entries: next } = await api.addGlossary({
        term: term.trim(),
        translations: keepAsIs ? null : translations,
        note: note.trim() || undefined,
      });
      setEntries(next);
      setTerm(''); setNote(''); setTranslations({});
      useStore.getState().toast({ kind: 'ok', title: t('glossary.saved') });
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('glossary.saveFailed'), body: (err as Error).message });
    }
  };

  const remove = async (id: string) => {
    try {
      const { entries: next } = await api.removeGlossary(id);
      setEntries(next);
    } catch { /* Fehler ist hier nicht kritisch */ }
  };

  return (
    <Shell title={t('glossary.title')} icon={<Sparkles size={18} />} onClose={onClose} width={620}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>{t('glossary.lead')}</p>

      <div style={{ padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', marginBottom: 'var(--sp-4)' }}>
        <div className="hstack gap-2" style={{ marginBottom: 'var(--sp-2)' }}>
          <input className="input" placeholder={t('glossary.termPlaceholder')} value={term} onChange={(e) => setTerm(e.target.value)} />
          <button className="btn btn--primary" onClick={() => void add()} disabled={!term.trim()}>
            <Plus size={15} /> {t('glossary.add')}
          </button>
        </div>
        <input className="input" placeholder={t('glossary.notePlaceholder')} value={note} onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 'var(--sp-2)' }} />
        <div className="row" style={{ borderBottom: 0, paddingBottom: 0 }}>
          <div className="row__main">
            <div className="row__title">{t('glossary.keepAsIs')}</div>
            <div className="row__sub">{t('glossary.keepAsIsHint')}</div>
          </div>
          <button className="switch" role="switch" aria-checked={keepAsIs} onClick={() => setKeepAsIs((v) => !v)} />
        </div>
        {!keepAsIs && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginTop: 'var(--sp-3)' }}>
            {LANGUAGES.slice(0, 8).map((l) => (
              <div key={l.code} className="hstack gap-2">
                <span style={{ width: 34, fontSize: 13 }}>{l.flag}</span>
                <input
                  className="input"
                  style={{ padding: '6px 9px', fontSize: 13 }}
                  placeholder={l.native}
                  value={translations[l.code] ?? ''}
                  onChange={(e) => setTranslations((t) => ({ ...t, [l.code]: e.target.value }))}
                />
              </div>
            ))}
          </div>
        )}
      </div>

      {loading && <Loader2 size={18} className="spin muted" />}
      {entries.map((entry) => (
        <div key={entry.id} className="row">
          <div className="row__main">
            <div className="row__title">
              {entry.term}
              {!entry.translations && <span className="msg__tag" style={{ marginLeft: 8 }}>{t('glossary.unchanged')}</span>}
            </div>
            <div className="row__sub">
              {entry.note ?? ''}
              {entry.translations && ` · ${Object.entries(entry.translations).map(([k, v]) => `${languageInfo(k).flag} ${v}`).join('  ')}`}
            </div>
          </div>
          <button className="icon-btn" onClick={() => void remove(entry.id)} title={t('glossary.remove')}>
            <Trash2 size={15} />
          </button>
        </div>
      ))}
    </Shell>
  );
}

/* ── Catch-up ───────────────────────────────────────────────── */

export function CatchupPanel({ onClose }: { onClose: () => void }) {
  const summary = useStore((s) => s.catchup);
  const loading = useStore((s) => s.catchupLoading);
  const users = useStore((s) => s.users);
  const channels = useStore((s) => s.channels);
  const activeChannelId = useStore((s) => s.activeChannelId);
  const ai = useStore((s) => s.ai);

  return (
    <Shell title={t('catchup.title')} icon={<Sparkles size={18} />} onClose={onClose} width={640}>
      {!ai?.assistant && (
        <p className="muted">
          {t('catchup.needsKey')}
          {ai?.note ? ` ${ai.note}` : ''}
        </p>
      )}

      {ai?.assistant && !summary && !loading && (
        <div className="stack gap-3">
          <p className="muted" style={{ margin: 0 }}>
            {t('catchup.lead', {
              kanal: channels[activeChannelId ?? '']
                ? `#${kanalName(channels[activeChannelId!])}`
                : t('catchup.thisChannel'),
            })}
          </p>
          <button
            className="btn btn--primary"
            onClick={() => activeChannelId && useStore.getState().runCatchup(activeChannelId)}
            disabled={!activeChannelId}
          >
            <Sparkles size={15} /> {t('catchup.run')}
          </button>
        </div>
      )}

      {loading && (
        <div className="hstack gap-3" style={{ padding: 'var(--sp-5) 0' }}>
          <Loader2 size={20} className="spin" style={{ color: 'var(--violet-soft)' }} />
          <span className="muted">{t('catchup.reading')}</span>
        </div>
      )}

      {summary && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="ai-card">
            <div className="ai-card__head">
              <Sparkles size={12} /> {t('catchup.messages', { n: summary.messageCount })}
            </div>
            {/* Bei nichts Neuem den eigenen Text nehmen: die Überschrift vom
                Server ist in diesem Fall nicht übersetzt. */}
            <h3>{summary.messageCount === 0 ? t('catchup.nothing') : summary.headline}</h3>
            {summary.bullets.length > 0 && (
              <ul className="ai-list">{summary.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}

            {summary.decisions.length > 0 && (
              <div className="ai-section">
                <div className="ai-section__title">{t('catchup.decisions')}</div>
                <ul className="ai-list">{summary.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}

            {summary.actionItems.length > 0 && (
              <div className="ai-section">
                <div className="ai-section__title">{t('catchup.tasks')}</div>
                {summary.actionItems.map((a, i) => (
                  <div key={i} className="ai-task">
                    <CheckCircle2 size={15} style={{ color: 'var(--mint)', flex: 'none', marginTop: 1 }} />
                    <div>
                      {a.text}
                      {a.assigneeId && users[a.assigneeId] && (
                        <span className="muted" style={{ marginLeft: 6, fontSize: 12 }}>
                          → {users[a.assigneeId].displayName}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="muted" style={{ fontSize: 11.5 }}>
            {t('catchup.disclaimer')}
          </p>
        </motion.div>
      )}
    </Shell>
  );
}

/* ── Gemeinsame Hülle ───────────────────────────────────────── */

/**
 * Wie viele Fenster gerade übereinander liegen. Escape darf immer nur das
 * oberste schließen — sonst reißt ein Klick auf Escape in einem Unterdialog
 * gleich das ganze Fenster darunter mit zu.
 */
let stapel = 0;

export function Shell({ title, icon, onClose, width, subtitle, actions, children }: {
  title: string; icon: React.ReactNode; onClose: () => void; width: number;
  subtitle?: string; actions?: React.ReactNode; children: React.ReactNode;
}) {
  const ebene = useRef(0);
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten);

  useEffect(() => {
    stapel += 1;
    ebene.current = stapel;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || ebene.current !== stapel) return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    // Capture, damit die allgemeine Escape-Behandlung der App nicht zuerst greift.
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      stapel -= 1;
    };
  }, [onClose]);

  // Am <body>, nicht dort wo es im Baum steht. Fenster über Fenstern — etwa
  // die Einzelansicht einer Aufgabe über dem Brett — steckten sonst im
  // äußeren fest: dessen backdrop-filter macht jede feste Positionierung
  // darin zunichte, und sein overflow schnitt sie oben und unten ab.
  return createPortal(
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        className="panel"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        style={{ width: `min(${width}px, 100%)` }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: 0.19, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          {icon}
          <div style={{ minWidth: 0 }}>
            <h2>{title}</h2>
            {subtitle && <p className="panel__sub">{subtitle}</p>}
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
            {actions}
            <button className="icon-btn" onClick={onClose}><X size={17} /></button>
          </div>
        </div>
        <div className="panel__body">{children}</div>
      </motion.div>
    </div>,
    document.body,
  );
}
