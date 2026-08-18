import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Star } from 'lucide-react';
import { LANGUAGES } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { api, serverUrl, setServerUrl } from '../net/api.js';

export function Login() {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [server, setServer] = useState(serverUrl());
  const [showServer, setShowServer] = useState(false);

  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');
  const [handle, setHandle] = useState('');
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [language, setLanguage] = useState(guessLanguage());

  useEffect(() => {
    let cancelled = false;
    api.health()
      .then(() => { if (!cancelled) setServerReachable(true); })
      .catch(() => { if (!cancelled) setServerReachable(false); });
    return () => { cancelled = true; };
  }, [server]);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      if (mode === 'login') {
        await useStore.getState().login(loginId.trim(), password);
      } else {
        await useStore.getState().register({
          handle: handle.trim().toLowerCase(),
          email: email.trim(),
          password,
          displayName: displayName.trim() || handle.trim(),
          language,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/Berlin',
        });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <motion.div
        className="auth__card"
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <motion.div
          className="auth__logo"
          animate={{ rotate: [0, 6, -6, 0] }}
          transition={{ duration: 9, repeat: Infinity, ease: 'easeInOut' }}
        >
          <Star size={28} color="#fff" fill="#fff" />
        </motion.div>

        <h1 className="auth__title">Stellium</h1>
        <p className="auth__sub">
          Team-Chat, der jede Sprache spricht
        </p>

        {error && <div className="auth__error">{error}</div>}
        {serverReachable === false && (
          <div className="auth__error">
            Server unter {server} nicht erreichbar. Läuft <code>npm run dev:server</code>?
          </div>
        )}

        <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          {mode === 'login' ? (
            <>
              <div className="field">
                <label className="field__label">Benutzername oder E-Mail</label>
                <input className="input" value={loginId} autoFocus onChange={(e) => setLoginId(e.target.value)} autoComplete="username" />
              </div>
              <div className="field">
                <label className="field__label">Passwort</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" />
              </div>
            </>
          ) : (
            <>
              <div className="field">
                <label className="field__label">Benutzername</label>
                <input className="input" value={handle} autoFocus placeholder="z.B. don" onChange={(e) => setHandle(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Anzeigename</label>
                <input className="input" value={displayName} placeholder="Vor- und Nachname" onChange={(e) => setDisplayName(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">E-Mail</label>
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="field">
                <label className="field__label">Passwort</label>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
                <p className="field__hint">Mindestens 8 Zeichen.</p>
              </div>
              <div className="field">
                <label className="field__label">Meine Sprache</label>
                <select className="select" value={language} onChange={(e) => setLanguage(e.target.value)}>
                  {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
                </select>
                <p className="field__hint">Alles, was andere schreiben, erscheint für dich in dieser Sprache.</p>
              </div>
            </>
          )}

          <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="spin" />}
            {mode === 'login' ? 'Anmelden' : 'Konto erstellen'}
          </button>
        </form>

        <div className="auth__switch">
          {mode === 'login' ? (
            <>Noch kein Konto? <button className="btn btn--ghost" style={{ height: 'auto', padding: 4 }} onClick={() => { setMode('register'); setError(null); }}>Registrieren</button></>
          ) : (
            <>Schon dabei? <button className="btn btn--ghost" style={{ height: 'auto', padding: 4 }} onClick={() => { setMode('login'); setError(null); }}>Anmelden</button></>
          )}
        </div>

        {mode === 'login' && (
          <div className="auth__demo">
            Demo-Zugang: <b>don</b> / <b>stellium2024</b><br />
            Weitere Konten: sarah (EN), yuki (JA), marta (PL), lucas (FR), ana (ES) — gleiches Passwort.
          </div>
        )}

        <div style={{ marginTop: 'var(--sp-3)', textAlign: 'center' }}>
          <button
            className="btn btn--ghost"
            style={{ height: 'auto', padding: 4, fontSize: 12 }}
            onClick={() => setShowServer((v) => !v)}
          >
            {showServer ? 'Server verbergen' : 'Anderer Server?'}
          </button>
          {showServer && (
            <div className="hstack gap-2" style={{ marginTop: 8 }}>
              <input className="input" value={server} onChange={(e) => setServer(e.target.value)} />
              <button className="btn" onClick={() => { setServerUrl(server); setServerReachable(null); }}>Setzen</button>
            </div>
          )}
        </div>
      </motion.div>
    </div>
  );
}

function guessLanguage(): string {
  const raw = navigator.language?.split('-')[0]?.toLowerCase() ?? 'de';
  return LANGUAGES.some((l) => l.code === raw) ? raw : 'de';
}
