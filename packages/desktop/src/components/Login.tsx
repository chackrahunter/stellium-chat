import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Loader2, Star } from 'lucide-react';
import { useStore } from '../state/store.js';
import { api, serverUrl, setServerUrl } from '../net/api.js';

export function Login() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [serverReachable, setServerReachable] = useState<boolean | null>(null);
  const [server, setServer] = useState(serverUrl());
  const [showServer, setShowServer] = useState(false);

  const [loginId, setLoginId] = useState('');
  const [password, setPassword] = useState('');

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
      await useStore.getState().login(loginId.trim(), password);
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
          <div className="field">
            <label className="field__label">Benutzername oder E-Mail</label>
            <input className="input" value={loginId} autoFocus autoComplete="username"
              onChange={(e) => setLoginId(e.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Passwort</label>
            <input className="input" type="password" value={password} autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} />
            <p className="field__hint">
              Beim ersten Mal das Einmal-Passwort von der Team-Leitung.
            </p>
          </div>

          <button className="btn btn--primary btn--block" type="submit" disabled={busy}>
            {busy && <Loader2 size={16} className="spin" />}
            Anmelden
          </button>
        </form>

        <div className="auth__demo">
          Kein Zugang? Konten legt die Team-Leitung an — frage nach einem
          Einmal-Passwort. Eine Selbstregistrierung gibt es bewusst nicht.
        </div>

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


