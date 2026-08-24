import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowDownLeft, ArrowUpRight, Clock, Hourglass, KeyRound,
  Landmark, Loader2, Lock, Receipt, RefreshCw, Stethoscope, TrendingUp, Wallet,
} from 'lucide-react';
import { Shell } from './Panels.jsx';
import { useStore } from '../state/store.js';
import { t as tStatisch, useT, currentUiLanguage, type TranslationKey } from '../i18n/index.js';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx } from '../lib/format.js';
import '../styles/paypal.css';

/**
 * Der PayPal-Kontostand — das Bankkonto der Firma, zum ANSEHEN.
 *
 * WARUM EIN EIGENER REITER UND NICHT EIN BLOCK IN DER VERKAUFSANSICHT:
 * Gumroad und Patreon beantworten „was haben wir verkauft". PayPal
 * beantwortet „was haben wir". Das sind zwei Fragen, und die Zahlen dazu
 * sind teilweise DASSELBE GELD zu zwei verschiedenen Zeitpunkten: ein
 * Gumroad-Verkauf über 25 € taucht Wochen später als PayPal-Eingang wieder
 * auf, wenn Gumroad auszahlt. Beides in eine Summe zu werfen hieße, denselben
 * Euro zweimal zu zählen — und weil niemand es merkt, wäre es die
 * gefährlichste Art von Fehler. Deshalb: getrennte Tafel, getrenntes Recht,
 * und unten ein ausdrücklicher Satz, dass die Zahlen NICHT addierbar sind.
 *
 * DREI ZUSTÄNDE, DIE NIE GLEICH AUSSEHEN DÜRFEN. Der Server schickt sie
 * ausdrücklich mit (`zustand`), damit diese Tafel sie nicht aus vorhandenen
 * oder fehlenden Feldern raten muss:
 *
 *   nicht eingerichtet  →  Anleitung, was zu tun ist.
 *   eingerichtet, letzter Abruf fehlgeschlagen  →  ein rotes Band mit „seit
 *       wann", UND die zuletzt bekannten Zahlen darunter, deutlich mit IHREM
 *       Zeitpunkt beschriftet. Nicht leer: alte Zahlen sind mehr wert als
 *       gar keine, solange man weiß, dass sie alt sind.
 *   eingerichtet und aktuell  →  „Stand HH:MM", dazu PayPals eigener
 *       Frischezeitpunkt (der ist bis zu drei Stunden älter, siehe
 *       services/paypal.ts).
 *
 * Ein LEERES Konto ist keiner dieser Sonderfälle: es ist „aktuell" mit
 * Salden von null, und genau so sieht es hier auch aus.
 *
 * KEIN KNOPF BEWEGT GELD. Diese Tafel zeigt an. Es gibt hier keine
 * Auszahlung, keine Überweisung, keine Erstattung, keinen Umtausch — auch
 * keinen ausgegrauten. Wer so etwas später ergänzen will: das gehört nicht
 * in diese Datei und nicht hinter dieses Recht.
 */

/* ── Abruf — eigener, kleiner Ersatz für request() aus net/api.ts ────
   Dieselbe Begründung wie in PartnerGruppenPanel.tsx: net/api.ts wird an
   anderer Stelle bearbeitet, und diese Tafel soll die Datei nicht anfassen
   müssen. Gespiegelt wird nur, was gebraucht wird — Basisadresse,
   Anmeldenachweis, das Lesen von `code`/`error` aus einer Fehlerantwort. */
async function bankFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
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

/* ── Was der Server schickt (siehe services/paypal.ts) ─────────────── */

interface Saldo {
  waehrung: string; primaer: boolean;
  gesamtMikro: number; verfuegbarMikro: number | null; einbehaltenMikro: number | null;
  euroMikro: number | null; kursQuelldatum: string | null;
}
interface Wocheneimer {
  start: string; eingangMikro: number; ausgangMikro: number;
  gebuehrenMikro: number; nettoMikro: number;
}
interface Bewegung {
  waehrung: string;
  eingangMikro: number; ausgangMikro: number; gebuehrenMikro: number; nettoMikro: number;
  offenEingangMikro: number; offenAusgangMikro: number;
  erstattungen: { anzahl: number; mikro: number };
  rueckbuchungen: { anzahl: number; mikro: number };
  zurBank: { anzahl: number; mikro: number };
  abgelehntAnzahl: number; storniertAnzahl: number;
  wochen: Wocheneimer[];
}
interface Werte {
  standUnser: number; standPaypal: number | null;
  vollstaendig: boolean; fensterTage: number;
  salden: Saldo[]; bewegung: Bewegung[];
}
/** Kennungen, keine Sätze — der Server kennt die Sprache dieser Oberfläche
 *  nicht (siehe PaypalFehlerCode in services/paypal.ts). Übersetzt wird hier,
 *  über `bank.fehler.<code>`. */
