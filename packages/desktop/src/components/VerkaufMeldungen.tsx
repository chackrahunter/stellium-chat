/**
 * Reiter "Verkaufsmeldungen" — "ein Kauf ist passiert", strukturiert statt
 * als Zahl in einer Kachel.
 *
 * WOHER DAS KOMMT UND WARUM EIN EIGENER REITER
 *
 * Der Auftrag war, Verkäufe über Gumroad/Patreon zu melden. Zwei
 * naheliegende Stellen gab es dafür schon: die Glocke in der Leiste
 * (Rail.tsx, öffnet RemindersPanel) und PostMeldungen.tsx. Beide passen
 * NICHT:
 *
 *   Die Glocke ist eine Liste von Dingen, an die MAN SICH SELBST erinnern
 *   lassen wollte — an einzelne Nachrichten gebunden (reminders.message_id/
 *   channel_id, siehe schema.sql: "Erinnerungen an einzelne Nachrichten"),
 *   von Hand angelegt. Ihre Zahl bedeutet heute genau eine Sache: "so viele
 *   offene Erinnerungen habe ich mir selbst gesetzt". Ein Verkauf ist das
 *   Gegenteil — niemand hat darum gebeten, erinnert zu werden, es ist ein
 *   Systemereignis. Beides in eine Liste zu werfen, würde die Bedeutung der
 *   Zahl an der Glocke zerstören (siehe RemindersPanel in Dialogs.tsx).
 *
 *   PostMeldungen.tsx ("Post-Sichtung") ist strukturell und nicht nur dem
 *   Namen nach an EINE Mailbox gebunden: der Typ PostMeldung trägt Absender,
 *   Betreff, Fach, Absenderart — Felder, die es bei einem Verkauf schlicht
 *   nicht gibt (und laut Auftrag auch nicht geben soll: keine Käuferdaten).
 *   Schwerer wiegt: der ganze Reiter verlangt `mail.lesen`, um überhaupt
 *   geöffnet zu werden (routes.ts, `/api/post/meldungen`) — wer `verkauf.sehen`
 *   hat, aber nicht `mail.lesen` (beide Rechte sind in permissions.ts
 *   ausdrücklich UNABHÄNGIG voneinander vergebbar, TECHNIK bekommt z. B.
 *   keins von beiden, TEAMLEITUNG beide zusammen — aber eine persönliche
 *   Ausnahme kann das jederzeit auseinanderziehen), säße vor einer Wand.
 *   Eine Verkaufsmeldung hinter dem falschen Recht zu verstecken ist kein
 *   kosmetischer Fehler.
 *
 * Deshalb dieser eigene, kleine Reiter — im Stern-Menü (Rail.tsx) statt in
 * der täglichen Zeile darunter, aus demselben Grund wie beim Bankreiter
 * daneben: ein Verkauf ist ein gelegentlicher Blick, kein Tagesgeschäft
 * (bei der heutigen Geschäftsgröße "heute null Verkäufe", siehe
 * services/gumroad.ts). `verkauf.sehen`, dieselbe Schwelle wie beim Ansehen
 * der Zahlen selbst.
 *
 * DERSELBE ANBLICK WIE POST-SICHTUNG, ANDERE DATEN
 * Karte mit farbigem Rand, Kopfzeile mit Zeitpunkt, Text darunter — bewusst
 * derselbe Anblick wie bei .postsicht-karte (siehe styles/
 * verkauf-meldungen.css für die Begründung, warum trotzdem eigene Klassen).
 * Ein Klick führt hier NICHT weiter (anders als bei Post-Sichtung, die zur
 * Mail springt) — es gibt keine einzelne "Quelle" für ein Verkaufsereignis
 * zu öffnen, die nicht schon SystemPanel/VerkaufDetailPanel wäre, und diese
 * Tafel hier bindet sich bewusst nicht an deren lokalen Zustand (siehe
 * Bericht am Auftragsende für den Grund und einen möglichen Nachrüst-Weg).
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2, RefreshCw, ShoppingBag } from 'lucide-react';
import { Shell } from './Panels.jsx';
import { useT } from '../i18n/index.js';
import { relativeTime } from '../lib/format.js';
import {
  verkaufMeldungZeile, type VerkaufMeldung,
} from '../state/verkaufMeldungen.js';
import { ApiError, serverUrl, token } from '../net/api.js';
import { t as tStatisch, type TranslationKey } from '../i18n/index.js';
import '../styles/verkauf-meldungen.css';

const SEITENGROESSE = 50;

/* ── Abruf — derselbe kleine, eigenständige Ersatz für request() aus
   net/api.ts wie in PostMeldungen.tsx/PaypalPanel.tsx, aus demselben Grund:
   an api.ts wird gerade an anderer Stelle gearbeitet. */
