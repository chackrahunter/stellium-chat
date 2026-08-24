/**
 * Einmalcodes — der zweite Faktor fürs Firmenkonto, im Chat statt auf einem
 * fremden Telefon.
 *
 * WAS HIER NICHT LIEGT
 *
 * Das Geheimnis. Es liegt auf dem Pi und wird auch DORT verrechnet
 * (server/services/einmalcode.ts erklärt, warum dort und nicht hier).
 * Verschlüsselt liegt es dort nur, wenn ein Masterpasswort gesetzt ist —
 * fehlt es, speichert server/crypto/pii.ts es unverändert im Klartext. Genau
 * deshalb schickt der Server `verschluesselt` mit JEDEM Konto mit, und diese
 * Tafel zeigt es an (`unverschluesselt`-Hinweis unten in `inhalt()` und in
 * `Einrichtung`), statt stillschweigend etwas zu versprechen, das gerade
 * nicht gilt. Diese Tafel bekommt fertige Ziffern und rechnet selbst nur noch
 * eines aus: wie spät es auf dem Server ist. Es gibt in dieser Datei keinen
 * Weg, an das Geheimnis zu kommen — es steht in keiner Antwort, die sie
 * abruft.
 *
 * NICHTS IST SICHTBAR, BIS JEMAND DARAUF DRÜCKT
 *
 * Beim Öffnen stehen hier nur Namen. Kein Code wird gerechnet, keiner
 * übertragen, keiner angezeigt, bevor jemand ausdrücklich „anzeigen" wählt —
 * und danach verschwindet er nach anderthalb Minuten von selbst wieder. Das
 * ist keine Zierde: Stellium ist ein Chat, in dem Bildschirme geteilt und
 * Fenster abfotografiert werden, und ein dauerhaft sichtbarer zweiter Faktor
 * landet früher oder später in einer Aufnahme.
 *
 * DIE UHR IST DER TEIL, DER KAPUTTGEHT
 *
 * Ein Einmalcode hängt an der Uhrzeit, sonst an nichts. Geht eine der beiden
 * Uhren falsch, sind die Ziffern falsch — und man sieht ihnen das nicht an.
 * Deshalb steht die Rechnung dazu für sich in state/einmalcode-zeit.ts
 * (geprüft von scripts/einmalcode-uhr-pruefen.mjs), und diese Tafel tut zwei
 * Dinge damit:
 *
 *   · Sie rechnet die Uhr DIESES Rechners heraus. Der Balken zählt in
 *     Serverzeit, nicht in der des Laptops.
 *   · Sie zeigt KEINEN Code, wenn der Server meldet, dass seine eigene Uhr
 *     nachweislich danebenliegt. Sechs Ziffern zu zeigen, von denen man
 *     weiß, dass Google sie ablehnt, wäre schlimmer als ein ehrliches
 *     „stimmt gerade nicht".
 *   · „unbekannt" ist NICHT dasselbe wie „stimmt". Weiß der Server es
 *     schlicht noch nicht (der Normalfall für ein paar Sekunden nach seinem
 *     eigenen Neustart), bleibt die Tafel still — das wäre sonst bei jedem
 *     Neustart ein Alarm, den niemand mehr liest. Bleibt es unbekannt,
 *     obwohl längst fertig geprüft wurde (etwa ein Pi ohne gepufferte Uhr,
 *     dem mitten im Betrieb das Internet wegbricht), zeigt sie einen echten
 *     Hinweis — der Code selbst bleibt sichtbar, siehe
 *     `anzeigeUrteil()` in state/einmalcode-zeit.ts für die Begründung.
 *
 * EIGENSTÄNDIG, EINE EINTRITTSSTELLE
 *
 * `net/api.ts`, `App.tsx` und `Rail.tsx` sind gerade in fremder Hand. Diese
 * Tafel holt ihre Daten deshalb selbst (kleiner eigener Ersatz für
 * `request()`, genau wie PartnerGruppenPanel.tsx es aus demselben Grund
 * vormacht) und braucht nur EINE Zeile, um zu erscheinen — siehe
 * state/einmalcode.ts für die Tür und die Einbauliste für die Stellen.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, Check, Clock, Copy, Eye, EyeOff, KeyRound, Loader2, Plus,
  RefreshCw, ShieldCheck, Trash2,
} from 'lucide-react';
import { useStore } from '../state/store.js';
import { useEinmalcodeUi } from '../state/einmalcode.js';
import { t as tStatisch, useT, type TranslationKey } from '../i18n/index.js';
import { Shell } from './Panels.jsx';
import { ApiError, serverUrl, token } from '../net/api.js';
import { clsx, relativeTime } from '../lib/format.js';
import {
  aktuellesFenster, anzeigeUrteil, restSekunden, serverJetzt, versatzMessen,
  type Codefenster, type Uhrstand, type Zeitabgleich,
} from '../state/einmalcode-zeit.js';
import '../styles/einmalcode.css';

/** Wie lange ein aufgedeckter Code stehen bleibt, bevor er sich wieder zudeckt. */
const ZUDECKEN_NACH_MS = 90_000;

