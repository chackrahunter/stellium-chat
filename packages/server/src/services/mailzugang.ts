/**
 * Der Zugang zum Postfach — verschlüsselt, unanzeigbar, ersetzbar.
 *
 * Gebaut wie `fernzugang.ts`, und aus demselben Grund: was hier liegt, öffnet
 * ein fremdes Konto. Es liegt mit dem Feldschlüssel verschlüsselt in den
 * Server-Einstellungen, dem gleichen, der Benutzernamen und E-Mail-Adressen
 * schützt. Wer die Datenbank in die Hand bekommt, hat damit noch nichts.
 *
 * **Angezeigt wird es nie.** Der Server holt es sich, wenn er eine Verbindung
 * aufbaut, und schreibt es nirgends hin. Wer den Zugang einrichtet, sieht
 * danach nur noch, DASS etwas hinterlegt ist — nicht was. Ein Geheimnis, das
 * man versehentlich weiterreichen kann, ist keins mehr.
 *
 * Warum drei Werte und kein Passwort:
 *
 * Google lässt kein Programm mehr mit Adresse und Passwort an ein Postfach.
 * Stattdessen erlaubt man einmal von Hand den Zugriff und bekommt dafür ein
 * **Aktualisierungs-Token**. Damit holt sich der Server bei Bedarf ein kurz
 * gültiges Zugangs-Token — das Aktualisierungs-Token selbst verlässt den
 * Server nie. Dazu gehören Client-ID und Client-Geheimnis aus dem
 * Google-Cloud-Projekt; sie sagen Google, WELCHES Programm fragt.
 *
 * Die Adresse ist kein Geheimnis und wird angezeigt — sonst könnte niemand
 * prüfen, ob das richtige Postfach hinterlegt ist.
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';

const SCHLUESSEL_ADRESSE   = 'mail.adresse';
const SCHLUESSEL_KENNUNG   = 'mail.kennung';
const SCHLUESSEL_GEHEIMNIS = 'mail.geheimnis';
const SCHLUESSEL_TOKEN     = 'mail.token';

export interface MailZugang {
  /** Das Postfach selbst, etwa `name@gmail.com`. Kein Geheimnis. */
  adresse: string;
  /** Client-ID aus dem Google-Cloud-Projekt. */
  kennung: string;
  /** Client-Geheimnis dazu. */
  geheimnis: string;
  /** Aktualisierungs-Token aus der einmaligen Zustimmung. */
  token: string;
}

/** Nur für den Verbindungsaufbau — niemals in eine Antwort geben. */
export function zugangLesen(): MailZugang | null {
  const adresse   = decryptField(getSetting(SCHLUESSEL_ADRESSE));
  const kennung   = decryptField(getSetting(SCHLUESSEL_KENNUNG));
  const geheimnis = decryptField(getSetting(SCHLUESSEL_GEHEIMNIS));
  const token     = decryptField(getSetting(SCHLUESSEL_TOKEN));
  if (!adresse || !kennung || !geheimnis || !token) return null;
  return { adresse, kennung, geheimnis, token };
}

/** Was man ohne Geheimnisse über den Zugang sagen darf. */
export function zugangStand(): {
  hinterlegt: boolean; verschluesselt: boolean; adresse: string | null;
} {
  const z = zugangLesen();
  return {
    hinterlegt: z !== null,
    /* Ohne Masterpasswort liegt es im Klartext in der Datenbank. Das ist kein
       Fehler, aber die Verwaltung soll es wissen. */
    verschluesselt: encryptionActive(),
    adresse: z?.adresse ?? decryptField(getSetting(SCHLUESSEL_ADRESSE)) ?? null,
  };
}

export function zugangSetzen(
  werte: { adresse?: string; kennung?: string; geheimnis?: string; token?: string },
  userId: string,
): void {
  /* Leere Felder lassen den bisherigen Wert stehen — so lässt sich das Token
     erneuern, ohne Client-ID und Geheimnis noch einmal einzugeben (die man
     ja nirgends mehr ablesen kann). */
  if (werte.adresse)   setSetting(SCHLUESSEL_ADRESSE,   encryptField(werte.adresse.trim()), userId);
  if (werte.kennung)   setSetting(SCHLUESSEL_KENNUNG,   encryptField(werte.kennung.trim()), userId);
  if (werte.geheimnis) setSetting(SCHLUESSEL_GEHEIMNIS, encryptField(werte.geheimnis.trim()), userId);
  if (werte.token)     setSetting(SCHLUESSEL_TOKEN,     encryptField(werte.token.trim()), userId);
}

export function zugangLoeschen(userId: string): void {
  for (const k of [SCHLUESSEL_ADRESSE, SCHLUESSEL_KENNUNG, SCHLUESSEL_GEHEIMNIS, SCHLUESSEL_TOKEN]) {
    setSetting(k, null, userId);
  }
}
