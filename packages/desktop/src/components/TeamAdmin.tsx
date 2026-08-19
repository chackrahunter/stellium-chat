import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Ban, Check, Copy, KeyRound, Loader2, Plus, Search,
  ShieldCheck, Trash2, UserPlus, X,
} from 'lucide-react';
import {
  LANGUAGES, PERMISSIONS,
  type ManagedUser, type MemberRole, type OneTimeCredential, type PermissionKey,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { api } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { t } from '../i18n/index.js';
import { relativeTime } from '../lib/format.js';

const ROLLEN: { wert: MemberRole; label: string; hinweis: string }[] = [
  { wert: 'owner',  label: 'Owner',    hinweis: 'Darf alles, kann nicht eingeschränkt werden' },
  { wert: 'admin',  label: 'Admin',    hinweis: 'Verwaltet Konten und Kanäle' },
  { wert: 'member', label: 'Mitglied', hinweis: 'Normale Nutzung' },
  { wert: 'guest',  label: 'Gast',     hinweis: 'Nur lesen und antworten' },
];

const GRUPPEN: { id: string; titel: string }[] = [
  { id: 'nachrichten', titel: 'Nachrichten' },
  { id: 'kanaele', titel: 'Kanäle' },
  { id: 'inhalte', titel: 'Inhalte' },
  { id: 'ki', titel: 'KI und Übersetzung' },
  { id: 'verwaltung', titel: 'Verwaltung' },
];

export function TeamAdmin({ onClose }: { onClose: () => void }) {
  const self = useStore((s) => s.self);
  const [liste, setListe] = useState<ManagedUser[]>([]);
  const [laden, setLaden] = useState(true);
  const [suche, setSuche] = useState('');
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [anlegen, setAnlegen] = useState(false);
  const [zugang, setZugang] = useState<OneTimeCredential | null>(null);
  const [busy, setBusy] = useState(false);

  const darfVerwalten = self?.permissions['user.manage'];
  const darfAnlegen = self?.permissions['user.invite'];
  const darfRechte = self?.permissions['permission.manage'];
  const darfLoeschen = self?.permissions['user.delete'];

  /**
   * Escape soll den obersten Dialog schließen, nicht gleich die ganze
   * Verwaltung. Der globale Handler in App.tsx hängt am Fenster, deshalb
   * greifen wir hier in der Erfassungsphase vor.
   */
  useEffect(() => {
    if (!anlegen && !zugang) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      e.preventDefault();
      if (zugang) setZugang(null);
      else setAnlegen(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [anlegen, zugang]);

  useEffect(() => {
    api.adminUsers()
      .then((r) => setListe(r.users))
      .catch((e) => useStore.getState().toast({ kind: 'error', title: 'Konten nicht abrufbar', body: (e as Error).message }))
      .finally(() => setLaden(false));
  }, []);

  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase();
    if (!q) return liste;
    return liste.filter((u) =>
      u.displayName.toLowerCase().includes(q) || u.handle.toLowerCase().includes(q));
  }, [liste, suche]);

  const person = liste.find((u) => u.id === gewaehlt) ?? null;

  const mit = async <T,>(fn: () => Promise<T & { users: ManagedUser[] }>, erfolg?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      setListe(r.users);
      if (erfolg) useStore.getState().toast({ kind: 'ok', title: erfolg });
      return r;
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: 'Nicht möglich', body: (err as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        className="panel panel--wide"
        style={{ width: 'min(1000px, 100%)', maxHeight: '86vh' }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          <ShieldCheck size={18} />
          <h2>Team verwalten</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>{liste.length} Konten</span>
          {darfAnlegen && (
            <button className="pill pill--accent" style={{ marginLeft: 'auto' }} onClick={() => setAnlegen(true)}>
              <UserPlus size={13} /> Konto anlegen
            </button>
          )}
          <button className="icon-btn" style={{ marginLeft: darfAnlegen ? 0 : 'auto' }} onClick={onClose}>
            <X size={17} />
          </button>
        </div>

        <div className="admin">
          <div className="admin__liste">
            <div className="hstack gap-2" style={{ padding: '0 0 var(--sp-3)' }}>
              <Search size={14} className="muted" />
              <input className="input" style={{ padding: '6px 10px', fontSize: 13 }}
                placeholder="Person suchen…" value={suche} onChange={(e) => setSuche(e.target.value)} />
            </div>

            {laden && <div className="hstack gap-2 muted"><Loader2 size={14} className="spin" /> lädt…</div>}

            {gefiltert.map((u) => (
              <button
                key={u.id}
                className="result"
                data-active={gewaehlt === u.id}
                onClick={() => setGewaehlt(u.id)}
              >
                <Avatar user={{ displayName: u.displayName, avatarColor: '#7c5cff', avatarUrl: null, status: 'offline' }} size={30} />
                <div className="result__main">
                  <div className="result__title">
                    {u.displayName}
                    {u.disabled && <span className="msg__tag" style={{ marginLeft: 6 }}>gesperrt</span>}
                    {u.mustChangePassword && <span className="msg__tag" style={{ marginLeft: 6 }}>neu</span>}
                  </div>
                  <div className="result__sub">@{u.handle} · {ROLLEN.find((r) => r.wert === u.role)?.label}</div>
                </div>
              </button>
            ))}
          </div>

          <div className="admin__detail">
            {!person && (
              <div className="empty" style={{ height: '100%' }}>
                <p>{t('team.pickPerson')}</p>
              </div>
            )}

            {person && (
              <>
                <div className="hstack gap-3" style={{ marginBottom: 'var(--sp-4)' }}>
                  <Avatar user={{ displayName: person.displayName, avatarColor: '#7c5cff', avatarUrl: null, status: 'offline' }} size={46} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: 17, fontWeight: 700 }}>{person.displayName}</div>
                    <div className="muted" style={{ fontSize: 12.5 }}>
                      @{person.handle} · {person.emailMasked}
                      {person.lastSeenAt && ` · zuletzt ${relativeTime(person.lastSeenAt)}`}
                    </div>
                  </div>
                </div>

                {person.mustChangePassword && (
                  <div className="hinweis">
                    <AlertTriangle size={14} />
                    Hat sich noch nicht mit einem eigenen Passwort angemeldet.
                  </div>
                )}

                <div className="field">
                  <label className="field__label">Rolle</label>
                  <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
                    {ROLLEN.map((r) => (
                      <button
                        key={r.wert}
                        className={`btn${person.role === r.wert ? ' btn--primary' : ''}`}
                        title={r.hinweis}
                        disabled={!darfVerwalten || busy || (r.wert === 'owner' && self?.role !== 'owner')}
                        onClick={() => void mit(() => api.setUserRole(person.id, r.wert), `Rolle: ${r.label}`)}
                      >{r.label}</button>
                    ))}
                  </div>
                  <p className="field__hint">
                    Die Rolle setzt die Vorgaben. Einzelne Rechte kannst du darunter abweichend setzen.
                  </p>
                </div>

                <div className="hstack gap-2" style={{ marginBottom: 'var(--sp-4)', flexWrap: 'wrap' }}>
                  {darfVerwalten && (
                    <button className="btn" disabled={busy} onClick={async () => {
                      const r = await mit(() => api.resetUserPassword(person.id));
                      if (r) setZugang(r.credential);
                    }}>
                      <KeyRound size={15} /> Passwort zurücksetzen
                    </button>
                  )}
                  {darfVerwalten && person.role !== 'owner' && (
                    <button className="btn" disabled={busy}
                      onClick={() => void mit(() => api.setUserDisabled(person.id, !person.disabled),
                        person.disabled ? 'Entsperrt' : 'Gesperrt')}>
                      <Ban size={15} /> {person.disabled ? 'Entsperren' : 'Sperren'}
                    </button>
                  )}
                  {darfLoeschen && person.role !== 'owner' && person.id !== self?.id && (
                    <button className="btn btn--danger" disabled={busy} onClick={() => {
                      if (!window.confirm(`${person.displayName} wirklich löschen? Nachrichten bleiben erhalten.`)) return;
                      void mit(() => api.deleteUser(person.id), 'Konto gelöscht');
                      setGewaehlt(null);
                    }}>
                      <Trash2 size={15} /> Löschen
                    </button>
                  )}
                </div>

                <div className="field">
                  <label className="field__label">
                    Rechte
                    <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
                      {Object.values(person.permissions).filter(Boolean).length} von {PERMISSIONS.length} erlaubt
                    </span>
                  </label>
                  {person.role === 'owner' && (
                    <p className="field__hint">{t('team.ownerAll')}</p>
                  )}
                </div>

                {person.role !== 'owner' && GRUPPEN.map((g) => {
                  const rechte = PERMISSIONS.filter((p) => p.group === g.id);
                  if (!rechte.length) return null;
                  return (
                    <div key={g.id} style={{ marginBottom: 'var(--sp-4)' }}>
                      <div className="ai-section__title">{g.titel}</div>
                      {rechte.map((p) => {
                        const an = person.permissions[p.key];
                        const abweichend = person.overrides[p.key] !== undefined;
                        const gesperrt = !darfRechte || busy || (p.ownerOnly && self?.role !== 'owner');
                        // Ein grauer Schalter ohne Begründung wirkt wie ein Fehler.
                        const grund = !darfRechte
                          ? t('team.needRight')
                          : p.ownerOnly && self?.role !== 'owner'
                            ? t('team.ownerOnly')
                            : undefined;
                        return (
                          <div className="row" key={p.key}>
                            <div className="row__main">
                              <div className="row__title">
                                {p.labelDe}
                                {abweichend && <span className="msg__tag" style={{ marginLeft: 7 }}>abweichend</span>}
                              </div>
                              {p.hintDe && <div className="row__sub">{p.hintDe}</div>}
                            </div>
                            {abweichend && (
                              <button className="btn btn--ghost" style={{ height: 28, fontSize: 12 }} disabled={gesperrt}
                                onClick={() => void mit(() => api.setUserPermission(person.id, p.key, null))}>
                                zurücksetzen
                              </button>
                            )}
                            <button
                              className="switch"
                              role="switch"
                              aria-checked={an}
                              disabled={gesperrt}
                              title={grund}
                              style={gesperrt ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                              onClick={() => void mit(() => api.setUserPermission(person.id, p.key, !an))}
                            />
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </div>
      </motion.div>

      <AnimatePresence>
        {anlegen && (
          <KontoAnlegen
            onClose={() => setAnlegen(false)}
            onFertig={(cred, users) => { setListe(users); setAnlegen(false); setZugang(cred); }}
          />
        )}
        {zugang && <ZugangAnzeigen credential={zugang} onClose={() => setZugang(null)} />}
      </AnimatePresence>
    </div>
  );
}

/* ── Konto anlegen ────────────────────────────────────────────── */

function KontoAnlegen({ onClose, onFertig }: {
  onClose: () => void;
  onFertig: (cred: OneTimeCredential, users: ManagedUser[]) => void;
}) {
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [rolle, setRolle] = useState<MemberRole>('member');
  const [sprache, setSprache] = useState('de');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const anlegen = async () => {
    setFehler(null);
    setBusy(true);
    try {
      const r = await api.createUser({
        displayName: name.trim(),
        handle: handle.trim() || undefined,
        email: email.trim() || undefined,
        role: rolle,
        language: sprache,
      });
      onFertig(r.credential, r.users);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim scrim--center" style={{ zIndex: 50 }} onClick={onClose}>
      <motion.div className="panel" style={{ width: 'min(480px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <UserPlus size={18} />
          <h2>Konto anlegen</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="panel__body">
          {fehler && <div className="auth__error">{fehler}</div>}

          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
            Du bekommst gleich ein Einmal-Passwort. Gib es der Person weiter — beim
            ersten Login legt sie ihr eigenes Passwort, ihren Benutzernamen und ihre
            E-Mail selbst fest.
          </p>

          <div className="field">
            <label className="field__label">Name</label>
            <input className="input" value={name} autoFocus placeholder={t('team.fullName')}
              onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <label className="field__label">Benutzername (optional)</label>
            <input className="input" value={handle} placeholder={t('team.handleAuto')}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} />
          </div>

          <div className="field">
            <label className="field__label">E-Mail (optional)</label>
            <input className="input" type="email" value={email} placeholder="kollegin@firma.de"
              onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="field">
            <label className="field__label">Rolle</label>
            <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
              {ROLLEN.filter((r) => r.wert !== 'owner').map((r) => (
                <button key={r.wert} className={`btn${rolle === r.wert ? ' btn--primary' : ''}`}
                  title={r.hinweis} onClick={() => setRolle(r.wert)}>{r.label}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field__label">Sprache</label>
            <select className="select" value={sprache} onChange={(e) => setSprache(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
            </select>
          </div>

          <button className="btn btn--primary btn--block" disabled={name.trim().length < 2 || busy}
            onClick={() => void anlegen()}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            Anlegen und Einmal-Passwort erzeugen
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ── Einmal-Passwort anzeigen ─────────────────────────────────── */

function ZugangAnzeigen({ credential, onClose }: { credential: OneTimeCredential; onClose: () => void }) {
  const [kopiert, setKopiert] = useState(false);

  const kopieren = () => {
    void navigator.clipboard.writeText(
      `Benutzername: ${credential.handle}\nEinmal-Passwort: ${credential.oneTimePassword}`,
    );
    setKopiert(true);
    window.setTimeout(() => setKopiert(false), 2200);
  };

  return (
    <div className="scrim scrim--center" style={{ zIndex: 60 }} onClick={onClose}>
      <motion.div className="panel" style={{ width: 'min(460px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <KeyRound size={18} />
          <h2>Einmal-Passwort</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="panel__body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
            Für <b style={{ color: 'var(--tx-hi)' }}>{credential.displayName}</b>.
            Gib beides persönlich weiter — danach ist es hier nicht mehr abrufbar.
          </p>

          <div className="zugang">
            <div className="zugang__zeile">
              <span className="zugang__label">Benutzername</span>
              <span className="zugang__wert mono">{credential.handle}</span>
            </div>
            <div className="zugang__zeile">
              <span className="zugang__label">Einmal-Passwort</span>
              <span className="zugang__wert zugang__wert--gross mono">{credential.oneTimePassword}</span>
            </div>
          </div>

          <button className="btn btn--primary btn--block" onClick={kopieren}>
            {kopiert ? <Check size={16} /> : <Copy size={16} />}
            {kopiert ? 'Kopiert' : 'Beides kopieren'}
          </button>

          <p className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>
            Gültig 14 Tage. Beim ersten Login muss ein eigenes Passwort gesetzt werden.
          </p>
        </div>
      </motion.div>
    </div>
  );
}