/* ── Abruf — eigener, kleiner Ersatz für request() aus net/api.ts ──── */
async function otpFetch<T>(pfad: string, init: RequestInit = {}): Promise<T> {
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

/**
 * Ein Abruf, der die Uhren nebenbei vergleicht.
 *
 * Jede Antwort dieser Tafel trägt `serverMs`. Zusammen mit den beiden
 * eigenen Zeitpunkten davor und danach ergibt das den Versatz — ohne eine
 * einzige zusätzliche Anfrage. Genau deshalb steht die Zeit in JEDER Antwort
 * und nicht in einem eigenen Weg daneben.
 */
async function otpFetchMitZeit<T extends { serverMs: number }>(
  pfad: string, init?: RequestInit,
): Promise<{ daten: T; abgleich: Zeitabgleich }> {
  const vorher = Date.now();
  const daten = await otpFetch<T>(pfad, init);
  const nachher = Date.now();
  return { daten, abgleich: versatzMessen(vorher, nachher, daten.serverMs) };
}

/* ── Formen der Antworten ───────────────────────────────────────── */

interface Konto {
  id: string;
  bezeichnung: string;
  aussteller: string;
  konto: string;
  algorithmus: 'SHA1' | 'SHA256' | 'SHA512';
  stellen: number;
  periode: number;
  verschluesselt: boolean;
  angelegtAm: number;
  geaendertAm: number | null;
}

interface Zeitstand {
  serverMs: number;
  periode: number;
  warnschwelleMs: number;
  uhr: Uhrstand;
}

interface Stand {
  konten: Konto[];
  zeit: Zeitstand;
  /** Dieselbe Zahl wie `zeit.serverMs`, oben — siehe http/einmalcode.ts. */
  serverMs: number;
  darfVerwalten: boolean;
  vorratFenster: number;
}

interface CodeAntwort {
  kontoId: string;
  serverMs: number;
  stellen: number;
  periode: number;
  codes: Codefenster[];
  restSekunden: number;
  vorratBisMs: number;
  uhr: Uhrstand;
}

interface Abruf {
  id: string; kontoId: string; bezeichnung: string; userId: string; am: number;
}

/* ── Die Tafel ──────────────────────────────────────────────────── */

export function EinmalcodePanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  // Nur zum Hervorheben eines Kontos, angesprungen aus dem Passwort-Tresor
  // (PasswortPanel.tsx) — siehe state/einmalcode.ts, hervorhebenKontoId.
  // Ein eigener, kleiner Import statt eines Props: diese Tafel bekommt EINE
  // Zeile zum Erscheinen (siehe Dateikopf, "EIGENSTÄNDIG, EINE
  // EINTRITTSSTELLE") und soll auch für diesen Zusatz keine zweite brauchen.
  const hervorhebenKontoId = useEinmalcodeUi((s) => s.hervorhebenKontoId);
  const [stand, setStand] = useState<Stand | null>(null);
  const [abgleich, setAbgleich] = useState<Zeitabgleich | null>(null);
  const [ladenFehler, setLadenFehler] = useState('');
  const [laedt, setLaedt] = useState(true);

  const laden = useCallback(async () => {
    setLaedt(true);
    try {
      const { daten, abgleich: a } = await otpFetchMitZeit<Stand>('/api/einmalcode');
      setStand(daten);
      setAbgleich(a);
      setLadenFehler('');
    } catch (f) {
      setLadenFehler(f instanceof Error ? f.message : String(f));
    } finally {
      setLaedt(false);
    }
  }, []);

  useEffect(() => { void laden(); }, [laden]);

  const inhalt = () => {
    if (laedt && !stand) {
      return <div className="einmalcode__laden"><Loader2 size={18} className="spin" /></div>;
    }
    if (ladenFehler) {
      return (
        <div className="empty-state">
          <AlertTriangle size={22} />
          <p>{ladenFehler}</p>
          <button className="btn" onClick={() => void laden()}>
            <RefreshCw size={14} /> {t('common.retry')}
          </button>
        </div>
      );
    }
    if (!stand) return null;

    /* Der Server nennt jedes Konto einzeln, aber `verschluesselt` kommt bei
       allen aus derselben Quelle — `encryptionActive()`, eine Eigenschaft der
       ganzen Installation, keine je Konto (server/services/einmalcode.ts).
       `some()` statt `every()` ist deshalb keine Vorsicht gegen einen
       gemischten Zustand, den es so nicht gibt, sondern nur der kürzeste Weg,
       an denselben Wert für alle heranzukommen. Ohne mindestens ein Konto
       gibt es nichts, worüber diese Auskunft etwas wüsste — dann bleibt sie
       stumm, statt etwas zu behaupten, das (noch) niemand geprüft hat. */
    const unverschluesselt = stand.konten.some((k) => !k.verschluesselt);

    return (
      <>
        <Uhrhinweis stand={stand} abgleich={abgleich} />

        {stand.konten.length === 0 ? (
          <div className="empty-state">
            <KeyRound size={22} />
            <p>{stand.darfVerwalten ? t('einmalcode.leerVerwalter') : t('einmalcode.leer')}</p>
          </div>
        ) : (
          <div className="einmalcode__liste">
            {unverschluesselt && (
              <div className="sys__notiz sys__notiz--warn">{t('einmalcode.unverschluesselt')}</div>
            )}
            {stand.konten.map((k) => (
              <Kontozeile
                key={k.id}
                konto={k}
                uhr={stand.zeit.uhr}
                abgleich={abgleich}
                aufAbgleich={setAbgleich}
                darfVerwalten={stand.darfVerwalten}
                aufAenderung={laden}
                hervorgehoben={k.id === hervorhebenKontoId}
              />
            ))}
          </div>
        )}

        {stand.darfVerwalten && <Einrichtung unverschluesselt={unverschluesselt} aufAenderung={laden} />}
        {stand.darfVerwalten && <Abrufliste />}
      </>
    );
  };

  return (
    <Shell
      title={t('einmalcode.titel')}
      subtitle={t('einmalcode.untertitel')}
      icon={<KeyRound size={18} />}
      onClose={onClose}
      width={560}
      actions={(
        <button
          className="icon-btn"
          onClick={() => void laden()}
          title={t('einmalcode.neuLaden')}
          aria-label={t('einmalcode.neuLaden')}
        >
          <RefreshCw size={15} className={laedt ? 'spin' : undefined} />
        </button>
      )}
    >
      <div className="einmalcode">{inhalt()}</div>
    </Shell>
  );
}

