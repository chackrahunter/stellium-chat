/**
 * Das Unternehmenspostfach — Fächer, ihre Liste und der Verlauf einer Post.
 *
 * Baut ausschließlich auf dem, was `packages/server/src/services/post.ts`
 * tatsächlich liefert: `faecher()`, `liste()`, `nachricht()`, `verlauf()` und
 * `senden()`. Die Strecke dorthin (`/api/post/*`) gibt es beim Schreiben
 * dieser Datei noch nicht — sie wird an anderer Stelle verdrahtet. Angenommen
 * ist deshalb nur die naheliegende Hülle je Route (siehe die `*Holen`-
 * Funktionen weiter unten, an der Kante zum Server benannt); weicht die
 * echte Antwort davon ab, genügt eine Zeile Anpassung dort.
 *
 * Zum HTML-Teil: `nachricht.html` kommt von außerhalb der Firma — von wem
 * auch immer an `support@` & Co. geschrieben hat. Standardmäßig zeigt diese
 * Tafel deshalb nur den Textteil. Wer HTML sehen will, muss das je Eintrag im
 * Verlauf ausdrücklich anklicken, und selbst dann läuft es durch ein
 * `<iframe sandbox="">` mit eigener, strenger Inhaltsrichtlinie statt durch
 * `dangerouslySetInnerHTML` — die Begründung steht bei `htmlDokument()`.
 */
import { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, AtSign, Clock, Inbox, Loader2, Mail,
  Paperclip, RefreshCw, Send, Sparkles,
} from 'lucide-react';
import type { Absenderart, Dringlichkeit } from '@stellium/shared';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { PostSchreiben } from './PostSchreiben.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, dateTime, fileSize, relativeTime } from '../lib/format.js';
import { dringlichkeitFarbe } from '../lib/post-farben.js';

/* ── Die Daten, wie post.ts sie liefert ────────────────────────────
   Lokal noch einmal erklärt statt aus dem Serverpaket importiert: das
   Postfach ist neu, und einen Import über die Paketgrenze zum Server gibt es
   in der Oberfläche sonst nirgends — das wäre eine eigene, hier nicht
   gewollte Abhängigkeit. */

interface PostNachricht {
  id: string;
  fach: string;
  richtung: 'ein' | 'aus';
  von: string;
  an: string;
  betreff: string;
  text: string;
  html: string | null;
  messageId: string | null;
  referenzen: string | null;
  threadId: string | null;
  am: number;
  gelesen: boolean;
  anhaenge: Array<{ name: string; typ: string; groesse: number }>;
}

interface PostFach {
  fach: string;
  gesamt: number;
  ungelesen: number;
}

/**
 * Zustand und Einordnung der KI-Sichtung zu einer Mail — die kleine Hülle
 * für `GET /api/post/sichtungen`, gebraucht für die Färbung und die
 * Sortierung nach Dringlichkeit weiter unten. Nur die Felder, die dafür
 * zählen; die volle Form (Anliegen, Begründung, Sprache, Modell) trägt
 * `PostMeldung` aus `@stellium/shared` und gehört dem Reiter
 * „Post-Sichtung" (PostMeldungen.tsx), nicht dieser Tafel hier.
 */
interface SichtungKurz {
  zustand: 'laeuft' | 'gemeldet' | 'entwurf' | 'gesendet' | 'abgelehnt' | 'fehler';
  einordnung: { absenderart: Absenderart; dringlichkeit: Dringlichkeit } | null;
}

const SEITENGROESSE = 50;

/* ── Abruf ───────────────────────────────────────────────────────
   Ein eigener, kleiner Ersatz für `request()` aus net/api.ts: an api.ts wird
   gerade an anderer Stelle gearbeitet, diese Tafel darf die Datei nicht
   anfassen, und `request()` ist dort ohnehin nicht exportiert. Diese Fassung
   spiegelt nur, was das Postfach braucht — Basisadresse, Anmeldenachweis und
   das Lesen von `code`/`error` aus einer Fehlerantwort —, damit vorhandene
   Übersetzungen für Fehlerkennungen (etwa 'post.keineVerbindung' aus
   post.ts) auch hier greifen, genau wie beim großen Vorbild. */
