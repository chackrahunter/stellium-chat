/**
 * "Ein Kauf ist passiert" — die Meldung dazu, anbieterübergreifend für
 * Gumroad und Patreon.
 *
 * WARUM EINE EIGENE, GENERISCHE DATEI UND NICHT JE EINE HÄLFTE IN
 * gumroad.ts/patreon.ts
 * Beide Anbindungen kennen ihre eigene, fremde API-Form (RohVerkauf, Patreons
 * Mitgliederseiten) — das gehört dorthin und bleibt dort. Was hier passiert,
 * ist anbieterunabhängig: ein Ereignis kam herein, ist es NEU (Fingerabdruck
 * noch nicht bekannt), und wenn ja, wen betrifft das und was soll dastehen.
 * gumroad.ts und patreon.ts rechnen ihre je eigene rohe Antwort in die
 * generische Form `VerkaufEreignisEingabe` um und reichen sie hier herein —
 * diese Datei selbst weiß nichts von `subscription_id` oder `patron_status`.
 *
 * WARUM EIN FINGERABDRUCK MIT UNIQUE-INDEX, DIESELBE BAUART WIE
 * mail_wissen_vorschlaege.abdruck
 * Beide Anbindungen fragen bei JEDEM Sync-Lauf den vollen Bestand ab, nicht
 * nur "seit dem letzten Mal" (Gumroad: siehe Dateikopf von gumroad.ts, Punkt
 * 2 — eine Erstattung ändert das Erstelldatum nicht, "seit gestern" sähe sie
 * nie; Patreon: kennzahlenHolen() liest bei jedem Lauf die volle
 * Mitgliederliste). Ein Server-Neustart, ein manueller Aktualisieren-Klick
 * und ein ganz normaler Sync-Takt sehen deshalb praktisch immer wieder
 * DIESELBEN Zeilen. Die Sperre gegen doppelte Meldungen steht deshalb — wie
 * bei mail_wissen_vorschlaege.abdruck und vorschlaege.abdruck — als
 * UNIQUE-Bedingung in der Datenbank (idx_verkauf_ereignisse_abdruck), nicht
 * als Merker im Arbeitsspeicher: ein Merker im Speicher überlebt keinen
 * Neustart, die Datenbank schon. `ereignisEinfuegen()` unten versucht ein
 * einziges `INSERT OR IGNORE` und liest an `changes` ab, ob die Zeile wirklich
 * neu war — das ist die ganze Prüfung, atomar in einer Anweisung, kein
 * SELECT-dann-INSERT mit einer Lücke dazwischen nötig (node:sqlite läuft
 * synchron, aber ein einziger Schritt ist trotzdem der robustere Ausdruck
 * derselben Absicht).
 *
 * WARUM DER FINGERABDRUCK HIER KLARTEXT SEIN DARF (ANDERS ALS BEI
 * mail_wissen_vorschlaege)
 * Dort ist der Fingerabdruck ein HMAC über echten Freitext (Thema/Inhalt
 * einer Beobachtung) — der Klartext selbst darf aus der Kennung nicht
 * rückrechenbar sein. Hier ist der Fingerabdruck nur `gumroad:verkauf:<fremde
 * Verkaufs-ID>` oder `patreon:mitglied:<fremde Mitglieds-ID>` — eine von
 * Gumroad/Patreon selbst vergebene, bedeutungslose Kennung, kein
 * Personenbezug (siehe auch der Dateikopf von verkauf_gumroad_verkaeufe in
 * schema.sql: "KEINE KUNDENDATEN"). Ein HMAC verbürge hier nichts, was nicht
 * schon so ist.
 *
 * WARUM "NEUER VERKAUF" ALLEIN NICHT REICHT
 * Der Auftrag verlangt: welches Produkt, wie viel, ob neuer Abonnent oder
 * Verlängerung, ob noch in der Probewoche. Alles außer dem Betrag/der
 * Probezeit-Frage ist NICHT aus der Bezahlung selbst ablesbar — `art` und
 * `inProbe` werden deshalb von den Aufrufern (gumroad.ts/patreon.ts) mit
 * hereingereicht, nicht hier erraten. Was hier NICHT hereinkommt: ein Name
 * oder eine E-Mail-Adresse der kaufenden Person — beide Anbindungen holen so
 * etwas nie ab (siehe deren Dateiköpfe), diese Datei kann folglich auch
 * nichts Falsches damit anstellen.
 *
 * WARUM PATREON IMMER `art: 'neu'` TRÄGT, NIE `verlaengerung`
 * Patreons Mitglieder-Endpunkt liefert den STAND JETZT, keine Kette
 * einzelner Zahlungen (siehe Dateikopf von patreon.ts: "Patreon kennt kein
 * 'ehemalig seit wann'"). Ob eine bestimmte Abbuchung eine Verlängerung war,
 * ließe sich nur über `last_charge_date` raten — ein Feld, das
 * kennzahlenHolen() heute nicht abruft und dessen genaue Bedeutung an dieser
 * Stelle nicht gegen einen echten Zugang geprüft ist (dieselbe Zurückhaltung
 * wie bei `earnings_visibility`/`pledge_cause_id`, die laut patreon.ts live
 * geprüft und wieder verworfen wurden). Der Fingerabdruck
 * `patreon:mitglied:<ID>` schlägt darum NICHT vor, eine Verlängerung zu
 * kennen — er sagt ehrlich nur "dieses Konto ist als Unterstützer:in zum
 * ersten Mal in Stelliums eigener Ablage aufgetaucht", und genau das ist
 * `art: 'neu'`. Bewusst weggelassen statt geraten — siehe Bericht am
 * Auftragsende.
 *
 * WARUM EIN KALTSTART STILL BLEIBT (`stumm`)
 * Die erste Anmeldung dieser Funktion trifft bei Gumroad sofort auf den
 * KOMPLETTEN Bestand seit 2020 (kein inkrementeller Abruf, siehe oben) und
 * bei Patreon auf jedes heute aktive Mitglied. Ohne Sonderfall wäre der
 * allererste Lauf ein Schwall aus Jahre alten "neuen" Verkäufen. `istKaltstart()`
 * prüft je Anbieter, ob überhaupt schon einmal ein Ereignis erfasst wurde;
 * ist das die allererste Zeile, werden alle Treffer DIESES Laufs mit
 * `stumm = 1` abgelegt — sie besetzen ihren Fingerabdruck (kein künftiger
 * Lauf hält sie für neu), tauchen aber nie in der Liste auf und lösen nie
 * eine Meldung aus. Jeder SPÄTERE, tatsächlich neue Verkauf meldet sich
 * normal.
 *
 * WARUM NICHT FLUTEN: EIN AUFRUF, EINE MELDUNG
 * `ereignisseVerarbeiten()` bekommt die komplette Liste eines einzelnen
 * Sync-Laufs auf einmal (bei Gumroad: alle Verkäufe dieses Abrufs, bei
 * Patreon: alle Mitgliederseiten dieses Abrufs) und meldet das Ergebnis
 * GEBÜNDELT — höchstens EIN Aufruf von `benachrichtigen()` je Anbieter je
 * Sync-Lauf, gleich ob dabei ein einzelnes Ereignis oder zwanzig entdeckt
 * wurden. Der Takt der Bündelung ist damit genau der Takt, in dem
 * gumroad.ts/patreon.ts ohnehin schon bei der fremden Schnittstelle
 * nachfragen (SYNC_FRIST_MS bzw. KENNZAHLEN_FRIST_MS, beide 15 Minuten) —
 * kein zusätzlicher, frei erfundener Schwellenwert nötig. Die Liste selbst
 * (meldungenListe(), siehe unten) bleibt davon unberührt: JEDES einzelne
 * Ereignis bekommt weiterhin seine eigene Zeile für den Reiter — geflutet
 * wird nur der unterbrechende Weg (Meldung/Toast/künftig Push), nicht die
 * Ablage.
 *
 * WARUM DIESE DATEI DAS GATEWAY NICHT KENNT
 * Dieselbe Bauart wie post-sichtung.ts (`melderSetzen`) und vorschlaege.ts
 * (`zustellerSetzen`): ein Dienst, der selbst weiß, wie man eine
 * WebSocket-Verbindung oder einen Web-Push verschickt, ließe sich nicht ohne
 * beides in einem Prüflauf starten. `melderSetzen()` unten ist die
 * Einhängestelle — das Gateway meldet sich dort beim Start an (siehe
 * `postSichtung.melderSetzen(...)` in ws/gateway.ts als Vorlage) und baut
 * daraus, was auch immer als Nächstes zugestellt werden soll (WebSocket,
 * später Web-Push). Meldet sich niemand an, geht nichts verloren: die Zeile
 * steht in `verkauf_ereignisse` und damit im Reiter, sobald ihn wieder
 * jemand öffnet — `meldungenListe()` liest von dort, nicht aus einem
 * Zwischenspeicher.
 */
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { may } from './users.js';

