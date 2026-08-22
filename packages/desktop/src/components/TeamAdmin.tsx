import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AlertTriangle, Ban, Check, Copy, KeyRound, Loader2, Plus, Search,
  ShieldCheck, Trash2, UserPlus, X,
} from 'lucide-react';
import {
  KONTO_KATEGORIEN, LANGUAGES, PERMISSIONS,
  type KontoKategorie, type ManagedUser, type MemberRole, type OneTimeCredential,
  type PermissionKey,
} from '@stellium/shared';
import { useStore } from '../state/store.js';
import { useFokusfalle } from './Fokusfalle.jsx';
import { api } from '../net/api.js';
import { Avatar } from './Avatar.jsx';
import { t } from '../i18n/index.js';
import { relativeTime } from '../lib/format.js';

const ROLLEN: { wert: MemberRole; label: string; hinweis: string }[] = [
  { wert: 'owner',  label: t('admin.roleOwner'),  hinweis: t('role.ownerHint') },
  { wert: 'admin',  label: t('admin.roleAdmin'),  hinweis: t('role.adminHint') },
  { wert: 'member', label: t('admin.roleMember'), hinweis: t('role.memberHint') },
  { wert: 'guest',  label: t('admin.roleGuest'),  hinweis: t('role.guestHint') },
];

/* Nur die Kennungen — die Überschriften kommen aus dem Wörterbuch.
   Reihenfolge wie in der Gruppenliste in permissions.ts, damit sich beide
   nebeneinander lesen lassen.

   `system` fehlte hier. Die Folge war kein Absturz und keine Fehlermeldung,
   sondern etwas Unauffälligeres: `system.ansehen` gab es, der Server setzte
   es durch — aber in dieser Ansicht kam es nie vor. Es ließ sich also
   einzeln weder vergeben noch entziehen, nur über die Rolle. Wer eine
   Gruppe hinzufügt, muss sie AUCH hier eintragen; die Liste ergibt sich
   nicht von selbst aus dem Katalog. */
const GRUPPEN = ['nachrichten', 'kanaele', 'inhalte', 'ki', 'system', 'fernzugriff', 'verwaltung'] as const;
const GRUPPEN_SCHLUESSEL: Record<(typeof GRUPPEN)[number], string> = {
  nachrichten: 'perm.groupMessages',
  kanaele: 'perm.groupChannels',
  inhalte: 'perm.groupContent',
  ki: 'perm.groupAi',
  system: 'perm.groupSystem',
  fernzugriff: 'perm.groupRemote',
  verwaltung: 'perm.groupAdmin',
};