async function postFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body !== undefined && init.body !== null) headers.set('content-type', 'application/json');
  const nachweis = token();
  if (nachweis) headers.set('authorization', `Bearer ${nachweis}`);

  let antwort: Response;
  try {
    antwort = await fetch(`${serverUrl()}${pfad}`, { ...init, headers });
  } catch {
    throw new ApiError(tStatisch('api.serverUnreachable', { adresse: serverUrl() }), 0);
  }

  if (!antwort.ok) {
    let message = tStatisch('api.error', { status: antwort.status });
    let code: string | undefined;
    let werte: Record<string, string> | undefined;
    try {
      const rumpf = await antwort.json() as { error?: string; code?: string; werte?: Record<string, string> };
      message = rumpf.error ?? message;
      code = rumpf.code;
      werte = rumpf.werte;
    } catch { /* keine JSON-Antwort */ }
    if (code) {
      const uebersetzt = tStatisch(code as TranslationKey, werte);
      if (uebersetzt && uebersetzt !== code) message = uebersetzt;
    }
    throw new ApiError(message, antwort.status, code);
  }
  return antwort.status === 204 ? (undefined as T) : ((await antwort.json()) as T);
}

/** Die Fächer mit ihren Zählständen. Angenommene Hülle: `{ faecher: [...] }`. */
async function faecherHolen(): Promise<PostFach[]> {
  const r = await postFetch<{ faecher: PostFach[] }>('/api/post/faecher');
  return r.faecher;
}

/** Eine Seite der Liste eines Fachs — oder aller Fächer, wenn `fach` null ist. */
async function listeHolen(fach: string | null, vor?: number): Promise<PostNachricht[]> {
  const qs = new URLSearchParams({ anzahl: String(SEITENGROESSE) });
  if (fach) qs.set('fach', fach);
  if (vor) qs.set('vor', String(vor));
  const r = await postFetch<{ nachrichten: PostNachricht[] }>(`/api/post/liste?${qs}`);
  return r.nachrichten;
}

/** Zustand/Dringlichkeit für eine Handvoll Mails — für Färbung und Sortierung
    nach Dringlichkeit, siehe SichtungKurz weiter oben. Leer rein, leer
    raus: eine Seite ohne eingegangene Mail (nur Gesendetes) braucht keinen
    Netzwerkumweg. */
async function sichtungenHolen(mailIds: string[]): Promise<Record<string, SichtungKurz>> {
  if (!mailIds.length) return {};
  const qs = new URLSearchParams({ ids: mailIds.join(',') });
  const r = await postFetch<{ sichtungen: Record<string, SichtungKurz> }>(`/api/post/sichtungen?${qs}`);
  return r.sichtungen;
}

/** Eine einzelne Nachricht. */
async function nachrichtHolen(id: string): Promise<PostNachricht | null> {
  const r = await postFetch<{ nachricht: PostNachricht | null }>(`/api/post/nachricht/${encodeURIComponent(id)}`);
  return r.nachricht;
}

/** Der ganze Verlauf zu einer Nachricht, älteste zuerst. */
async function verlaufHolen(threadId: string): Promise<PostNachricht[]> {
  const r = await postFetch<{ verlauf: PostNachricht[] }>(`/api/post/verlauf/${encodeURIComponent(threadId)}`);
  return r.verlauf;
}

interface AntwortEingabe {
  fach: string;
  an: string;
  betreff: string;
  text: string;
  antwortAuf: { messageId: string | null; referenzen: string | null; threadId: string | null };
}

async function antwortSenden(eingabe: AntwortEingabe): Promise<{ id: string }> {
  return postFetch<{ id: string }>('/api/post/senden', { method: 'POST', body: JSON.stringify(eingabe) });
}

/* ── Kleinigkeiten ─────────────────────────────────────────────── */

/** Ein einzeiliger Ausschnitt aus dem Text — Zeilenumbrüche raus, sonst
    reißt die erste Zeile eines Briefs die Vorschau in Fetzen. */
function auszug(text: string, laenge = 140): string {
  const einzeilig = text.replace(/\s+/g, ' ').trim();
  return einzeilig.length > laenge ? `${einzeilig.slice(0, laenge)}…` : einzeilig;
}

/** Der Teil vor dem @ — „support" statt „support@firma.de" in der Fächerliste. */
function fachName(fach: string): string {
  const [lokal] = fach.split('@');
  return lokal || fach;
}