type FehlerCode =
  | 'nichtEingerichtet' | 'zugangAbgelehnt' | 'rechteFehlen' | 'zuVieleDaten'
  | 'paypalFehler' | 'zeitlimit' | 'netz' | 'unbekannt';
interface FehlerInfo { code: FehlerCode; detail: string | null; debugId: string | null }
interface Uebersicht {
  zustand: 'nichtEingerichtet' | 'fehler' | 'aktuell';
  umgebung: 'live' | 'sandbox';
  fehlerCode: FehlerCode | null; fehlerDetail: string | null; fehlerSeit: number | null;
  werte: Werte | null;
}
interface ZugangStand {
  hinterlegt: boolean; clientIdHinterlegt: boolean; clientSecretHinterlegt: boolean;
  umgebung: 'live' | 'sandbox'; verschluesselt: boolean;
}
interface Diagnose {
  eingerichtet: boolean; umgebung: 'live' | 'sandbox'; verschluesselt: boolean;
  token: { geholt: boolean; gueltigBisAm: number | null; fehler: FehlerInfo | null };
  scope: { roh: string | null; vorhanden: Record<string, boolean>; pflichtFehlt: string[]; ungenutztVorhanden: string[] };
  salden: { abgerufen: boolean; waehrungen: string[]; standPaypal: number | null; fehler: FehlerInfo | null };
  bewegung: { abgerufen: boolean; zeilen: number; vollstaendig: boolean; fehler: FehlerInfo | null };
  debugId: string | null;
  stillerAusfallVerdacht: boolean;
  hinweis: 'nichtEingerichtet' | 'tokenFehlgeschlagen' | 'rechteFehlen'
    | 'saldenLeerTrotzBewegung' | 'abrufFehlgeschlagen' | null;
}

/* ── Formatierung ──────────────────────────────────────────────────────
 *
 * GELD: nicht über geld() aus lib/format.ts. Das rechnet mit Cent, teilt
 * also fest durch 100 — und genau das ist bei Geld aus einer Bank falsch:
 * JPY hat keine Nachkommastellen, TND drei. Der Server liefert deshalb
 * MIKROEINHEITEN (siehe services/paypal.ts), und die richtige Zahl
 * Nachkommastellen bestimmt hier Intl aus dem Währungskürzel selbst — kein
 * fester Teiler, keine eigene Währungstabelle.
 */
function betrag(mikro: number | null | undefined, waehrung: string): string {
  if (mikro === null || mikro === undefined || !Number.isFinite(mikro)) return '—';
  const wert = mikro / 1_000_000;
  try {
    return new Intl.NumberFormat(currentUiLanguage(), { style: 'currency', currency: waehrung }).format(wert);
  } catch {
    /* Unbekanntes Kürzel — lieber die nackte Zahl als gar nichts, und die
       Gruppierung kommt trotzdem aus der Sprache der Oberfläche. */
    return `${new Intl.NumberFormat(currentUiLanguage(), { maximumFractionDigits: 2 }).format(wert)} ${waehrung}`;
  }
}

/**
 * ZEIT: immer in der Zeitzone, die diese Person eingestellt hat — nie in der
 * des Rechners.
 *
 * `timeZone: undefined` gilt Intl als „nicht angegeben" und wird
 * kommentarlos durch die Zeitzone DIESES Rechners ersetzt; eine leere
 * Zeichenkette wirft dagegen. Beides steht ausführlich im Kopf von
 * lib/format.ts (localTimeFor / zeitAusSicht). Deshalb hier dieselbe
 * Notlösung wie dort: ohne gültige Zeitzone wird UTC genommen UND
 * beschriftet, statt heimlich die Rechnerzeit unter fremdem Namen zu zeigen
 * — bei einem Kontostand hieße das sonst „aktualisiert um 09:15", während es
 * beim Betrachter 03:15 ist.
 */
