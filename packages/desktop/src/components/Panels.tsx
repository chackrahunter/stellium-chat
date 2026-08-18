import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  CheckCircle2, Hash, Loader2, Lock, Plus, Sparkles, Trash2, Users, X,
} from 'lucide-react';
import { LANGUAGES, type GlossaryEntry } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { api } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo, localTimeFor, relativeTime } from '../lib/format.js';

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
    <Shell title="Neuer Kanal" icon={<Hash size={18} />} onClose={onClose} width={480}>
      <div className="field">
        <label className="field__label">Name</label>
        <input
          className="input"
          value={name}
          autoFocus
          placeholder="z.B. produkt-launch"
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
        />
        <p className="field__hint">Kleinbuchstaben und Bindestriche — Leerzeichen werden automatisch ersetzt.</p>
      </div>

      <div className="field">
        <label className="field__label">Thema (optional)</label>
        <input className="input" value={topic} placeholder="Worum geht es hier?" onChange={(e) => setTopic(e.target.value)} />
      </div>

      <div className="field">
        <label className="field__label">Kanalsprache</label>
        <select className="select" value={lang} onChange={(e) => setLang(e.target.value)}>
          <option value="">Automatisch erkennen</option>
          {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
        </select>
        <p className="field__hint">
          Legt fest, in welcher Sprache dir beim Schreiben die Vorschau angezeigt wird.
          Gelesen wird trotzdem jede:r in der eigenen Sprache.
        </p>
      </div>

      <div className="field">
        <label className="field__label">Sichtbarkeit</label>
        <div className="hstack gap-2">
          <button className={`btn${kind === 'public' ? ' btn--primary' : ''}`} onClick={() => setKind('public')}>
            <Hash size={14} /> Öffentlich
          </button>
          <button className={`btn${kind === 'private' ? ' btn--primary' : ''}`} onClick={() => setKind('private')}>
            <Lock size={14} /> Privat
          </button>
        </div>
      </div>

      <button className="btn btn--primary btn--block" onClick={submit} disabled={!name.trim()}>
        Kanal anlegen
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
    <Shell title="Team" icon={<Users size={18} />} onClose={onClose} width={560}>
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
                {u.id === self?.id && <span className="msg__tag" style={{ marginLeft: 8 }}>du</span>}
                {u.statusEmoji && <span style={{ marginLeft: 8 }}>{u.statusEmoji}</span>}
              </div>
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
      .catch(() => useStore.getState().toast({ kind: 'error', title: 'Glossar konnte nicht geladen werden' }))
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
      useStore.getState().toast({ kind: 'ok', title: 'Begriff gespeichert' });
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: 'Speichern fehlgeschlagen', body: (err as Error).message });
    }
  };

  const remove = async (id: string) => {
    try {
      const { entries: next } = await api.removeGlossary(id);
      setEntries(next);
    } catch { /* Fehler ist hier nicht kritisch */ }
  };

  return (
    <Shell title="Glossar" icon={<Sparkles size={18} />} onClose={onClose} width={620}>
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
        Begriffe, die die Übersetzung nicht anfassen darf — Produktnamen, interne Kürzel, Eigennamen.
        Wahlweise mit fester Übersetzung je Sprache.
      </p>

      <div style={{ padding: 'var(--sp-3)', borderRadius: 'var(--r-md)', border: '1px solid var(--line)', marginBottom: 'var(--sp-4)' }}>
        <div className="hstack gap-2" style={{ marginBottom: 'var(--sp-2)' }}>
          <input className="input" placeholder="Begriff, z.B. Sternenkarte" value={term} onChange={(e) => setTerm(e.target.value)} />
          <button className="btn btn--primary" onClick={() => void add()} disabled={!term.trim()}>
            <Plus size={15} /> Hinzufügen
          </button>
        </div>
        <input className="input" placeholder="Notiz (optional)" value={note} onChange={(e) => setNote(e.target.value)} style={{ marginBottom: 'var(--sp-2)' }} />
        <div className="row" style={{ borderBottom: 0, paddingBottom: 0 }}>
          <div className="row__main">
            <div className="row__title">Unverändert lassen</div>
            <div className="row__sub">Der Begriff bleibt in jeder Sprache exakt gleich</div>
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
              {!entry.translations && <span className="msg__tag" style={{ marginLeft: 8 }}>unverändert</span>}
            </div>
            <div className="row__sub">
              {entry.note ?? ''}
              {entry.translations && ` · ${Object.entries(entry.translations).map(([k, v]) => `${languageInfo(k).flag} ${v}`).join('  ')}`}
            </div>
          </div>
          <button className="icon-btn" onClick={() => void remove(entry.id)} title="Entfernen">
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
    <Shell title="Was habe ich verpasst?" icon={<Sparkles size={18} />} onClose={onClose} width={640}>
      {!ai?.assistant && (
        <p className="muted">
          Für Zusammenfassungen braucht der Server einen Groq-Schlüssel.
          {ai?.note ? ` ${ai.note}` : ''}
        </p>
      )}

      {ai?.assistant && !summary && !loading && (
        <div className="stack gap-3">
          <p className="muted" style={{ margin: 0 }}>
            Fasst alles zusammen, was du seit deinem letzten Besuch in
            {' '}<b>{channels[activeChannelId ?? '']?.name ? `#${channels[activeChannelId!].name}` : 'diesem Kanal'}</b>{' '}
            verpasst hast — in deiner Sprache, egal in welcher es geschrieben wurde.
          </p>
          <button
            className="btn btn--primary"
            onClick={() => activeChannelId && useStore.getState().runCatchup(activeChannelId)}
            disabled={!activeChannelId}
          >
            <Sparkles size={15} /> Zusammenfassen
          </button>
        </div>
      )}

      {loading && (
        <div className="hstack gap-3" style={{ padding: 'var(--sp-5) 0' }}>
          <Loader2 size={20} className="spin" style={{ color: 'var(--violet-soft)' }} />
          <span className="muted">Lese die Nachrichten…</span>
        </div>
      )}

      {summary && (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
          <div className="ai-card">
            <div className="ai-card__head"><Sparkles size={12} /> {summary.messageCount} Nachrichten</div>
            <h3>{summary.headline}</h3>
            {summary.bullets.length > 0 && (
              <ul className="ai-list">{summary.bullets.map((b, i) => <li key={i}>{b}</li>)}</ul>
            )}

            {summary.decisions.length > 0 && (
              <div className="ai-section">
                <div className="ai-section__title">Entscheidungen</div>
                <ul className="ai-list">{summary.decisions.map((d, i) => <li key={i}>{d}</li>)}</ul>
              </div>
            )}

            {summary.actionItems.length > 0 && (
              <div className="ai-section">
                <div className="ai-section__title">Aufgaben</div>
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
            Automatisch erstellt — bei wichtigen Details lieber im Verlauf nachlesen.
          </p>
        </motion.div>
      )}
    </Shell>
  );
}

/* ── Gemeinsame Hülle ───────────────────────────────────────── */

function Shell({ title, icon, onClose, width, children }: {
  title: string; icon: React.ReactNode; onClose: () => void; width: number; children: React.ReactNode;
}) {
  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        className="panel"
        style={{ width: `min(${width}px, 100%)` }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        transition={{ duration: 0.19, ease: [0.16, 1, 0.3, 1] }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          {icon}
          <h2>{title}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="panel__body">{children}</div>
      </motion.div>
    </div>
  );
}