/* ── Hinweis über den Uhren ─────────────────────────────────────── */

function Uhrhinweis({ stand, abgleich }: { stand: Stand; abgleich: Zeitabgleich | null }) {
  const t = useT();
  /* Dasselbe Urteil wie in der Zeile, nur ohne Fenster: hier geht es allein
     um die Uhren, nicht um einen einzelnen Code. `fenster` bekommt deshalb
     ein Fenster ohne Ende und `rest` einen großen Wert — so bleiben „Vorrat
     leer" und „gleich neu" hier stumm; beide gehören an den Code, nicht über
     die Liste. */
  const urteil = anzeigeUrteil({
    uhr: stand.zeit.uhr,
    abgleich,
    periodeSekunden: stand.zeit.periode,
    fenster: { fenster: '', code: '', gueltigAbMs: 0, gueltigBisMs: Number.MAX_SAFE_INTEGER },
    rest: Number.MAX_SAFE_INTEGER,
  });

  const sekunden = (ms: number | null | undefined) => Math.round(Math.abs(ms ?? 0) / 1000);

  /* Ausgeschrieben statt `${hinweis}Text` zusammengesetzt: nur so lassen sich
     die verwendeten Schlüssel im Quelltext FINDEN — von einem Menschen, von
     scripts/deutsch-finden.mjs und von jedem, der die 22 Wörterbücher
     pflegt. Ein zusammengebauter Schlüssel ist genau der Eintrag, der beim
     Aufräumen als unbenutzt gilt und gelöscht wird. */
  let titel: string;
  let text: string;
  if (urteil.hinweis === 'einmalcode.uhrServerFalsch') {
    titel = t('einmalcode.uhrServerFalsch');
    text = t('einmalcode.uhrServerFalschText', { sekunden: sekunden(stand.zeit.uhr.abweichungMs) });
  } else if (urteil.hinweis === 'einmalcode.uhrServerUngeprueft') {
    titel = t('einmalcode.uhrServerUngeprueft');
    text = t('einmalcode.uhrServerUngeprueftText');
  } else if (urteil.hinweis === 'einmalcode.uhrServerUnbekannt') {
    titel = t('einmalcode.uhrServerUnbekannt');
    text = t('einmalcode.uhrServerUnbekanntText');
  } else if (urteil.hinweis === 'einmalcode.uhrGeraetSchief') {
    titel = t('einmalcode.uhrGeraetSchief');
    text = t('einmalcode.uhrGeraetSchiefText', { sekunden: sekunden(abgleich?.versatzMs) });
  } else {
    return null;
  }

  return (
    <div className={`einmalcode__uhr${urteil.schwer ? ' einmalcode__uhr--schwer' : ''}`} role="status">
      <AlertTriangle size={15} />
      <div>
        <p className="einmalcode__uhr-titel">{titel}</p>
        <p className="einmalcode__uhr-text">{text}</p>
      </div>
    </div>
  );
}