/**
 * Ein eigenständiges Dokument für die HTML-Vorschau.
 *
 * Kein `dangerouslySetInnerHTML`: der Inhalt kommt von Fremden und geht nie
 * in den React-Baum dieser App. Stattdessen bekommt ein `<iframe
 * sandbox="">` ein vollständig eigenes Dokument über `srcDoc` — ganz ohne
 * `allow-scripts` und `allow-same-origin` kann darin nichts laufen und
 * nichts auf diese App zugreifen. Das erzwingt der Browser selbst, keine
 * selbstgebaute Prüfung.
 *
 * Die Inhaltsrichtlinie im `<meta>` ist ein zweiter Riegel: `default-src
 * 'none'` unterbindet auch das bloße NACHLADEN von Inhalten — zum Beispiel
 * ein unsichtbares Zählpixel, das sonst schon beim Öffnen verriete, dass die
 * Post gelesen wurde. Verweise in der Vorschau funktionieren dadurch nicht;
 * das ist Absicht und kein Fehler — ein klickbarer Verweis bräuchte genau
 * die Erlaubnis, die hier fehlt, und könnte sonst zu einer gefälschten Seite
 * führen, ohne dass die App das verhindern könnte.
 */
function htmlDokument(html: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">`
    + `<meta http-equiv="Content-Security-Policy" `
    + `content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;">`
    + `<style>body{font:14px/1.55 -apple-system,Helvetica,Arial,sans-serif;`
    + `color:#1a1a1a;background:#fff;padding:14px;overflow-wrap:anywhere}</style>`
    + `</head><body>${html}</body></html>`;
}

/* ── Die Tafel ─────────────────────────────────────────────────── */

