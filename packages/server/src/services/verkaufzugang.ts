/**
 * Der Gumroad- und der Patreon-Zugang — verschlüsselt, unanzeigbar, ersetzbar.
 *
 * Ohne sie kennt die Konsole nur die öffentlichen Zahlen: Mitgliederzahl,
 * Preise, Probezeit. Die wirklichen Einnahmen und die Aufteilung der Abos
 * geben Gumroad und Patreon nur gegen den jeweiligen Schlüssel heraus.
 *
 * Bis hierher stand der Gumroad-Schlüssel im Klartext in
 * `/etc/stellium-triton.env` auf dem Pi. Das war nicht falsch — die Datei
 * gehört root —, aber es bedeutete: wer den Token wechseln will, braucht eine
 * SSH-Sitzung. Hier liegen beide mit demselben Feldschlüssel verschlüsselt
 * wie Benutzernamen und das Fern-Passwort, und der Server reicht den
 * Gumroad-Token beim Aufruf der Konsole als Umgebungsvariable durch. Auf der
 * Platte steht keiner der beiden im Klartext.
 *
 * **Angezeigt wird keiner der Schlüssel** — mit einer Ausnahme: Patreons
 * Client-ID identifiziert nur, welche App eingetragen ist, nicht den Zugriff
 * selbst. Sie ist kein Geheimnis und kommt darum entschlüsselt zurück, damit
 * im Formular sichtbar bleibt, welcher Client hinterlegt ist.
 *
 * Patreons Zugriffstoken läuft ab, anders als Gumroads dauerhafter Token.
 * `ablaufAm` hält fest, bis wann er gilt — damit ein Ablauf sichtbar wird,
 * statt still zu passieren. Die eigentliche Erneuerung (Patreons
 * Token-Endpunkt mit dem Refresh-Token aufrufen, bevor der Zugriffstoken
 * abläuft, und danach BEIDE neuen Werte speichern, weil Patreon beim
 * Erneuern in aller Regel auch einen neuen Refresh-Token ausgibt) ist noch
 * nicht gebaut; `patreonAblaufSetzen` liegt schon bereit, damit sie es ohne
 * Umbau am Speicherort nachrüsten kann.
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';

const GUMROAD_SCHLUESSEL = 'verkauf.gumroad';

/** Nur für den Aufruf der Konsole — niemals in eine Antwort geben. */
export function tokenLesen(): string | null {
  return decryptField(getSetting(GUMROAD_SCHLUESSEL)) || null;
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
  setSetting(GUMROAD_SCHLUESSEL, wert.trim() ? encryptField(wert.trim()) : null, userId);
}

/* ── Patreon ──────────────────────────────────────────────────
 * Vier Werte statt einem: Patreons OAuth-Modell trennt die App (Client-ID
 * und -Secret) vom Zugriff auf ein bestimmtes Konto (Access- und
 * Refresh-Token). Jeder der vier lässt sich einzeln setzen oder — durch
 * einen ausdrücklich leeren Wert — einzeln löschen; ein weggelassenes Feld
 * lässt den bisherigen Wert dagegen stehen. So lässt sich zum Beispiel nur
 * der Access-Token austauschen, ohne Client-ID und -Secret erneut
 * einzutippen.
 */
const PATREON_CLIENT_ID = 'verkauf.patreon.clientId';
const PATREON_CLIENT_SECRET = 'verkauf.patreon.clientSecret';
const PATREON_ACCESS_TOKEN = 'verkauf.patreon.accessToken';
const PATREON_REFRESH_TOKEN = 'verkauf.patreon.refreshToken';
const PATREON_ABLAUF = 'verkauf.patreon.ablaufAm';

/** Nur für eine künftige Anbindung an Patreon — Secret, Access- und
 *  Refresh-Token niemals in eine Antwort geben. Die Client-ID ist keins
 *  (siehe Dateikopf) und kommt über `patreonStand` entschlüsselt zurück. */
export function patreonClientIdLesen(): string | null {
  return decryptField(getSetting(PATREON_CLIENT_ID)) || null;
}
export function patreonClientSecretLesen(): string | null {
  return decryptField(getSetting(PATREON_CLIENT_SECRET)) || null;
}
export function patreonAccessTokenLesen(): string | null {
  return decryptField(getSetting(PATREON_ACCESS_TOKEN)) || null;
}
export function patreonRefreshTokenLesen(): string | null {
  return decryptField(getSetting(PATREON_REFRESH_TOKEN)) || null;
}
/** Zeitpunkt (ms seit Epoche), bis zu dem der Access-Token gilt — oder
 *  `null`, solange niemand ihn gesetzt hat (siehe Dateikopf). */
export function patreonAblaufLesen(): number | null {
  const roh = getSetting(PATREON_ABLAUF);
  return roh ? Number(roh) : null;
}

export function patreonStand(): {
  hinterlegt: boolean;
  clientId: string | null;
  clientSecretHinterlegt: boolean;
  refreshTokenHinterlegt: boolean;
  ablaufAm: number | null;
  verschluesselt: boolean;
} {
  return {
    /* Ohne Access-Token geht kein Aufruf — das ist das Kernkriterium dafür,
       ob Patreon "hinterlegt" ist, genau wie bei Gumroads einzelnem Token. */
    hinterlegt: patreonAccessTokenLesen() !== null,
    clientId: patreonClientIdLesen(),
    clientSecretHinterlegt: patreonClientSecretLesen() !== null,
    refreshTokenHinterlegt: patreonRefreshTokenLesen() !== null,
    ablaufAm: patreonAblaufLesen(),
    verschluesselt: encryptionActive(),
  };
}

/** Ein weggelassenes Feld lässt den bisherigen Wert stehen; ein ausdrücklich
 *  leeres löscht ihn — genau wie beim Gumroad-Token, hier nur je Feld
 *  einzeln statt für den gesamten Wert auf einmal. */
export function patreonSetzen(werte: {
  clientId?: string; clientSecret?: string; accessToken?: string; refreshToken?: string;
}, userId: string): void {
  if (werte.clientId !== undefined) {
    setSetting(PATREON_CLIENT_ID, werte.clientId.trim() ? encryptField(werte.clientId.trim()) : null, userId);
  }
  if (werte.clientSecret !== undefined) {
    setSetting(PATREON_CLIENT_SECRET, werte.clientSecret.trim() ? encryptField(werte.clientSecret.trim()) : null, userId);
  }
  if (werte.accessToken !== undefined) {
    setSetting(PATREON_ACCESS_TOKEN, werte.accessToken.trim() ? encryptField(werte.accessToken.trim()) : null, userId);
  }
  if (werte.refreshToken !== undefined) {
    setSetting(PATREON_REFRESH_TOKEN, werte.refreshToken.trim() ? encryptField(werte.refreshToken.trim()) : null, userId);
  }
}

/** Setzt NUR das Ablaufdatum, ohne die Token anzufassen — für die künftige
 *  Erneuerung. Ruft heute noch niemand auf (siehe Dateikopf); die manuelle
 *  Eingabe im Einstellungsfenster kennt kein Ablaufdatum, weil Patreons
 *  Entwicklerbereich beim Anzeigen der Token keins nennt, sondern nur beim
 *  tatsächlichen Erneuern über den Token-Endpunkt. */
export function patreonAblaufSetzen(zeitstempel: number | null, userId: string): void {
  setSetting(PATREON_ABLAUF, zeitstempel != null ? String(zeitstempel) : null, userId);
}
