/**
 * Der Reiter „Post-Sichtung" — was die KI aus eingegangener Firmenpost
 * gemacht hat, strukturiert statt als Fließtext.
 *
 * WOHER DAS KOMMT UND WARUM ES HIER STEHT, NICHT IM CHAT
 *
 * Bis Fassung 1.0.30 schrieb `post-sichtung.ts` (Server) diese Meldung als
 * Direktnachricht des Assistenten in den Chat jeder Person mit `mail.lesen`
 * und einer Führungsrolle — sieben Zeilen grauer Fließtext, mitten zwischen
 * echten Gesprächen, mit einer technischen Kennung am Ende. Dieser Reiter
 * ersetzt das: eine Zeile pro Mail, mit Fach, Absender, Anliegen,
 * Dringlichkeit und — als einziger Zeile, die zum Handeln auffordert — ob
 * ein Antwortentwurf auf Freigabe wartet.
 *
 * Die Chatnachricht ist bewusst ENTFALLEN, nicht nur verschoben. Sie war
 * eine zweite Kopie desselben Standes: der Zustand einer Sichtung ändert
 * sich (`entwurf` -> `gesendet`/`abgelehnt`), eine schon verschickte
 * Chatnachricht nie mit. Zwei Kopien liefen damit zwangsläufig auseinander.
 * Dieser Reiter liest stattdessen live aus `mail_sichtung`/`mail_entwuerfe`
 * (über `GET /api/post/meldungen`) — derselben Datenbank, in der die Mail
 * ohnehin dauerhaft liegt. Das ist der Rückhalt: eine Liste, die sich beim
 * Lesen NICHT leert (anders als eine Chatnachricht, die irgendwann im
 * Verlauf nach oben wandert), sondern beim nächsten Öffnen exakt denselben
 * Stand zeigt. Wer offline war, verpasst höchstens die Web-Push-Meldung im
 * Moment des Eintreffens (siehe postMeldungPushMelden() im Gateway) — nicht
 * die Mail selbst.
 *
 * WARUM EIN EIGENER REITER UND KEIN EINTRAG IM POSTFACH-REITER
 *
 * Postfach (PostPanel.tsx) ist der Briefkasten: jede Mail, roh, zum
 * Beantworten. Dieser Reiter ist die Einordnung EINER KI darüber — eine
 * andere Frage („was sollte mir auffallen?" statt „was liegt vor?"), mit
 * einem eigenen Rundgang. Ein Klick auf eine Zeile hier führt trotzdem
 * direkt zur Mail im Postfach-Reiter (`jumpToPostMail()` in state/store.ts,
 * dieselbe Bauart wie `jumpToMessage()` für den Sprung aus einer Suche in
 * einen Kanal) — dort steht der ganze Verlauf und die Antwortmöglichkeit.
 *
 * WARUM `mail.lesen` UND KEINE ENGERE ROLLE
 *
 * In jeder Zeile stehen Absender und Betreff echter Kundenpost. Wer die Post
 * selbst nicht lesen darf, darf auch ihre Einordnung nicht sehen — aber wer
 * sie lesen darf, darf auch das hier sehen, unabhängig von einer Rolle. Das
 * ist dieselbe Schwelle wie beim Postfach selbst (`requirePermission(userId,
 * 'mail.lesen')` in routes.ts). Enger ist nur der Kreis, der bei einer NEUEN
 * Mail sofort einen Web-Push bekommt (Leitung/Administration, siehe
 * `empfaengerkreis()` in post-sichtung.ts) — das entscheidet, WER ungefragt
 * gestört wird, nicht, wer nachträglich nachsehen darf.
 *
 * STRUKTURIERT STATT FLIESSTEXT
 *
 * Fach, Absender, Betreff, Anliegen, Dringlichkeit und der Handlungsstatus
 * sind getrennte Felder, keine Zeilen eines Textblocks — ein Absender kann
 * damit nicht mehr eine zusätzliche Zeile vortäuschen und sich als
 * „Dringlichkeit: niedrig" ausgeben (`fuerMeldung()` in post-sichtung.ts
 * entfernt trotzdem weiterhin Zeilenumbrüche aus jedem einzelnen Feld).
 *
 * FARBE NACH BEDEUTUNG
 *
 * Siehe der Kopf von styles/post-meldungen.css für die ausführliche
 * Begründung der zwei Farbachsen (Dringlichkeit am Kartenrand, Absenderart
 * am Punkt) und warum keine neue Farbe erfunden wurde.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpRight, Loader2, MailSearch, RefreshCw } from 'lucide-react';
import type { PostMeldung } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, relativeTime } from '../lib/format.js';
import { ABSENDERART_FARBE, dringlichkeitFarbe } from '../lib/post-farben.js';
import '../styles/post-meldungen.css';

const SEITENGROESSE = 50;

/* ── Abruf ───────────────────────────────────────────────────────
   Derselbe kleine, eigenständige Ersatz für request() aus net/api.ts wie in
   PostPanel.tsx, aus demselben Grund: an api.ts wird gerade an anderer
   Stelle gearbeitet, und ein zweiter Weg zur selben Fehlerübersetzung
   (Kennung -> Wörterbuch, deutscher Text als Rückfall) soll nicht an einer
   dritten Stelle neu erfunden werden, wo PostPanel.tsx die Vorlage schon
   liefert. */
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