export function PostPanel({ onClose }: { onClose: () => void }) {
  const t = useT();

  const [faecher, setFaecher] = useState<PostFach[] | null>(null);
  const [faecherLaedt, setFaecherLaedt] = useState(true);
  const [faecherFehler, setFaecherFehler] = useState<string | null>(null);

  const [aktivesFach, setAktivesFach] = useState<string | null>(null);
  const [eintraege, setEintraege] = useState<PostNachricht[]>([]);
  const [listeLaedt, setListeLaedt] = useState(true);
  const [listeFehler, setListeFehler] = useState<string | null>(null);
  const [kannWeiterladen, setKannWeiterladen] = useState(false);
  const [weitereLaedt, setWeitereLaedt] = useState(false);
  /* Zustand/Dringlichkeit je Mail, für Rand-Farbe und Sortierung — sammelt
     sich über mehrere Seiten hinweg an (siehe sichtungenNachladen), damit
     „Ältere laden" nicht die Einordnung der schon gezeigten Zeilen verliert. */
  const [sichtungen, setSichtungen] = useState<Record<string, SichtungKurz>>({});
  /* Vorgabe „Dringlichkeit": das ist eine Einschätzung der KI, keine
     Tatsache (siehe sortierteEintraege weiter unten) — deshalb bleibt „Nach
     Zeit" jederzeit ein Klick entfernt, nicht nur beim ersten Laden. */
  const [sortierung, setSortierung] = useState<'dringlichkeit' | 'zeit'>('dringlichkeit');

  const [ausgewaehlteId, setAusgewaehlteId] = useState<string | null>(null);
  const [verlauf, setVerlauf] = useState<PostNachricht[]>([]);
  const [detailLaedt, setDetailLaedt] = useState(false);
  const [detailFehler, setDetailFehler] = useState<string | null>(null);

  const [antwortText, setAntwortText] = useState('');
  const [sendenLaedt, setSendenLaedt] = useState(false);

  const verlaufRef = useRef<HTMLDivElement>(null);

  const faecherLaden = async () => {
    setFaecherLaedt(true); setFaecherFehler(null);
    try {
      setFaecher(await faecherHolen());
    } catch (err) {
      setFaecherFehler((err as Error).message);
    } finally {
      setFaecherLaedt(false);
    }
  };

  /* Fehlschlagen darf die Liste selbst nicht mit reißen: ohne Einordnung
     bleibt eine Zeile einfach neutral gefärbt (siehe dringlichkeitRang()
     weiter unten) statt dass ein zweiter Fehlertext über der Liste steht,
     die gerade erfolgreich geladen hat. */
  const sichtungenNachladen = async (nachrichten: PostNachricht[]) => {
    const ids = nachrichten.filter((n) => n.richtung === 'ein').map((n) => n.id);
    if (!ids.length) return;
    try {
      const gefunden = await sichtungenHolen(ids);
      setSichtungen((v) => ({ ...v, ...gefunden }));
    } catch { /* siehe Begründung oben */ }
  };

  const listeLaden = async (fach: string | null) => {
    // Sofort leeren statt erst nach der Antwort: sonst zeigt die Liste kurz
    // die Post des VORHERIGEN Fachs unter dem neu gewählten Namen an.
    setListeLaedt(true); setListeFehler(null); setEintraege([]); setKannWeiterladen(false);
    try {
      const seite = await listeHolen(fach);
      setEintraege(seite);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
      void sichtungenNachladen(seite);
    } catch (err) {
      setListeFehler((err as Error).message);
    } finally {
      setListeLaedt(false);
    }
  };

  const weitereLaden = async () => {
    if (!eintraege.length) return;
    setWeitereLaedt(true);
    try {
      const seite = await listeHolen(aktivesFach, eintraege[eintraege.length - 1].am);
      setEintraege((v) => [...v, ...seite]);
      setKannWeiterladen(seite.length >= SEITENGROESSE);
      void sichtungenNachladen(seite);
    } catch (err) {
      setListeFehler((err as Error).message);
    } finally {
      setWeitereLaedt(false);
    }
  };

  useEffect(() => { void faecherLaden(); }, []);
  useEffect(() => { void listeLaden(aktivesFach); }, [aktivesFach]);

  /* Sprung aus dem Reiter „Post-Sichtung" (siehe jumpToPostMail() in
     state/store.ts): eine Mail auswählen, sobald von dort eine Kennung
     ankommt, und uns danach abmelden — sonst wählte ein späteres,
     unabhängiges Öffnen dieses Reiters dieselbe Mail noch einmal aus. Die
     Auswahl selbst holt sich ihren Inhalt über den Effekt weiter unten
     (nachrichtHolen), unabhängig davon, ob die Mail im aktuell geladenen
     Fach/Ausschnitt der Liste steht. */
  const postJumpMailId = useStore((s) => s.postJumpMailId);
  useEffect(() => {
    if (!postJumpMailId) return;
    setAusgewaehlteId(postJumpMailId);
    useStore.getState().postJumpConsumed();
  }, [postJumpMailId]);

  useEffect(() => {
    if (!ausgewaehlteId) { setVerlauf([]); setDetailFehler(null); return; }
    let lebt = true;
    setDetailLaedt(true); setDetailFehler(null);
    (async () => {
      try {
        const n = await nachrichtHolen(ausgewaehlteId);
        if (!n) {
          // Verschwunden oder falsche Kennung: zurück zur leeren Auswahl
          // statt eine Fehlermeldung über eine einzelne Nachricht zu zeigen.
          if (lebt) { setVerlauf([]); setAusgewaehlteId(null); }
          return;
        }
        // Ohne threadId ist die Nachricht selbst der Anfang und das Ende
        // ihres Verlaufs — dann genügt ein Eintrag statt eines Abrufs.
        const kette = n.threadId ? await verlaufHolen(n.threadId) : [n];
        if (lebt) setVerlauf(kette.length ? kette : [n]);
      } catch (err) {
        if (lebt) setDetailFehler((err as Error).message);
      } finally {
        if (lebt) setDetailLaedt(false);
      }
    })();
    return () => { lebt = false; };
  }, [ausgewaehlteId]);

  // Zur gewählten Nachricht springen, wenn sie Teil eines längeren Verlaufs
  // ist — sonst steht sie irgendwo außerhalb des sichtbaren Ausschnitts.
  useEffect(() => {
    if (!ausgewaehlteId || !verlauf.length) return;
    const ziel = verlaufRef.current
      ?.querySelector<HTMLElement>(`[data-post-id="${CSS.escape(ausgewaehlteId)}"]`);
    ziel?.scrollIntoView({ block: 'nearest' });
  }, [ausgewaehlteId, verlauf]);

  const gesamtUngelesen = faecher?.reduce((summe, f) => summe + f.ungelesen, 0) ?? 0;

  /**
   * Stufe für die Sortierung nach Dringlichkeit — kleiner ist weiter oben.
   *
   * VIER FALLSTRICKE, VIER ENTSCHEIDUNGEN:
   *
   *   1. Ungesichtete Post darf nicht untergehen. Eine Mail ohne eigene
   *      Zeile in `sichtungen` (frisch eingegangen, `sichtungenNachladen`
   *      noch nicht durch oder die Sichtung selbst noch nicht einmal
   *      gestartet) landet in Stufe 0 — ganz oben, noch vor „hoch". Sie ist
   *      die neueste Mail und könnte alles sein; sie unten anzuhängen wäre
   *      der stille Rückfall auf „niedrig", den es hier nicht geben soll.
   *   2. Zeit zählt als zweite Ordnung — siehe sortierteEintraege() unten:
   *      innerhalb derselben Stufe bleibt die vom Server gelieferte
   *      Reihenfolge (neueste zuerst) einfach erhalten.
   *   3. Eine gescheiterte Sichtung (`fehler`) — die KI hat nichts geliefert
   *      — steht aus demselben Grund wie Punkt 1 ebenfalls in Stufe 0, nicht
   *      in „niedrig": „nichts weiß" ist kein Werturteil.
   *   4. Die Einstufung kommt von einer KI und kann falsch liegen — deshalb
   *      ist „Nach Dringlichkeit" nur die VORGABE, nicht die einzige
   *      Ordnung. Der Umschalter in der Kopfzeile wechselt jederzeit auf
   *      „Nach Zeit", der reinen, von keiner Einschätzung abhängigen Order.
   *
   * Gesendete Post (`richtung === 'aus'`) hat nie eine Sichtung und keine
   * Dringlichkeit — sie steht bewusst UNTER „niedrig": diese Sortierung ist
   * eine Triage eingehender Post, das eigene Archiv drängt sich dabei nicht
   * nach vorn.
   */
  const dringlichkeitRang = (n: PostNachricht): number => {
    if (n.richtung === 'aus') return 4;
    const s = sichtungen[n.id];
    if (!s || s.zustand === 'laeuft' || s.zustand === 'fehler') return 0;
    const d = s.einordnung?.dringlichkeit;
    if (d === 'hoch') return 1;
    if (d === 'normal') return 2;
    if (d === 'niedrig') return 3;
    return 0; // z.B. 'entwurf'/'gemeldet', dessen Einordnung noch nicht eingetroffen ist
  };

  // 'zeit' ist keine eigene Sortierung: der Server liefert `eintraege` schon
  // chronologisch (neueste zuerst, siehe post.liste()) — genau das ist die
  // reine, von keiner KI-Einschätzung abhängige Ordnung aus Fallstrick 4
  // oben. `sort()` auf einer Kopie, damit `eintraege` selbst (Grundlage für
  // `weitereLaden()`s Zeitstempel) unverändert bleibt.
  const sortierteEintraege = sortierung === 'zeit'
    ? eintraege
    : [...eintraege].sort((a, b) => dringlichkeitRang(a) - dringlichkeitRang(b));

  // Antwortziel: die jeweils ANDERE Seite des letzten Eintrags im Verlauf —
  // bei einer eingegangenen Nachricht ihr Absender, bei einer gesendeten ihr
  // Empfänger. So passt das Ziel unabhängig davon, welcher Eintrag gerade in
  // der Liste angeklickt wurde, und der Bezug (`In-Reply-To`/`References`)
  // knüpft am jüngsten Glied der Kette an, nicht am angeklickten.
  const letzte = verlauf.length ? verlauf[verlauf.length - 1] : null;
  const zielAdresse = letzte ? (letzte.richtung === 'ein' ? letzte.von : letzte.an) : null;
  const absenderFach = letzte?.fach ?? null;
  const betreffVorschlag = letzte
    ? (/^re:/i.test(letzte.betreff.trim()) ? letzte.betreff : `Re: ${letzte.betreff}`)
    : '';

  const senden = async () => {
    const text = antwortText.trim();
    if (!text || !letzte || !zielAdresse || !absenderFach) return;
    setSendenLaedt(true);
    try {
      await antwortSenden({
        fach: absenderFach,
        an: zielAdresse,
        betreff: betreffVorschlag,
        text,
        antwortAuf: { messageId: letzte.messageId, referenzen: letzte.referenzen, threadId: letzte.threadId },
      });
      setAntwortText('');
      useStore.getState().toast({ kind: 'ok', title: t('post.gesendet') });
      // Die eigene Antwort steht jetzt im Verlauf und ändert die Zählstände.
      if (letzte.threadId) setVerlauf(await verlaufHolen(letzte.threadId));
      void faecherLaden();
      void listeLaden(aktivesFach);
    } catch (err) {
      useStore.getState().toast({
        kind: 'error', title: t('post.sendenFehlgeschlagen'), body: (err as Error).message,
      });
    } finally {
      setSendenLaedt(false);
    }
  };

  return (
    <Shell
      title={t('post.titel')}
      subtitle={faecher ? t('post.untertitelUngelesen', { n: gesamtUngelesen }) : undefined}
      icon={<Mail size={18} />}
      onClose={onClose}
      width={1180}
      actions={
        <>
          {/* Eigene Komponente, eine Zeile eingehängt (siehe PostSchreiben.tsx) — verwaltet Knopf und Fenster vollständig selbst. */}
          <PostSchreiben onGesendet={() => { void faecherLaden(); void listeLaden(aktivesFach); }} />
          <button
            className="icon-btn"
            title={t('post.aktualisieren')}
            onClick={() => { void faecherLaden(); void listeLaden(aktivesFach); }}
          >
            <RefreshCw size={15} />
          </button>
        </>
      }
    >
      <div className="post">
        <nav className="post__faecher" aria-label={t('post.faecherAria')}>
          {faecherFehler && <div className="post__fehler"><AlertTriangle size={13} /> {faecherFehler}</div>}
          {faecherLaedt && !faecher && (
            <Loader2 size={16} className="spin muted" role="status" aria-label={t('post.laedt')} />
          )}
          {faecher && (
            <>
              <button
                className={clsx('chan', gesamtUngelesen > 0 && 'chan--unread')}
                aria-current={aktivesFach === null ? 'true' : undefined}
                onClick={() => setAktivesFach(null)}
              >
                <span className="chan__icon"><Inbox size={15} /></span>
                <span className="chan__name">{t('post.alle')}</span>
                {gesamtUngelesen > 0 && <span className="chan__badge">{gesamtUngelesen}</span>}
              </button>
              {faecher.map((f) => (
                <FachZeile
                  key={f.fach}
                  fach={f}
                  aktiv={aktivesFach === f.fach}
                  onWaehlen={() => setAktivesFach(f.fach)}
                />
              ))}
            </>
          )}
        </nav>

        <section className="post__liste">
          {listeFehler && <div className="post__fehler"><AlertTriangle size={13} /> {listeFehler}</div>}
          {listeLaedt && (
            <Loader2 size={18} className="spin muted" role="status" aria-label={t('post.laedt')} />
          )}
          {!listeLaedt && !listeFehler && !eintraege.length && (
            <div className="empty-state">
              <Mail size={26} className="muted" />
              <p>{t('post.listeLeer')}</p>
            </div>
          )}
          {/* Vorgabe „Nach Dringlichkeit", aber jederzeit umschaltbar: die
              Einstufung stammt von einer KI und kann danebenliegen — siehe
              die ausführliche Begründung bei dringlichkeitRang() weiter oben. */}
          {!listeLaedt && !!eintraege.length && (
            <div className="post__sortierung" role="group" aria-label={t('post.sortierungAria')}>
              <button
                className={clsx('pill pill--sort', sortierung === 'dringlichkeit' && 'pill--sort-on')}
                aria-pressed={sortierung === 'dringlichkeit'}
                title={t('post.sortierungHinweis')}
                onClick={() => setSortierung('dringlichkeit')}
              >
                <Sparkles size={12} /> {t('post.sortierungDringlichkeit')}
              </button>
              <button
                className={clsx('pill pill--sort', sortierung === 'zeit' && 'pill--sort-on')}
                aria-pressed={sortierung === 'zeit'}
                onClick={() => setSortierung('zeit')}
              >
                <Clock size={12} /> {t('post.sortierungZeit')}
              </button>
            </div>
          )}
          {!listeLaedt && sortierteEintraege.map((n) => (
            <NachrichtZeile
              key={n.id}
              n={n}
              sichtung={sichtungen[n.id]}
              aktiv={n.id === ausgewaehlteId}
              onOeffnen={() => setAusgewaehlteId(n.id)}
            />
          ))}
          {!listeLaedt && kannWeiterladen && (
            <button
              className="btn btn--ghost btn--block"
              disabled={weitereLaedt}
              onClick={() => void weitereLaden()}
            >
              {weitereLaedt ? <Loader2 size={14} className="spin" /> : t('post.weitereLaden')}
            </button>
          )}
        </section>

        <section className="post__detail">
          {!ausgewaehlteId && (
            <div className="empty-state">
              <Send size={26} className="muted" />
              <p>{t('post.keineAuswahl')}</p>
            </div>
          )}
          {ausgewaehlteId && detailFehler && (
            <div className="post__fehler"><AlertTriangle size={13} /> {detailFehler}</div>
          )}
          {ausgewaehlteId && detailLaedt && !verlauf.length && (
            <Loader2 size={18} className="spin muted" role="status" aria-label={t('post.laedt')} />
          )}
          {ausgewaehlteId && !!verlauf.length && (
            <>
              <h3 className="post__betreff">{letzte?.betreff || t('post.ohneBetreff')}</h3>

              <div ref={verlaufRef} className="post__verlauf">
                {verlauf.map((n) => (
                  <VerlaufEintrag key={n.id} n={n} aktiv={n.id === ausgewaehlteId} t={t} />
                ))}
              </div>

              <div className="post__antwort">
                <p className="muted post__antwort-ziel">
                  {t('post.antwortVon', { fach: absenderFach ?? '' })}
                </p>
                <textarea
                  className="textarea"
                  aria-label={t('post.antwortLabel')}
                  placeholder={t('post.antwortPlatzhalter')}
                  value={antwortText}
                  onChange={(e) => setAntwortText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void senden(); }
                  }}
                  rows={3}
                />
                <div className="post__antwort-fuss">
                  <span className="muted post__antwort-hinweis">{t('post.sendenHinweis')}</span>
                  <button
                    className="btn btn--primary"
                    disabled={!antwortText.trim() || sendenLaedt}
                    onClick={() => void senden()}
                  >
                    {sendenLaedt ? <Loader2 size={14} className="spin" /> : <Send size={14} />}
                    {t('post.senden')}
                  </button>
                </div>
              </div>
            </>
          )}
        </section>
      </div>
    </Shell>
  );

  // Verschachtelt statt auf Modulebene: beide halten keinen eigenen Zustand
  // und schließen einfach über das `t` von oben — ein neuer Bauplan bei
  // jedem Rendern von PostPanel kostet hier nichts, siehe VerlaufEintrag
  // weiter unten für den Fall, in dem das nicht mehr stimmt.
  function FachZeile({ fach, aktiv, onWaehlen }: { fach: PostFach; aktiv: boolean; onWaehlen: () => void }) {
    return (
      <button
        className={clsx('chan', fach.ungelesen > 0 && 'chan--unread')}
        aria-current={aktiv ? 'true' : undefined}
        title={fach.fach}
        onClick={onWaehlen}
      >
        <span className="chan__icon"><AtSign size={14} /></span>
        <span className="chan__name">{fachName(fach.fach)}</span>
        {fach.ungelesen > 0 && (
          <span className="chan__badge">
            {fach.ungelesen}
            <span className="post__sr-only"> · {t('post.ungelesenMarke')}</span>
          </span>
        )}
      </button>
    );
  }

  function NachrichtZeile({ n, sichtung, aktiv, onOeffnen }: {
    n: PostNachricht; sichtung: SichtungKurz | undefined; aktiv: boolean; onOeffnen: () => void;
  }) {
    const ungelesen = n.richtung === 'ein' && !n.gelesen;
    const adresse = n.richtung === 'aus' ? n.an : n.von;
    // Dieselbe Farbe wie im Reiter „Post-Sichtung" (siehe lib/post-farben.ts)
    // — `undefined` (noch nicht gesichtet) und `dringlichkeit` fehlend
    // (Sichtung läuft/fehlgeschlagen) ergeben beide die neutrale Randfarbe,
    // nie die Farbe von „niedrig" (siehe dringlichkeitRang() weiter oben).
    const randFarbe = n.richtung === 'ein' ? dringlichkeitFarbe(sichtung?.einordnung?.dringlichkeit) : undefined;
    return (
      <button
        className={clsx('post-row', ungelesen && 'post-row--ungelesen')}
        style={randFarbe ? { borderInlineStartColor: randFarbe } : undefined}
        aria-current={aktiv ? 'true' : undefined}
        onClick={onOeffnen}
      >
        <span className="post-row__kopf">
          <span className="post-row__von truncate">
            {n.richtung === 'aus' && <ArrowUpRight size={11} className="post-row__richtung" aria-hidden="true" />}
            {adresse || t('post.unbekannt')}
          </span>
          <span className="post-row__zeit">{relativeTime(n.am)}</span>
        </span>
        <span className="post-row__betreff truncate">{n.betreff || t('post.ohneBetreff')}</span>
        <span className="post-row__auszug truncate">{auszug(n.text)}</span>
        {ungelesen && <span className="post__sr-only">{t('post.ungelesenMarke')}</span>}
      </button>
    );
  }
}