async function meldungenFetch<T>(pfad: string): Promise<T> {
  const headers = new Headers();
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);
  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}${pfad}`, { headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }
  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    let code: string | undefined;
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string };
      message = rumpf.error ?? message;
      code = rumpf.code;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

async function meldungenHolen(vor?: number): Promise<VerkaufMeldung[]> {
  const qs = new URLSearchParams({ anzahl: String(SEITENGROESSE) });
  if (vor) qs.set('vor', String(vor));
  const r = await meldungenFetch<{ meldungen: VerkaufMeldung[] }>(`/api/verkauf/meldungen?${qs}`);
  return r.meldungen;
}

export function VerkaufMeldungen({ onClose }: { onClose: () => void }) {
  const t = useT();

  const [liste, setListe] = useState<VerkaufMeldung[] | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [kannWeiterladen, setKannWeiterladen] = useState(false);
  const [weitereLaedt, setWeitereLaedt] = useState(false);

  const laden = async () => {
    setLaedt(true); setFehler(null);
    try {
      const seite = await meldungenHolen();
      setListe(seite);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setLaedt(false);
    }
  };

  const weitereLaden = async () => {
    if (!liste?.length) return;
    setWeitereLaedt(true);
    try {
      const seite = await meldungenHolen(liste[liste.length - 1].erkanntAm);
      setListe((v) => [...(v ?? []), ...seite]);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setWeitereLaedt(false);
    }
  };

  useEffect(() => { void laden(); }, []);

  return (
    <Shell
      title={t('verkaufMeldung.nav' as TranslationKey)}
      icon={<ShoppingBag size={18} />}
      onClose={onClose}
      width={480}
      actions={
        <button className="icon-btn" title={t('post.aktualisieren')} aria-label={t('post.aktualisieren')} onClick={() => void laden()}>
          <RefreshCw size={15} />
        </button>
      }
    >
      <p className="postsicht__hinweis">{t('verkaufMeldung.hinweis' as TranslationKey)}</p>

      {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

      {laedt && !liste && (
        <Loader2 size={22} className="spin muted" role="status" aria-label={t('post.laedt')} />
      )}

      {!laedt && !!liste && !liste.length && (
        <div className="empty-state">
          <ShoppingBag size={28} className="muted" />
          <p>{t('post.listeLeer')}</p>
        </div>
      )}

      {!!liste?.length && (
        <div className="verkaufmeldung-liste">
          {liste.map((m) => <Meldung key={m.id} m={m} t={t} />)}
        </div>
      )}

      {!laedt && kannWeiterladen && (
        <button
          className="btn btn--ghost btn--block"
          disabled={weitereLaedt}
          onClick={() => void weitereLaden()}
        >
          {weitereLaedt ? <Loader2 size={14} className="spin" /> : t('post.weitereLaden')}
        </button>
      )}
    </Shell>
  );
}

/** Eine Zeile — auf Modulebene wie bei PostMeldungen.tsx, aus demselben
 *  Grund (siehe dort): `t` kommt als Wert herein statt aus einem eigenen
 *  `useT()`, damit ein Nachladen nicht jede Karte neu aufbaut. */
function Meldung({ m, t }: {
  m: VerkaufMeldung;
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
}) {
  return (
    <div className="verkaufmeldung-karte">
      <div className="verkaufmeldung-karte__kopf">
        <span className="verkaufmeldung-karte__anbieter">
          {t(`verkaufMeldung.anbieter.${m.anbieter}` as TranslationKey)}
        </span>
        <span className="verkaufmeldung-karte__zeit">{relativeTime(m.erkanntAm)}</span>
      </div>
      <div className="verkaufmeldung-karte__name truncate">
        {m.produktName ?? t(`verkaufMeldung.anbieter.${m.anbieter}` as TranslationKey)}
      </div>
      <div className="verkaufmeldung-karte__zeile">{verkaufMeldungZeile(m)}</div>
    </div>
  );
}