/* ── Eine Zeile: ein Konto ──────────────────────────────────────── */

function Kontozeile({ konto, uhr, abgleich, aufAbgleich, darfVerwalten, aufAenderung, hervorgehoben }: {
  konto: Konto;
  uhr: Uhrstand;
  abgleich: Zeitabgleich | null;
  aufAbgleich: (a: Zeitabgleich) => void;
  darfVerwalten: boolean;
  aufAenderung: () => Promise<void>;
  /** Angesprungen aus dem Passwort-Tresor — hebt die Zeile optisch hervor
   *  und scrollt sie ins Bild. Deckt nie selbst einen Code auf (siehe
   *  Dateikopf, "NICHTS IST SICHTBAR, BIS JEMAND DARAUF DRÜCKT"). */
  hervorgehoben?: boolean;
}) {
  const t = useT();
  const zeileRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (hervorgehoben) zeileRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [hervorgehoben]);
  const [antwort, setAntwort] = useState<CodeAntwort | null>(null);
  const [aufgedeckt, setAufgedeckt] = useState(false);
  const [holt, setHolt] = useState(false);
  const [fehler, setFehler] = useState('');
  const [kopiert, setKopiert] = useState(false);
  const [ohneVerbindung, setOhneVerbindung] = useState(false);
  /* Der Takt. Ein `useState`, damit die Zeile jede Sekunde neu rechnet —
     eine `ref` würde sich ändern, ohne dass jemand hinsieht. */
  const [, takt] = useState(0);
  const zudecken = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Die Ansage für Sprachausgaben — sparsam, nicht bei jedem der 250-ms-
     Takte (siehe `role="timer"` weiter unten, `aria-live="off"` von Haus
     aus, und bewusst NICHT auf "polite" gestellt: bei diesem Takt spräche
     das ohne Unterlass). Stattdessen drei feste Anlässe, siehe die drei
     Effekte unten: Aufdecken, Ablauf kurz bevorsteht, neuer Code da. Immer im
     Baum (gleich in der Zeile weiter unten), nur der Text wechselt — wie bei
     den Toasts (Toasts.tsx) und dem Tipp-Hinweis der Seitenleiste
     (Sidebar.tsx, DmTypingHint). */
  const [ansage, setAnsage] = useState('');
  const zuletztFenster = useRef<string | null>(null);
  const knappAngesagt = useRef(false);

  /* Beim Verlassen alles fallen lassen: die Codes leben nur, solange die
     Zeile lebt. Kein Speicher, keine Ablage, kein Zustand außerhalb. */
  useEffect(() => () => {
    if (zudecken.current) clearTimeout(zudecken.current);
  }, []);

  useEffect(() => {
    if (!aufgedeckt) return undefined;
    const uhrwerk = setInterval(() => takt((n) => n + 1), 250);
    return () => clearInterval(uhrwerk);
  }, [aufgedeckt]);

  const jetztServer = serverJetzt(abgleich);
  const fenster = antwort ? aktuellesFenster(antwort.codes, jetztServer) : null;
  const rest = restSekunden(fenster, jetztServer);
  const urteil = anzeigeUrteil({
    uhr: antwort?.uhr ?? uhr,
    abgleich,
    periodeSekunden: konto.periode,
    fenster,
    rest,
  });

  /* Anlass 1: Aufdecken. Hängt allein an `aufgedeckt` — nicht an `urteil`
     oder `fenster`, die sich jeden Takt neu berechnen —, läuft also genau
     einmal je Aufdecken, nicht bei jedem der 250-ms-Takte. Der Code selbst
     steht schon in der sichtbaren Zahl und ihrem eigenen `aria-label`
     (`einmalcode.kopierenLang`) — hier geht es nur darum, dass ÜBERHAUPT
     etwas erschienen ist, damit eine Sprachausgabe dorthin findet. Zugleich
     der Reset für Anlass 2: das gerade erschienene Fenster gilt als bekannt,
     nicht als „neu hereingerollt". */
  useEffect(() => {
    if (!aufgedeckt) { zuletztFenster.current = null; knappAngesagt.current = false; return; }
    zuletztFenster.current = fenster?.fenster ?? null;
    knappAngesagt.current = false;
    setAnsage(urteil.codeZeigen
      ? t('einmalcode.ansageAufgedeckt', { bezeichnung: konto.bezeichnung })
      : t('einmalcode.ansageGesperrt', { bezeichnung: konto.bezeichnung }));
  }, [aufgedeckt]);

  /* Anlass 2: ein neuer Code ist da. `fenster` ist dieselbe Objektreferenz,
     solange dasselbe Zeitfenster gilt (siehe `aktuellesFenster` in
     state/einmalcode-zeit.ts — sie kommt aus dem unveränderten `codes`-Array
     der Antwort), wechselt die Referenz also nur beim tatsächlichen
     Rollover, nicht bei jedem Takt. Bleibt hier stumm, bis das ERSTE Fenster
     einmal gesetzt wurde (s.o.) — sonst gälte das Aufdecken selbst schon als
     „neu hereingerollt". */
  useEffect(() => {
    if (!aufgedeckt || !fenster) return;
    if (zuletztFenster.current !== null && fenster.fenster !== zuletztFenster.current) {
      zuletztFenster.current = fenster.fenster;
      knappAngesagt.current = false;
      setAnsage(t('einmalcode.ansageNeuerCode', { bezeichnung: konto.bezeichnung }));
    }
  }, [fenster, aufgedeckt]);

  /* Anlass 3: gleich läuft der Code ab. Dieselbe Schwelle wie der rote Rand
     am Balken und der Text „gleich neu" (state/einmalcode-zeit.ts,
     `istKnapp`/`KNAPP_SEKUNDEN`) — keine zweite, erfundene Zahl. `rest`
     ändert sich jeden Takt, `knappAngesagt` sorgt trotzdem für GENAU eine
     Ansage je Fenster: sie fällt erst wieder, wenn ein neues Fenster beginnt
     (Anlass 2 setzt sie zurück). */
  useEffect(() => {
    if (!aufgedeckt || !urteil.codeZeigen) return;
    if (urteil.hinweis === 'einmalcode.gleichNeu' && !knappAngesagt.current) {
      knappAngesagt.current = true;
      setAnsage(t('einmalcode.gleichNeu'));
    }
  }, [urteil.hinweis, aufgedeckt]);

  const verstecken = useCallback(() => {
    setAufgedeckt(false);
    setKopiert(false);
    if (zudecken.current) { clearTimeout(zudecken.current); zudecken.current = null; }
  }, []);

  const aufdecken = useCallback(async () => {
    setHolt(true);
    setFehler('');
    try {
      const { daten, abgleich: a } = await otpFetchMitZeit<CodeAntwort>(
        `/api/einmalcode/konten/${konto.id}/codes`, { method: 'POST' },
      );
      setAntwort(daten);
      aufAbgleich(a);
      setOhneVerbindung(false);
    } catch (f) {
      /* Der Server ist weg — aber vielleicht liegt noch ein Vorrat von
         vorhin da, der bis in dieses Fenster reicht. Genau dafür ist er da
         (siehe server/services/einmalcode.ts, VORRAT). Ist auch der
         abgelaufen, sagt `anzeigeUrteil` von selbst „Vorrat leer" und es
         erscheint keine Zahl. */
      const nochGut = antwort && aktuellesFenster(antwort.codes, serverJetzt(abgleich));
      if (nochGut) {
        setOhneVerbindung(true);
      } else {
        setFehler(f instanceof Error ? f.message : String(f));
        setHolt(false);
        return;
      }
    }
    setHolt(false);
    setAufgedeckt(true);
    if (zudecken.current) clearTimeout(zudecken.current);
    zudecken.current = setTimeout(verstecken, ZUDECKEN_NACH_MS);
  }, [konto.id, aufAbgleich, antwort, abgleich, verstecken]);

  const kopieren = async () => {
    if (!fenster) return;
    try {
      await navigator.clipboard.writeText(fenster.code);
      setKopiert(true);
      setTimeout(() => setKopiert(false), 1600);
    } catch { /* ohne Zwischenablage bleibt das Ablesen */ }
  };

  const untertitel = [konto.aussteller, konto.konto].filter(Boolean).join(' · ');
  const anteil = fenster ? Math.max(0, Math.min(1, rest / konto.periode)) : 0;

  return (
    <div ref={zeileRef} className={clsx('einmalcode__zeile', hervorgehoben && 'einmalcode__zeile--hervorgehoben')}>
      {/* Sparsame Ansage statt `aria-live` am 250-ms-Takt weiter unten (dem
         Balken, `role="timer"`) — siehe die drei Effekte oben für die
         Anlässe. */}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{ansage}</span>
      <div className="einmalcode__kopf">
        <div className="einmalcode__namen">
          <span className="einmalcode__name">{konto.bezeichnung}</span>
          {untertitel && <span className="einmalcode__konto">{untertitel}</span>}
        </div>
        {darfVerwalten && <Kontowerkzeuge konto={konto} aufAenderung={aufAenderung} />}
      </div>

      {!aufgedeckt ? (
        <div className="einmalcode__zu">
          <button className="btn btn--primary" onClick={() => void aufdecken()} disabled={holt}>
            {holt ? <Loader2 size={14} className="spin" /> : <Eye size={14} />}
            {t('einmalcode.anzeigen')}
          </button>
          <span className="einmalcode__zu-text">{t('einmalcode.zugedeckt')}</span>
        </div>
      ) : (
        <div className="einmalcode__auf">
          {urteil.codeZeigen && fenster ? (
            <>
              <div className="einmalcode__zahl-reihe">
                <button
                  className="einmalcode__zahl"
                  onClick={() => void kopieren()}
                  title={t('einmalcode.kopieren')}
                  aria-label={t('einmalcode.kopierenLang', { code: fenster.code.split('').join(' ') })}
                >
                  {gruppiert(fenster.code)}
                </button>
                <div className="einmalcode__knoepfe">
                  <button
                    className="icon-btn icon-btn--sm"
                    onClick={() => void kopieren()}
                    title={t('einmalcode.kopieren')}
                    aria-label={t('einmalcode.kopieren')}
                  >
                    {kopiert ? <Check size={14} /> : <Copy size={14} />}
                  </button>
                  <button
                    className="icon-btn icon-btn--sm"
                    onClick={verstecken}
                    title={t('einmalcode.verstecken')}
                    aria-label={t('einmalcode.verstecken')}
                  >
                    <EyeOff size={14} />
                  </button>
                </div>
              </div>

              <div className="einmalcode__balken" role="timer" aria-label={t('einmalcode.restLang', { sekunden: rest })}>
                <div
                  className={`einmalcode__balken-fuellung${rest <= 5 ? ' einmalcode__balken-fuellung--knapp' : ''}`}
                  style={{ inlineSize: `${anteil * 100}%` }}
                />
              </div>
              <p className={`einmalcode__rest${rest <= 5 ? ' einmalcode__rest--knapp' : ''}`}>
                <Clock size={12} /> {t('einmalcode.rest', { sekunden: rest })}
                {urteil.hinweis === 'einmalcode.gleichNeu' && <> · {t('einmalcode.gleichNeu')}</>}
              </p>
            </>
          ) : (
            <div className="einmalcode__gesperrt">
              <AlertTriangle size={16} />
              {/* Ausgeschrieben, nicht zusammengesetzt — siehe Uhrhinweis
                  weiter oben: nur so sind die Schlüssel auffindbar. Genau
                  diese beiden Fälle halten hier einen Code zurück
                  (state/einmalcode-zeit.ts, `anzeigeUrteil`). */}
              <span>
                {urteil.hinweis === 'einmalcode.uhrServerFalsch'
                  ? t('einmalcode.uhrServerFalsch')
                  : t('einmalcode.vorratLeer')}
              </span>
              <button className="btn btn--sm" onClick={() => void aufdecken()}>
                <RefreshCw size={13} /> {t('common.retry')}
              </button>
            </div>
          )}

          {ohneVerbindung && (
            <p className="einmalcode__ohneVerbindung">
              <AlertTriangle size={12} /> {t('einmalcode.ohneVerbindung')}
            </p>
          )}
        </div>
      )}

      {fehler && <p className="einmalcode__fehler">{fehler}</p>}
    </div>
  );
}

