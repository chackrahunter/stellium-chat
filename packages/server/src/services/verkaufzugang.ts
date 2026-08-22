/**
 * Der Gumroad-Token — verschlüsselt, unanzeigbar, ersetzbar.
 *
 * Ohne ihn kennt die Konsole nur die öffentlichen Zahlen: Mitgliederzahl,
 * Preise, Probezeit. Die wirklichen Einnahmen und die Aufteilung der Abos
 * gibt Gumroad nur gegen diesen Schlüssel heraus.
 *
 * Bis hierher stand er im Klartext in `/etc/stellium-triton.env` auf dem Pi.
 * Das war nicht falsch — die Datei gehört root —, aber es bedeutete: wer den
 * Token wechseln will, braucht eine SSH-Sitzung. Hier liegt er mit demselben
 * Feldschlüssel verschlüsselt wie Benutzernamen und das Fern-Passwort, und
 * der Server reicht ihn beim Aufruf der Konsole als Umgebungsvariable durch.
 * Auf der Platte steht er damit nirgends im Klartext.
 *
 * **Angezeigt wird er nie.** Wer ihn hinterlegt, sieht danach nur noch, DASS
 * etwas hinterlegt ist.
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';

const SCHLUESSEL = 'verkauf.gumroad';

/** Nur für den Aufruf der Konsole — niemals in eine Antwort geben. */
export function tokenLesen(): string | null {
  return decryptField(getSetting(SCHLUESSEL)) || null;
}

export function tokenStand(): { hinterlegt: boolean; verschluesselt: boolean } {
  return {
    hinterlegt: tokenLesen() !== null,
    /* Ohne Masterpasswort liegt er im Klartext in der Datenbank. Kein Fehler,
       aber die Verwaltung soll es wissen. */
    verschluesselt: encryptionActive(),
  };
}

export function tokenSetzen(wert: string, userId: string): void {
  setSetting(SCHLUESSEL, wert.trim() ? encryptField(wert.trim()) : null, userId);
}
