import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, Cpu, Globe, Loader2, LogOut, Palette, Server, Sparkles, User, Volume2, X } from 'lucide-react';
import { LANGUAGES, type AiModelInfo } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { api, serverUrl, setServerUrl } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo } from '../lib/format.js';

type Tab = 'profil' | 'sprache' | 'modelle' | 'benachrichtigungen' | 'darstellung' | 'server';

export function Settings({ onClose }: { onClose: () => void }) {
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const { updatePrefs, logout } = useStore.getState();
  const [tab, setTab] = useState<Tab>('sprache');
  const [server, setServer] = useState(serverUrl());

  if (!self) return null;

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        className="panel panel--wide"
        style={{ maxHeight: '82vh' }}
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.97 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          <Avatar user={self} size={36} showPresence />
          <div>
            <h2>{self.displayName}</h2>
            <div className="muted" style={{ fontSize: 12.5 }}>@{self.handle} · {self.title ?? 'Team Stellium'}</div>
          </div>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>

        <div className="tabs">
          <Tabs tab={tab} setTab={setTab} />
        </div>

        <div className="panel__body">
          {tab === 'sprache' && (
            <>
              <div className="field">
                <label className="field__label">Meine Anzeigesprache</label>
                <select
                  className="select"
                  value={self.language}
                  onChange={(e) => updatePrefs({ language: e.target.value })}
                >
                  {LANGUAGES.map((l) => (
                    <option key={l.code} value={l.code}>{l.flag} {l.native} ({l.name})</option>
                  ))}
                </select>
                <p className="field__hint">
                  Alles, was in einer anderen Sprache geschrieben wird, erscheint für dich automatisch
                  auf {languageInfo(self.language).native}. Das Original bleibt einen Klick entfernt.
                </p>
              </div>

              <Row
                title="Live-Übersetzung"
                sub="Eingehende Nachrichten sofort in meine Sprache übersetzen"
                checked={self.autoTranslate}
                onChange={(v) => updatePrefs({ autoTranslate: v })}
              />
              <Row
                title="Vorschau vor dem Senden"
                sub="Zeigt beim Tippen, wie deine Nachricht in der Kanalsprache ankommt"
                checked={self.composeTargetPreview}
                onChange={(v) => updatePrefs({ composeTargetPreview: v })}
              />

              <div className="field" style={{ marginTop: 'var(--sp-4)' }}>
                <label className="field__label">Wie soll übersetzt werden?</label>
                <div className="hstack gap-2">
                  {([
                    ['fast', 'Schnell', 'Kleines Modell, Antwort in Sekundenbruchteilen'],
                    ['balanced', 'Ausgewogen', 'Kurzes schnell, Längeres gründlich'],
                    ['accurate', 'Genau', 'Immer das große Modell'],
                  ] as const).map(([value, label, hint]) => (
                    <button
                      key={value}
                      className={`btn${self.translationSpeed === value ? ' btn--primary' : ''}`}
                      title={hint}
                      onClick={() => updatePrefs({ translationSpeed: value })}
                    >{label}</button>
                  ))}
                </div>
              </div>

              <div className="ai-card" style={{ marginTop: 'var(--sp-4)' }}>
                <div className="ai-card__head"><Sparkles size={12} /> Übersetzungs-Dienst</div>
                <div style={{ fontSize: 14, marginBottom: ai?.model ? 8 : 0 }}>
                  <b>{ai?.provider ?? 'unbekannt'}</b>
                </div>

                {ai?.model && (
                  <div className="stack gap-1" style={{ fontSize: 13 }}>
                    <div className="hstack gap-2">
                      <span className="muted" style={{ minWidth: 148 }}>Übersetzung, Zusammenfassung</span>
                      <span className="mono">{ai.model}</span>
                    </div>
                    {ai.fastModel && ai.fastModel !== ai.model && (
                      <div className="hstack gap-2">
                        <span className="muted" style={{ minWidth: 148 }}>Antwortvorschläge</span>
                        <span className="mono">{ai.fastModel}</span>
                      </div>
                    )}
                  </div>
                )}

                {ai?.modelSource && (
                  <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
                    {ai.modelSource === 'auto'
                      ? `Automatisch gewählt aus ${ai.modelsAvailable ?? '?'} Modellen, die ${ai.provider} gerade anbietet. Der Server sieht alle sechs Stunden nach, ob es etwas Besseres gibt.`
                      : ai.modelSource === 'pinned'
                        ? 'Fest in der .env eingetragen. Lösche GROQ_MODEL, damit der Server wieder selbst wählt.'
                        : 'Standardwerte — die Modell-Liste war beim Start nicht abrufbar.'}
                  </p>
                )}

                {ai?.note && <p className="muted" style={{ fontSize: 12.5, margin: '6px 0 0' }}>{ai.note}</p>}
              </div>
            </>
          )}

          {tab === 'profil' && (
            <>
              <div className="field">
                <label className="field__label">Anzeigename</label>
                <input
                  className="input"
                  defaultValue={self.displayName}
                  onBlur={(e) => { const v = e.target.value.trim(); if (v && v !== self.displayName) updatePrefs({ displayName: v }); }}
                />
              </div>
              <div className="field">
                <label className="field__label">Rolle / Titel</label>
                <input
                  className="input"
                  defaultValue={self.title ?? ''}
                  placeholder="z.B. Backend Engineer"
                  onBlur={(e) => updatePrefs({ title: e.target.value.trim() || null })}
                />
              </div>
              <div className="field">
                <label className="field__label">Zeitzone</label>
                <select className="select" value={self.timezone} onChange={(e) => updatePrefs({ timezone: e.target.value })}>
                  {TIMEZONES.map((tz) => <option key={tz} value={tz}>{tz}</option>)}
                </select>
                <p className="field__hint">Kolleg:innen sehen dann deine Ortszeit — hilfreich, bevor jemand um 23 Uhr schreibt.</p>
              </div>
              <button className="btn btn--danger" onClick={() => { logout(); onClose(); }}>
                <LogOut size={15} /> Abmelden
              </button>
            </>
          )}

          {tab === 'modelle' && <ModelPicker />}

          {tab === 'benachrichtigungen' && (
            <>
              <div className="field">
                <label className="field__label">Benachrichtigen bei</label>
                <select
                  className="select"
                  value={self.notifyOn}
                  onChange={(e) => updatePrefs({ notifyOn: e.target.value as typeof self.notifyOn })}
                >
                  <option value="all">Allen neuen Nachrichten</option>
                  <option value="mentions">Nur Erwähnungen und DMs</option>
                  <option value="none">Nie</option>
                </select>
              </div>
              <div className="field">
                <label className="field__label">Klang</label>
                <select
                  className="select"
                  value={self.notificationSound}
                  onChange={(e) => updatePrefs({ notificationSound: e.target.value })}
                >
                  <option value="ping">Ping</option>
                  <option value="blip">Blip</option>
                  <option value="chime">Glocke</option>
                  <option value="aus">Kein Ton</option>
                </select>
              </div>

              <div className="field">
                <label className="field__label">Ruhezeiten</label>
                <div className="hstack gap-2">
                  <input
                    className="input" type="time" style={{ maxWidth: 150 }}
                    value={minutesToTime(self.quietHoursStart)}
                    onChange={(e) => updatePrefs({ quietHoursStart: timeToMinutes(e.target.value) })}
                  />
                  <span className="muted">bis</span>
                  <input
                    className="input" type="time" style={{ maxWidth: 150 }}
                    value={minutesToTime(self.quietHoursEnd)}
                    onChange={(e) => updatePrefs({ quietHoursEnd: timeToMinutes(e.target.value) })}
                  />
                  <button
                    className="btn btn--ghost"
                    onClick={() => updatePrefs({ quietHoursStart: null, quietHoursEnd: null })}
                  >Aus</button>
                </div>
                <p className="field__hint">
                  In dieser Zeit bleibt es still. Direkte Erwähnungen kommen trotzdem durch —
                  damit dich niemand im Notfall nicht erreicht.
                </p>
              </div>
            </>
          )}

          {tab === 'darstellung' && (
            <>
              <div className="field">
                <label className="field__label">Erscheinungsbild</label>
                <div className="hstack gap-2">
                  {(['dark', 'light', 'system'] as const).map((t) => (
                    <button
                      key={t}
                      className={`btn${self.theme === t ? ' btn--primary' : ''}`}
                      onClick={() => updatePrefs({ theme: t })}
                    >
                      {t === 'dark' ? 'Dunkel' : t === 'light' ? 'Hell' : 'Systemvorgabe'}
                    </button>
                  ))}
                </div>
              </div>
              <div className="field">
                <label className="field__label">Dichte</label>
                <div className="hstack gap-2">
                  {(['comfortable', 'compact'] as const).map((d) => (
                    <button
                      key={d}
                      className={`btn${self.density === d ? ' btn--primary' : ''}`}
                      onClick={() => updatePrefs({ density: d })}
                    >{d === 'comfortable' ? 'Luftig' : 'Kompakt'}</button>
                  ))}
                </div>
              </div>
            </>
          )}

          {tab === 'server' && (
            <>
              <div className="field">
                <label className="field__label">Server-Adresse</label>
                <input className="input" value={server} onChange={(e) => setServer(e.target.value)} placeholder="http://localhost:8787" />
                <p className="field__hint">
                  Nach dem Ändern meldet sich die App neu an. Für den Firmenbetrieb zeigt das auf euren
                  eigenen Stellium-Server.
                </p>
              </div>
              <button
                className="btn btn--primary"
                onClick={() => { setServerUrl(server); logout(); onClose(); }}
              >
                <Server size={15} /> Speichern und neu anmelden
              </button>
            </>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const items: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: 'sprache', label: 'Sprache & Übersetzung', icon: <Globe size={14} /> },
    { id: 'modelle', label: 'KI-Modell', icon: <Cpu size={14} /> },
    { id: 'profil', label: 'Profil', icon: <User size={14} /> },
    { id: 'benachrichtigungen', label: 'Benachrichtigungen', icon: <Bell size={14} /> },
    { id: 'darstellung', label: 'Darstellung', icon: <Palette size={14} /> },
    { id: 'server', label: 'Server', icon: <Server size={14} /> },
  ];
  return (
    <>
      {items.map((it) => (
        <button key={it.id} className="tab" aria-selected={tab === it.id} onClick={() => setTab(it.id)}>
          <span className="hstack gap-2">{it.icon}{it.label}</span>
        </button>
      ))}
    </>
  );
}

