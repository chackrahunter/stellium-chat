/**
 * Einmalcodes für gemeinsam genutzte Konten — der zweite Faktor im Chat.
 *
 * WOFÜR
 *
 * Das Team teilt sich ein Firmenkonto bei Google. Den zweiten Faktor hat heute
 * genau eine Person auf dem Telefon; alle anderen fragen und warten. Hier
 * liegt derselbe zweite Faktor, und wer das Recht hat, holt sich den Code
 * selbst.
 *
 * WO GERECHNET WIRD — UND WARUM HIER
 *
 * **Auf dem Server, nicht in der App.** Ein Einmalcode braucht das Geheimnis;
 * wer ihn auf dem eigenen Rechner ausrechnen will, muss das Geheimnis dort
 * haben. Das hieße: der zweite Faktor des Firmenkontos liegt auf zehn
 * Laptops statt auf einem Pi. Zehn Geräte, die verloren gehen, verkauft,
 * repariert oder befallen werden können — und aus denen man ihn nicht mehr
 * zurückholt. Ein einziges schlechtes Paket im Renderer genügt, und er ist
 * für immer draußen; ein Widerruf hieße, das Google-Konto neu einzurichten
 * UND jedem Laptop zu glauben, dass er ihn gelöscht hat.
 *
 * Dagegen steht „geht ohne Verbindung". Das wiegt hier weniger, als es klingt:
 * Diese Tafel sitzt in einem CHAT, der ohne den Pi ohnehin ein leeres Fenster
 * ist. Wer den Server nicht erreicht, sieht keine Nachrichten, keine Kanäle,
 * keine Tafel. Der Fall, in dem es wirklich zählt, ist ein anderer und viel
 * schmaler: die App LÄUFT, jemand hat die Tafel offen, und mitten im Anmelden
 * fällt der Pi weg (oder die Freigabe nach draußen läuft ab, siehe
 * server-setup). Genau dieser Fall — und nur der — wird unten mit dem VORRAT
 * abgedeckt: der Server gibt nicht einen Code heraus, sondern die nächsten
 * paar Fenster im Voraus. Die App hält sie NUR IM ARBEITSSPEICHER und kann
 * damit weiterzählen, bis der Vorrat leer ist; danach sagt sie es, statt eine
 * abgelaufene Zahl anzuzeigen.
 *
 * Das ist der ganze Handel: ein paar Minuten benutzbarer Codes im
 * Arbeitsspeicher statt eines unbefristeten Geheimnisses auf der Platte. Das
 * Geheimnis selbst verlässt den Pi nie — es gibt keinen Weg, über den es
 * hinausginge (siehe `kontenListe`, `kontoStand`: keine Rückgabe trägt es).
 *
 * WIE ES LIEGT
 *
 * Verschlüsselt mit dem Feldschlüssel aus crypto/pii.ts — demselben, der
 * Benutzernamen und E-Mail-Adressen schützt, und derselbe Weg wie beim
 * Fernzugang (services/fernzugang.ts) und beim Postfach
 * (services/mailzugang.ts). Wer die Datenbank in die Hand bekommt, hat damit
 * noch nichts.
 *
 * **Angezeigt wird es nie.** Wer ein Konto einrichtet, sieht danach nur noch,
 * DASS etwas hinterlegt ist — nicht was. Das ist die Hausregel für
 * Geheimnisse (services/verkaufzugang.ts, Dateikopf), und sie hat dort genau
 * EINE bewusste Ausnahme: Patreons Client-ID, weil sie nur benennt, welche App
 * eingetragen ist, und selbst kein Geheimnis ist. Hier gibt es keine
 * Ausnahme. Aussteller und Kontoname kommen zurück — sie sind das Etikett,
 * ohne das niemand zwei Konten auseinanderhält —, das Geheimnis nicht,
 * nirgends, auch nicht verkürzt und auch nicht in einem Fehlertext.
 *
 * WER DARF WAS
 *
 * Zwei Rechte, wie bei Fernzugang und Postfach auch:
 *   · `einmalcode.nutzen`    — die Tafel sehen und Codes holen.
 *   · `einmalcode.verwalten` — Konten anlegen, ändern, löschen. `ownerOnly`.
 * Geprüft wird in http/einmalcode.ts, nicht hier — dieselbe Aufteilung wie
 * überall im Haus.
 *
 * WER WANN EINEN CODE GEHOLT HAT
 *
 * Steht in `einmalcode_abrufe`. Ohne diese Liste ließe sich „wer hat sich am
 * Dienstag ins Firmenkonto eingeloggt?" nicht beantworten — und das ist die
 * eine Frage, die nach einem Vorfall garantiert kommt. Der Code selbst steht
 * dort NICHT; er wäre nach dreißig Sekunden ohnehin wertlos und vorher ein
 * Nachschlüssel im Klartext.
 */
