import {
  NOTZUGANG_ANFRAGE_STUNDEN, NOTZUGANG_ANTEILE, NOTZUGANG_SCHWELLE,
  type NotzugangAnfrage, type NotzugangAnteilBlob, type NotzugangAufgabe,
  type NotzugangHuelle, type NotzugangProtokollZeile, type NotzugangStand,
  type FluechtigesPaket,
} from '@stellium/shared';
import { db, placeholders } from '../db/index.js';
import { newId } from '../util/id.js';
import { abweisung } from '../util/abweisung.js';
import { hartVerwerfen } from './kontoverwerfen.js';

/**
 * Der Notzugang — „3 von 5", verwahrt, nie geöffnet.
 *
 * WAS HIER PASSIERT UND WAS AUSDRÜCKLICH NICHT
 *
 * Diese Datei nimmt Bytes entgegen, prüft Kennungen und Zählungen und gibt
 * Bytes wieder heraus. Sie teilt kein Geheimnis, setzt keines zusammen und
 * öffnet keine Hülle — das geschieht ausschließlich in
 * desktop/src/lib/notzugang.ts, auf einem Gerät. shared/geheimnisteilung.ts
 * wird von hier bewusst NICHT eingebunden: ein Server, der die Teilung auch
 * nur importiert, ist ein Server, dem jemand später zutraut, sie zu benutzen.
 *
 * DIE DREI ZÄHLUNGEN, AUF DENEN ALLES RUHT
 *
 *   1. FÜNF ANTEILE, FÜNF VERSCHIEDENE MENSCHEN. `einrichten()` nimmt nur
 *      genau NOTZUGANG_ANTEILE Anteile an, mit fünf verschiedenen Kennungen,
 *      alle aktiv, keiner die besitzende Person selbst. Vier Anteile mit
 *      einem doppelt gäbe eine Schwelle von zwei.
 *
 *   2. HÖCHSTENS ZWEI AUS DER VERWALTUNG. Owner und Administratoren dürfen
 *      zusammen höchstens NOTZUGANG_SCHWELLE - 1 Anteile halten. Ohne diese
 *      Regel könnte der Kreis, der ohnehin Passwörter zurücksetzt, die
 *      Schwelle unter sich erreichen — und dann wäre der ganze Aufbau eine
 *      aufwendige Art, genau das Gegenteil dessen zu tun, wofür er da ist.
 *      Die Regel ist auf die Schwelle bezogen und nicht auf die Zahl 2:
 *      wer die Schwelle später ändert, ändert sie mit.
 *
 *   3. NUR BRAUCHBARE ANTEILE ZÄHLEN. Ein Anteil zählt, wenn das Konto der
 *      haltenden Person aktiv ist UND ihr heutiger öffentlicher Teil noch
 *      der ist, für den verpackt wurde. Verlässt jemand die Firma oder
 *      wechselt sein Schlüsselpaar, sinkt `brauchbar` sichtbar — statt dass
 *      die Schwelle still von drei auf „geht nicht mehr" fällt und das
 *      niemand merkt, bis es darauf ankommt.
 *
 * WARUM DIE VERWALTUNG EINEN NOTZUGANG AUFHEBEN DARF, ABER NIE EINLÖSEN
 *
 * `aufheben()` steht auch der Kontenverwaltung offen, `beitraegeHolen()` und
 * `einloesen()` ausschließlich der besitzenden Person selbst. Das ist kein
 * Versehen, sondern die Asymmetrie, um die es geht: ZERSTÖREN öffnet nichts.
 * Wer einen Notzugang aufhebt, nimmt der Firma eine Rettungsleine und
 * gewinnt dabei keinen einzigen Blick in fremde Notizen. Genau deshalb darf
 * eine einzelne Person das — und es ist der vorgesehene Griff für den Fall,
 * in dem ein Passwort nicht vergessen, sondern durchgesickert ist.
 *
 * IN BEIDEN REIHENFOLGEN, und das ist neu. „Erst aufheben, dann zurücksetzen"
 * brannte schon immer alles nieder — `verwerfen()` in
 * services/kontoschluessel.ts findet dann keinen Notzugang mehr und läuft in
 * den harten Zweig. „Erst zurücksetzen, dann aufheben" tat es NICHT: der
 * schonende Zweig ließ jedes Notiz- und Tresorpaket stehen, und `aufheben()`
 * sah den Kontoschlüssel nie an. Seither holt `aufheben()` das Niederbrennen
 * selbst nach, wenn keine Passworthülle mehr dasteht — die ausgeschriebene
 * Begründung steht bei der Funktion.
 */

/* ── Kleinkram ────────────────────────────────────────────────── */

interface HalterZeile {
  halter_id: string;
  stelle: number;
  halter_abdruck: string;
}

/** Aktiv heißt: nicht gelöscht und nicht gesperrt — dieselbe Bedingung wie
 *  verwaltungIds() in services/vertraulich.ts. */
const AKTIV = 'u.deleted_at IS NULL AND u.disabled = 0';

function jetzt(): number { return Date.now(); }

function protokollieren(
  userId: string, art: string, anfrageId: string | null, halterId: string | null,
): void {
  db.run(
    'INSERT INTO notzugang_protokoll (id, user_id, anfrage_id, art, halter_id, am) VALUES (?,?,?,?,?,?)',
    newId('nzp'), userId, anfrageId, art, halterId, jetzt(),
  );
}

/* ── Auskunft ─────────────────────────────────────────────────── */

function halterZeilen(userId: string): HalterZeile[] {
  return db.all<HalterZeile>(
    'SELECT halter_id, stelle, halter_abdruck FROM notzugang_anteile WHERE user_id = ? ORDER BY stelle',
    userId,
  );
}

/**
 * Der Stand — ohne ein einziges Geheimnis.
 *
 * `brauchbar` ist die Zahl, auf die es ankommt: sie zählt nur Anteile, die
 * heute noch einzulösen wären. Fällt sie unter die Schwelle, ist der
 * Notzugang kaputt, und die Tafel sagt das mit denselben Worten.
 *
 * OHNE `notzugangWartet` — ABSICHTLICH. Diese Datei importiert
 * services/kontoschluessel.ts bewusst nicht: die einzige Stelle bindet
 * schon in die Gegenrichtung (kontoschluessel.ts -> notzugang.ts, für
 * gedeckterAbdruck()), und ein Import zurück machte daraus einen Kreis für
 * eine einzige Zeile. `kontoschluessel.notzugangWartet()` ist DIE einzige
 * Stelle, die diese Frage beantwortet (siehe dort); wer den vollständigen
 * `NotzugangStand` braucht, setzt das Feld an der Stelle dazu, die beide
 * Dienste schon kennt — http/routes.ts.
 */
