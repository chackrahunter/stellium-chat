import { useRef, useState } from 'react';
import { motion } from 'framer-motion';
import {
  Archive, Bot, Hash, Lock, Megaphone, Settings2, Trash2, UserMinus,
  UserPlus, X,
} from 'lucide-react';
import { LANGUAGES } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { useT } from '../i18n/index.js';
import { Avatar } from './Avatar.jsx';
import { languageInfo } from '../lib/format.js';
import { VertraulichAbschnitt } from './Vertraulich.jsx';

/** Alles, was man an einem Kanal einstellen kann — an einem Ort. */
export function ChannelSettings({ channelId, onClose }: { channelId: string; onClose: () => void }) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  const t = useT();
  const channel = useStore((s) => s.channels[channelId]);
  const users = useStore((s) => s.users);
  const self = useStore((s) => s.self);
  const state = useStore((s) => s.states[channelId]);
  const ai = useStore((s) => s.ai);
  const {
    updateChannel, deleteChannel, hideChannel, setChannelMembers,
    muteChannel, starChannel, setAiMode, leaveChannel,
  } = useStore.getState();

  const [name, setName] = useState(channel?.name ?? '');
  const [topic, setTopic] = useState(channel?.topic ?? '');
  const [purpose, setPurpose] = useState(channel?.purpose ?? '');
  const [suche, setSuche] = useState('');
  const [loeschen, setLoeschen] = useState(false);

  if (!channel) return null;

  const istDm = channel.kind === 'dm';
  const darfVerwalten = Boolean(self?.permissions['channel.manage']) && !istDm;
  const darfMitglieder = Boolean(self?.permissions['channel.members']) && !istDm;
  const darfArchivieren = Boolean(self?.permissions['channel.archive']) && !istDm;
  const darfLoeschen = Boolean(self?.permissions['channel.delete']) && !istDm;

  const mitglieder = channel.memberIds.map((id) => users[id]).filter(Boolean);
  const kandidaten = Object.values(users)
    .filter((u) => !u.disabled && !u.technisch && !channel.memberIds.includes(u.id))
    .filter((u) => !suche || u.displayName.toLowerCase().includes(suche.toLowerCase())
                          || u.handle.toLowerCase().includes(suche.toLowerCase()))
    .slice(0, 8);

  const speichern = () => {
    const patch: Parameters<typeof updateChannel>[1] = {};
    if (name !== channel.name) patch.name = name;
    if (topic !== (channel.topic ?? '')) patch.topic = topic;
    if (purpose !== (channel.purpose ?? '')) patch.purpose = purpose;
    if (Object.keys(patch).length) updateChannel(channelId, patch);
  };

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={istDm ? users[channel.dmPeerId ?? '']?.displayName ?? t('nav.directMessages') : `#${channel.name}`}
        className="panel panel--wide"
        style={{ width: 'min(680px, 100%)', maxHeight: '84vh' }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          {istDm ? <Avatar user={users[channel.dmPeerId ?? '']} size={24} />
            : channel.kind === 'private' ? <Lock size={18} /> : <Hash size={18} />}
          <h2>{istDm ? users[channel.dmPeerId ?? '']?.displayName ?? t('nav.directMessages') : `#${channel.name}`}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>

        <div className="panel__body">
          {/* ── Für mich ── */}
          <div className="ai-section__title">{t('channel.forMe')}</div>
          <div className="row">
            <div className="row__main">
              <div className="row__title">{t('channel.mute')}</div>
              <div className="row__sub">{t('channel.muteHint')}</div>
            </div>
            <button className="switch" role="switch" aria-checked={state?.muted ?? false}
              onClick={() => muteChannel(channelId, !(state?.muted ?? false))} />
          </div>
          <div className="row">
            <div className="row__main">
              <div className="row__title">{t('channel.star')}</div>
              <div className="row__sub">{t('channel.starHint')}</div>
            </div>
            <button className="switch" role="switch" aria-checked={state?.starred ?? false}
              onClick={() => starChannel(channelId, !(state?.starred ?? false))} />
          </div>

          {/* ── Einstellungen ── */}
          {darfVerwalten && (
            <>
              <div className="ai-section__title" style={{ marginTop: 'var(--sp-5)' }}>{t('channel.settings')}</div>

              <div className="field">
                <label className="field__label">{t('channel.name')}</label>
                <input className="input" value={name} onBlur={speichern}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/\s+/g, '-'))} />
                <p className="field__hint">{t('channel.nameHint')}</p>
              </div>

              <div className="field">
                <label className="field__label">{t('channel.topic')}</label>
                <input className="input" value={topic} placeholder={t('channel.topicPlaceholder')}
                  onBlur={speichern} onChange={(e) => setTopic(e.target.value)} />
              </div>

              <div className="field">
                <label className="field__label">{t('channel.purpose')}</label>
                <textarea className="textarea" style={{ minHeight: 64 }} value={purpose}
                  placeholder={t('channel.purposePlaceholder')}
                  onBlur={speichern} onChange={(e) => setPurpose(e.target.value)} />
              </div>

              <div className="field">
                <label className="field__label">{t('header.channelLanguage')}</label>
                <select className="select" value={channel.primaryLanguage ?? ''}
                  onChange={(e) => updateChannel(channelId, { primaryLanguage: e.target.value || null })}>
                  <option value="">🌐 {t('header.auto')}</option>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
                </select>
              </div>

              <div className="row">
                <div className="row__main">
                  <div className="row__title"><Megaphone size={13} style={{ verticalAlign: -2, marginRight: 6 }} />{t('channel.readOnly')}</div>
                  <div className="row__sub">{t('channel.readOnlyHint')}</div>
                </div>
                <button className="switch" role="switch" aria-checked={channel.readOnly}
                  onClick={() => updateChannel(channelId, { readOnly: !channel.readOnly })} />
              </div>
            </>
          )}

          {/* ── Vertraulichkeit ── */}
          <VertraulichAbschnitt channelId={channelId} />

          {/* ── KI ──
              In einem vertraulichen Kanal ist der Assistent abgeschaltet: der
              Server sieht dort nur Chiffrat. Die Umschaltung stehen zu lassen
              hieße, einen Schalter anzubieten, der nichts bewirkt. */}
          {ai?.assistant && !channel.vertraulich && (darfVerwalten || istDm) && (
            <>
              <div className="ai-section__title" style={{ marginTop: 'var(--sp-5)' }}>
                <Bot size={12} style={{ verticalAlign: -2, marginRight: 6 }} />{t('ai.modeLabel')}
              </div>
              <div className="hstack gap-2" style={{ flexWrap: 'wrap', marginBottom: 'var(--sp-4)' }}>
                {(['off', 'mention', 'always'] as const).map((m) => (
                  <button key={m}
                    className={`btn${channel.aiMode === m ? ' btn--primary' : ''}`}
                    disabled={!darfVerwalten && !istDm}
                    onClick={() => setAiMode(channelId, m)}>
                    {m === 'off' ? t('ai.modeOff') : m === 'mention' ? t('ai.modeMention') : t('ai.modeAlways')}
                  </button>
                ))}
              </div>
            </>
          )}

          {/* ── Mitglieder ── */}
          {!istDm && (
            <>
              <div className="ai-section__title" style={{ marginTop: 'var(--sp-5)' }}>
                {t('channel.members', { n: mitglieder.length })}
              </div>
              {mitglieder.map((u) => (
                <div className="row" key={u.id}>
                  <Avatar user={u} size={28} showPresence />
                  <div className="row__main" style={{ marginLeft: 10 }}>
                    <div className="row__title">{u.displayName}</div>
                    <div className="row__sub">@{u.handle} · {languageInfo(u.language).flag}</div>
                  </div>
                  {darfMitglieder && u.id !== channel.createdBy && (
                    <button className="icon-btn" title={t('channel.remove')}
                      onClick={() => setChannelMembers(channelId, [], [u.id])}>
                      <UserMinus size={15} />
                    </button>
                  )}
                </div>
              ))}

              {darfMitglieder && (
                <div className="field" style={{ marginTop: 'var(--sp-3)' }}>
                  <input className="input" value={suche} placeholder={t('channel.addPerson')}
                    onChange={(e) => setSuche(e.target.value)} />
                  {suche && kandidaten.map((u) => (
                    <button key={u.id} className="result" style={{ marginTop: 4 }}
                      onClick={() => { setChannelMembers(channelId, [u.id]); setSuche(''); }}>
                      <Avatar user={u} size={24} />
                      <div className="result__main">
                        <div className="result__title">{u.displayName}</div>
                        <div className="result__sub">@{u.handle}</div>
                      </div>
                      <UserPlus size={15} className="muted" />
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {/* ── Gefahrenzone ── */}
          <div className="ai-section__title" style={{ marginTop: 'var(--sp-5)', color: 'var(--rose)' }}>
            {t('channel.dangerZone')}
          </div>

          <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
            {istDm ? (
              <button className="btn" onClick={() => { hideChannel(channelId); onClose(); }}>
                <Archive size={15} /> {t('channel.hideDm')}
              </button>
            ) : (
              <button className="btn" onClick={() => { leaveChannel(channelId); onClose(); }}>
                {t('channel.leave')}
              </button>
            )}

            {darfArchivieren && (
              <button className="btn" onClick={() => { updateChannel(channelId, { archived: true }); onClose(); }}>
                <Archive size={15} /> {t('channel.archive')}
              </button>
            )}

            {darfLoeschen && !loeschen && (
              <button className="btn btn--danger" onClick={() => setLoeschen(true)}>
                <Trash2 size={15} /> {t('channel.delete')}
              </button>
            )}
          </div>

          {loeschen && (
            <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }}
              className="hinweis" style={{ marginTop: 'var(--sp-3)', borderColor: 'rgba(251,113,133,.4)', background: 'rgba(251,113,133,.1)', color: 'var(--rose)' }}>
              <div>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>{t('channel.deleteConfirm', { name: channel.name })}</div>
                <div style={{ fontSize: 12.5, opacity: 0.9 }}>{t('channel.deleteWarning')}</div>
                <div className="hstack gap-2" style={{ marginTop: 10 }}>
                  <button className="btn btn--danger" onClick={() => { deleteChannel(channelId); onClose(); }}>
                    {t('channel.deleteYes')}
                  </button>
                  <button className="btn btn--ghost" onClick={() => setLoeschen(false)}>{t('common.cancel')}</button>
                </div>
              </div>
            </motion.div>
          )}

          <div className="hstack gap-2" style={{ marginTop: 'var(--sp-4)' }}>
            <Settings2 size={13} className="muted" />
            <span className="muted" style={{ fontSize: 12 }}>{t('channel.savedAutomatically')}</span>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
