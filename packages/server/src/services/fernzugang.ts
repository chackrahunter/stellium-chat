/**
 * Adresse und Passwort für die Fernsteuerung des Pi.
 *
 * Beides liegt **verschlüsselt** in den Server-Einstellungen — mit demselben
 * Feldschlüssel, der auch Benutzernamen und E-Mails schützt. Wer die
 * Datenbank in die Hand bekommt, hat damit noch nichts.
 *
 * Angezeigt wird beides fast nirgends. Die App holt es sich, wenn sie eine
 * Verbindung aufbaut, und schreibt es nirgends hin. Die eine Ausnahme ist
 * `GET /api/fern/zugang-ansehen` (http/routes.ts): Inhaber und
 * Administratoren dürfen Adresse UND Passwort ablesen, weil sie beides
 * Kollegen weitergeben müssen, die nicht über die App hereinkommen. Für alle
 * anderen — auch für die Teamleitung mit `fern.zugriff` — bleibt es bei „ich
 * sehe nur, DASS etwas hinterlegt ist".
 *
 * WARUM DAS ABLESEN NICHT VERMERKT WIRD — im Unterschied zum Passworttresor,
 * der für jedes Aufdecken eine Zeile in `passwort_offenlegungen` schreibt.
 *
 * Der Tresor kann das, weil das Aufdecken dort die EINZIGE Tür zum Klartext
 * ist: die Einträge sind Ende-zu-Ende verschlüsselt, ohne den Kontoschlüssel
 * der jeweiligen Person kommt niemand an den Wert. Eine fehlende Zeile heißt
 * dort tatsächlich „hat nicht gesehen", und darauf kann sich ein Nachspiel
 * stützen.
 *
 * Hier läge genau das nicht vor. Jeder mit `fern.verwalten` trägt über die
 * Rollenvorgabe auch `fern.zugriff` und kann sich dieselben Werte jederzeit
 * über `/api/fern/zugang` holen — spurlos, mit einem einzigen Aufruf. Ein
 * Vermerk nur an der Anzeige-Tür ergäbe eine Liste, die genau die Vorsichtigen
 * führt und die Umgehung verschweigt. Ein solcher Nachweis ist schlimmer als
 * keiner: wer ihn später liest, deutet die fehlende Zeile als „hat nicht
 * gesehen", obwohl sie nichts dergleichen sagt.
 *
 * Dazu kommt: es ist EIN Geheimnis EINER Maschine, gehalten von einer
 * Handvoll Leuten — kein personengebundener Zugang wie im Tresor. Der Preis
 * (eine Tabelle, eine Wanderung auf der laufenden Datenbank, eine
 * Aufbewahrungsfrist, eine Ansicht dafür) kauft hier keine Aussage, die
 * trägt. Wer eines Tages einen belastbaren Nachweis will, muss ihn an
 * `zugangLesen()` hängen, nicht an die Anzeige — dann zählt er beide Türen.
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';

const SCHLUESSEL_ADRESSE = 'fern.adresse';
const SCHLUESSEL_PASSWORT = 'fern.passwort';
const SCHLUESSEL_KENNUNG = 'fern.id';

export interface FernZugang {
  adresse: string;
  passwort: string;
  kennung: string;
}

/** Der Klartext. Zwei Wege führen hierher und sonst keiner: der
 *  Verbindungsaufbau (`fern.zugriff`, `/api/fern/zugang`) und das Ablesen zum
 *  Weitergeben (`fern.verwalten`, `/api/fern/zugang-ansehen`). Wer eine dritte
 *  Antwort daraus speist, muss vorher eines dieser beiden Rechte prüfen —
 *  „angemeldet" reicht nicht. */
export function zugangLesen(): FernZugang | null {
  const adresse = decryptField(getSetting(SCHLUESSEL_ADRESSE));
  const passwort = decryptField(getSetting(SCHLUESSEL_PASSWORT));
  if (!adresse || !passwort) return null;
  return { adresse, passwort, kennung: decryptField(getSetting(SCHLUESSEL_KENNUNG)) };
}