/** „123 456" statt „123456" — sechs Ziffern am Stück liest niemand fehlerfrei ab. */
function gruppiert(code: string): string {
  const mitte = Math.ceil(code.length / 2);
  return `${code.slice(0, mitte)} ${code.slice(mitte)}`;
}

/* ── Werkzeuge je Konto (nur mit Verwaltungsrecht) ──────────────── */

function Kontowerkzeuge({ konto, aufAenderung }: { konto: Konto; aufAenderung: () => Promise<void> }) {
  const t = useT();
  const [fragt, setFragt] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState('');

  const loeschen = async () => {
    setLaeuft(true);
    setFehler('');
    try {
      await otpFetch(`/api/einmalcode/konten/${konto.id}`, { method: 'DELETE' });
      await aufAenderung();
      /* Nur bei Erfolg schließen: sonst sähe eine gescheiterte Löschung
         genauso aus wie eine geglückte, und die Meldung wäre schon wieder
         weg, bevor sie jemand liest. */
      setFragt(false);
    } catch (f) {
      setFehler(f instanceof Error ? f.message : String(f));
    } finally {
      setLaeuft(false);
    }
  };

  if (!fragt) {
    return (
      <button
        className="icon-btn icon-btn--sm icon-btn--danger"
        onClick={() => setFragt(true)}
        title={t('einmalcode.loeschen')}
        aria-label={t('einmalcode.loeschen')}
      >
        <Trash2 size={14} />
      </button>
    );
  }
  return (
    <div className="einmalcode__fragtSpalte">
      <div className="einmalcode__fragt">
        <span>{t('einmalcode.loeschenFrage')}</span>
        <button className="btn btn--sm btn--danger" onClick={() => void loeschen()} disabled={laeuft}>
          {laeuft ? <Loader2 size={12} className="spin" /> : <Trash2 size={12} />} {t('einmalcode.loeschenJa')}
        </button>
        <button className="btn btn--sm btn--ghost" onClick={() => { setFragt(false); setFehler(''); }}>{t('common.cancel')}</button>
      </div>
      {fehler && <p className="einmalcode__fehler">{fehler}</p>}
    </div>
  );
}