export type VerkaufAnbieter = 'gumroad' | 'patreon';
export type VerkaufEreignisArt = 'einmalig' | 'neu' | 'verlaengerung';

/** Was ein Aufrufer (gumroad.ts/patreon.ts) hereinreicht — schon in
 *  anbieterunabhängiger Form, siehe Dateikopf. */
export interface VerkaufEreignisEingabe {
  /** z. B. `gumroad:verkauf:<Verkaufs-ID>` oder `patreon:mitglied:<Mitglieds-ID>` */
  fingerabdruck: string;
  art: VerkaufEreignisArt;
  produktName: string | null;
  betragCent: number | null;
  waehrung: string | null;
  /** null = nicht zutreffend (kein Abo, oder Anbieter ohne Probezeit-Begriff). */
  inProbe: boolean | null;
}

/** Eine Zeile für den Reiter — dieselbe Form geht als JSON an die
 *  Oberfläche (siehe routes.ts, `GET /api/verkauf/meldungen`). */
export interface VerkaufMeldung {
  id: string;
  anbieter: VerkaufAnbieter;
  art: VerkaufEreignisArt;
  produktName: string | null;
  betragCent: number | null;
  waehrung: string | null;
  inProbe: boolean | null;
  erkanntAm: number;
}

function istKaltstart(anbieter: VerkaufAnbieter): boolean {
  return (db.get<{ n: number }>(
    'SELECT COUNT(*) as n FROM verkauf_ereignisse WHERE anbieter = ?', anbieter,
  )?.n ?? 0) === 0;
}