import { db } from '../db/index.js';
import { newId } from '../util/id.js';
import { abweisung } from '../util/abweisung.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';
import {
  codeReihe, eingabeLesen, restSekunden,
  Base32Fehler, UriFehler,
  VORGABE_ALGORITHMUS, VORGABE_PERIODE, VORGABE_STELLEN,
  type Einmalcodevorgabe, type Hashverfahren,
} from './einmalcode-kern.js';
import { uhrstand, warnschwelleMs, type Uhrstand } from './einmalcode-uhr.js';

/**
 * Wie viele Fenster im Voraus herausgegeben werden.
 *
 * Zehn mal dreißig Sekunden sind fünf Minuten. Das ist bemessen an dem, was
 * es abdecken soll: eine angefangene Anmeldung zu Ende bringen, wenn der Pi
 * mittendrin wegfällt. Es ist ausdrücklich NICHT bemessen für „stundenlang
 * ohne Server arbeiten" — dafür wäre die richtige Antwort ein Telefon mit
 * eigenem Authenticator, nicht ein größerer Vorrat.
 *
 * Wer hier hochzählt, sollte wissen, was er tut: jedes Fenster mehr ist ein
 * weiterer gültiger Code, der in der Antwort steht.
 */
export const VORRAT_FENSTER = 10;

/** Was von einem Konto nach draußen darf. Kein Geheimnis, nirgends. */
export interface EinmalcodeKonto {
  id: string;
  /** Frei wählbares Etikett, etwa „Google — Firmenkonto". */
  bezeichnung: string;
  /** Aus der `otpauth://`-Adresse, etwa „Google". Leer, wenn keine dabei war. */
  aussteller: string;
  /** Aus der Adresse, meist die Mailadresse des Kontos. */
  konto: string;
  algorithmus: Hashverfahren;
  stellen: number;
  periode: number;
  /** Liegt das Geheimnis verschlüsselt? Ohne Masterpasswort nicht. */
  verschluesselt: boolean;
  angelegtAm: number;
  geaendertAm: number | null;
}

interface Zeile {
  id: string;
  bezeichnung: string;
  aussteller: string | null;
  konto: string | null;
  geheimnis: string;
  algorithmus: string;
  stellen: number;
  periode: number;
  angelegt_am: number;
  geaendert_am: number | null;
}

/* Ohne `geheimnis` — damit eine vergessene Spalte gar nicht erst irgendwo
   landen kann, wo sie nicht hingehört. Wer das Geheimnis braucht, holt es
   ausdrücklich über `geheimnisLesen()` unten; das ist die einzige Stelle im
   Haus, an der es entschlüsselt wird, und sie gibt es nicht weiter. */
const OHNE_GEHEIMNIS = `
  SELECT id, bezeichnung, aussteller, konto, algorithmus, stellen, periode,
         angelegt_am, geaendert_am
    FROM einmalcode_konten`;

function ausZeile(z: Omit<Zeile, 'geheimnis'>): EinmalcodeKonto {
  return {
    id: z.id,
    bezeichnung: decryptField(z.bezeichnung),
    aussteller: decryptField(z.aussteller),
    konto: decryptField(z.konto),
    algorithmus: z.algorithmus as Hashverfahren,
    stellen: z.stellen,
    periode: z.periode,
    verschluesselt: encryptionActive(),
    angelegtAm: z.angelegt_am,
    geaendertAm: z.geaendert_am,
  };
}

/* ── Lesen ────────────────────────────────────────────────────── */

export function kontenListe(): EinmalcodeKonto[] {
  return db.all<Omit<Zeile, 'geheimnis'>>(`${OHNE_GEHEIMNIS} ORDER BY angelegt_am ASC`).map(ausZeile);
}

export function kontoLesen(id: string): EinmalcodeKonto | null {
  const z = db.get<Omit<Zeile, 'geheimnis'>>(`${OHNE_GEHEIMNIS} WHERE id = ?`, id);
  return z ? ausZeile(z) : null;
}

