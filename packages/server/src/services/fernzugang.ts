/**
 * Adresse und Passwort für die Fernsteuerung des Pi.
 *
 * Beides liegt **verschlüsselt** in den Server-Einstellungen — mit demselben
 * Feldschlüssel, der auch Benutzernamen und E-Mails schützt. Wer die
 * Datenbank in die Hand bekommt, hat damit noch nichts.
 *
 * Und beides wird **nie angezeigt**. Die App holt es sich, wenn sie eine
 * Verbindung aufbaut, und schreibt es nirgends hin. Wer den Zugang
 * einrichtet, sieht danach selbst nur noch, DASS etwas hinterlegt ist —
 * nicht was. Das ist Absicht: ein Passwort, das man versehentlich
 * weiterreichen kann, ist keins mehr.
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

/** Nur für den Aufbau einer Verbindung — niemals in eine Antwort geben,
 *  die jemand ohne `fern.zugriff` zu sehen bekommt. */
export function zugangLesen(): FernZugang | null {
  const adresse = decryptField(getSetting(SCHLUESSEL_ADRESSE));
  const passwort = decryptField(getSetting(SCHLUESSEL_PASSWORT));
  if (!adresse || !passwort) return null;
  return { adresse, passwort, kennung: decryptField(getSetting(SCHLUESSEL_KENNUNG)) };
}

/** Was man ohne Geheimnisse über den Zugang sagen darf. */
export function zugangStand(): { hinterlegt: boolean; verschluesselt: boolean; kennung: string | null } {
  const z = zugangLesen();
  return {
    hinterlegt: z !== null,
    /* Ohne Masterpasswort liegt es im Klartext in der Datenbank. Das ist kein
       Fehler, aber die Verwaltung soll es wissen. */
    verschluesselt: encryptionActive(),
    /* Die ID ist eine Adresse, kein Geheimnis — TeamViewer zeigt sie auch an.
       Sie hilft beim Erkennen, ob der richtige Pi hinterlegt ist. */
    kennung: z?.kennung || null,
  };
}

export function zugangSetzen(
  werte: { adresse?: string; passwort?: string; kennung?: string },
  userId: string,
): void {
  /* Leere Felder lassen den bisherigen Wert stehen — so kann man die Adresse
     ändern, ohne das Passwort noch einmal eingeben zu müssen (das man ja
     nirgends mehr ablesen kann). */
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