/**
 * Ein einzelnes Ereignis eintragen. Gibt die Meldung zurück, wenn der
 * Fingerabdruck wirklich NEU war (also nie gemeldet werden soll, wenn
 * `stumm` ist — siehe Dateikopf) — sonst `null`: entweder weil der
 * Fingerabdruck schon stand (keine Dublette) oder weil es ein
 * Kaltstart-Eintrag war (still erfasst).
 */
function ereignisEinfuegen(
  anbieter: VerkaufAnbieter, eingabe: VerkaufEreignisEingabe, stumm: boolean, jetzt: number,
): VerkaufMeldung | null {
  const id = newId('ve_');
  const ergebnis = db.run(
    `INSERT OR IGNORE INTO verkauf_ereignisse
       (id, fingerabdruck, anbieter, art, produkt_name, betrag_cent, waehrung, in_probe, stumm, erkannt_am)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id, eingabe.fingerabdruck, anbieter, eingabe.art, eingabe.produktName, eingabe.betragCent,
    eingabe.waehrung, eingabe.inProbe === null ? null : (eingabe.inProbe ? 1 : 0), stumm ? 1 : 0, jetzt,
  );
  // Der Fingerabdruck stand schon da (idx_verkauf_ereignisse_abdruck) — kein
  // Einfügen, keine Meldung. Das ist die ganze Dublettensperre.
  if (ergebnis.changes === 0) return null;
  if (stumm) return null;
  return {
    id, anbieter, art: eingabe.art, produktName: eingabe.produktName, betragCent: eingabe.betragCent,
    waehrung: eingabe.waehrung, inProbe: eingabe.inProbe, erkanntAm: jetzt,
  };
}

/**
 * Der eine Weg, auf dem gumroad.ts/patreon.ts Ereignisse melden. Bekommt die
 * komplette Liste eines Sync-Laufs auf einmal und löst — falls es wirklich
 * etwas Neues gibt und dies nicht der Kaltstart ist — GENAU EINE Meldung aus,
 * gleich wie viele einzelne Ereignisse darin stecken (siehe Dateikopf,
 * "WARUM NICHT FLUTEN").
 */
export function ereignisseVerarbeiten(
  anbieter: VerkaufAnbieter, eingaben: VerkaufEreignisEingabe[], jetzt = Date.now(),
): VerkaufMeldung[] {
  if (!eingaben.length) return [];
  const stumm = istKaltstart(anbieter);
  const neu: VerkaufMeldung[] = [];
  for (const eingabe of eingaben) {
    const meldung = ereignisEinfuegen(anbieter, eingabe, stumm, jetzt);
    if (meldung) neu.push(meldung);
  }
  if (neu.length) benachrichtigen(anbieter, neu);
  return neu;
}

/* ── Zustellung — siehe Dateikopf, "WARUM DIESE DATEI DAS GATEWAY NICHT KENNT" ── */

export type VerkaufMelder = (userId: string, anbieter: VerkaufAnbieter, meldungen: VerkaufMeldung[]) => void;
let melder: VerkaufMelder | null = null;
export function melderSetzen(fn: VerkaufMelder | null): void { melder = fn; }

/** Wer `verkauf.sehen` hat, darf auch erfahren, DASS verkauft wurde — dieselbe
 *  Schwelle wie beim Ansehen der Zahlen selbst (routes.ts, `/api/verkauf/…`).
 *  Keine engere Rollen-Vorauswahl wie bei post-sichtung.ts: dort schmälert
 *  `empfaengerkreis()` bewusst auf Leitung/Administration, weil `mail.lesen`
 *  allein (auch an Mitwirkende vergebbar) zu weit für ungefragte Post-Meldungen
 *  wäre. `verkauf.sehen` ist demgegenüber selbst schon das enge Recht — siehe
 *  permissions.ts: extra NICHT Teil von `system.ansehen`, eigens dafür
 *  gedacht, wer die Zahlen des Geschäfts sehen darf. */
function empfaengerkreis(): string[] {
  const kandidaten = db.all<{ id: string }>('SELECT id FROM users WHERE disabled = 0');
  return kandidaten.map((k) => k.id).filter((id) => may(id, 'verkauf.sehen'));
}

function benachrichtigen(anbieter: VerkaufAnbieter, meldungen: VerkaufMeldung[]): number {
  const kreis = empfaengerkreis();
  if (!kreis.length) {
    console.warn(`[verkauf] Niemand mit verkauf.sehen — die Meldung (${anbieter}, ${meldungen.length}×) geht ins Leere.`);
    return 0;
  }
  let zugestellt = 0;
  for (const userId of kreis) {
    try {
      melder?.(userId, anbieter, meldungen);
      zugestellt += 1;
    } catch (err) {
      // Eine Person, deren Zustellung klemmt, darf die anderen nicht mitnehmen.
      console.error('[verkauf] Meldung an', userId, 'fehlgeschlagen:', (err as Error).message);
    }
  }
  return zugestellt;
}

/* ── Die Liste für den Reiter ────────────────────────────────────────── */

function zeileZuMeldung(r: any): VerkaufMeldung {
  return {
    id: r.id,
    anbieter: r.anbieter,
    art: r.art,
    produktName: r.produkt_name ?? null,
    betragCent: r.betrag_cent ?? null,
    waehrung: r.waehrung ?? null,
    inProbe: r.in_probe === null || r.in_probe === undefined ? null : Boolean(r.in_probe),
    erkanntAm: r.erkannt_am,
  };
}

/**
 * Neueste zuerst, `vor` zum Nachladen — dieselbe Kennung wie bei
 * `postSichtung.meldungenListe()`: der `erkanntAm`-Wert der letzten schon
 * geladenen Zeile. Kaltstart-Zeilen (`stumm = 1`) bleiben draußen: sie sind
 * die Dublettensperre für einen Altbestand, keine Meldung, die je jemand
 * sehen sollte (siehe Dateikopf).
 */
export function meldungenListe(anzahl = 50, vor?: number): VerkaufMeldung[] {
  const grenze = Math.min(Math.max(1, Math.trunc(anzahl) || 50), 200);
  const rows = vor
    ? db.all<any>(
        'SELECT * FROM verkauf_ereignisse WHERE stumm = 0 AND erkannt_am < ? ORDER BY erkannt_am DESC LIMIT ?',
        vor, grenze,
      )
    : db.all<any>(
        'SELECT * FROM verkauf_ereignisse WHERE stumm = 0 ORDER BY erkannt_am DESC LIMIT ?',
        grenze,
      );
  return rows.map(zeileZuMeldung);
}
