/**
 * Der Zugang zum Postfach — verschlüsselt, unanzeigbar, ersetzbar.
 *
 * Gebaut wie `fernzugang.ts`, und aus demselben Grund: was hier liegt, öffnet
 * den Versand im Namen des Unternehmens. Es liegt mit dem Feldschlüssel
 * verschlüsselt in den Server-Einstellungen — demselben, der Benutzernamen
 * und E-Mail-Adressen schützt. Wer die Datenbank in die Hand bekommt, hat
 * damit noch nichts.
 *
 * **Angezeigt wird es nie.** Wer den Zugang einrichtet, sieht danach nur
 * noch, DASS etwas hinterlegt ist — nicht was. Ein Schlüssel, den man
 * versehentlich weiterreichen kann, ist keiner mehr.
 *
 * Zwei Geheimnisse, zwei Richtungen:
 *
 *   · `versandSchluessel` — für den Weg NACH DRAUSSEN. Damit ruft Stellium
 *     den Versanddienst auf, der die Post mit DKIM auf der eigenen Domain
 *     signiert. Ohne ihn steht beim Empfänger eine fremde Absenderdomain.
 *
 *   · `eingangGeheimnis` — für den Weg HEREIN. Der Cloudflare-Worker legt es
 *     jeder Anfrage bei; ohne diese Prüfung könnte jeder erfundene Post in
 *     das Unternehmenspostfach einspeisen, denn `/api/post/eingang` hängt
 *     öffentlich am Tunnel.
 *
 * Absenderadresse und -name sind KEINE Geheimnisse und werden angezeigt —
 * sonst könnte niemand prüfen, unter welchem Namen nach außen geschrieben
 * wird.
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';

const S_ABSENDER  = 'mail.absender';
const S_NAME      = 'mail.name';
const S_VERSAND   = 'mail.versand';
const S_EINGANG   = 'mail.eingang';

export interface MailZugang {
  /** Aus welcher Adresse geschrieben wird, etwa `support@stellium.club`. */
  absender: string;
  /** Der Name davor, etwa `Stellium`. */
  name: string;
  /** Schlüssel des Versanddienstes. */
  versandSchluessel: string;
}

/** Nur für den Versand — niemals in eine Antwort geben. */
export function zugangLesen(): MailZugang | null {
  const absender = decryptField(getSetting(S_ABSENDER));
  const versandSchluessel = decryptField(getSetting(S_VERSAND));
  if (!absender || !versandSchluessel) return null;
  return { absender, name: decryptField(getSetting(S_NAME)) || 'Stellium', versandSchluessel };
}

/** Das Geheimnis, mit dem sich der Worker ausweist. */
export function eingangGeheimnis(): string | null {
  return decryptField(getSetting(S_EINGANG)) || null;
}

/** Was man ohne Geheimnisse über den Zugang sagen darf. */
export function zugangStand(): {
  versandBereit: boolean; eingangBereit: boolean; verschluesselt: boolean;
  absender: string | null; name: string | null;
} {
  return {
    /* Nur, ob der Versand-SCHLÜSSEL selbst hinterlegt ist — nicht, ob damit
       auch tatsächlich verschickt werden kann (das braucht zusätzlich den
       Absender, siehe zugangLesen() für den echten Versand). Stünde hier
       zugangLesen() !== null, zeigte der Reiter „Schlüssel" FEHLT für den
       Versand-Schlüssel, obwohl er längst gespeichert ist — nur weil im
       Reiter „Post" noch kein Absender eingetragen wurde. Zwei Reiter, ein
       Wert, eine irreführende Meldung. */
    /* Direkt am gespeicherten Wert geprüft, nicht am entschlüsselten:
       decryptField() gibt bei einem fehlenden Feld '' zurück, nie `null`
       (ihr Rückgabetyp ist `string`, kein `string | null`) — ein Vergleich
       `decryptField(...) !== null` war dadurch IMMER wahr, ganz gleich, ob
       ein Schlüssel hinterlegt war oder nicht. Das fiel erst auf, als
       post.ts::senden() sich auf genau dieses Feld verließ, um „kein
       Schlüssel" von „kein Absender" zu unterscheiden — mit dem alten
       Vergleich hätte es nie „kein Schlüssel" gemeldet. */
    versandBereit: getSetting(S_VERSAND) !== null,
    eingangBereit: eingangGeheimnis() !== null,
    /* Ohne Masterpasswort liegt es im Klartext in der Datenbank. Das ist kein
       Fehler, aber die Verwaltung soll es wissen. */
    verschluesselt: encryptionActive(),
    absender: decryptField(getSetting(S_ABSENDER)) || null,
    name: decryptField(getSetting(S_NAME)) || null,
  };
}

export function zugangSetzen(
  werte: { absender?: string; name?: string; versandSchluessel?: string; eingangGeheimnis?: string },
  userId: string,
): void {
  /* Leere Felder lassen den bisherigen Wert stehen — so lässt sich der
     Absendername ändern, ohne den Schlüssel noch einmal einzugeben (den man
     ja nirgends mehr ablesen kann). */
  if (werte.absender)          setSetting(S_ABSENDER, encryptField(werte.absender.trim()), userId);
  if (werte.name !== undefined) setSetting(S_NAME, werte.name ? encryptField(werte.name.trim()) : null, userId);
  if (werte.versandSchluessel) setSetting(S_VERSAND, encryptField(werte.versandSchluessel.trim()), userId);
  if (werte.eingangGeheimnis)  setSetting(S_EINGANG, encryptField(werte.eingangGeheimnis.trim()), userId);
}

export function zugangLoeschen(userId: string): void {
  for (const k of [S_ABSENDER, S_NAME, S_VERSAND, S_EINGANG]) setSetting(k, null, userId);
}