async function meldungenHolen(vor?: number): Promise<PostMeldung[]> {
  const qs = new URLSearchParams({ anzahl: String(SEITENGROESSE) });
  if (vor) qs.set('vor', String(vor));
  const r = await meldungenFetch<{ meldungen: PostMeldung[] }>(`/api/post/meldungen?${qs}`);
  return r.meldungen;
}

/* Farbzuordnung: siehe lib/post-farben.ts — geteilt mit PostPanel.tsx, damit
   Postfach-Reiter und Post-Sichtung dieselbe Farbe für dieselbe Bedeutung
   zeigen. */

/* ── Die Tafel ─────────────────────────────────────────────────── */

export function PostMeldungen({ onClose }: { onClose: () => void }) {
  const t = useT();

  const [liste, setListe] = useState<PostMeldung[] | null>(null);
  const [laedt, setLaedt] = useState(true);
  const [fehler, setFehler] = useState<string | null>(null);
  const [kannWeiterladen, setKannWeiterladen] = useState(false);
  const [weitereLaedt, setWeitereLaedt] = useState(false);
  const [nurWartend, setNurWartend] = useState(false);

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
      const seite = await meldungenHolen(liste[liste.length - 1].gesichtetAm);
      setListe((v) => [...(v ?? []), ...seite]);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
    } catch (err) {
      setFehler((err as Error).message);
    } finally {
      setWeitereLaedt(false);
    }
  };

  useEffect(() => { void laden(); }, []);

  const wartendAnzahl = (liste ?? []).filter((m) => m.zustand === 'entwurf').length;
  const sichtbar = (liste ?? []).filter((m) => !nurWartend || m.zustand === 'entwurf');

  return (
    <Shell
      title={t('postSichtung.titel')}
      icon={<MailSearch size={18} />}
      onClose={onClose}
      width={720}
      actions={
        <button className="icon-btn" title={t('post.aktualisieren')} onClick={() => void laden()}>
          <RefreshCw size={15} />
        </button>
      }
    >
      <p className="postsicht__hinweis">{t('postSichtung.hinweis')}</p>

      <div className="postsicht-leiste">
        <button
          className={clsx('postsicht-tab', !nurWartend && 'postsicht-tab--on')}
          onClick={() => setNurWartend(false)}
        >
          {t('post.alle')}
          <span className="postsicht-tab__n">{liste?.length ?? 0}</span>
        </button>
        <button
          className={clsx('postsicht-tab', nurWartend && 'postsicht-tab--on')}
          onClick={() => setNurWartend(true)}
        >
          {t('postSichtung.filterWartend')}
          <span className="postsicht-tab__n">{wartendAnzahl}</span>
        </button>
      </div>

      {fehler && <div className="post__fehler"><AlertTriangle size={13} /> {fehler}</div>}

      {laedt && !liste && (
        <Loader2 size={22} className="spin muted" role="status" aria-label={t('post.laedt')} />
      )}

      {!laedt && !!liste && !sichtbar.length && (
        <div className="empty-state">
          <MailSearch size={28} className="muted" />
          <p>{t(nurWartend ? 'postSichtung.leerWartend' : 'post.listeLeer')}</p>
        </div>
      )}

      {!!sichtbar.length && (
        <div className="postsicht-liste">
          {sichtbar.map((m) => <Meldung key={m.mailId} m={m} t={t} onClose={onClose} />)}
        </div>
      )}

      {!laedt && !nurWartend && kannWeiterladen && (
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

/**
 * Eine Zeile — auf Modulebene wie VerlaufEintrag in PostPanel.tsx, aus
 * demselben Grund: eine hier verschachtelte Komponente bekäme bei jedem
 * Rendern von PostMeldungen einen neuen Bauplan, und React baute sie bei
 * jeder Änderung (Filter, Nachladen) komplett neu auf statt sie nur zu
 * aktualisieren. `t` kommt deshalb als Wert herein statt aus einem eigenen
 * `useT()`.
 */
function Meldung({ m, t, onClose }: {
  m: PostMeldung; onClose: () => void;
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
}) {
  const dringlichkeit = m.einordnung?.dringlichkeit ?? null;
  const randFarbe = dringlichkeitFarbe(dringlichkeit);

  return (
    <button
      className="postsicht-karte"
      style={{ borderInlineStartColor: randFarbe }}
      onClick={() => { useStore.getState().jumpToPostMail(m.mailId); onClose(); }}
    >
      <div className="postsicht-karte__kopf">
        {m.einordnung && (
          <span className="postsicht-badge" style={{ color: ABSENDERART_FARBE[m.einordnung.absenderart] }}>
            <span
              className="postsicht-badge__punkt"
              style={{ background: ABSENDERART_FARBE[m.einordnung.absenderart] }}
              aria-hidden="true"
            />
            {t(`postSichtung.absenderart.${m.einordnung.absenderart}` as TranslationKey)}
          </span>
        )}
        <span className="postsicht-karte__fach">{m.fach}</span>
        <span className="postsicht-karte__zeit">{relativeTime(m.gesichtetAm)}</span>
      </div>

      <div className="postsicht-karte__von truncate">{m.von}</div>
      <div className="postsicht-karte__betreff truncate">{m.betreff || t('post.ohneBetreff')}</div>

      {m.einordnung ? (
        <>
          <p className="postsicht-karte__anliegen">{m.einordnung.anliegen}</p>
          <span className="postsicht-karte__dringlichkeit" style={{ color: randFarbe }}>
            {t(`postSichtung.dringlichkeit.${m.einordnung.dringlichkeit}` as TranslationKey)}
          </span>
        </>
      ) : m.zustand === 'laeuft' ? (
        <p className="postsicht-karte__anliegen muted">{t('postSichtung.wirdGeprueft')}</p>
      ) : null}

      {m.grundCode && (
        <p className={clsx('postsicht-karte__grund', m.zustand === 'entwurf' && 'postsicht-karte__grund--handeln')}>
          {m.zustand === 'entwurf' && <ArrowUpRight size={12} />}
          {t(`postSichtung.grund.${m.grundCode}` as TranslationKey)}
        </p>
      )}

      {m.abweichung && (
        <p className="postsicht-karte__warnung">
          <AlertTriangle size={12} />
          {t('postSichtung.abweichung', { an: m.abweichung.an, von: m.abweichung.von })}
        </p>
      )}
    </button>
  );
}