function zeitpunkt(ts: number, zone: string, mitDatum: boolean): string {
  const grund: Intl.DateTimeFormatOptions = mitDatum
    ? { dateStyle: 'short', timeStyle: 'short' }
    : { hour: '2-digit', minute: '2-digit' };
  if (zone) {
    try {
      return new Intl.DateTimeFormat(currentUiLanguage(), { ...grund, timeZone: zone }).format(ts);
    } catch { /* ungültiger Zonenname — unten weiter */ }
  }
  return new Intl.DateTimeFormat(currentUiLanguage(), { ...grund, timeZone: 'UTC', timeZoneName: 'short' }).format(ts);
}

/** Liegt der Zeitpunkt am heutigen Kalendertag DIESER Person? Entscheidet
 *  nur darüber, ob das Datum mit angezeigt wird — „seit 09:15" ist eine
 *  andere Aussage als „seit 09:15", wenn dazwischen ein Tag liegt. */
function istHeute(ts: number, zone: string): boolean {
  const alsTag = (wert: number): string => {
    try {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: zone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(wert);
    } catch {
      return new Intl.DateTimeFormat('en-CA', {
        timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(wert);
    }
  };
  return alsTag(ts) === alsTag(Date.now());
}

/** Beschriftung eines Wocheneimers: der erste Tag der Woche, kurz. Der Wert
 *  kommt als 'JJJJ-MM-TT' in UTC vom Server (die Eimergrenzen müssen für
 *  alle Betrachter dieselben sein, sonst verschöbe sich der Verlauf je nach
 *  Standort) — angezeigt wird er in der Sprache der Oberfläche. */
function wochenLabel(start: string): string {
  const ms = Date.parse(`${start}T00:00:00Z`);
  if (!Number.isFinite(ms)) return start;
  return new Intl.DateTimeFormat(currentUiLanguage(), { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(ms);
}

/** Aus einer Fehlerkennung wird hier — und nur hier — ein Satz. PayPals
 *  eigener Wortlaut hängt unübersetzt daran, weil er der Teil ist, mit dem
 *  man weitersucht. */
function fehlerText(info: FehlerInfo | null, t: ReturnType<typeof useT>): string {
  if (!info) return t('bank.diagnose.fehler');
  const satz = t(`bank.fehler.${info.code}`);
  return info.detail ? `${satz} · ${info.detail}` : satz;
}

/* ── Bausteine ─────────────────────────────────────────────────────── */

function Zeile({ name, wert, ton }: { name: string; wert: React.ReactNode; ton?: 'gut' | 'warn' }) {
  return (
    <div className="syszeile">
      <span className="syszeile__name">{name}</span>
      <span className={clsx('syszeile__wert', ton && `syszeile__wert--${ton}`)}>{wert}</span>
    </div>
  );
}

function Kennzahl({ label, wert, ton }: { label: string; wert: string; ton?: 'warn' }) {
  return (
    <div className="bank__kennzahl">
      <div className={clsx('bank__kennzahlWert', ton && `bank__kennzahlWert--${ton}`)}>{wert}</div>
      <div className="bank__kennzahlLabel">{label}</div>
    </div>
  );
}

/**
 * Der Verlauf. Anders als die Balken der Verkaufsansicht kann ein Wert hier
 * NEGATIV sein — in einer Woche kann mehr abgeflossen als hereingekommen
 * sein. Deshalb eine Mittellinie: nach rechts ist Zuwachs, nach links
 * Abfluss. Ein Balken, der Negatives einfach als Länge zeichnet, hätte eine
 * schlechte Woche wie eine gute aussehen lassen.
 */
function Verlauf({ eimer, waehrung }: { eimer: Wocheneimer[]; waehrung: string }) {
  const groesster = Math.max(1, ...eimer.map((e) => Math.abs(e.nettoMikro)));
  return (
    <div className="bank__verlauf">
      {eimer.map((e) => {
        const anteil = Math.min(1, Math.abs(e.nettoMikro) / groesster);
        const negativ = e.nettoMikro < 0;
        return (
          <div className="bank__verlaufZeile" key={e.start}>
            <span className="bank__verlaufLabel">{wochenLabel(e.start)}</span>
            <span className="bank__verlaufSpur">
              <span className="bank__verlaufMitte" />
              <span
                className={clsx('bank__verlaufBalken', negativ && 'bank__verlaufBalken--minus')}
                /* Logische statt physischer Seiten: in Arabisch (eine der 22
                   Sprachen) läuft die Zeile von rechts nach links, und ein
                   fest verdrahtetes `left` hätte den Balken dort auf die
                   falsche Seite der Nulllinie gesetzt. */
                style={negativ
                  ? { width: `${Math.max(e.nettoMikro === 0 ? 0 : 1.5, anteil * 50)}%`, insetInlineEnd: '50%' }
                  : { width: `${Math.max(e.nettoMikro === 0 ? 0 : 1.5, anteil * 50)}%`, insetInlineStart: '50%' }}
              />
            </span>
            <span className="bank__verlaufWert">{betrag(e.nettoMikro, waehrung)}</span>
          </div>
        );
      })}
    </div>
  );
}

/* ── Zustandsband ──────────────────────────────────────────────────── */

function Standband({ u, zone, t }: {
  u: Uebersicht; zone: string; t: ReturnType<typeof useT>;
}) {
  if (u.zustand === 'fehler') {
    const seit = u.fehlerSeit;
    return (
      <div className="bank__band bank__band--fehler">
        <AlertTriangle size={15} />
        <div>
          <div className="bank__bandTitel">
            {seit
              ? t('bank.stand.fehlerSeit', { zeit: zeitpunkt(seit, zone, !istHeute(seit, zone)) })
              : t('bank.stand.fehler')}
          </div>
          {u.fehlerCode && <div className="bank__bandDetail">{t(`bank.fehler.${u.fehlerCode}`)}</div>}
          {/* PayPals eigener Wortlaut, absichtlich unübersetzt: das ist ein
              Fremdtext wie ein HTTP-Status, und genau dieser Satz ist der,
              den man beim Nachschlagen braucht. Deshalb daneben eine
              Beschriftung, die sagt, dass er von PayPal stammt. */}
          {u.fehlerDetail && (
            <div className="bank__bandDetail">
              {t('bank.stand.paypalWortlaut')}
              <span className="mono"> {u.fehlerDetail}</span>
            </div>
          )}
          {u.werte && (
            <div className="bank__bandDetail">
              {t('bank.stand.alteZahlen', {
                zeit: zeitpunkt(u.werte.standUnser, zone, !istHeute(u.werte.standUnser, zone)),
              })}
            </div>
          )}
          {!u.werte && <div className="bank__bandDetail">{t('bank.stand.nochKeineZahlen')}</div>}
        </div>
      </div>
    );
  }

  const w = u.werte;
  if (!w) return null;
  return (
    <div className="bank__band">
      <Clock size={15} />
      <div>
        <div className="bank__bandTitel">
          {t('bank.stand.aktuell', { zeit: zeitpunkt(w.standUnser, zone, !istHeute(w.standUnser, zone)) })}
        </div>
        <div className="bank__bandDetail">
          {w.standPaypal
            ? t('bank.stand.paypalFrisch', {
              zeit: zeitpunkt(w.standPaypal, zone, !istHeute(w.standPaypal, zone)),
            })
            : t('bank.stand.paypalUnbekannt')}
        </div>
        {!w.vollstaendig && <div className="bank__bandDetail">{t('bank.stand.unvollstaendig')}</div>}
        {u.umgebung === 'sandbox' && <div className="bank__bandDetail">{t('bank.stand.sandbox')}</div>}
      </div>
    </div>
  );
}

/* ── Salden und Bewegung ───────────────────────────────────────────── */

function SaldenBlock({ salden, t }: { salden: Saldo[]; t: ReturnType<typeof useT> }) {
  if (salden.length === 0) {
    return (
      <section className="sys__block">
        <h3 className="sys__titel"><Wallet size={14} /> {t('bank.saldenTitel')}</h3>
        <div className="sys__notiz">{t('bank.keinSaldo')}</div>
      </section>
    );
  }
  return (
    <>
      {salden.map((s) => (
        <section className="sys__block" key={s.waehrung}>
          <h3 className="sys__titel">
            <Wallet size={14} />
            {s.primaer ? t('bank.saldenTitelHaupt', { waehrung: s.waehrung })
              : t('bank.saldenTitelWeitere', { waehrung: s.waehrung })}
          </h3>
          <div className="bank__kopf">
            <Kennzahl label={t('bank.gesamt')} wert={betrag(s.gesamtMikro, s.waehrung)} />
            <Kennzahl label={t('bank.verfuegbar')} wert={betrag(s.verfuegbarMikro, s.waehrung)} />
            <Kennzahl
              label={t('bank.einbehalten')}
              wert={betrag(s.einbehaltenMikro, s.waehrung)}
              ton={(s.einbehaltenMikro ?? 0) > 0 ? 'warn' : undefined}
            />
          </div>
          {(s.einbehaltenMikro ?? 0) > 0 && <div className="sys__notiz">{t('bank.einbehaltenHinweis')}</div>}
          {s.euroMikro !== null && (
            <Zeile
              name={t('bank.richtwertEuro')}
              wert={t('bank.richtwertEuroWert', {
                betrag: betrag(s.euroMikro, 'EUR'),
                datum: s.kursQuelldatum ?? '—',
              })}
            />
          )}
        </section>
      ))}
    </>
  );
}

function BewegungBlock({ b, tage, t }: { b: Bewegung; tage: number; t: ReturnType<typeof useT> }) {
  const auffaellig = b.erstattungen.anzahl + b.rueckbuchungen.anzahl + b.abgelehntAnzahl + b.storniertAnzahl;
  return (
    <>
      <section className="sys__block">
        <h3 className="sys__titel">
          <ArrowDownLeft size={14} /> {t('bank.bewegungTitel', { tage, waehrung: b.waehrung })}
        </h3>
        <div className="bank__kopf">
          <Kennzahl label={t('bank.eingang')} wert={betrag(b.eingangMikro, b.waehrung)} />
          <Kennzahl label={t('bank.ausgang')} wert={betrag(b.ausgangMikro, b.waehrung)} />
          <Kennzahl
            label={t('bank.netto')}
            wert={betrag(b.nettoMikro, b.waehrung)}
            ton={b.nettoMikro < 0 ? 'warn' : undefined}
          />
        </div>
        <Zeile name={t('bank.gebuehren')} wert={betrag(b.gebuehrenMikro, b.waehrung)} />
        {b.eingangMikro > 0 && (
          <Zeile
            name={t('bank.gebuehrenAnteil')}
            wert={new Intl.NumberFormat(currentUiLanguage(), {
              style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1,
            }).format(b.gebuehrenMikro / b.eingangMikro)}
          />
        )}
        {b.zurBank.anzahl > 0 && (
          <>
            <Zeile
              name={t('bank.zurBank')}
              wert={`${b.zurBank.anzahl}× · ${betrag(b.zurBank.mikro, b.waehrung)}`}
            />
            <div className="sys__notiz">{t('bank.zurBankHinweis')}</div>
          </>
        )}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><Hourglass size={14} /> {t('bank.offenTitel')}</h3>
        {b.offenEingangMikro === 0 && b.offenAusgangMikro === 0 ? (
          <div className="sys__notiz">{t('bank.offenKeins')}</div>
        ) : (
          <>
            <Zeile name={t('bank.offenEingang')} wert={betrag(b.offenEingangMikro, b.waehrung)} ton="gut" />
            {b.offenAusgangMikro > 0 && (
              <Zeile name={t('bank.offenAusgang')} wert={betrag(b.offenAusgangMikro, b.waehrung)} />
            )}
            <div className="sys__notiz">{t('bank.offenHinweis')}</div>
          </>
        )}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><AlertTriangle size={14} /> {t('bank.auffaelligTitel')}</h3>
        {auffaellig === 0 ? (
          <div className="sys__notiz">{t('bank.auffaelligKeins', { tage })}</div>
        ) : (
          <>
            <Zeile
              name={t('bank.erstattungen')}
              wert={`${b.erstattungen.anzahl}× · ${betrag(b.erstattungen.mikro, b.waehrung)}`}
            />
            <Zeile
              name={t('bank.rueckbuchungen')}
              wert={`${b.rueckbuchungen.anzahl}× · ${betrag(b.rueckbuchungen.mikro, b.waehrung)}`}
              ton={b.rueckbuchungen.anzahl > 0 ? 'warn' : undefined}
            />
            <Zeile name={t('bank.abgelehnt')} wert={String(b.abgelehntAnzahl)} />
            <Zeile name={t('bank.storniert')} wert={String(b.storniertAnzahl)} />
            <div className="sys__notiz">{t('bank.storniertHinweis')}</div>
          </>
        )}
      </section>

      <section className="sys__block">
        <h3 className="sys__titel"><TrendingUp size={14} /> {t('bank.verlaufTitel')}</h3>
        {b.wochen.every((w) => w.nettoMikro === 0) ? (
          <div className="sys__notiz">{t('bank.verlaufLeer')}</div>
        ) : (
          <Verlauf eimer={b.wochen} waehrung={b.waehrung} />
        )}
      </section>
    </>
  );
}

/* ── Einrichtung (nur mit bank.verwalten) ──────────────────────────── */

function Einrichtung({ t, onGeaendert }: { t: ReturnType<typeof useT>; onGeaendert: () => void }) {
  const [stand, setStand] = useState<ZugangStand | null>(null);
  const [clientId, setClientId] = useState('');
  const [secret, setSecret] = useState('');
  const [umgebung, setUmgebung] = useState<'live' | 'sandbox'>('live');
  const [laeuft, setLaeuft] = useState(false);
  const [meldung, setMeldung] = useState<string | null>(null);
  const [diagnose, setDiagnose] = useState<Diagnose | null>(null);

  const standLaden = useCallback(() => {
    bankFetch<ZugangStand>('/api/bank/paypal/zugang')
      .then((s) => { setStand(s); setUmgebung(s.umgebung); })
      .catch((f: Error) => setMeldung(f.message));
  }, []);

  useEffect(standLaden, [standLaden]);

  const speichern = async () => {
    setLaeuft(true); setMeldung(null);
    try {
      /* Ein weggelassenes Feld lässt den bisherigen Wert stehen — deshalb
         gehen leere Eingabefelder gar nicht erst mit. Wer einen Wert löschen
         will, trägt ausdrücklich ein Leerzeichen ein; das beschreibt der
         Hinweistext unter dem Feld. */
      const körper: Record<string, string> = { umgebung };
      if (clientId !== '') körper.clientId = clientId;
      if (secret !== '') körper.clientSecret = secret;
      const neu = await bankFetch<ZugangStand>('/api/bank/paypal/zugang', {
        method: 'POST', body: JSON.stringify(körper),
      });
      setStand(neu);
      /* Die Felder werden geleert, sobald gespeichert ist. Nicht aus
         Ordnungsliebe: was hier stehen bleibt, steht in einem Formular, das
         jemand offen liegen lassen kann. */
      setClientId(''); setSecret('');
      setMeldung(t('bank.einrichten.gespeichert'));
      onGeaendert();
    } catch (f) {
      setMeldung((f as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  const pruefen = async () => {
    setLaeuft(true); setMeldung(null); setDiagnose(null);
    try {
      setDiagnose(await bankFetch<Diagnose>('/api/bank/paypal/diagnose'));
    } catch (f) {
      setMeldung((f as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  const jetztHolen = async () => {
    setLaeuft(true); setMeldung(null);
    try {
      const r = await bankFetch<{ ok: boolean; code?: FehlerCode; detail?: string | null }>(
        '/api/bank/paypal/aktualisieren', { method: 'POST' });
      setMeldung(r.ok
        ? t('bank.einrichten.abgerufen')
        : fehlerText(r.code ? { code: r.code, detail: r.detail ?? null, debugId: null } : null, t));
      onGeaendert();
    } catch (f) {
      setMeldung((f as Error).message);
    } finally {
      setLaeuft(false);
    }
  };

  return (
    <section className="sys__block">
      <h3 className="sys__titel"><KeyRound size={14} /> {t('bank.einrichten.titel')}</h3>

      <div className="sys__notiz">{t('bank.einrichten.anleitung')}</div>

      {stand && (
        <>
          <Zeile
            name={t('bank.einrichten.standClientId')}
            wert={stand.clientIdHinterlegt ? t('bank.einrichten.hinterlegt') : t('bank.einrichten.fehlt')}
            ton={stand.clientIdHinterlegt ? 'gut' : 'warn'}
          />
          <Zeile
            name={t('bank.einrichten.standSecret')}
            wert={stand.clientSecretHinterlegt ? t('bank.einrichten.hinterlegt') : t('bank.einrichten.fehlt')}
            ton={stand.clientSecretHinterlegt ? 'gut' : 'warn'}
          />
          {!stand.verschluesselt && <div className="sys__notiz sys__notiz--warn">{t('bank.einrichten.unverschluesselt')}</div>}
        </>
      )}

      <label className="field">
        <span className="field__label">{t('bank.einrichten.clientId')}</span>
        <input
          className="input" type="text" autoComplete="off" spellCheck={false}
          value={clientId} onChange={(e) => setClientId(e.target.value)}
          placeholder={t('bank.einrichten.unveraendert')}
        />
        <span className="field__hint">{t('bank.einrichten.clientIdHinweis')}</span>
      </label>

      <label className="field">
        <span className="field__label">{t('bank.einrichten.secret')}</span>
        <input
          className="input" type="password" autoComplete="new-password" spellCheck={false}
          value={secret} onChange={(e) => setSecret(e.target.value)}
          placeholder={t('bank.einrichten.unveraendert')}
        />
        <span className="field__hint">{t('bank.einrichten.secretHinweis')}</span>
      </label>

      <label className="field">
        <span className="field__label">{t('bank.einrichten.umgebung')}</span>
        <select className="select" value={umgebung} onChange={(e) => setUmgebung(e.target.value as 'live' | 'sandbox')}>
          <option value="live">{t('bank.einrichten.umgebungLive')}</option>
          <option value="sandbox">{t('bank.einrichten.umgebungSandbox')}</option>
        </select>
        <span className="field__hint">{t('bank.einrichten.umgebungHinweis')}</span>
      </label>

      <div className="hstack gap-2 bank__knoepfe">
        <button className="btn btn--primary" onClick={speichern} disabled={laeuft}>
          {laeuft ? <Loader2 size={14} className="dreht" /> : <Lock size={14} />}
          {t('bank.einrichten.speichern')}
        </button>
        <button className="btn" onClick={pruefen} disabled={laeuft || !stand?.hinterlegt}>
          <Stethoscope size={14} /> {t('bank.einrichten.pruefen')}
        </button>
        <button className="btn" onClick={jetztHolen} disabled={laeuft || !stand?.hinterlegt}>
          <RefreshCw size={14} /> {t('bank.einrichten.jetztHolen')}
        </button>
      </div>

      {meldung && <div className="sys__notiz">{meldung}</div>}

      {diagnose && (
        <div className="bank__diagnose">
          {/* Die Zusammenfassung zuerst: eine Zeile, die sagt, woran es liegt.
              Der Server schickt sie als Kennung, übersetzt wird sie hier. */}
          <div className={clsx('sys__notiz', diagnose.hinweis && 'sys__notiz--warn')}>
            {t(`bank.diagnose.hinweis.${diagnose.hinweis ?? 'inOrdnung'}`)}
          </div>
          <Zeile
            name={t('bank.diagnose.token')}
            wert={diagnose.token.geholt ? t('bank.diagnose.ok') : fehlerText(diagnose.token.fehler, t)}
            ton={diagnose.token.geholt ? 'gut' : 'warn'}
          />
          <Zeile
            name={t('bank.diagnose.rechte')}
            wert={diagnose.scope.pflichtFehlt.length === 0
              ? t('bank.diagnose.ok')
              : t('bank.diagnose.rechteFehlen', { anzahl: diagnose.scope.pflichtFehlt.length })}
            ton={diagnose.scope.pflichtFehlt.length === 0 ? 'gut' : 'warn'}
          />
          {diagnose.scope.pflichtFehlt.map((s) => (
            <div className="sys__notiz sys__notiz--warn mono" key={s}>{s}</div>
          ))}
          {diagnose.scope.ungenutztVorhanden.length > 0 && (
            <div className="sys__notiz">{t('bank.diagnose.ungenutzt', { anzahl: diagnose.scope.ungenutztVorhanden.length })}</div>
          )}
          <Zeile
            name={t('bank.diagnose.salden')}
            wert={diagnose.salden.abgerufen
              ? t('bank.diagnose.waehrungen', { anzahl: diagnose.salden.waehrungen.length })
              : fehlerText(diagnose.salden.fehler, t)}
            ton={diagnose.salden.abgerufen ? 'gut' : 'warn'}
          />
          <Zeile
            name={t('bank.diagnose.bewegung')}
            wert={diagnose.bewegung.abgerufen
              ? t('bank.diagnose.zeilen', { anzahl: diagnose.bewegung.zeilen })
              : fehlerText(diagnose.bewegung.fehler, t)}
            ton={diagnose.bewegung.abgerufen ? 'gut' : 'warn'}
          />
          {diagnose.stillerAusfallVerdacht && (
            <div className="sys__notiz sys__notiz--warn">{t('bank.diagnose.stillerAusfall')}</div>
          )}
          {diagnose.debugId && (
            <Zeile name={t('bank.diagnose.debugId')} wert={<span className="mono">{diagnose.debugId}</span>} />
          )}
          <div className="sys__notiz">{t('bank.diagnose.hinweisGeheim')}</div>
        </div>
      )}
    </section>
  );
}

/* ── Die Tafel ─────────────────────────────────────────────────────── */

export function PaypalPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const self = useStore((s) => s.self);
  const zone = self?.timezone ?? '';
  /* Entschieden wird das ohnehin auf dem Server: /api/bank/paypal/zugang
     prüft `bank.verwalten` noch einmal selbst. Hier geht es nur darum, dass
     niemand gegen eine Wand läuft — dieselbe Aufteilung wie in Rail.tsx. */
  const darfVerwalten = self?.permissions['bank.verwalten'] === true;

  const [daten, setDaten] = useState<Uebersicht | null>(null);
  const [ladeFehler, setLadeFehler] = useState<string | null>(null);

  const laden = useCallback(() => {
    bankFetch<Uebersicht>('/api/bank/paypal/uebersicht')
      .then((u) => { setDaten(u); setLadeFehler(null); })
      .catch((f: Error) => setLadeFehler(f.message));
  }, []);

  useEffect(() => { laden(); }, [laden]);

  const inhalt = () => {
    /* Ein Fehler beim Sprechen mit dem EIGENEN Server ist etwas anderes als
       ein Fehler beim Sprechen mit PayPal — der eine heißt „das Gerät ist
       nicht erreichbar", der andere „die Bank antwortet nicht". Deshalb hier
       ein eigener Zweig und nicht derselbe rote Kasten. */
    if (ladeFehler) return <div className="sys__leer"><AlertTriangle size={15} /> {ladeFehler}</div>;
    if (!daten) return <div className="sys__leer"><Loader2 size={16} className="dreht" /></div>;

    const eingerichtet = daten.zustand !== 'nichtEingerichtet';
    const w = daten.werte;

    /* Genau EIN Zeichenort für <Einrichtung> unten, außerhalb der beiden
       Zweige -- vorher stand der Aufruf zweimal da, je einer im
       nichtEingerichtet- und im normalen Zweig. Beide Zweige liefern eine
       unterschiedliche Zahl Geschwister davor; React vergleicht Kinder ohne
       eigenen `key` nach Position, also hätte es Einrichtung beim Wechsel
       zwischen den Zweigen als NEUE Komponente behandelt -- genau dann,
       wenn `speichern()` (dort drin) gerade noch die Erfolgsmeldung gesetzt
       hatte und onGeaendert() -> laden() den zustand von 'nichtEingerichtet'
       wegkippt: die Meldung wäre mit der alten Instanz verschwunden, bevor
       irgendwer sie liest. Der `key` sichert das zusätzlich ab, falls die
       Zweige unten je wieder unterschiedlich viele Geschwister bekommen. */
    return (
      <div className={clsx('sys', eingerichtet && 'bank')}>
        {eingerichtet ? (
          <>
            <Standband u={daten} zone={zone} t={t} />

            {w && <SaldenBlock salden={w.salden} t={t} />}

            {w?.bewegung.length === 0 && (
              <section className="sys__block">
                <h3 className="sys__titel"><ArrowUpRight size={14} /> {t('bank.bewegungLeerTitel')}</h3>
                <div className="sys__notiz">{t('bank.bewegungLeer', { tage: w.fensterTage })}</div>
              </section>
            )}
            {w?.bewegung.map((b) => (
              <BewegungBlock key={b.waehrung} b={b} tage={w.fensterTage} t={t} />
            ))}

            <section className="sys__block">
              <h3 className="sys__titel"><Receipt size={14} /> {t('bank.abgrenzungTitel')}</h3>
              <div className="sys__notiz">{t('bank.abgrenzung')}</div>
            </section>
          </>
        ) : (
          <section className="sys__block">
            <h3 className="sys__titel"><Landmark size={14} /> {t('bank.titel')}</h3>
            <div className="sys__notiz">
              {darfVerwalten ? t('bank.nichtEingerichtet') : t('bank.nichtEingerichtetOhneRecht')}
            </div>
          </section>
        )}

        {darfVerwalten && <Einrichtung key="einrichtung" t={t} onGeaendert={laden} />}
      </div>
    );
  };

  return (
    <Shell title={t('bank.titel')} icon={<Landmark size={16} />} onClose={onClose} width={640}>
      {inhalt()}
    </Shell>
  );
}