/**
 * Ein Eintrag im Verlauf — mit eigenem Umschalter für die HTML-Vorschau.
 *
 * Bewusst auf Modulebene statt in PostPanel verschachtelt, mit eigenem
 * `useState`: eine in einer anderen Komponente NEU DEFINIERTE Komponente
 * bekommt bei jedem Rendern der äußeren einen neuen Bauplan (eine neue
 * Funktionsreferenz), und React sieht darin einen ANDEREN Komponententyp —
 * es baut sie neu auf, statt sie nur zu aktualisieren, und jeder eigene
 * Zustand geht dabei verloren. Das Antwortfeld daneben ändert seinen
 * Zustand bei jedem Tastendruck; verschachtelt wäre der HTML-Umschalter
 * also bei jedem Zeichen zurück auf „nur Text" gesprungen. `t` kommt deshalb
 * als Wert herein statt aus einem eigenen `useT()`.
 */
function VerlaufEintrag({ n, aktiv, t }: {
  n: PostNachricht; aktiv: boolean; t: (key: TranslationKey, werte?: Record<string, string | number>) => string;
}) {
  const [htmlOffen, setHtmlOffen] = useState(false);

  return (
    <div
      data-post-id={n.id}
      className={clsx(
        'post__eintrag',
        aktiv && 'post__eintrag--aktiv',
        n.richtung === 'aus' && 'post__eintrag--richtung-aus',
      )}
    >
      <div className="post__eintrag-kopf">
        {/* `title` sitzt auf der Hülle, nicht auf dem Symbol selbst: lucide-react
            reicht kein `title` an das SVG durch (LucideProps kennt es nicht),
            eine Elternspanne mit Titel-Attribut zeigt denselben Hinweis beim
            Überfahren mit der Maus. */}
        <span
          className="post__eintrag-richtung"
          title={n.richtung === 'ein' ? t('post.eingegangen') : t('post.ausgegangen')}
          aria-hidden="true"
        >
          {n.richtung === 'ein' ? <ArrowDownLeft size={13} className="muted" /> : <ArrowUpRight size={13} className="muted" />}
        </span>
        <span className="post__eintrag-adresse truncate">{n.richtung === 'ein' ? n.von : n.an}</span>
        <span className="post__eintrag-zeit">{dateTime(n.am)}</span>
      </div>

      {!!n.anhaenge.length && (
        <div className="post__anhaenge">
          {n.anhaenge.map((a, i) => (
            <span key={i} className="post__anhang">
              <Paperclip size={11} /> {a.name} · {fileSize(a.groesse)}
            </span>
          ))}
        </div>
      )}

      {/* Reiner Text als React-Kindknoten: der Browser kann daraus keinen
          Code machen, ganz ohne Sonderbehandlung. Das ist die Vorgabe — HTML
          gibt es nur nach ausdrücklichem Klick, siehe unten. */}
      <div className="post__text">{n.text}</div>

      {n.html && (
        <div className="post__html-zeile">
          <button className="pill" onClick={() => setHtmlOffen((v) => !v)}>
            {htmlOffen ? t('post.nurText') : t('post.htmlAnzeigen')}
          </button>
        </div>
      )}

      {n.html && htmlOffen && (
        <>
          <iframe
            className="post__html-rahmen"
            title={t('post.htmlVorschau')}
            sandbox=""
            referrerPolicy="no-referrer"
            srcDoc={htmlDokument(n.html)}
          />
          <p className="post__html-hinweis"><AlertTriangle size={12} /> {t('post.htmlHinweis')}</p>
        </>
      )}
    </div>
  );
}
