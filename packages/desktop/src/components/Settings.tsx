import { useState } from 'react';
import { motion } from 'framer-motion';
import { Bell, Globe, LogOut, Moon, Palette, Server, Sparkles, User, X } from 'lucide-react';
import { LANGUAGES } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { serverUrl, setServerUrl } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo } from '../lib/format.js';

type Tab = 'profil' | 'sprache' | 'benachrichtigungen' | 'darstellung' | 'server';

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

              <div className="ai-card" style={{ marginTop: 'var(--sp-4)' }}>
                <div className="ai-card__head"><Sparkles size={12} /> Übersetzungs-Dienst</div>
                <div style={{ fontSize: 14 }}>
                  <b>{ai?.provider ?? 'unbekannt'}</b>{ai?.model ? ` · ${ai.model}` : ''}
                </div>
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