export function standFuer(userId: string): Omit<NotzugangStand, 'notzugangWartet'> {
  const zeile = db.get<{
    schwelle: number; anteile: number; erstellt_am: number;
  }>('SELECT schwelle, anteile, erstellt_am FROM konto_notzugang WHERE user_id = ?', userId);

  if (!zeile) {
    return {
      eingerichtet: false, schwelle: NOTZUGANG_SCHWELLE, anteile: NOTZUGANG_ANTEILE,
      brauchbar: 0, halter: [], erstelltAm: 0,
      ausDerVerwaltung: 0, verwaltungZuViele: false,
    };
  }

  const zeilen = halterZeilen(userId);
  const ids = zeilen.map((z) => z.halter_id);
  const lebend = ids.length
    ? db.all<{ id: string; abdruck: string | null; role: string }>(
        `SELECT u.id, u.role, s.abdruck FROM users u
         LEFT JOIN vertraulich_schluessel s ON s.user_id = u.id
         WHERE u.id IN (${placeholders(ids.length)}) AND ${AKTIV}`,
        ...ids,
      )
    : [];
  const nachId = new Map(lebend.map((r) => [r.id, r.abdruck]));

  /* Zählung 2 aus dem Dateikopf, HEUTE gemessen statt beim Einrichten
     eingefroren. einrichten() unten prüft dieselbe Regel gegen dieselbe
     Rollenspalte — nur eben einmal, im Augenblick des Einrichtens. Danach
     befördert setRole() in services/users.ts Menschen, ohne je einen Anteil
     anzusehen, und zwei Beförderungen später hält die Verwaltung drei von
     fünf Anteilen: genau die Aufstellung, die die Regel verbietet, und die
     Tafel sagte trotzdem „alles in Ordnung".

     WARUM DIE ZAHL NUR GEMELDET UND KEINE BEFÖRDERUNG ABGELEHNT WIRD: eine
     Rollenvergabe, die an einem fremden Rettungsanteil scheitert, wäre ein
     überraschender Fehlschlag in einem Vorgang, der damit nichts zu tun hat
     — und die naheliegende Abhilfe („dann eben den Notzugang aufheben")
     nähme jemandem seine Rettungsleine für eine Personalentscheidung. Eine
     Wiederherstellung deswegen ZU VERWEIGERN wäre noch schlechter: es träfe
     die Person, die gerade nicht mehr an ihre Notizen kommt, und sie könnte
     es nicht einmal heilen — den Notzugang zu erneuern setzt voraus, dass
     man den Kontoschlüssel hat, also genau das, was fehlt. Bleibt das
     Sichtbarmachen: die Tafel nennt die Zahl, und die besitzende Person
     tauscht die haltenden Personen aus, solange sie es noch kann. */
  const ausDerVerwaltung = lebend.filter((r) => r.role === 'owner' || r.role === 'admin').length;

  const halter = zeilen.map((z) => {
    const aktiv = nachId.has(z.halter_id);
    return {
      halterId: z.halter_id,
      stelle: z.stelle,
      aktiv,
      /* Kein Schlüssel beim Server heißt „passt nicht" und nicht „passt
         vielleicht": ein Anteil, den niemand mehr öffnen kann, darf nicht
         mitgezählt werden. */
      schluesselPasst: aktiv && nachId.get(z.halter_id) === z.halter_abdruck,
    };
  });

  return {
    eingerichtet: true,
    schwelle: zeile.schwelle,
    anteile: zeile.anteile,
    brauchbar: halter.filter((h) => h.aktiv && h.schluesselPasst).length,
    halter,
    erstelltAm: zeile.erstellt_am,
    ausDerVerwaltung,
    verwaltungZuViele: ausDerVerwaltung >= zeile.schwelle,
  };
}

/**
 * Alle Konten, für die ein Notzugang steht.
 *
 * Für die Kontenliste der Verwaltung (services/store.ts, listManagedUsers()).
 * Es geht nur um das OB — wer Anteile hält, steht hier nicht und geht die
 * Verwaltung auch nichts an. Eine einzige Abfrage statt einer je Zeile: die
 * Liste zeigt jedes Konto des Hauses.
 */
export function kontenMitNotzugang(): Set<string> {
  return new Set(
    db.all<{ user_id: string }>('SELECT user_id FROM konto_notzugang').map((r) => r.user_id),
  );
}

/**
 * Konten, bei denen „Notzugang aufheben" JETZT den Kontoschlüssel
 * niederbrennt — dieselbe Bedingung wie unten in aufheben() (`konto_schluessel.
 * daten` leer bei stehender Zeile), nur für die ganze Liste auf einmal und
 * rein lesend, außerhalb jeder Transaktion.
 *
 * Für dieselbe Kontenliste wie kontenMitNotzugang() oben, aber für eine
 * ANDERE Frage: nicht mehr „gibt es einen Notzugang", sondern „was tut der
 * Knopf, der ihn aufhebt, in diesem Augenblick". Das ist kein Blick auf WER
 * Anteile hält oder WIE VIELE noch tragen — die gehen der Verwaltung
 * weiterhin nichts an (siehe hatNotzugang in @stellium/shared) —, sondern
 * die unmittelbare Folge des einen Knopfs, den die Verwaltung gleich
 * drückt. Siehe TeamAdmin.tsx für die Abwägung, warum genau diese eine
 * Auskunft die Grenze verschiebt und keine weitere.
 */
export function kontenBeiDenenAufhebenVerbrennt(): Set<string> {
  return new Set(
    db.all<{ user_id: string }>("SELECT user_id FROM konto_schluessel WHERE daten = ''").map((r) => r.user_id),
  );
}

/** Die Hülle um den Kontoschlüssel — nur für die besitzende Person, und ohne
 *  den Notschlüssel wertlos. */
export function huelleHolen(userId: string): NotzugangHuelle | null {
  const r = db.get<{
    alg: string; iv: string; daten: string; konto_abdruck: string;
    konto_fassung: number; schwelle: number; anteile: number;
  }>(
    `SELECT alg, iv, daten, konto_abdruck, konto_fassung, schwelle, anteile
     FROM konto_notzugang WHERE user_id = ?`, userId,
  );
  if (!r) return null;
  return {
    alg: r.alg, iv: r.iv, daten: r.daten,
    kontoAbdruck: r.konto_abdruck, kontoFassung: r.konto_fassung,
    schwelle: r.schwelle, anteile: r.anteile,
  };
}

/**
 * Gibt es einen Notzugang auf GENAU DIESEN Kontoschlüssel?
 *
 * Die Frage mit einem Abdruck IN DER HAND. services/kontoschluessel.ts stellt
 * sie so nicht mehr: dort war der Abdruck aus `konto_schluessel` das
 * Argument, und genau den räumt das harte Verwerfen weg — die Sicherung
 * verschwand mit ihm. Dort fragt jetzt gedeckterAbdruck() unten, das ohne
 * Argument auskommt.
 *
 * Was hier bleibt, ist die Prüfrichtung: „gehört dieser Abdruck, den ich
 * schon habe, zum Notzugang dieses Kontos?" — so fragt pruefungen/
 * notzugang.mts nach jedem Schritt, und so fragt jeder, der zwei Abdrücke
 * vergleichen will, ohne einen davon herauszugeben.
 */
