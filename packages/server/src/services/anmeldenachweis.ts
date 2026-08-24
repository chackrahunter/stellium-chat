import crypto from 'node:crypto';
import { ANMELDE_KDF, ANMELDE_RUNDEN, type AnmeldeNachweisBlob, type AnmeldeSalz } from '@stellium/shared';
import { hashPassword } from '../auth.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { abweisung } from '../util/abweisung.js';

/**
 * Der Anmeldenachweis — die Anmeldung ohne Passwort.
 *
 * WAS HIER PASSIERT UND WAS AUSDRÜCKLICH NICHT
 *
 * Diese Datei rechnet KEINE Ableitung aus einem Passwort. Sie nimmt eine
 * fertige Zeichenkette entgegen, die ein Gerät aus dem Passwort abgeleitet
 * hat, hasht sie mit genau demselben scrypt wie users.password_hash
 * (hashPassword aus auth.ts, unverändert) und legt sie ab. Für den Server
 * ist der Nachweis ein undurchsichtiger Wert, mit dem er nichts tun kann
 * als vergleichen — er kann daraus weder das Passwort noch den
 * Kontoschlüssel-KEK herstellen.
 *
 * WARUM DAS DER PUNKT IST
 *
 * services/kontoschluessel.ts verwahrt den Kontoschlüssel in einer Hülle,
 * die aus dem PASSWORT abgeleitet ist. Solange `POST /api/auth/login` das
 * Passwort im Klartext bekam, war diese Hülle gegen den Server selbst
 * wertlos: er hätte in genau dem Augenblick mitschreiben und dieselbe
 * Ableitung rechnen können. Mit dem Nachweis geht das Passwort nicht mehr
 * über die Leitung, und die Hülle hält, was der Dateikopf dort verspricht.
 *
 * DIE EINE ENTSCHEIDUNG, AUF DER ALLES RUHT: users.password_hash BLEIBT
 *
 * Der alte Weg wird NICHT abgelöst. `users.password_hash` steht unverändert
 * daneben und trägt weiterhin jede Anmeldung, die ein Passwort schickt.
 * Der Grund ist nicht Bequemlichkeit, sondern der Server, um den es geht:
 * er steht auf einem Rechner, an den niemand herankommt. Ein Umbau, nach
 * dem eine alte App, ein Browser mit gemerktem Bündel oder eine Person, die
 * nicht aktualisiert hat, nicht mehr hereinkommt, wäre dort nicht
 * zurückzunehmen. Deshalb ist hier alles ZUSÄTZLICH: eine fehlende Zeile in
 * `anmelde_nachweise` heißt "noch nicht umgestellt" und nie "ausgesperrt".
 *
 * WAS DIE AUSKUNFT VOR DER ANMELDUNG VERRÄT: NICHTS
 *
 * `salzFuer()` antwortet auf JEDEN eingetippten Namen mit derselben Art von
 * Wegbeschreibung. Gibt es kein Konto — oder gibt es eines, das noch keinen
 * Nachweis hinterlegt hat —, kommt ein Salz, das aus einem Servergeheimnis
 * und dem Namen abgeleitet ist: für denselben Namen immer dasselbe, von
 * außen von echtem Zufall nicht zu unterscheiden, und ohne das Geheimnis
 * nicht vorherzusagen. Dieselbe Überlegung wie bei nachDerselbenZeit() in
 * auth.ts, nur gegen die Auskunft statt gegen die Uhr.
 */

/* Fest und öffentlich wie AUSGLEICH_SALZ in auth.ts: der Text schützt
   nichts, er trennt nur diese Ableitung von jeder anderen aus demselben
   Servergeheimnis. */
const ERSATZSALZ_VORSPANN = 'stellium/anmeldung/ersatzsalz/v1';

/**
 * Ein Salz für einen Namen, zu dem es keines gibt.
 *
 * HMAC über das Servergeheimnis: deterministisch (derselbe Name bekommt bei
 * jeder Anfrage dasselbe Salz — ein wechselndes wäre selbst die Auskunft
 * "dieses Konto gibt es nicht"), unvorhersagbar (ohne das Geheimnis nicht
 * zu rechnen) und von 16 zufälligen Bytes nicht zu unterscheiden.
 *
 * `config.jwtSecret` liegt in data/.jwt-secret und überlebt einen Neustart —
 * ohne diese Beständigkeit wechselte das Ersatzsalz bei jedem Serverstart
 * und verriete damit genau das, was es verbergen soll.
 */
function ersatzSalz(login: string): string {
  return crypto.createHmac('sha256', config.jwtSecret)
    .update(`${ERSATZSALZ_VORSPANN}/${login.trim().toLowerCase()}`)
    .digest()
    .subarray(0, 16)           // dieselbe Länge wie die 16 Zufallsbytes eines Geräts
    .toString('base64url');
}

/**
 * Die Wegbeschreibung, mit der ein Gerät seinen Nachweis bildet.
 *
 * `userId` ist `null`, wenn es zu dem eingetippten Namen kein Konto gibt.
 * Die Antwort sieht in beiden Fällen gleich aus, und die drei Zustände
 * (Konto mit Nachweis / Konto ohne Nachweis / kein Konto) sind von außen
 * nicht zu unterscheiden.
 *
 * Beide Wege werden IMMER gegangen — die Abfrage und die HMAC-Rechnung —,
 * und erst danach wird gewählt. Ein `if` davor spräche in einem Fall mit
 * der Datenbank und im anderen nicht; das ist zwar eine Sache von
 * Mikrosekunden, aber die Sorte Unterschied, aus der in auth.ts schon
 * einmal ein messbarer wurde.
 */