/**
 * Das Geheimnis — die EINZIGE Stelle, an der es entschlüsselt wird.
 *
 * Nicht exportiert, und das ist der Punkt: von außerhalb dieser Datei gibt es
 * keinen Weg an den Klartext. Wer einen Code will, ruft `codesHolen()` und
 * bekommt Ziffern.
 */
function vorgabeLesen(id: string): Einmalcodevorgabe | null {
  const z = db.get<Zeile>('SELECT * FROM einmalcode_konten WHERE id = ?', id);
  if (!z) return null;
  const geheimnisBase32 = decryptField(z.geheimnis);
  if (!geheimnisBase32) return null;
  return {
    geheimnisBase32,
    algorithmus: z.algorithmus as Hashverfahren,
    stellen: z.stellen,
    periode: z.periode,
  };
}

/* ── Schreiben ────────────────────────────────────────────────── */

export interface KontoEingabe {
  /** Das Etikett. Leer? Dann wird eins aus Aussteller und Konto gebaut. */
  bezeichnung?: string;
  /** `otpauth://…` ODER das nackte Geheimnis in Base32. Wird NIE zurückgegeben. */
  geheimnis?: string;
}

/**
 * Eine Eingabe zu Kennzahlen machen — und dabei nichts vom Geheimnis
 * weitergeben.
 *
 * Die Fehler aus dem Kern (Base32Fehler, UriFehler) tragen NUR die Art des
 * Fehlers, nie den Wert. Sie werden hier trotzdem noch einmal umgewandelt:
 * in eine Abweisung mit Wörterbuchkennung, damit die Oberfläche in ihrer
 * eigenen Sprache erklären kann, was schiefging. Der ursprüngliche Text wird
 * dabei ABSICHTLICH NICHT als `cause` mitgegeben — bei allem anderen im Haus
 * ist das richtig (siehe util/abweisung.ts), hier nicht: eine `cause` landet
 * im Protokoll, und ein Fehler beim Einlesen eines Geheimnisses ist die
 * Stelle, an der ein Protokoll am ehesten etwas davon abbekäme.
 */
function eingabePruefen(roh: string) {
  try {
    return eingabeLesen(roh);
  } catch (f) {
    if (f instanceof UriFehler) throw abweisung('fehler.einmalcodeUri', 'Diese Adresse lässt sich nicht lesen.');
    if (f instanceof Base32Fehler) throw abweisung('fehler.einmalcodeGeheimnis', 'Dieses Geheimnis lässt sich nicht lesen.');
    throw abweisung('fehler.einmalcodeGeheimnis', 'Dieses Geheimnis lässt sich nicht lesen.');
  }
}

/** Ein Etikett, wenn niemand eins getippt hat. Nie leer. */
function etikettBauen(bezeichnung: string, aussteller: string, konto: string): string {
  const getippt = bezeichnung.trim();
  if (getippt) return getippt;
  const gebaut = [aussteller, konto].filter(Boolean).join(' — ');
  /* Letzter Ausweg: ein Etikett ohne jeden Bezug zum Geheimnis. Der Zeitpunkt
     ist unverfänglich und macht zwei namenlose Konten unterscheidbar. */
  return gebaut || `Konto ${new Date().toISOString().slice(0, 10)}`;
}