export function deckt(userId: string, kontoAbdruck: string): boolean {
  if (!kontoAbdruck) return false;
  return Boolean(db.get(
    'SELECT 1 AS x FROM konto_notzugang WHERE user_id = ? AND konto_abdruck = ?',
    userId, kontoAbdruck,
  ));
}

/**
 * WELCHEN Kontoschlüssel deckt der Notzugang dieses Kontos? `null`, wenn es
 * keinen gibt.
 *
 * Der Unterschied zu deckt() ist der ganze Punkt: deckt() fragt „passt der
 * Abdruck, den ich schon habe?" und braucht dafür einen. Nach einem harten
 * Verwerfen (services/kontoschluessel.ts) steht in `konto_schluessel.abdruck`
 * aber nichts mehr — und damit verschwand die Antwort genau in dem
 * Augenblick, in dem sie gebraucht wird. Diese Auskunft hängt an der Zeile
 * des NOTZUGANGS, die niemand nebenbei leert: sie überlebt jedes Verwerfen
 * und ist deshalb die einzige, auf der eine Sicherung stehen darf.
 *
 * Herausgegeben wird ein Abdruck — SHA-256 über 256 Bit Zufall mit eigenem
 * Vorspann. Er verrät den Schlüssel nicht.
 */
export function gedeckterAbdruck(userId: string): string | null {
  const r = db.get<{ konto_abdruck: string }>(
    'SELECT konto_abdruck FROM konto_notzugang WHERE user_id = ?', userId,
  );
  return r?.konto_abdruck || null;
}

/**
 * Die Fassung in der Zeile des Notzugangs nachziehen — UND jedes Notiz- und
 * Tresorpaket, das noch unter der alten Zahl liegt, gleich mit.
 *
 * Gerufen aus hinterlegenInTransaktion() (services/kontoschluessel.ts), und
 * NUR aus dem zweiten Zweig von `derselbe` — dem, der eine Heimkehr in ein
 * Konto ohne Abdruck erkennt. Dort ist `konto_notzugang.konto_fassung` mit
 * Sicherheit veraltet: das alte, harte Verwerfen hat `konto_schluessel.fassung`
 * hochgezählt und diese Zeile nicht angefasst.
 *
 * WAS DAS REPARIERT. `konto_fassung` behauptet, zu welcher Fassung des
 * Kontoschlüssels die Nothülle gehört — einrichten() nimmt eine Hülle gar
 * nicht erst an, wenn die beiden Zahlen auseinandergehen. In diesem
 * Altzustand gingen sie auseinander, und das Gerät merkt es: es vergleicht
 * die vom Server zurückgemeldete Fassung mit der aus der Hülle
 * (lib/kontoschluessel.ts, mitNotschluesselWiederherstellen) und bricht bei
 * Ungleichheit ab — zu Recht, denn dieselbe Ungleichheit entstünde auch,
 * wenn der Server heimlich den Ersatzzweig gelaufen wäre. Diese Prüfung
 * bleibt streng; korrigiert wird die ZAHL, die falsch ist, nicht die
 * Prüfung, die sie findet.
 *
 * WARUM DIE PAKETE MIT WANDERN, UND WARUM DAS UNGEFÄHRLICH IST. Dieser
 * Zweig läuft ausschließlich dann, wenn `derselbe` (kontoschluessel.ts) ihn
 * als Heimkehr erkannt hat — der zurückgekehrte Kontoschlüssel ist Byte für
 * Byte derselbe wie vorher, kein Ersatz, keine neue Verschlüsselung, nur
 * eine neue Hülle darum. Jedes notiz_konto_pakete- und
 * passwort_konto_pakete-Paket, das noch die ALTE Zahl trägt, ist von genau
 * diesem Schlüssel verpackt — nur das Etikett stimmte nicht mehr. Ohne
 * dieses Nachziehen bliebe es falsch etikettiert und damit für
 * kontoPaketeFuerAlle() (services/notizen.ts, services/passwoerter.ts)
 * unsichtbar, denn die filtert beim Lesen auf `konto_fassung = ?` GENAU
 * — für immer, weil ein zweiter Durchgang durch diese Funktion dieselbe
 * alte Zahl nie wieder antrifft: die Zeile des Notzugangs steht ja bereits
 * auf der neuen. Verloren geht dabei nichts, das nicht schon vorher verloren
 * war: der Primärschlüssel beider Tabellen ist (notiz_id, user_id) bzw.
 * (eintrag_id, user_id) OHNE `konto_fassung` — es gibt je Notiz und Person
 * höchstens eine Zeile, also kann das Nachziehen keine zweite, schon
 * richtig etikettierte Zeile überschreiben oder verdrängen. Betroffen ist
 * ausschließlich diese eine Person (WHERE user_id) und ausschließlich die
 * eine Zahl, die eben noch in `konto_notzugang.konto_fassung` stand.
 *
 * WAS ES WEITERHIN NICHT REPARIERT, ehrlich benannt: der Versuch, der die
 * Zeile geradezieht, scheitert noch. Das Gerät hat seine Hülle geholt,
 * bevor die Zahl stimmte, und vergleicht gegen die alte. Der Kontoschlüssel
 * UND jedes Paket stehen zu diesem Zeitpunkt schon richtig da; der NÄCHSTE
 * Versuch — dieselbe Anfrage, dieselben Beiträge, ein zweiter Klick — läuft
 * glatt durch. Die Alternative wäre gewesen, die Prüfung im Gerät weicher
 * zu machen; das hätte die eine Stelle entschärft, an der ein
 * stillschweigend gelaufener Ersatzzweig überhaupt auffällt.
 *
 * Der Wert kommt aus dem Server (die soeben geschriebene Fassung), nie aus
 * einer Eingabe.
 */
export function kontoFassungNachziehen(userId: string, fassung: number): void {
  const zeile = db.get<{ konto_fassung: number }>(
    'SELECT konto_fassung FROM konto_notzugang WHERE user_id = ?', userId,
  );
  if (!zeile || zeile.konto_fassung === fassung) return;

  db.run(
    'UPDATE notiz_konto_pakete SET konto_fassung = ? WHERE user_id = ? AND konto_fassung = ?',
    fassung, userId, zeile.konto_fassung,
  );
  db.run(
    'UPDATE passwort_konto_pakete SET konto_fassung = ? WHERE user_id = ? AND konto_fassung = ?',
    fassung, userId, zeile.konto_fassung,
  );
  db.run(
    'UPDATE konto_notzugang SET konto_fassung = ?, geaendert_am = ? WHERE user_id = ? AND konto_fassung <> ?',
    fassung, jetzt(), userId, fassung,
  );
}

/* ── Einrichten und Aufheben ──────────────────────────────────── */

function vollstaendig(huelle: NotzugangHuelle | undefined | null): boolean {
  return Boolean(
    huelle && huelle.alg && huelle.iv && huelle.daten && huelle.kontoAbdruck
    && Number.isInteger(huelle.kontoFassung) && huelle.kontoFassung > 0
    && huelle.schwelle === NOTZUGANG_SCHWELLE && huelle.anteile === NOTZUGANG_ANTEILE,
  );
}