/* ── Einrichten ─────────────────────────────────────────────────── */

/**
 * Das Feld, in das der Inhaber das Geheimnis einfügt.
 *
 * `type="password"`, `autoComplete="off"`, `spellCheck={false}` — und nach
 * dem Speichern wird das Feld GELEERT. Es gibt danach keinen Weg mehr, den
 * Wert zu sehen: der Server gibt ihn nirgends zurück, und hier steht er auch
 * nicht mehr. Das ist dieselbe Regel wie beim Fernzugang und beim Postfach
 * (server/services/fernzugang.ts, mailzugang.ts) — ein Geheimnis, das man
 * versehentlich weiterreichen kann, ist keins mehr.
 */
function Einrichtung({ unverschluesselt, aufAenderung }: {
  unverschluesselt: boolean;
  aufAenderung: () => Promise<void>;
}) {
  const t = useT();
  const [offen, setOffen] = useState(false);
  const [bezeichnung, setBezeichnung] = useState('');
  const [geheimnis, setGeheimnis] = useState('');
  const [laeuft, setLaeuft] = useState(false);
  const [fehler, setFehler] = useState('');

  const speichern = async () => {
    if (!geheimnis.trim()) return;
    setLaeuft(true);
    setFehler('');
    try {
      await otpFetch('/api/einmalcode/konten', {
        method: 'POST',
        body: JSON.stringify({ bezeichnung: bezeichnung.trim(), geheimnis }),
      });
      /* Zuerst leeren, dann neu laden: läuft das Neuladen in einen Fehler,
         soll das Geheimnis trotzdem schon aus dem Feld verschwunden sein. */
      setGeheimnis('');
      setBezeichnung('');
      setOffen(false);
      await aufAenderung();
    } catch (f) {
      setFehler(f instanceof Error ? f.message : String(f));
    } finally {
      setLaeuft(false);
    }
  };

  if (!offen) {
    return (
      <button className="btn einmalcode__neu" onClick={() => setOffen(true)}>
        <Plus size={14} /> {t('einmalcode.neu')}
      </button>
    );
  }

  return (
    <div className="einmalcode__form">
      <div className="field">
        <label className="field__label" htmlFor="einmalcode-bezeichnung">{t('einmalcode.bezeichnung')}</label>
        <input
          id="einmalcode-bezeichnung"
          className="input"
          value={bezeichnung}
          onChange={(e) => setBezeichnung(e.target.value)}
          placeholder={t('einmalcode.bezeichnungPlatzhalter')}
          autoComplete="off"
        />
        <p className="field__hint">{t('einmalcode.bezeichnungHinweis')}</p>
      </div>

      <div className="field">
        <label className="field__label" htmlFor="einmalcode-geheimnis">{t('einmalcode.geheimnis')}</label>
        <input
          id="einmalcode-geheimnis"
          className="input"
          type="password"
          value={geheimnis}
          onChange={(e) => setGeheimnis(e.target.value)}
          placeholder={t('einmalcode.geheimnisPlatzhalter')}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          /* Kein `name`: ohne Namen bietet kein Passwortspeicher an, den Wert
             zu behalten, und kein Browser trägt ihn je wieder von selbst ein. */
        />
        <p className="field__hint">{t('einmalcode.geheimnisHinweis')}</p>
      </div>

      {/* Kommt aus dem Bestand, nicht aus einer eigenen Prüfung — siehe
          `unverschluesselt` weiter oben in `inhalt()`. Ist noch kein Konto
          hinterlegt, weiß niemand, ob ein Masterpasswort gesetzt ist, und die
          Zeile bleibt aus statt zu raten. */}
      {unverschluesselt && (
        <div className="sys__notiz sys__notiz--warn">{t('einmalcode.unverschluesselt')}</div>
      )}

      <div className="einmalcode__warnung">
        <ShieldCheck size={15} />
        <p>{t('einmalcode.einrichtenWarnung')}</p>
      </div>

      {fehler && <p className="einmalcode__fehler">{fehler}</p>}

      <div className="hstack gap-2">
        <button className="btn btn--primary" onClick={() => void speichern()} disabled={laeuft || !geheimnis.trim()}>
          {laeuft ? <Loader2 size={14} className="spin" /> : <Check size={14} />} {t('common.save')}
        </button>
        <button
          className="btn btn--ghost"
          onClick={() => { setGeheimnis(''); setBezeichnung(''); setOffen(false); }}
        >
          {t('common.cancel')}
        </button>
      </div>
    </div>
  );
}