function Row({ title, sub, checked, onChange }: { title: string; sub: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="row">
      <div className="row__main">
        <div className="row__title">{title}</div>
        <div className="row__sub">{sub}</div>
      </div>
      <button className="switch" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} />
    </div>
  );
}

function minutesToTime(minutes: number | null): string {
  if (minutes == null) return '';
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function timeToMinutes(value: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const TIMEZONES = [
  'Europe/Berlin', 'Europe/London', 'Europe/Paris', 'Europe/Madrid', 'Europe/Warsaw',
  'Europe/Lisbon', 'Europe/Athens', 'Europe/Istanbul', 'Europe/Kyiv', 'Europe/Moscow',
  'America/New_York', 'America/Chicago', 'America/Denver', 'America/Los_Angeles', 'America/Sao_Paulo',
  'Asia/Dubai', 'Asia/Kolkata', 'Asia/Singapore', 'Asia/Shanghai', 'Asia/Tokyo', 'Asia/Seoul',
  'Australia/Sydney', 'Pacific/Auckland', 'UTC',
];


/* ── Modellauswahl ────────────────────────────────────────────── */

function ModelPicker() {
  const self = useStore((s) => s.self);
  const ai = useStore((s) => s.ai);
  const { selectModels } = useStore.getState();

  const [models, setModels] = useState<AiModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.models()
      .then((r) => setModels(r.models))
      .catch(() => setModels([]))
      .finally(() => setLoading(false));
  }, []);

  const mayChange = self?.role === 'owner' || self?.role === 'admin';
  const usable = models.filter((m) => m.usable);
  const rejected = models.filter((m) => !m.usable);

  const apply = async (input: { quality?: string | null; fast?: string | null; auto?: boolean }) => {
    setBusy(true);
    await selectModels(input);
    setBusy(false);
  };

  if (!ai?.assistant) {
    return (
      <p className="muted" style={{ fontSize: 13.5 }}>
        Für die Modellwahl braucht der Server einen Groq-Schlüssel.
        {ai?.note ? ` ${ai.note}` : ''}
      </p>
    );
  }

  return (
    <>
      <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
        Die Übersetzung macht ein Sprachmodell — kein separater Übersetzungsdienst.
        Welches Modell das ist, entscheidet der Server normalerweise selbst.
        Hier kannst du es festlegen.
      </p>

      <div className="ai-card">
        <div className="ai-card__head"><Sparkles size={12} /> Aktuell im Einsatz</div>
        <div className="stack gap-1" style={{ fontSize: 13 }}>
          <div className="hstack gap-2">
            <span className="muted" style={{ minWidth: 152 }}>Übersetzung, Zusammenfassung</span>
            <span className="mono">{ai.model ?? '—'}</span>
          </div>
          <div className="hstack gap-2">
            <span className="muted" style={{ minWidth: 152 }}>Antwortvorschläge</span>
            <span className="mono">{ai.fastModel ?? '—'}</span>
          </div>
          {ai.transcription && (
            <div className="hstack gap-2">
              <span className="muted" style={{ minWidth: 152 }}>Sprachnachrichten</span>
              <span className="mono">{ai.transcriptionModel}</span>
            </div>
          )}
        </div>
        <p className="muted" style={{ fontSize: 12, margin: '8px 0 0' }}>
          {ai.modelSource === 'manual' ? 'Von Hand gewählt.'
            : ai.modelSource === 'pinned' ? 'In der .env festgelegt.'
            : ai.modelSource === 'auto' ? `Automatisch aus ${ai.modelsAvailable ?? '?'} Modellen gewählt.`
            : 'Standardwerte.'}
        </p>
      </div>

      {!mayChange && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          Ändern darf das nur die Team-Leitung — es gilt für alle im Arbeitsbereich.
        </p>
      )}

      {mayChange && (
        <>
          <div className="field">
            <label className="field__label">Modell für die Übersetzung</label>
            <select
              className="select"
              value={ai.modelSource === 'manual' ? ai.model ?? '' : ''}
              disabled={busy || loading}
              onChange={(e) => void apply(e.target.value ? { quality: e.target.value } : { auto: true })}
            >
              <option value="">Automatisch wählen (empfohlen)</option>
              {usable.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.id}{m.params ? ` — ${m.params} Mrd.` : ''} · {Math.round(m.contextWindow / 1024)}k Kontext
                </option>
              ))}
            </select>
            <p className="field__hint">
              Größere Modelle übersetzen feiner, kleinere antworten schneller.
              Für Chat-Sätze reicht meist das automatisch gewählte.
            </p>
          </div>

          <div className="hstack gap-2">
            <button className="btn" disabled={busy} onClick={() => void apply({ auto: true })}>
              {busy && <Loader2 size={14} className="spin" />} Zurück auf automatisch
            </button>
          </div>
        </>
      )}

      {loading && <div className="hstack gap-2 muted" style={{ marginTop: 'var(--sp-4)' }}><Loader2 size={14} className="spin" /> Modelle werden geladen…</div>}

      {usable.length > 0 && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="ai-section__title">Verfügbar bei {ai.provider} ({usable.length})</div>
          {usable.map((m) => (
            <div key={m.id} className="row">
              <div className="row__main">
                <div className="row__title mono" style={{ fontSize: 13 }}>{m.id}</div>
                <div className="row__sub">
                  {m.ownedBy}
                  {m.params ? ` · ${m.params} Mrd. Parameter` : ''}
                  {` · ${Math.round(m.contextWindow / 1024)}k Kontext`}
                </div>
              </div>
              {ai.model === m.id && <span className="msg__tag">aktiv</span>}
            </div>
          ))}
        </div>
      )}

      {rejected.length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <div className="ai-section__title">Nicht für Chat geeignet ({rejected.length})</div>
          <div className="muted" style={{ fontSize: 12.5, lineHeight: 1.8 }}>
            {rejected.map((m) => (
              <div key={m.id}>
                <span className="mono">{m.id}</span> — {m.rejected}
              </div>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
