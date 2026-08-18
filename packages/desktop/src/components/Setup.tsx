import { useState } from 'react';
import { motion } from 'framer-motion';
import { Check, Loader2, ShieldCheck, Star } from 'lucide-react';
import { LANGUAGES } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { api } from '../net/api.js';

/**
 * Erste Anmeldung mit dem Einmal-Passwort: hier legt die Person ihre eigenen
 * Zugangsdaten fest. Das Einmal-Passwort ist danach ungültig.
 */
export function Setup() {
  const self = useStore((s) => s.self);
  const [handle, setHandle] = useState(self?.handle ?? '');
  const [email, setEmail] = useState(self?.email ?? '');
  const [displayName, setDisplayName] = useState(self?.displayName ?? '');
  const [passwort, setPasswort] = useState('');
  const [wiederholung, setWiederholung] = useState('');
  const [sprache, setSprache] = useState(self?.language ?? 'de');
  const [busy, setBusy] = useState(false);
  const [fehler, setFehler] = useState<string | null>(null);

  const staerke = passwortStaerke(passwort);
  const passt = passwort.length >= 10 && passwort === wiederholung;
  const bereit = passt && handle.trim().length >= 2 && displayName.trim().length >= 2;

  const speichern = async () => {
    setFehler(null);
    setBusy(true);
    try {
      const { user } = await api.setup({
        handle: handle.trim().toLowerCase(),
        email: email.trim() || undefined,
        displayName: displayName.trim(),
        newPassword: passwort,
      });
      if (sprache !== user.language) {
        useStore.getState().updatePrefs({ language: sprache, uiLanguage: sprache });
      }
      useStore.setState({ self: user });
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <motion.div
        className="auth__card"
        style={{ width: 'min(500px, 100%)' }}
        initial={{ opacity: 0, y: 18, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
      >
        <div className="auth__logo"><Star size={28} color="#fff" fill="#fff" /></div>
        <h1 className="auth__title">Willkommen</h1>
        <p className="auth__sub">
          Du hast dich mit einem Einmal-Passwort angemeldet.
          Lege jetzt deine eigenen Zugangsdaten fest — danach ist es ungültig.
        </p>

        {fehler && <div className="auth__error">{fehler}</div>}

        <div className="field">
          <label className="field__label">Dein Name</label>
          <input className="input" value={displayName} autoFocus placeholder="Vor- und Nachname"
            onChange={(e) => setDisplayName(e.target.value)} />
          <p className="field__hint">So sehen dich deine Kolleg:innen. Später jederzeit änderbar.</p>
        </div>

        <div className="field">
          <label className="field__label">Benutzername</label>
          <input className="input" value={handle} placeholder="z.B. don"
            onChange={(e) => setHandle(e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, ''))} />
          <p className="field__hint">Damit meldest du dich an, und darüber wirst du erwähnt: @{handle || '…'}</p>
        </div>

        <div className="field">
          <label className="field__label">E-Mail (optional)</label>
          <input className="input" type="email" value={email} placeholder="du@firma.de"
            onChange={(e) => setEmail(e.target.value)} />
          <p className="field__hint">Wird verschlüsselt gespeichert und niemandem im Chat angezeigt.</p>
        </div>

        <div className="field">
          <label className="field__label">Neues Passwort</label>
          <input className="input" type="password" value={passwort} autoComplete="new-password"
            onChange={(e) => setPasswort(e.target.value)} />
          <div className="staerke">
            <span className="staerke__balken">
              <span className={`staerke__fuellung staerke__fuellung--${staerke.stufe}`} style={{ width: `${staerke.anteil}%` }} />
            </span>
            <span className="staerke__text">{staerke.text}</span>
          </div>
        </div>

        <div className="field">
          <label className="field__label">Passwort wiederholen</label>
          <input className="input" type="password" value={wiederholung} autoComplete="new-password"
            onChange={(e) => setWiederholung(e.target.value)} />
          {wiederholung.length > 0 && (
            <p className="field__hint" style={{ color: passt ? 'var(--mint)' : 'var(--rose)' }}>
              {passt ? '✓ stimmt überein' : 'stimmt noch nicht überein'}
            </p>
          )}
        </div>

        <div className="field">
          <label className="field__label">Deine Sprache</label>
          <select className="select" value={sprache} onChange={(e) => setSprache(e.target.value)}>
            {LANGUAGES.map((l) => <option key={l.code} value={l.code}>{l.flag} {l.native}</option>)}
          </select>
          <p className="field__hint">
            Bestimmt die Sprache der Oberfläche und in welche Sprache Nachrichten
            für dich übersetzt werden.
          </p>
        </div>

        <button className="btn btn--primary btn--block" disabled={!bereit || busy} onClick={() => void speichern()}>
          {busy ? <Loader2 size={16} className="spin" /> : <Check size={16} />}
          Einrichtung abschließen
        </button>

        <div className="auth__demo" style={{ display: 'flex', gap: 9, alignItems: 'flex-start' }}>
          <ShieldCheck size={15} style={{ flex: 'none', marginTop: 1, color: 'var(--mint)' }} />
          <span>
            Dein Passwort wird als scrypt-Hash gespeichert und ist nicht auslesbar —
            auch nicht von der Team-Leitung. Vergisst du es, gibt es ein neues Einmal-Passwort.
          </span>
        </div>
      </motion.div>
    </div>
  );
}

function passwortStaerke(p: string): { anteil: number; stufe: string; text: string } {
  if (!p) return { anteil: 0, stufe: 'leer', text: 'mindestens 10 Zeichen' };
  let punkte = Math.min(p.length / 16, 1) * 55;
  if (/[a-z]/.test(p) && /[A-Z]/.test(p)) punkte += 15;
  if (/\d/.test(p)) punkte += 15;
  if (/[^\w\s]/.test(p)) punkte += 15;
  const anteil = Math.min(100, Math.round(punkte));
  if (p.length < 10) return { anteil, stufe: 'schwach', text: `noch ${10 - p.length} Zeichen` };
  if (anteil < 55) return { anteil, stufe: 'schwach', text: 'schwach' };
  if (anteil < 80) return { anteil, stufe: 'mittel', text: 'in Ordnung' };
  return { anteil, stufe: 'stark', text: 'stark' };
}
