import { useEffect, useRef, useState } from 'react';
import { Check, ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import type { User } from '@stellium/shared';
import { Avatar } from './Avatar.jsx';
import { useStore } from '../state/store.js';
import { serverUrl, token } from '../net/api.js';
import { useT } from '../i18n/index.js';
import { bildVerkleinern } from '../lib/bilder.js';

/**
 * Eigenes Profilbild wählen, als Vorschau ansehen, bestätigen oder verwerfen,
 * und wieder entfernen.
 *
 * Eigene, neue Komponente — Settings.tsx ist gesperrt, während diese Datei
 * entstand. Eingehängt wird sie im Profil-Reiter (siehe Hinweis am Ende
 * dieser Datei für die genaue Zeile).
 *
 * Braucht keine Props: `self` kommt aus dem globalen Zustand. Für die
 * eigene Bildadresse wird NICHT `self.avatarUrl` gelesen, sondern
 * `users[self.id]?.avatarUrl` — denselben Umweg geht Settings.tsx bereits
 * beim Status (`eigenerStatus`), aus demselben Grund: `self` wird nur vom
 * `self:updated`-Ereignis fortgeschrieben (siehe state/store.ts), der
 * laufende Stand für alle anderen Ereignisse — auch für `user:upsert`, das
 * diese Komponente nach einer Änderung auslöst — liegt in `users`. Direkt
 * nach dem eigenen Hochladen/Entfernen kommt die frische Adresse ohnehin
 * schon aus der Serverantwort (siehe `serverAntwortUrl`), sodass hier nie
 * eine Lücke sichtbar wird.
 */
export function Profilbild() {
  const t = useT();
  const self = useStore((s) => s.self);
  const eigenerEintrag = useStore((s) => (self ? s.users[self.id] : undefined));

  const eingabe = useRef<HTMLInputElement>(null);
  const [datei, setDatei] = useState<File | null>(null);
  const [vorschau, setVorschau] = useState<string | null>(null);
  const [laeuft, setLaeuft] = useState(false);
  const [fortschritt, setFortschritt] = useState(0);
  const [fehler, setFehler] = useState<string | null>(null);
  /* Sofortiges, eigenes Feedback nach einer Änderung — bevor die eigene
     WebSocket-Meldung (user:upsert) den globalen Zustand einholt. undefined
     heißt "kein eigener Stand, `users`/`self` gilt". */
  const [serverAntwortUrl, setServerAntwortUrl] = useState<string | null | undefined>(undefined);

  // Vorschau-Adresse wieder freigeben, sobald sie ersetzt oder verworfen wird.
  useEffect(() => () => { if (vorschau) URL.revokeObjectURL(vorschau); }, [vorschau]);

  if (!self) return null;

  const aktuelleUrl = serverAntwortUrl !== undefined
    ? serverAntwortUrl
    : (eigenerEintrag?.avatarUrl ?? self.avatarUrl);
  const avatarPerson: Pick<User, 'displayName' | 'avatarColor' | 'avatarUrl' | 'status'> = {
    displayName: self.displayName, avatarColor: self.avatarColor, avatarUrl: aktuelleUrl, status: self.status,
  };

  async function ausgewaehlt(liste: FileList | null): Promise<void> {
    const roh = liste?.[0];
    if (!roh) return;
    setFehler(null);
    // Nur eine Vorprüfung für schnelles Feedback — die verbindliche Prüfung
    // an den tatsächlichen Bytes macht ausschließlich der Server.
    if (!/^image\/(jpe?g|png|webp)$/i.test(roh.type)) {
      setFehler(t('profilbild.typFalsch'));
      if (eingabe.current) eingabe.current.value = '';
      return;
    }
    // Dasselbe Werkzeug wie beim Hochladen eines Anhangs: verkleinert vor dem
    // Versand, was ohnehin niemand in voller Handyfoto-Auflösung braucht.
    const { datei: verkleinert } = await bildVerkleinern(roh);
    if (vorschau) URL.revokeObjectURL(vorschau);
    setDatei(verkleinert);
    setVorschau(URL.createObjectURL(verkleinert));
  }

  function verwerfen(): void {
    if (vorschau) URL.revokeObjectURL(vorschau);
    setDatei(null);
    setVorschau(null);
    setFehler(null);
    if (eingabe.current) eingabe.current.value = '';
  }

  function bestaetigen(): void {
    if (!datei) return;
    setLaeuft(true);
    setFehler(null);
    setFortschritt(0);
    const form = new FormData();
    form.append('file', datei);

    // XHR statt fetch, weil nur XHR den Upload-Fortschritt meldet — wie
    // beim Hochladen in die Team-Ablage (net/api.ts, uploadToLibrary).
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${serverUrl()}/api/me/avatar`);
    const tok = token();
    if (tok) xhr.setRequestHeader('authorization', `Bearer ${tok}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) setFortschritt(e.loaded / e.total); };
    xhr.onload = () => {
      setLaeuft(false);
      let antwort: { user?: User; error?: string } | null = null;
      try { antwort = JSON.parse(xhr.responseText); } catch { /* kein JSON */ }
      if (xhr.status >= 200 && xhr.status < 300) {
        setServerAntwortUrl(antwort?.user?.avatarUrl ?? null);
        verwerfen();
      } else {
        setFehler(antwort?.error ?? t('api.error', { status: xhr.status }));
      }
    };
    xhr.onerror = () => { setLaeuft(false); setFehler(t('api.uploadNoConnection')); };
    xhr.send(form);
  }

  async function entfernen(): Promise<void> {
    setLaeuft(true);
    setFehler(null);
    try {
      const headers: Record<string, string> = {};
      const tok = token();
      if (tok) headers.authorization = `Bearer ${tok}`;
      const res = await fetch(`${serverUrl()}/api/me/avatar`, { method: 'DELETE', headers });
      const antwort = await res.json().catch(() => null) as { user?: User; error?: string } | null;
      if (!res.ok) throw new Error(antwort?.error ?? t('api.error', { status: res.status }));
      setServerAntwortUrl(antwort?.user?.avatarUrl ?? null);
    } catch (e) {
      setFehler((e as Error).message);
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <div className="field">
      <label className="field__label">{t('profilbild.label')}</label>
      <div className="hstack gap-3" style={{ alignItems: 'center' }}>
        {vorschau ? (
          <img
            src={vorschau}
            alt=""
            style={{
              width: 72, height: 72, borderRadius: 'var(--r-md)',
              objectFit: 'cover', border: '1px solid var(--line)', flexShrink: 0,
            }}
          />
        ) : (
          <Avatar user={avatarPerson} size={72} />
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-2)' }}>
          {!datei ? (
            <div className="hstack gap-2">
              <button
                type="button" className="btn btn--sm" disabled={laeuft}
                onClick={() => eingabe.current?.click()}
              >
                <ImagePlus size={14} /> {aktuelleUrl ? t('profilbild.aendern') : t('profilbild.waehlen')}
              </button>
              {aktuelleUrl && (
                <button
                  type="button" className="btn btn--sm btn--ghost" disabled={laeuft}
                  onClick={() => void entfernen()}
                >
                  {laeuft ? <Loader2 size={14} className="spin" /> : <Trash2 size={14} />} {t('profilbild.entfernen')}
                </button>
              )}
            </div>
          ) : (
            <div className="hstack gap-2">
              <button type="button" className="btn btn--sm btn--primary" disabled={laeuft} onClick={bestaetigen}>
                {laeuft ? <Loader2 size={14} className="spin" /> : <Check size={14} />}
                {laeuft && fortschritt > 0 ? ` ${Math.round(fortschritt * 100)}%` : t('profilbild.bestaetigen')}
              </button>
              <button type="button" className="btn btn--sm btn--ghost" disabled={laeuft} onClick={verwerfen}>
                <X size={14} /> {t('profilbild.verwerfen')}
              </button>
            </div>
          )}
          <p className="field__hint">{t('profilbild.hinweis')}</p>
          {fehler && <p className="field__hint" style={{ color: 'var(--rose)' }}>{fehler}</p>}
        </div>
      </div>

      <input
        ref={eingabe}
        type="file"
        accept="image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => { void ausgewaehlt(e.target.files); }}
      />
    </div>
  );
}