export function kontoAnlegen(eingabe: KontoEingabe, userId: string): EinmalcodeKonto {
  if (!eingabe.geheimnis?.trim()) {
    throw abweisung('fehler.einmalcodeOhneGeheimnis', 'Ohne Geheimnis geht es nicht.');
  }
  const gelesen = eingabePruefen(eingabe.geheimnis);
  const id = newId('otp_');
  const jetzt = Date.now();
  db.run(
    `INSERT INTO einmalcode_konten
       (id, bezeichnung, aussteller, konto, geheimnis, algorithmus, stellen, periode, angelegt_von, angelegt_am)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    id,
    encryptField(etikettBauen(eingabe.bezeichnung ?? '', gelesen.aussteller, gelesen.konto)),
    gelesen.aussteller ? encryptField(gelesen.aussteller) : null,
    /* Der Kontoname ist meistens eine Mailadresse — im Haus ist das ein
       personenbezogenes Feld, und die liegen verschlüsselt (crypto/pii.ts). */
    gelesen.konto ? encryptField(gelesen.konto) : null,
    encryptField(gelesen.geheimnisBase32),
    gelesen.algorithmus, gelesen.stellen, gelesen.periode,
    userId, jetzt,
  );
  const angelegt = kontoLesen(id);
  if (!angelegt) throw abweisung('fehler.einmalcodeKonto', 'Das Konto wurde nicht gefunden.');
  return angelegt;
}

/**
 * Etikett ändern — und/oder das Geheimnis austauschen.
 *
 * Ein weggelassenes Geheimnis lässt das bisherige stehen: nur so lässt sich
 * ein Konto umbenennen, ohne das Geheimnis noch einmal einzugeben, das man ja
 * nirgends mehr ablesen kann. Dieselbe Regel wie bei fernzugang.ts und
 * mailzugang.ts.
 */
export function kontoAendern(id: string, eingabe: KontoEingabe, userId: string): EinmalcodeKonto {
  const vorhanden = kontoLesen(id);
  if (!vorhanden) throw abweisung('fehler.einmalcodeKonto', 'Das Konto wurde nicht gefunden.');

  if (eingabe.geheimnis?.trim()) {
    const gelesen = eingabePruefen(eingabe.geheimnis);
    db.run(
      `UPDATE einmalcode_konten
          SET geheimnis = ?, algorithmus = ?, stellen = ?, periode = ?,
              aussteller = ?, konto = ?, geaendert_von = ?, geaendert_am = ?
        WHERE id = ?`,
      encryptField(gelesen.geheimnisBase32),
      gelesen.algorithmus, gelesen.stellen, gelesen.periode,
      gelesen.aussteller ? encryptField(gelesen.aussteller) : null,
      gelesen.konto ? encryptField(gelesen.konto) : null,
      userId, Date.now(), id,
    );
  }

  if (eingabe.bezeichnung !== undefined && eingabe.bezeichnung.trim()) {
    db.run(
      'UPDATE einmalcode_konten SET bezeichnung = ?, geaendert_von = ?, geaendert_am = ? WHERE id = ?',
      encryptField(eingabe.bezeichnung.trim()), userId, Date.now(), id,
    );
  }

  const neu = kontoLesen(id);
  if (!neu) throw abweisung('fehler.einmalcodeKonto', 'Das Konto wurde nicht gefunden.');
  return neu;
}

export function kontoLoeschen(id: string): void {
  const vorhanden = db.get<{ id: string }>('SELECT id FROM einmalcode_konten WHERE id = ?', id);
  if (!vorhanden) throw abweisung('fehler.einmalcodeKonto', 'Das Konto wurde nicht gefunden.');
  /* Die Abrufe bleiben stehen. Sie sind der Nachweis, wer wann einen Code
     geholt hat, und der verliert seinen Sinn, wenn ein gelöschtes Konto ihn
     mitnimmt — gerade das Löschen ist der Griff, mit dem jemand Spuren
     verwischen würde. Deshalb kein ON DELETE CASCADE in der Tabelle. */
  db.run('DELETE FROM einmalcode_konten WHERE id = ?', id);
}

/* ── Codes ────────────────────────────────────────────────────── */

export interface CodeAntwort {
  kontoId: string;
  /** Die Uhrzeit des Servers, als die Codes entstanden. Die App rechnet damit. */
  serverMs: number;
  stellen: number;
  periode: number;
  /** Das laufende Fenster und die nächsten `VORRAT_FENSTER - 1`. */
  codes: Array<{ fenster: string; code: string; gueltigAbMs: number; gueltigBisMs: number }>;
  /** Wie lange das laufende Fenster noch gilt, in Sekunden. */
  restSekunden: number;
  /** Bis wann der Vorrat reicht — danach muss die App wieder fragen. */
  vorratBisMs: number;
  uhr: Uhrstand;
}

/**
 * Codes holen — der einzige Weg, auf dem aus dem Geheimnis etwas wird.
 *
 * Dass hier ein Vorrat entsteht und nicht ein einzelner Code, ist die
 * Antwort auf „geht es ohne Verbindung?" — siehe Dateikopf.
 */
export function codesHolen(id: string, userId: string): CodeAntwort {
  const vorgabe = vorgabeLesen(id);
  if (!vorgabe) throw abweisung('fehler.einmalcodeKonto', 'Das Konto wurde nicht gefunden.');

  const serverMs = Date.now();
  const sekunden = Math.floor(serverMs / 1000);
  const codes = codeReihe(vorgabe, sekunden, VORRAT_FENSTER);

  abrufMerken(id, userId, serverMs);

  return {
    kontoId: id,
    serverMs,
    stellen: vorgabe.stellen,
    periode: vorgabe.periode,
    codes,
    restSekunden: restSekunden(sekunden, vorgabe.periode),
    vorratBisMs: codes[codes.length - 1].gueltigBisMs,
    uhr: uhrstand(vorgabe.periode),
  };
}

/* ── Uhr ──────────────────────────────────────────────────────── */

/**
 * Der Zeitstand für die Tafel — auch dann, wenn noch kein Konto angelegt ist.
 *
 * `serverMs` ist der Anker, an dem die App ihre eigene Uhr misst: sie schickt
 * mit, wann sie gefragt hat, rechnet die Umlaufzeit heraus und weiß danach,
 * um wie viel ihre Uhr gegenüber dem Server danebenliegt. Angezeigt wird der
 * Code trotzdem aus SERVERZEIT — eine schiefe Uhr auf dem Laptop macht ihn
 * also nicht falsch, sondern nur den Balken darunter, und genau den korrigiert
 * die App damit.
 */
export function zeitstand(periode = VORGABE_PERIODE): {
  serverMs: number; periode: number; warnschwelleMs: number; uhr: Uhrstand;
} {
  return {
    serverMs: Date.now(),
    periode,
    warnschwelleMs: warnschwelleMs(periode),
    uhr: uhrstand(periode),
  };
}

/* ── Abrufe ───────────────────────────────────────────────────── */

export interface Abruf {
  id: string;
  kontoId: string;
  /** Etikett zum Zeitpunkt des Abrufs — bleibt lesbar, auch wenn das Konto weg ist. */
  bezeichnung: string;
  userId: string;
  am: number;
}

/**
 * Einen Abruf festhalten.
 *
 * In try/catch, und das mit Absicht: fehlt die Tabelle (etwa weil die
 * Nachrüstung in db/migrate.ts noch aussteht), soll der Code trotzdem
 * herauskommen. Ein fehlender Nachweis ist ärgerlich; eine Tafel, die
 * deswegen gar nichts mehr herausgibt, wäre schlimmer — dann greift wieder
 * jeder zum Telefon des Kollegen, und die Funktion ist umsonst gebaut.
 * Auffallen soll es trotzdem, deshalb die Zeile im Protokoll.
 */
function abrufMerken(kontoId: string, userId: string, am: number): void {
  try {
    const konto = db.get<{ bezeichnung: string }>(
      'SELECT bezeichnung FROM einmalcode_konten WHERE id = ?', kontoId,
    );
    db.run(
      'INSERT INTO einmalcode_abrufe (id, konto_id, bezeichnung, user_id, am) VALUES (?,?,?,?,?)',
      newId('otpa_'), kontoId,
      /* Kopie des Etiketts, verschlüsselt wie das Original — der Nachweis
         soll auch dann noch lesbar sein, wenn jemand das Konto löscht. */
      konto?.bezeichnung ?? encryptField('—'), userId, am,
    );
  } catch (f) {
    console.error('[einmalcode] Ein Abruf ließ sich nicht festhalten:', (f as Error).message);
  }
}

/** Die letzten Abrufe — wer, wann, welches Konto. Nie: welcher Code. */
export function abrufeListe(grenze = 200): Abruf[] {
  try {
    return db.all<{ id: string; konto_id: string; bezeichnung: string; user_id: string; am: number }>(
      'SELECT id, konto_id, bezeichnung, user_id, am FROM einmalcode_abrufe ORDER BY am DESC LIMIT ?',
      Math.min(Math.max(1, grenze), 500),
    ).map((z) => ({
      id: z.id,
      kontoId: z.konto_id,
      bezeichnung: decryptField(z.bezeichnung),
      userId: z.user_id,
      am: z.am,
    }));
  } catch {
    return [];
  }
}

/* Damit die Voreinstellungen auch außerhalb des Kerns greifbar sind, ohne
   dass jemand zwei Quellen für dieselbe Zahl pflegt. */
export { VORGABE_ALGORITHMUS, VORGABE_PERIODE, VORGABE_STELLEN };