export function TeamAdmin({ onClose }: { onClose: () => void }) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten);
  const self = useStore((s) => s.self);
  const [liste, setListe] = useState<ManagedUser[]>([]);
  const [laden, setLaden] = useState(true);
  const [suche, setSuche] = useState('');
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  const [anlegen, setAnlegen] = useState(false);
  const [zugang, setZugang] = useState<OneTimeCredential | null>(null);
  const [busy, setBusy] = useState(false);
  const [zeigeGeloeschte, setZeigeGeloeschte] = useState(false);

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
      .catch((e) => useStore.getState().toast({ kind: 'error', title: t('team.loadFailed'), body: (e as Error).message }))
      .finally(() => setLaden(false));
  }, []);

  const geloeschte = liste.filter((u) => u.deletedAt);

  /**
   * In welche Schublade ein Konto gehört.
   *
   * Gelöschte sind gesetzt — dafür gibt es keine Wahl. Sonst gilt, was jemand
   * von Hand gewählt hat; ohne Wahl entscheidet, was das Konto ist: ein Bot
   * gehört zu den technischen, wer sich noch nie angemeldet hat, ist neu, und
   * die Leitung steht bei der Leitung.
   */
  const schublade = (u: ManagedUser): KontoKategorie => {
    if (u.deletedAt) return 'geloescht';
    if (u.kategorie) return u.kategorie;
    if (u.role === 'bot') return 'technisch';
    if (u.mustChangePassword) return 'neu';
    if (u.role === 'owner' || u.role === 'admin') return 'leitung';
    if (u.role === 'guest') return 'extern';
    return 'mitglieder';
  };

  /* Gelöschte Konten bleiben in der Datenbank, damit ihre Nachrichten einen
     Urheber behalten. In der Liste haben sie nichts verloren: dort sahen sie
     aus wie gewöhnliche Konten, und das Löschen wirkte, als hätte es nicht
     funktioniert. */
  const gefiltert = useMemo(() => {
    const q = suche.trim().toLowerCase();
    const sichtbar = zeigeGeloeschte ? liste : liste.filter((u) => !u.deletedAt);
    if (!q) return sichtbar;
    return sichtbar.filter((u) =>
      u.displayName.toLowerCase().includes(q) || u.handle.toLowerCase().includes(q));
  }, [liste, suche, zeigeGeloeschte]);

  /* Nach Schubladen sortiert, leere fallen weg. Bei acht Konten wirkt das
     überflüssig — bei achtzig ist es der Unterschied zwischen Suchen und
     Finden. */
  const gruppen = useMemo(() => {
    const nach = new Map<KontoKategorie, ManagedUser[]>();
    for (const u of gefiltert) {
      const k = schublade(u);
      if (!nach.has(k)) nach.set(k, []);
      nach.get(k)!.push(u);
    }
    return KONTO_KATEGORIEN
      .map((k) => ({ kategorie: k, leute: nach.get(k) ?? [] }))
      .filter((g) => g.leute.length > 0);
  }, [gefiltert, liste]);

  const person = liste.find((u) => u.id === gewaehlt) ?? null;

  const mit = async <T,>(fn: () => Promise<T & { users: ManagedUser[] }>, erfolg?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      setListe(r.users);
      if (erfolg) useStore.getState().toast({ kind: 'ok', title: erfolg });
      return r;
    } catch (err) {
      useStore.getState().toast({ kind: 'error', title: t('team.notPossible'), body: (err as Error).message });
      return null;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="scrim scrim--center" onClick={onClose}>
      <motion.div
        ref={kasten}
        role="dialog"
        aria-modal="true"
        aria-label={t('team.title')}
        className="panel panel--wide"
        style={{ width: 'min(1000px, 100%)', maxHeight: '86vh' }}
        initial={{ opacity: 0, scale: 0.97, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97, y: 8 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="panel__head">
          <ShieldCheck size={18} />
          <h2>{t('team.title')}</h2>
          <span className="muted" style={{ fontSize: 12.5 }}>{t('team.accounts', { n: liste.length - geloeschte.length })}</span>
          {darfAnlegen && (
            <button className="pill pill--accent" style={{ marginLeft: 'auto' }} onClick={() => setAnlegen(true)}>
              <UserPlus size={13} /> {t('team.createAccount')}
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
                placeholder={t('team.searchPerson')} value={suche} onChange={(e) => setSuche(e.target.value)} />
            </div>

            {laden && <div className="hstack gap-2 muted"><Loader2 size={14} className="spin" /> {t('team.loading')}</div>}

            {geloeschte.length > 0 && (
              <button
                className="btn btn--ghost"
                style={{ width: '100%', justifyContent: 'flex-start', fontSize: 12, padding: '5px 8px' }}
                onClick={() => setZeigeGeloeschte((v) => !v)}
              >
                {zeigeGeloeschte
                  ? t('team.hideDeleted')
                  : t('team.showDeleted', { n: geloeschte.length })}
              </button>
            )}

            {gruppen.map((g) => (
              <div key={g.kategorie} className="kat-gruppe">
                <div className="kat-gruppe__kopf">
                  {t(`kat.${g.kategorie}` as never)}
                  <span className="kat-gruppe__zahl">{g.leute.length}</span>
                </div>
                {g.leute.map((u) => (
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
                        {u.disabled && !u.deletedAt && <span className="msg__tag" style={{ marginInlineStart: 6 }}>{t('team.blocked')}</span>}
                      </div>
                      <div className="result__sub">@{u.handle} · {ROLLEN.find((r) => r.wert === u.role)?.label}</div>
                    </div>
                  </button>
                ))}
              </div>
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
                      {person.lastSeenAt && ` · ${t('profile.lastSeen', { zeit: relativeTime(person.lastSeenAt) })}`}
                    </div>
                  </div>
                </div>

                {person.mustChangePassword && (
                  <div className="hinweis">
                    <AlertTriangle size={14} />
                    {t('team.neverLoggedIn')}
                  </div>
                )}

                <div className="field">
                  <label className="field__label">{t('team.role')}</label>
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
                  <p className="field__hint">{t('team.roleHint')}</p>
                </div>

                <div className="hstack gap-2" style={{ marginBottom: 'var(--sp-4)', flexWrap: 'wrap' }}>
                  {darfVerwalten && (
                    <button className="btn" disabled={busy} onClick={async () => {
                      const r = await mit(() => api.resetUserPassword(person.id));
                      if (r) setZugang(r.credential);
                    }}>
                      <KeyRound size={15} /> {t('team.resetPassword')}
                    </button>
                  )}
                  {person.deletedAt && (
                    <p className="hinweis" style={{ margin: 0, width: '100%' }}>
                      <AlertTriangle size={14} />
                      {t('team.deletedNote')}
                    </p>
                  )}
                  {!person.deletedAt && darfVerwalten && person.role !== 'owner' && (
                    <button className="btn" disabled={busy}
                      onClick={() => void mit(() => api.setUserDisabled(person.id, !person.disabled),
                        person.disabled ? t('team.unblocked') : t('team.blockedDone'))}>
                      <Ban size={15} /> {person.disabled ? t('team.unblock') : t('team.block')}
                    </button>
                  )}
                  {!person.deletedAt && darfLoeschen && person.role !== 'owner' && person.id !== self?.id && (
                    <button className="btn btn--danger" disabled={busy} onClick={() => {
                      if (!window.confirm(t('team.deleteConfirm', { name: person.displayName }))) return;
                      void mit(() => api.deleteUser(person.id), t('team.deletedToast'));
                      setGewaehlt(null);
                    }}>
                      <Trash2 size={15} /> {t('team.delete')}
                    </button>
                  )}
                </div>

                {!person.deletedAt && darfVerwalten && (
                  <div className="field">
                    <label className="field__label">{t('kat.einsortieren')}</label>
                    <select
                      className="select"
                      value={person.kategorie ?? ''}
                      disabled={busy}
                      onChange={(e) => void mit(
                        () => api.setUserKategorie(person.id, e.target.value || null),
                        t('kat.verschoben'),
                      )}
                    >
                      <option value="">
                        {t('kat.automatisch')} — {t(`kat.${schublade({ ...person, kategorie: null })}` as never)}
                      </option>
                      {KONTO_KATEGORIEN.filter((k) => k !== 'geloescht').map((k) => (
                        <option key={k} value={k}>{t(`kat.${k}` as never)}</option>
                      ))}
                    </select>
                    <p className="field__hint">{t('kat.hinweis')}</p>
                  </div>
                )}

                <div className="field">
                  <label className="field__label">
                    {t('team.rights')}
                    <span className="muted" style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0, marginLeft: 8 }}>
                      {t('team.rightsCount', {
                        erlaubt: Object.values(person.permissions).filter(Boolean).length,
                        gesamt: PERMISSIONS.length,
                      })}
                    </span>
                  </label>
                  {person.role === 'owner' && (
                    <p className="field__hint">{t('team.ownerAll')}</p>
                  )}
                </div>

                {person.role !== 'owner' && GRUPPEN.map((g) => {
                  const rechte = PERMISSIONS.filter((p) => p.group === g);
                  if (!rechte.length) return null;
                  return (
                    <div key={g} style={{ marginBottom: 'var(--sp-4)' }}>
                      <div className="ai-section__title">{t(GRUPPEN_SCHLUESSEL[g] as never)}</div>
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
                                {abweichend && <span className="msg__tag" style={{ marginLeft: 7 }}>{t('admin.overridden')}</span>}
                              </div>
                              {p.hintDe && <div className="row__sub">{p.hintDe}</div>}
                            </div>
                            {abweichend && (
                              <button className="btn btn--ghost" style={{ height: 28, fontSize: 12 }} disabled={gesperrt}
                                onClick={() => void mit(() => api.setUserPermission(person.id, p.key, null))}>
                                {t('admin.reset')}
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
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
  const [name, setName] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [rolle, setRolle] = useState<MemberRole>('member');
  const [sprache, setSprache] = useState('de');
  const [busy, setBusy] = useState(false);
  const [zeigeGeloeschte, setZeigeGeloeschte] = useState(false);
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
      <motion.div ref={kasten} role="dialog" aria-modal="true" aria-label={t('team.createAccount')}
        className="panel" style={{ width: 'min(480px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <UserPlus size={18} />
          <h2>{t('team.createAccount')}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="panel__body">
          {fehler && <div className="auth__error">{fehler}</div>}

          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>{t('team.oneTimeLead')}</p>

          <div className="field">
            <label className="field__label">{t('team.name')}</label>
            <input className="input" value={name} autoFocus placeholder={t('team.fullName')}
              onChange={(e) => setName(e.target.value)} />
          </div>

          <div className="field">
            <label className="field__label">{t('admin.nameOptional')}</label>
            <input className="input" value={handle} placeholder={t('team.handleAuto')}
              onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} />
          </div>

          <div className="field">
            <label className="field__label">{t('setup.email')}</label>
            <input className="input" type="email" value={email} placeholder={t('team.emailPlaceholder')}
              onChange={(e) => setEmail(e.target.value)} />
          </div>

          <div className="field">
            <label className="field__label">{t('team.role')}</label>
            <div className="hstack gap-2" style={{ flexWrap: 'wrap' }}>
              {ROLLEN.filter((r) => r.wert !== 'owner').map((r) => (
                <button key={r.wert} className={`btn${rolle === r.wert ? ' btn--primary' : ''}`}
                  title={r.hinweis} onClick={() => setRolle(r.wert)}>{r.label}</button>
              ))}
            </div>
          </div>

          <div className="field">
            <label className="field__label">{t('team.language')}</label>
            <select className="select" value={sprache} onChange={(e) => setSprache(e.target.value)}>
              {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
            </select>
          </div>

          <button className="btn btn--primary btn--block" disabled={name.trim().length < 2 || busy}
            onClick={() => void anlegen()}>
            {busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />}
            {t('team.createAndGenerate')}
          </button>
        </div>
      </motion.div>
    </div>
  );
}

/* ── Einmal-Passwort anzeigen ─────────────────────────────────── */

function ZugangAnzeigen({ credential, onClose }: { credential: OneTimeCredential; onClose: () => void }) {
  const kasten = useRef<HTMLDivElement>(null);
  useFokusfalle(kasten, true, onClose);
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
      <motion.div ref={kasten} role="dialog" aria-modal="true" aria-label={t('admin.oneTimePassword')}
        className="panel" style={{ width: 'min(460px, 100%)' }}
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.96 }}
        onClick={(e) => e.stopPropagation()}>
        <div className="panel__head">
          <KeyRound size={18} />
          <h2>{t('admin.oneTimePassword')}</h2>
          <button className="icon-btn" style={{ marginLeft: 'auto' }} onClick={onClose}><X size={17} /></button>
        </div>
        <div className="panel__body">
          <p className="muted" style={{ marginTop: 0, fontSize: 13.5 }}>
            {t('admin.oneTimeFor', { name: credential.displayName })}
          </p>

          <div className="zugang">
            <div className="zugang__zeile">
              <span className="zugang__label">{t('setup.username')}</span>
              <span className="zugang__wert mono">{credential.handle}</span>
            </div>
            <div className="zugang__zeile">
              <span className="zugang__label">{t('admin.oneTimePassword')}</span>
              <span className="zugang__wert zugang__wert--gross mono">{credential.oneTimePassword}</span>
            </div>
          </div>

          <button className="btn btn--primary btn--block" onClick={kopieren}>
            {kopiert ? <Check size={16} /> : <Copy size={16} />}
            {kopiert ? t('team.copied') : t('team.copyBoth')}
          </button>

          <p className="field__hint" style={{ marginTop: 'var(--sp-3)' }}>
            {t('team.validHint')}
          </p>
        </div>
      </motion.div>
    </div>
  );
}