function paketVollstaendig(p: FluechtigesPaket | undefined | null): boolean {
  return Boolean(p && p.alg && p.eph && p.iv && p.daten);
}

/**
 * Einen Notzugang anlegen oder erneuern.
 *
 * Alles oder nichts, in einer Transaktion: eine Hülle ohne Anteile wäre ein
 * Schloss ohne Schlüssel, fünf Anteile ohne Hülle ein Schlüssel ohne Schloss.
 * Beides sähe in der Tafel aus wie „eingerichtet".
 *
 * Gerufen wird das auch nach jeder gelungenen Wiederherstellung: die
 * gebrauchten Anteile sind durch drei Hände gegangen und werden ersetzt
 * (lib/notzugang.ts, wiederherstellen()).
 */
export function einrichten(
  userId: string, huelle: NotzugangHuelle, anteile: NotzugangAnteilBlob[],
): void {
  if (!vollstaendig(huelle)) {
    throw abweisung('fehler.notzugangUngueltig', 'Der Notzugang ist unvollständig.');
  }

  /* Die Hülle muss zum HEUTE gültigen Kontoschlüssel gehören. Sonst legte
     jemand eine Hülle um einen Schlüssel von gestern — sie ginge auf und
     öffnete nichts mehr. */
  /* Direkt gelesen statt über services/kontoschluessel.ts: DIE Datei bindet
     ihrerseits diese hier ein (verwerfen()/hinterlegenInTransaktion() fragen
     `deckt()`), und zwei Module, die sich gegenseitig einbinden, laden je
     nach Reihenfolge halbfertig. Der Lesezugriff auf eine einzige Spalte ist
     der kleinere Preis. */
  const konto = db.get<{ abdruck: string; daten: string; fassung: number }>(
    'SELECT abdruck, daten, fassung FROM konto_schluessel WHERE user_id = ?', userId,
  );
  if (!konto || !konto.daten || konto.abdruck !== huelle.kontoAbdruck || konto.fassung !== huelle.kontoFassung) {
    throw abweisung('fehler.notzugangUngueltig', 'Der Notzugang gehört nicht zum aktuellen Kontoschlüssel.');
  }

  if (anteile.length !== NOTZUGANG_ANTEILE) {
    throw abweisung('fehler.notzugangUngueltig', 'Es müssen genau fünf Anteile sein.');
  }
  const stellen = new Set(anteile.map((a) => a.stelle));
  const halterIds = [...new Set(anteile.map((a) => a.halterId))];
  if (stellen.size !== NOTZUGANG_ANTEILE || [...stellen].some((s) => !Number.isInteger(s) || s < 1 || s > NOTZUGANG_ANTEILE)) {
    throw abweisung('fehler.notzugangUngueltig', 'Die Anteile tragen keine sauberen Stellen.');
  }
  if (halterIds.length !== NOTZUGANG_ANTEILE) {
    throw abweisung('fehler.notzugangUngueltig', 'Eine Person kann nur einen Anteil halten.');
  }
  if (halterIds.includes(userId)) {
    throw abweisung('fehler.notzugangUngueltig', 'Ein eigener Anteil senkt die Schwelle.');
  }
  if (anteile.some((a) => !paketVollstaendig(a.paket) || !a.halterAbdruck)) {
    throw abweisung('fehler.notzugangUngueltig', 'Der Notzugang ist unvollständig.');
  }

  const leute = db.all<{ id: string; role: string; abdruck: string | null }>(
    `SELECT u.id, u.role, s.abdruck FROM users u
     LEFT JOIN vertraulich_schluessel s ON s.user_id = u.id
     WHERE u.id IN (${placeholders(halterIds.length)}) AND ${AKTIV}`,
    ...halterIds,
  );
  if (leute.length !== NOTZUGANG_ANTEILE) {
    throw abweisung('fehler.notzugangUngueltig', 'Nicht jede gewählte Person ist ein aktives Konto.');
  }
  const nachId = new Map(leute.map((l) => [l.id, l]));

  /* Der Abdruck, den das Gerät MITSCHICKT, muss der sein, den der Server
     kennt. Damit hängt später `schluesselPasst` an einer Tatsache und nicht
     an einer Behauptung — und ein Anteil, der für einen falschen
     öffentlichen Teil verpackt wurde, fällt hier auf statt beim Einlösen. */
  for (const a of anteile) {
    const person = nachId.get(a.halterId)!;
    if (!person.abdruck || person.abdruck !== a.halterAbdruck) {
      throw abweisung('fehler.notzugangUngueltig', 'Für eine gewählte Person passt der hinterlegte Schlüssel nicht.');
    }
  }

  /* Höchstens `schwelle - 1` aus dem Kreis, der ohnehin Passwörter
     zurücksetzen kann — siehe Zählung 2 im Dateikopf. */
  const ausDerVerwaltung = leute.filter((l) => l.role === 'owner' || l.role === 'admin').length;
  if (ausDerVerwaltung >= huelle.schwelle) {
    throw abweisung(
      'fehler.notzugangZuVieleVerwaltungen',
      'Die Verwaltung darf die Schwelle nicht allein erreichen.',
    );
  }

  const zeit = jetzt();
  db.transaction(() => {
    db.run(
      `INSERT INTO konto_notzugang (user_id, alg, iv, daten, konto_abdruck, konto_fassung, schwelle, anteile, erstellt_am, geaendert_am)
       VALUES (?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         alg = excluded.alg, iv = excluded.iv, daten = excluded.daten,
         konto_abdruck = excluded.konto_abdruck, konto_fassung = excluded.konto_fassung,
         schwelle = excluded.schwelle, anteile = excluded.anteile,
         geaendert_am = excluded.geaendert_am`,
      userId, huelle.alg, huelle.iv, huelle.daten, huelle.kontoAbdruck, huelle.kontoFassung,
      huelle.schwelle, huelle.anteile, zeit, zeit,
    );
    /* Erst weg, dann neu: eine Erneuerung mit anderen Personen ließe sonst
       die Anteile der alten liegen — und die gehören zu einem Notschlüssel,
       den es nicht mehr gibt. */
    db.run('DELETE FROM notzugang_anteile WHERE user_id = ?', userId);
    for (const a of anteile) {
      db.run(
        `INSERT INTO notzugang_anteile (user_id, halter_id, stelle, alg, eph, iv, daten, halter_abdruck, erstellt_am)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        userId, a.halterId, a.stelle, a.paket.alg, a.paket.eph, a.paket.iv, a.paket.daten,
        a.halterAbdruck, zeit,
      );
    }
    /* Offene Anfragen fallen mit: sie zielen auf den alten Notschlüssel, und
       ein Beitrag dazu wäre nach der Erneuerung wertlos — aber er sähe in der
       Zählung aus wie einer. Die Beiträge selbst zuerst, VOR dem Abbrechen:
       stünde die Zeile schon auf 'abgebrochen', träfe das folgende DELETE sie
       nicht mehr. Sonst blieben sie stehen — Chiffrat von Anteilen eines
       Notschlüssels, den es gleich nicht mehr gibt, in einer Datenbank, die
       das Bedrohungsmodell als gestohlen annimmt (dieselbe Begründung wie in
       abbrechen() und kontoBereinigen() unten). */
    db.run(
      `DELETE FROM notzugang_beitraege WHERE anfrage_id IN (
         SELECT id FROM notzugang_anfragen WHERE user_id = ? AND stand = 'offen')`,
      userId,
    );
    db.run("UPDATE notzugang_anfragen SET stand = 'abgebrochen' WHERE user_id = ? AND stand = 'offen'", userId);
    protokollieren(userId, 'eingerichtet', null, null);
  });
}

/**
 * Den Notzugang aufheben — die Rettungsleine kappen.
 *
 * Öffnet nichts und gibt nichts heraus. Danach brennt ein Zurücksetzen des
 * Passworts wieder alles nieder (services/kontoschluessel.ts, verwerfen()),
 * und genau das ist der Zweck: es ist der Griff für ein DURCHGESICKERTES
 * Passwort, nicht für ein vergessenes.
 *
 * WARUM HIER SELBST NIEDERGEBRANNT WIRD, UND NICHT ERST BEIM NÄCHSTEN
 * ZURÜCKSETZEN
 *
 * Das Versprechen „erst aufheben, dann zurücksetzen, dann brennt wieder
 * alles" (Dateikopf, http/routes.ts, und die Warnung, die der Verwaltung in
 * der Kontenliste angezeigt wird) hielt nur in EINER Reihenfolge. Die andere
 * ist die, die ein Mensch bei einem durchgesickerten Passwort naheliegend
 * wählt — erst den Zugang sperren, dann in Ruhe aufräumen:
 *
 *   1. Die Verwaltung setzt das Passwort zurück. Der schonende Zweig läuft,
 *      weil ein Notzugang steht: `abdruck` und `fassung` bleiben, jedes
 *      Notiz- und Tresorpaket bleibt, nur die Passworthülle stirbt.
 *   2. Die Verwaltung liest die Warnung und hebt den Notzugang auf.
 *   3. Hier stand bisher nichts über den Kontoschlüssel. Also blieben die
 *      Pakete liegen — verpackt unter einem Kontoschlüssel, den das
 *      DURCHGESICKERTE Passwort zusammen mit einer Sicherung von vor
 *      Schritt 1 wieder herleitet. Ein zweites Zurücksetzen half nicht
 *      mehr: `verwerfen()` fände zwar jetzt den harten Zweig, aber niemand
 *      setzt ein Passwort zweimal zurück, das gerade erst zurückgesetzt
 *      wurde.
 *
 * Die Pakete waren in dieser Reihenfolge ohnehin verloren — ein
 * zurückkehrender Kontoschlüssel liefe ohne Notzugang durch den Ersatzzweig
 * von hinterlegenInTransaktion() und nähme sie mit. Sie liegen zu lassen
 * heißt also nicht, etwas zu retten, sondern nur, ein Chiffrat länger
 * liegen zu lassen, als es irgendjemandem nützt.
 *
 * WORAN DIE ENTSCHEIDUNG HÄNGT: `konto_schluessel.daten`.
 *
 *   leer  ->  es gibt keine Passworthülle mehr. Entweder hat ein schonendes
 *             Verwerfen sie geleert (Fall oben), oder das Konto hatte nie
 *             einen Kontoschlüssel. Niederbrennen.
 *   voll  ->  das Konto ist heil und die Person kommt mit ihrem Passwort an
 *             alles. Der Notzugang war nur die ZWEITE Hülle; ihn zu kappen
 *             nimmt eine Rettungsleine und sonst nichts. Hier zu brennen
 *             zerstörte ein gesundes Konto — das ist der gewöhnliche Fall,
 *             und er darf nichts anfassen.
 *   keine Zeile -> nichts da, nichts zu tun.
 *
 * UND WARUM DAS KEINE LAUFENDE WIEDERHERSTELLUNG ZERREISST: gelesen wird
 * INNERHALB derselben Transaktion, in der die Zeile des Notzugangs stirbt.
 * SQLite reiht die Schreiber; entweder hat hinterlegenInTransaktion() den
 * zurückgeholten Schlüssel vorher abgelegt — dann steht `daten` voll da und
 * hier brennt nichts —, oder es kommt danach und findet den Notzugang schon
 * weg, läuft also in den Ersatzzweig, den es ohne Notzugang immer gab. Eine
 * Zwischenlage, in der das eine das andere halb sieht, gibt es nicht.
 *
 * Eine offene Anfrage ist ausdrücklich KEIN Hinderungsgrund. Wäre sie einer,
 * hielte jede offene Anfrage das Niederbrennen auf — und ein durchgesickertes
 * Passwort kann jederzeit eine offene Anfrage erzeugen.
 *
 * Zurück kommt, OB dabei niedergebrannt wurde. http/routes.ts macht daraus
 * die Meldung an die betroffene Person: „deine Rettungsleine ist weg" und
 * „Notizen und Tresor sind weg" sind zwei verschiedene Nachrichten, und die
 * zweite darf niemand aus der ersten erraten müssen.
 *
 * OHNE STEHENDE ZEILE WIRD NICHTS GETAN — geworfen wird stattdessen
 * `fehler.notzugangNichtVorhanden`. Vorher lief die Funktion für JEDES
 * Konto glatt durch, auch für eines ohne Notzugang: das erste Aufheben
 * brennt dann schon nieder (kein Notzugang bedeutet keine Sicherung mehr,
 * `konto_schluessel.daten` mag trotzdem leer sein), und ein zweiter Aufruf
 * — ein Skript, ein Klick auf einen zwischenzeitlich neu geladenen Knopf,
 * eine zweite Verwaltung — fand beim nächsten Mal wieder nichts vor, brannte
 * aber TROTZDEM ein zweites Mal, zählte `fassung` ein zweites Mal hoch und
 * schrieb eine zweite Spur aus `aufgehoben` und `verworfen` für einen
 * Notzugang, den es zu diesem Zeitpunkt gar nicht mehr gab — und die Person
 * bekam ein zweites Mal die Nachricht „Notizen und Tresor sind endgültig
 * verloren", obwohl beim zweiten Mal nichts mehr zu verlieren war. Die Spur
 * log damit eine Zerstörung, die nicht stattfand.
 */
export function aufheben(userId: string, durch: string): boolean {
  let verbrannt = false;
  db.transaction(() => {
    const bestand = db.get<{ user_id: string }>(
      'SELECT user_id FROM konto_notzugang WHERE user_id = ?', userId,
    );
    if (!bestand) {
      throw abweisung('fehler.notzugangNichtVorhanden', 'Für dieses Konto gibt es keinen Notzugang.');
    }

    /* Vor dem Löschen der Anfragen, aus demselben Grund wie in einrichten()
       oben: Chiffrat von Anteilen eines Notschlüssels, den es gleich nicht
       mehr gibt, hat in einer gestohlen gedachten Datenbank nichts
       verloren — auch wenn der Wickel, den es öffnen würde, in derselben
       Transaktion mit verschwindet. */
    db.run(
      `DELETE FROM notzugang_beitraege WHERE anfrage_id IN (
         SELECT id FROM notzugang_anfragen WHERE user_id = ? AND stand = 'offen')`,
      userId,
    );
    db.run('DELETE FROM notzugang_anteile WHERE user_id = ?', userId);
    db.run('DELETE FROM konto_notzugang WHERE user_id = ?', userId);
    db.run("UPDATE notzugang_anfragen SET stand = 'abgebrochen' WHERE user_id = ? AND stand = 'offen'", userId);
    protokollieren(userId, 'aufgehoben', null, durch === userId ? null : durch);

    /* Erst nachdem der Notzugang weg ist: `hartVerwerfen()` leert `abdruck`,
       und solange die Zeile des Notzugangs noch stünde, sähe der nächste
       Leser ein Konto mit gedecktem Abdruck ohne eigenen — den Zustand, für
       den der zweite Zweig von `derselbe` gebaut ist. Ein halber Schritt
       davon soll nie sichtbar werden; er ist es auch nicht, denn beides
       steht in einer Transaktion. */
    const alt = db.get<{ daten: string }>(
      'SELECT daten FROM konto_schluessel WHERE user_id = ?', userId,
    );
    if (alt && !alt.daten) {
      hartVerwerfen(userId);
      protokollieren(userId, 'verworfen', null, durch === userId ? null : durch);
      verbrannt = true;
    }
  });
  return verbrannt;
}

/** Alles, was zu einem Konto gehört, wenn es gelöscht wird. Ohne eigene
 *  Transaktion — der Aufrufer (services/users.ts) hat schon eine offen. */
export function kontoBereinigen(userId: string): void {
  db.run('DELETE FROM notzugang_anteile WHERE user_id = ?', userId);
  db.run('DELETE FROM konto_notzugang WHERE user_id = ?', userId);
  /* Erst die Beiträge, dann die Anfragen — und beides von Hand.
     `notzugang_beitraege.anfrage_id` trägt zwar ON DELETE CASCADE, und die
     Kaskade ist hier tatsächlich lebendig (nachgemessen: `PRAGMA
     foreign_keys` steht nach dem Anwenden von schema.sql auf 1, und eine
     gelöschte Anfrage nimmt ihre Beiträge mit — anders als die 23 Kaskaden
     an `users(id)`, die nie feuern, weil deleteAccount() die Zeile in
     `users` nur ändert). Trotzdem steht die Zeile hier: die Einstellung
     gilt je VERBINDUNG, nicht je Datenbank, migrate.ts schaltet sie für den
     Neubau der users-Tabelle zwischendurch ab, und was hier liegen bliebe,
     wäre kein Karteirest, sondern Chiffrat eines Anteils an einem fremden
     Kontoschlüssel. Eine Zeile ist billiger als diese Wette. */
  db.run(
    'DELETE FROM notzugang_beitraege WHERE anfrage_id IN (SELECT id FROM notzugang_anfragen WHERE user_id = ?)',
    userId,
  );
  db.run('DELETE FROM notzugang_anfragen WHERE user_id = ?', userId);
  /* Die Anteile, die diese Person für ANDERE hielt, bleiben stehen. Sie sind
     Chiffrat für ein Schlüsselpaar, das mit dem Konto gerade gelöscht wurde
     (services/users.ts löscht vertraulich_schluessel), also für niemanden
     mehr zu öffnen — und die Zeile ist das Einzige, woran die besitzende
     Person sieht, WER ihr abhanden gekommen ist. Sie zählt in `brauchbar`
     nicht mehr mit: standFuer() verlangt ein aktives Konto. */
}

/* ── Wiederherstellung ────────────────────────────────────────── */

/* Die drei Formen der Anzeige stehen in shared/vertraulich.ts, damit App und
   Server sie nicht zweimal beschreiben. */
type AnfrageZeile = NotzugangAnfrage;

function anfrageLesen(id: string): AnfrageZeile | null {
  const r = db.get<{
    id: string; user_id: string; stand: string; laeuft_ab: number; erstellt_am: number;
  }>('SELECT id, user_id, stand, laeuft_ab, erstellt_am FROM notzugang_anfragen WHERE id = ?', id);
  if (!r) return null;
  const n = db.get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM notzugang_beitraege WHERE anfrage_id = ?', id,
  )!.n;
  return {
    id: r.id, userId: r.user_id, stand: r.stand,
    laeuftAb: r.laeuft_ab, erstelltAm: r.erstellt_am, beitraege: n,
  };
}

/** Offen heißt: nicht abgebrochen, nicht eingelöst und noch nicht abgelaufen. */
function offen(a: AnfrageZeile): boolean {
  return a.stand === 'offen' && a.laeuftAb > jetzt();
}

/**
 * Eine Wiederherstellung anstoßen.
 *
 * `codeAbdruck` ist SHA-256 über einen Code, den das Gerät der anfragenden
 * Person gewürfelt hat. Der Code selbst kommt hier nie an — er wird mündlich
 * weitergegeben und verschließt später jeden Beitrag ein zweites Mal.
 *
 * Höchstens eine offene Anfrage je Konto: zwei parallele wären zwei
 * getrennte Sammlungen von Anteilen, und niemand hätte den Überblick, wie
 * viele Anteile gerade unterwegs sind.
 */
export function anfragen(userId: string, codeAbdruck: string): AnfrageZeile {
  if (!codeAbdruck) throw abweisung('fehler.notzugangUngueltig', 'Der Code fehlt.');
  const stand = standFuer(userId);
  if (!stand.eingerichtet) {
    throw abweisung('fehler.notzugangFehlt', 'Für dieses Konto gibt es keinen Notzugang.');
  }
  if (stand.brauchbar < stand.schwelle) {
    throw abweisung('fehler.notzugangKaputt', 'Es sind nicht mehr genug brauchbare Anteile übrig.');
  }

  const laufende = db.all<{ id: string }>(
    "SELECT id FROM notzugang_anfragen WHERE user_id = ? AND stand = 'offen' AND laeuft_ab > ?",
    userId, jetzt(),
  );
  if (laufende.length) {
    throw abweisung('fehler.notzugangSchonOffen', 'Es läuft bereits eine Wiederherstellung.');
  }

  const id = newId('nza');
  const zeit = jetzt();
  db.transaction(() => {
    /* Abgelaufene aufräumen, damit die Liste der haltenden Personen nicht mit
       Karteileichen zuwächst. */
    db.run(
      "UPDATE notzugang_anfragen SET stand = 'abgelaufen' WHERE stand = 'offen' AND laeuft_ab <= ?",
      zeit,
    );
    db.run(
      `INSERT INTO notzugang_anfragen (id, user_id, code_abdruck, stand, laeuft_ab, erstellt_am, eingeloest_am)
       VALUES (?,?,?,'offen',?,?,NULL)`,
      id, userId, codeAbdruck, zeit + NOTZUGANG_ANFRAGE_STUNDEN * 3600_000, zeit,
    );
    protokollieren(userId, 'angefragt', id, null);
  });
  return anfrageLesen(id)!;
}

/** Eine laufende Anfrage abbrechen — nur die anfragende Person selbst. */
export function abbrechen(userId: string, anfrageId: string): void {
  const a = anfrageLesen(anfrageId);
  if (!a || a.userId !== userId) throw abweisung('fehler.notzugangAnfrageFehlt', 'Diese Anfrage gibt es nicht.');
  db.transaction(() => {
    db.run("UPDATE notzugang_anfragen SET stand = 'abgebrochen' WHERE id = ?", anfrageId);
    db.run('DELETE FROM notzugang_beitraege WHERE anfrage_id = ?', anfrageId);
    protokollieren(userId, 'abgebrochen', anfrageId, null);
  });
}

/** Die eigene, laufende Anfrage — oder nichts. */
export function eigeneAnfrage(userId: string): AnfrageZeile | null {
  const r = db.get<{ id: string }>(
    "SELECT id FROM notzugang_anfragen WHERE user_id = ? AND stand = 'offen' AND laeuft_ab > ? ORDER BY erstellt_am DESC",
    userId, jetzt(),
  );
  return r ? anfrageLesen(r.id) : null;
}

type AufgabeFuerHalter = NotzugangAufgabe;

/**
 * Was auf eine haltende Person wartet.
 *
 * Der verschlossene Anteil kommt gleich mit: er ist für genau diesen
 * privaten Schlüssel verpackt, und ein zweiter Weg, ihn zu holen, wäre eine
 * zweite Stelle, an der man die Berechtigung prüfen müsste.
 */
export function aufgabenFuer(halterId: string): AufgabeFuerHalter[] {
  return db.all<{
    anfrage_id: string; user_id: string; stelle: number; erstellt_am: number;
    laeuft_ab: number; erledigt: number; alg: string; eph: string; iv: string; daten: string;
  }>(
    `SELECT a.id AS anfrage_id, a.user_id, t.stelle, a.erstellt_am, a.laeuft_ab,
            t.alg, t.eph, t.iv, t.daten,
            (SELECT COUNT(*) FROM notzugang_beitraege b
              WHERE b.anfrage_id = a.id AND b.halter_id = t.halter_id) AS erledigt
     FROM notzugang_anfragen a
     JOIN notzugang_anteile t ON t.user_id = a.user_id AND t.halter_id = ?
     WHERE a.stand = 'offen' AND a.laeuft_ab > ?
     ORDER BY a.erstellt_am DESC`,
    halterId, jetzt(),
  ).map((r) => ({
    anfrageId: r.anfrage_id,
    userId: r.user_id,
    stelle: r.stelle,
    erstelltAm: r.erstellt_am,
    laeuftAb: r.laeuft_ab,
    erledigt: r.erledigt > 0,
    anteil: { alg: r.alg, eph: r.eph, iv: r.iv, daten: r.daten },
  }));
}

/**
 * Einen Anteil beisteuern.
 *
 * Der Beitrag ist doppelt verschlossen und kommt fertig aus der App der
 * haltenden Person: innen für die anfragende Person (flüchtiges ECDH), außen
 * mit dem Code. Der Server prüft, ob der Abdruck des Codes zu dieser Anfrage
 * gehört — mehr kann er nicht, und mehr soll er nicht.
 *
 * WARUM DER CODEABDRUCK ÜBERHAUPT GEPRÜFT WIRD, obwohl er kryptografisch
 * nichts durchsetzt: ohne die Prüfung könnte eine haltende Person mit einem
 * falsch verstandenen Code beisteuern, die Zählung stünde auf drei, und erst
 * beim Einlösen fiele auf, dass nichts aufgeht. Ein Fehler, der beim
 * Eintippen auffällt, ist besser als einer, der eine halbe Stunde später
 * auffällt.
 */
export function beitragen(
  halterId: string, anfrageId: string, paket: FluechtigesPaket, codeAbdruck: string,
): void {
  const a = anfrageLesen(anfrageId);
  if (!a || !offen(a)) throw abweisung('fehler.notzugangAnfrageFehlt', 'Diese Anfrage gibt es nicht.');
  if (!paketVollstaendig(paket)) throw abweisung('fehler.notzugangUngueltig', 'Der Notzugang ist unvollständig.');

  const codeStimmt = db.get(
    'SELECT 1 AS x FROM notzugang_anfragen WHERE id = ? AND code_abdruck = ?', anfrageId, codeAbdruck,
  );
  if (!codeStimmt) throw abweisung('fehler.codePasstNicht', 'Der Code passt nicht.');

  const anteil = db.get<{ stelle: number }>(
    'SELECT stelle FROM notzugang_anteile WHERE user_id = ? AND halter_id = ?', a.userId, halterId,
  );
  if (!anteil) throw abweisung('fehler.notzugangKeinAnteil', 'Für dieses Konto hältst du keinen Anteil.');

  db.transaction(() => {
    db.run(
      `INSERT INTO notzugang_beitraege (anfrage_id, halter_id, stelle, alg, eph, iv, daten, erstellt_am)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(anfrage_id, halter_id) DO UPDATE SET
         stelle = excluded.stelle, alg = excluded.alg, eph = excluded.eph,
         iv = excluded.iv, daten = excluded.daten, erstellt_am = excluded.erstellt_am`,
      anfrageId, halterId, anteil.stelle, paket.alg, paket.eph, paket.iv, paket.daten, jetzt(),
    );
    protokollieren(a.userId, 'beigetragen', anfrageId, halterId);
  });
}

export interface BeitragZeile {
  halterId: string;
  stelle: number;
  paket: FluechtigesPaket;
}

/**
 * Die Herausgabe der Beiträge festhalten — an der Stelle, an der sie
 * WIRKLICH geschieht.
 *
 * DER FEHLER, DEN DAS BEHEBT: die Spur und die Meldungen hingen bisher
 * ausschließlich an `einloesen()`, und das ruft der CLIENT, nachdem er den
 * Kontoschlüssel schon in der Hand hat (lib/notzugang.ts: erst
 * wiederherstellen, dann melden). Ein Client, der die Zeile danach einfach
 * wegließe — oder stattdessen `abbrechen` riefe —, käme an den Schlüssel,
 * ohne dass die besitzende Person oder eine einzige beitragende Person je
 * davon erführe. Eine Spur, die der Beobachtete abschalten kann, ist keine.
 *
 * Der Server gibt die Beiträge heraus; also hält er das auch fest. Ab dem
 * Augenblick, in dem `schwelle` Beiträge über die Leitung gehen, ist der
 * Notschlüssel für die anfragende Person rechnerisch erreichbar — das ist
 * der Vorgang, über den zu berichten ist, nicht die spätere Höflichkeit des
 * Clients.
 *
 * Gibt die Personen zurück, die zu benachrichtigen sind, und zwar GENAU
 * EINMAL JE PERSON UND ANFRAGE: wer schon eine eigene Spurzeile hat, kommt
 * nicht wieder vor. Sonst löste ein Client, der die Liste alle paar Sekunden
 * neu zöge, eine Meldungslawine aus.
 *
 * JE PERSON, NICHT JE ANFRAGE — der Unterschied ist der Fehler, den das
 * behebt. Hier stand eine Sperre auf die ANFRAGE: existierte irgendeine
 * `herausgegeben`-Zeile, kam nichts mehr zurück. Die vierte und die fünfte
 * haltende Person steuern aber regelmäßig noch bei, nachdem die Schwelle
 * schon überschritten ist — sie sind ja gleichzeitig angeschrieben worden
 * und wissen nicht, wer schneller war. `beitraegeHolen()` gibt ihre Anteile
 * anstandslos mit heraus (es gibt ALLE Zeilen zurück), aber niemand erfuhr
 * davon: keine Meldung an die beiden, keine Zeile mit ihrem Namen, und in
 * der Tafel der besitzenden Person standen drei Namen, während fünf Anteile
 * unterwegs waren. Ein Anteil, der über die Leitung geht, ohne dass die
 * haltende Person es je erfährt, ist genau das, was diese Funktion
 * verhindern soll.
 */
export function herausgabeVermerken(userId: string, anfrageId: string): string[] {
  const a = anfrageLesen(anfrageId);
  if (!a || a.userId !== userId || !offen(a)) return [];

  const schwelle = db.get<{ schwelle: number }>(
    'SELECT schwelle FROM konto_notzugang WHERE user_id = ?', userId,
  )?.schwelle ?? NOTZUGANG_SCHWELLE;

  const beteiligte = db.all<{ halter_id: string }>(
    'SELECT halter_id FROM notzugang_beitraege WHERE anfrage_id = ?', anfrageId,
  ).map((r) => r.halter_id);
  /* Unter der Schwelle geht nichts hinaus, was rechnerisch etwas ergäbe —
     also ist auch nichts zu melden. */
  if (beteiligte.length < schwelle) return [];

  /* Schon vermerkt? Die eigene Spur ist der Merker — eine zusätzliche Spalte
     in `notzugang_anfragen` hielte dieselbe Auskunft ein zweites Mal, und
     zwei Stellen für eine Tatsache laufen irgendwann auseinander. Gefragt
     wird jetzt nach der Zeile MIT NAMEN statt nach irgendeiner. */
  const schonGemeldet = new Set(db.all<{ halter_id: string | null }>(
    "SELECT halter_id FROM notzugang_protokoll WHERE anfrage_id = ? AND art = 'herausgegeben'",
    anfrageId,
  ).map((r) => r.halter_id));

  const neu = beteiligte.filter((h) => !schonGemeldet.has(h));
  if (!neu.length) return [];

  db.transaction(() => {
    for (const h of neu) protokollieren(userId, 'herausgegeben', anfrageId, h);
  });
  return neu;
}

/** Die gesammelten Beiträge — ausschließlich für die anfragende Person. */
export function beitraegeHolen(userId: string, anfrageId: string): BeitragZeile[] {
  const a = anfrageLesen(anfrageId);
  if (!a || a.userId !== userId || !offen(a)) {
    throw abweisung('fehler.notzugangAnfrageFehlt', 'Diese Anfrage gibt es nicht.');
  }
  return db.all<{
    halter_id: string; stelle: number; alg: string; eph: string; iv: string; daten: string;
  }>(
    'SELECT halter_id, stelle, alg, eph, iv, daten FROM notzugang_beitraege WHERE anfrage_id = ?',
    anfrageId,
  ).map((r) => ({
    halterId: r.halter_id,
    stelle: r.stelle,
    paket: { alg: r.alg, eph: r.eph, iv: r.iv, daten: r.daten },
  }));
}

/**
 * Die Anfrage schließen, nachdem das Gerät den Kontoschlüssel wiederhat.
 *
 * Hier entsteht die Spur, die diesen ganzen Weg erträglich macht: eine Zeile
 * je beitragender Person mit Namen und Uhrzeit, dazu eine für das Einlösen
 * selbst. Sie steht in der eigenen Tafel der besitzenden Person, und sie
 * lässt sich nicht abschalten.
 *
 * Die Beiträge werden dabei gelöscht. Sie sind verbraucht — ein zweites Mal
 * einzulösen wäre eine zweite Wiederherstellung ohne zweites Nachfragen.
 */
export function einloesen(userId: string, anfrageId: string): string[] {
  const a = anfrageLesen(anfrageId);
  if (!a || a.userId !== userId || !offen(a)) {
    throw abweisung('fehler.notzugangAnfrageFehlt', 'Diese Anfrage gibt es nicht.');
  }
  const beteiligte = db.all<{ halter_id: string }>(
    'SELECT halter_id FROM notzugang_beitraege WHERE anfrage_id = ?', anfrageId,
  ).map((r) => r.halter_id);

  /* Unter der Schwelle wird nichts geschlossen. Bisher stand hier keine
     Zählung, und damit ließ sich eine Anfrage mit NULL Beiträgen „einlösen":
     der Stand sprang auf `eingeloest`, die Schleife unten lief null Mal, und
     in der Spur stand am Ende gar nichts — eine Wiederherstellung, die
     stattgefunden hat oder auch nicht, ohne eine einzige Zeile darüber. Die
     Schwelle kommt aus der Zeile des Notzugangs und nicht aus der Konstante:
     wer sie später ändert, ändert sie hier mit. */
  const schwelle = db.get<{ schwelle: number }>(
    'SELECT schwelle FROM konto_notzugang WHERE user_id = ?', userId,
  )?.schwelle ?? NOTZUGANG_SCHWELLE;
  if (beteiligte.length < schwelle) {
    throw abweisung('fehler.notzugangZuWenigAnteile', 'Es sind noch nicht genug Anteile beigesteuert.');
  }

  db.transaction(() => {
    db.run(
      "UPDATE notzugang_anfragen SET stand = 'eingeloest', eingeloest_am = ? WHERE id = ?",
      jetzt(), anfrageId,
    );
    db.run('DELETE FROM notzugang_beitraege WHERE anfrage_id = ?', anfrageId);
    for (const h of beteiligte) protokollieren(userId, 'eingeloest', anfrageId, h);
  });
  return beteiligte;
}

type ProtokollZeile = NotzugangProtokollZeile;

/** Die Spur eines Kontos, jüngste zuerst. */
export function protokollFuer(userId: string, grenze = 100): ProtokollZeile[] {
  return db.all<{
    id: string; art: string; halter_id: string | null; anfrage_id: string | null; am: number;
  }>(
    'SELECT id, art, halter_id, anfrage_id, am FROM notzugang_protokoll WHERE user_id = ? ORDER BY am DESC LIMIT ?',
    userId, grenze,
  ).map((r) => ({
    id: r.id, art: r.art, halterId: r.halter_id, anfrageId: r.anfrage_id, am: r.am,
  }));
}

/** Von services/kontoschluessel.ts gerufen, wenn ein Zurücksetzen den
 *  Kontoschlüssel wegen eines Notzugangs SCHONT — damit auch das in der Spur
 *  steht und nicht nur in den Folgen. */
export function geschontVermerken(userId: string): void {
  protokollieren(userId, 'geschont', null, null);
}