/**
 * Was man ohne Geheimnisse über den Zugang sagen darf.
 *
 * DIE ADRESSE BLEIBT HIER DRAUSSEN, und das ändert sich auch nicht dadurch,
 * dass `/api/fern/zugang-ansehen` sie jetzt herausgibt. Der Unterschied ist
 * nicht der Wert, sondern der Kreis: an dieser Auskunft hängt
 * `GET /api/fern/stand`, und deren einziger Wächter für den GRUNDSTOCK der
 * Antwort ist „angemeldet" — jeder darf wissen, ob der Fernzugang überhaupt
 * eingerichtet ist, sonst steht in der App ein Knopf, der ohne Erklärung
 * nichts tut. Die Adresse hier einzutragen hieße also, den erreichbaren
 * Netzweg zum Pi an jedes Konto zu geben, bis hinunter zum Gast — während die
 * neue Route ihn dem Inhaber und den Administratoren zeigt. Das wäre keine
 * Angleichung, sondern eine um zwei Größenordnungen weitere Tür.
 *
 * DIE KENNUNG STEHT HIER DRIN UND WIRD TROTZDEM NICHT AN JEDEN AUSGELIEFERT.
 * Sie ist kein Geheimnis in demselben Sinn, aber sie benennt DIE MASCHINE,
 * und das rechtfertigt der Satz oben gerade nicht: er trägt `hinterlegt`, das
 * bloße OB. `GET /api/fern/stand` schneidet sie deshalb für Konten ohne
 * `fern.zugriff` heraus (siehe die ausgeschriebene Begründung an der Route).
 * Diese Funktion liefert weiter alle drei Felder — sie ist die Auskunft für
 * die Wege, die eine Schwelle davor haben (`POST`/`DELETE /api/fern/zugang`,
 * beide `fern.verwalten`). Wer sie an einer VIERTEN Stelle einhängt, muss
 * dort selbst entscheiden, ob die Kennung mitgeht.
 */
export function zugangStand(): { hinterlegt: boolean; verschluesselt: boolean; kennung: string | null } {
  const z = zugangLesen();
  return {
    hinterlegt: z !== null,
    /* Ohne Masterpasswort liegt es im Klartext in der Datenbank. Das ist kein
       Fehler, aber die Verwaltung soll es wissen. */
    verschluesselt: encryptionActive(),
    /* Die ID ist eine vermittelte Adresse, kein Geheimnis — TeamViewer zeigt
       sie auch an. Sie hilft beim Erkennen, ob der richtige Pi hinterlegt
       ist, und gehört damit zu dem, der verbinden darf. „Kein Geheimnis"
       heißt NICHT „für jeden": wer diesen Wert weitergibt, gibt die halbe
       Zugangspaarung weiter. Wer den Kreis abschneidet, tut das an der
       Route, nicht hier — siehe den Dateikopf dieser Funktion. */
    kennung: z?.kennung || null,
  };
}

export function zugangSetzen(
  werte: { adresse?: string; passwort?: string; kennung?: string },
  userId: string,
): void {
  /* Leere Felder lassen den bisherigen Wert stehen — so kann man die Adresse
     ändern, ohne das Passwort noch einmal eingeben zu müssen. */
  if (werte.adresse) setSetting(SCHLUESSEL_ADRESSE, encryptField(werte.adresse.trim()), userId);
  if (werte.passwort) setSetting(SCHLUESSEL_PASSWORT, encryptField(werte.passwort), userId);
  if (werte.kennung !== undefined) {
    setSetting(SCHLUESSEL_KENNUNG, werte.kennung ? encryptField(werte.kennung.trim()) : null, userId);
  }
}

export function zugangLoeschen(userId: string): void {
  setSetting(SCHLUESSEL_ADRESSE, null, userId);
  setSetting(SCHLUESSEL_PASSWORT, null, userId);
  setSetting(SCHLUESSEL_KENNUNG, null, userId);
}