export function salzFuer(userId: string | null, login: string): AnmeldeSalz {
  const zeile = db.get<{ salz: string }>(
    'SELECT salz FROM anmelde_nachweise WHERE user_id = ?', userId ?? '',
  );
  const ersatz = ersatzSalz(login);
  return {
    kdf: ANMELDE_KDF,
    salz: zeile?.salz || ersatz,
    /* Immer die Konstante, nie eine gespeicherte Zahl — sonst unterschiede
       sich ein Konto mit alter Rundenzahl von einem erfundenen, das immer
       die neue bekäme. Was das für eine spätere Erhöhung heißt, steht bei
       ANMELDE_RUNDEN in shared/vertraulich.ts: sie heilt sich über einen
       Anmeldevorgang je Person von selbst. */
    runden: ANMELDE_RUNDEN,
  };
}

/**
 * Der hinterlegte scrypt-Abdruck des Nachweises — oder `null`, wenn dieses
 * Konto noch keinen hat.
 *
 * `null` ist hier ausdrücklich kein Fehler, sondern der Normalfall am Tag
 * der Umstellung. Die Anmeldung antwortet darauf mit demselben 401 wie auf
 * einen falschen Nachweis (siehe http/routes.ts) — alles andere wäre die
 * Auskunft "dieses Konto gibt es, es hat nur noch keinen Nachweis".
 */
export function nachweisHash(userId: string): string | null {
  const zeile = db.get<{ nachweis: string }>(
    'SELECT nachweis FROM anmelde_nachweise WHERE user_id = ?', userId,
  );
  return zeile?.nachweis || null;
}

function vollstaendig(blob: AnmeldeNachweisBlob | undefined | null): boolean {
  return Boolean(
    blob && blob.kdf && blob.salz && blob.nachweis
    && Number.isInteger(blob.runden) && blob.runden > 0,
  );
}

/**
 * Hinterlegen — gerufen von einem Gerät, das sich gerade klassisch
 * angemeldet hat und deshalb das Passwort im Klartext hatte.
 *
 * Der eingehende `nachweis` wird gehasht und nicht roh abgelegt. Das ist
 * kein Zierat: läge er roh da, wäre eine gestohlene Datenbanksicherung
 * unmittelbar eine Sammlung gültiger Anmeldungen. So kostet sie dieselbe
 * scrypt-Arbeit wie `users.password_hash` daneben — und obendrein die
 * PBKDF2-Runden, die auf dem Gerät schon darin stecken.
 *
 * Ein zweites Hinterlegen überschreibt das erste. Auch das ist Absicht: es
 * ist der Weg, auf dem eine später erhöhte Rundenzahl oder ein
 * gewechseltes Salz nachwachsen, ohne dass jemand etwas tun müsste.
 */
export function hinterlegen(userId: string, blob: AnmeldeNachweisBlob): void {
  /* Bewusst die BESTEHENDE Kennung aus services/kontoschluessel.ts und keine
     eigene: eine neue müsste in allen 22 Wörterbüchern stehen, sonst schlägt
     scripts/e2e-fehlertexte.mjs zu Recht an — und die Wörterbücher liegen
     gerade in anderer Hand. Sie passt auch inhaltlich: hier wie dort kommt
     ein unvollständiger abgeleiteter Wert an. */
  if (!vollstaendig(blob)) throw abweisung('fehler.schluesselUnvollstaendig', 'Der Nachweis ist unvollständig.');
  const jetzt = Date.now();
  db.run(
    `INSERT INTO anmelde_nachweise (user_id, kdf, salz, runden, nachweis, erstellt_am, geaendert_am)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(user_id) DO UPDATE SET
       kdf = excluded.kdf, salz = excluded.salz, runden = excluded.runden,
       nachweis = excluded.nachweis, geaendert_am = excluded.geaendert_am`,
    userId, blob.kdf, blob.salz, blob.runden, hashPassword(blob.nachweis), jetzt, jetzt,
  );
}

/**
 * Den Nachweis wegräumen — überall dort, wo ein Passwort gesetzt wird.
 *
 * Der Nachweis ist aus dem BISHERIGEN Passwort abgeleitet; nach einem
 * Wechsel passt er nicht mehr. Ihn stehen zu lassen wäre keine Sperre,
 * sondern schlimmer: er bliebe ein gültiger zweiter Zugang zu einem Konto,
 * dessen Passwort gerade eben ausgetauscht wurde — genau der Fall, für den
 * man ein Passwort wechselt.
 *
 * Die Zeile wird ganz gelöscht und nicht geleert (anders als bei
 * verwerfen() in services/kontoschluessel.ts): dort hängt an der Zeile ein
 * weiterzählender Fassungszähler, hier hängt an ihr nichts. Eine fehlende
 * Zeile heißt "meldet sich vorerst wieder klassisch an" — der harmloseste
 * Zustand, den dieser Umbau kennt.
 *
 * Ohne eigene db.transaction(): läuft innerhalb der Transaktion des
 * Aufrufers (services/users.ts) — dieselbe Begründung wie bei
 * hinterlegenInTransaktion() in services/kontoschluessel.ts.
 */
export function verwerfen(userId: string): void {
  db.run('DELETE FROM anmelde_nachweise WHERE user_id = ?', userId);
}