/* ── Wer wann einen Code geholt hat ─────────────────────────────── */

function Abrufliste() {
  const t = useT();
  const users = useStore((s) => s.users);
  const [offen, setOffen] = useState(false);
  const [abrufe, setAbrufe] = useState<Abruf[] | null>(null);
  const [laeuft, setLaeuft] = useState(false);

  const holen = useCallback(async () => {
    setLaeuft(true);
    try {
      const daten = await otpFetch<{ abrufe: Abruf[] }>('/api/einmalcode/abrufe?grenze=50');
      setAbrufe(daten.abrufe);
    } catch {
      setAbrufe([]);
    } finally {
      setLaeuft(false);
    }
  }, []);

  useEffect(() => { if (offen && !abrufe) void holen(); }, [offen, abrufe, holen]);

  const zeilen = useMemo(() => abrufe ?? [], [abrufe]);

  return (
    <div className="einmalcode__abrufe">
      <button className="btn btn--ghost btn--sm" onClick={() => setOffen((o) => !o)}>
        <Clock size={13} /> {t('einmalcode.abrufe')}
      </button>
      {offen && (
        laeuft ? <div className="einmalcode__laden"><Loader2 size={16} className="spin" /></div> : (
          <>
            <p className="einmalcode__abrufe-hinweis">{t('einmalcode.abrufeHinweis')}</p>
            {zeilen.length === 0 ? (
              <p className="muted">{t('einmalcode.abrufeLeer')}</p>
            ) : (
              <ul className="einmalcode__abrufe-liste">
                {zeilen.map((a) => (
                  <li key={a.id}>
                    <span className="einmalcode__abruf-wer">{users[a.userId]?.displayName ?? a.userId}</span>
                    <span className="einmalcode__abruf-was">{a.bezeichnung}</span>
                    <span className="einmalcode__abruf-wann muted">{relativeTime(a.am)}</span>
                  </li>
                ))}
              </ul>
            )}
          </>
        )
      )}
    </div>
  );
}
