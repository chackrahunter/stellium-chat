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
 * Domäne und Anzeigename sind KEINE Geheimnisse und werden angezeigt — sonst
 * könnte niemand prüfen, unter welcher Domäne nach außen geschrieben wird.
 *
 * **Hier liegt nur die Domäne, keine vollständige Adresse.** Der lokale Teil
 * einer ausgehenden Adresse (`support`, `info`, …) kommt beim tatsächlichen
 * Versand ausschließlich aus dem FACH, nie aus einer globalen Einstellung —
 * siehe services/post.ts, `senden()`: `senden({ fach: 'info', … })` schickt
 * aus `info@<domaene>`, nicht aus einer hier hinterlegten Adresse. Vor dieser
 * Umstellung lag hier eine vollständige Adresse (etwa `support@stellium.club`)
 * und das Fach wurde beim Absender schlicht ignoriert — eine Mail, die an
 * `info@` ankam, hätte ihre Antwort aus der einen global eingestellten
 * Adresse bekommen. `domaeneLesen()` weiter unten bleibt trotzdem robust
 * gegenüber einer noch so gesetzten Altadresse.
 */
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';

/** Die Domäne, aus der geschrieben wird — etwa `stellium.club`. */
const S_DOMAENE = 'mail.domaene';
/** ALTLAST vor dieser Umstellung: lag hier eine VOLLSTÄNDIGE Adresse statt
    nur der Domäne (siehe Dateikopf). Wird nicht mehr BESCHRIEBEN — nur noch
    als Rückfall gelesen (domaeneLesen()) und beim Zurücksetzen mitgelöscht
    (zugangLoeschen()), damit keine Karteileiche liegen bleibt. */
const S_ABSENDER_ALT = 'mail.absender';
const S_NAME      = 'mail.name';
const S_VERSAND   = 'mail.versand';
const S_EINGANG   = 'mail.eingang';

export interface MailZugang {
  /** Die Domäne, aus der geschrieben wird, etwa `stellium.club`. Die
      vollständige Absenderadresse entsteht erst aus Domäne UND Fach — siehe
      services/post.ts, `senden()`. */
  domaene: string;
  /** Der Anzeigename, etwa `Stellium` — Rückfall für den Namen vor der
      Adresse, falls ein Fach keinen eigenen Teamnamen hat (siehe
      post-ki.ts, `teamNameFuerFach()`). Für die acht bekannten Fächer kommt
      der tatsächlich verwendete Name von dort, nicht von hier. */
  name: string;
  /** Schlüssel des Versanddienstes. */
  versandSchluessel: string;
}

/* Nur einmal je Prozesslauf gemeldet, nicht bei jedem Aufruf — siehe
   domaeneLesen(). Ein Prozess lebt hier Tage bis Wochen; ein einziger Hinweis
   beim ersten Zugriff genügt, um die Verwaltung auf den Altfall aufmerksam
   zu machen, ohne das Protokoll zuzumüllen. */
let alteAdresseGemeldet = false;

/**
 * Die Domäne lesen — robust gegenüber der ÄLTEREN Fassung dieser Einstellung,
 * die unter demselben Namensraum eine VOLLSTÄNDIGE ADRESSE ablegte (siehe
 * Dateikopf). Ein dort noch gesetzter Wert mit "@" ist deshalb kein kaputter
 * Zustand, sondern genau dieser Altfall: nur der Teil HINTER dem "@" gilt als
 * Domäne, der lokale Teil davor wird verworfen — er hätte ohnehin nie mehr
 * Bedeutung gehabt, seit das Fach den lokalen Teil bestimmt. Steht schon eine
 * Domäne am neuen Schlüssel, wird die alte Adresse gar nicht erst angesehen.
 */
function domaeneLesen(): string {
  const neu = decryptField(getSetting(S_DOMAENE)).trim().toLowerCase();
  if (neu) return neu;

  const alt = decryptField(getSetting(S_ABSENDER_ALT)).trim().toLowerCase();
  if (!alt) return '';
  const domaene = alt.includes('@') ? (alt.split('@')[1] ?? '') : alt;
  if (domaene && !alteAdresseGemeldet) {
    alteAdresseGemeldet = true;
    console.warn(
      `[mailzugang] Unter der alten Einstellung liegt noch eine vollständige Adresse ("${alt}") statt nur `
      + `der Domäne. Es wird nur die Domäne ("${domaene}") verwendet. Im Reiter „Postfach" einmal neu `
      + 'speichern, dann verschwindet dieser Hinweis endgültig.',
    );
  }
  return domaene;
}

/** Nur für den Versand — niemals in eine Antwort geben. */
export function zugangLesen(): MailZugang | null {
  const domaene = domaeneLesen();
  const versandSchluessel = decryptField(getSetting(S_VERSAND));
  if (!domaene || !versandSchluessel) return null;
  return { domaene, name: decryptField(getSetting(S_NAME)) || 'Stellium', versandSchluessel };
}

/** Das Geheimnis, mit dem sich der Worker ausweist. */
export function eingangGeheimnis(): string | null {
  return decryptField(getSetting(S_EINGANG)) || null;
}

/** Was man ohne Geheimnisse über den Zugang sagen darf. */
export function zugangStand(): {
  versandBereit: boolean; eingangBereit: boolean; verschluesselt: boolean;
  domaene: string | null; name: string | null;
} {
  return {
    /* Nur, ob der Versand-SCHLÜSSEL selbst hinterlegt ist — nicht, ob damit
       auch tatsächlich verschickt werden kann (das braucht zusätzlich die
       Domäne, siehe zugangLesen() für den echten Versand). Stünde hier
       zugangLesen() !== null, zeigte der Reiter „Schlüssel" FEHLT für den
       Versand-Schlüssel, obwohl er längst gespeichert ist — nur weil im
       Reiter „Post" noch keine Domäne eingetragen wurde. Zwei Reiter, ein
       Wert, eine irreführende Meldung. */
    /* Direkt am gespeicherten Wert geprüft, nicht am entschlüsselten:
       decryptField() gibt bei einem fehlenden Feld '' zurück, nie `null`
       (ihr Rückgabetyp ist `string`, kein `string | null`) — ein Vergleich
       `decryptField(...) !== null` war dadurch IMMER wahr, ganz gleich, ob
       ein Schlüssel hinterlegt war oder nicht. Das fiel erst auf, als
       post.ts::senden() sich auf genau dieses Feld verließ, um „kein
       Schlüssel" von „keine Domäne" zu unterscheiden — mit dem alten
       Vergleich hätte es nie „kein Schlüssel" gemeldet. */
    versandBereit: getSetting(S_VERSAND) !== null,
    eingangBereit: eingangGeheimnis() !== null,
    /* Ohne Masterpasswort liegt es im Klartext in der Datenbank. Das ist kein
       Fehler, aber die Verwaltung soll es wissen. */
    verschluesselt: encryptionActive(),
    domaene: domaeneLesen() || null,
    name: decryptField(getSetting(S_NAME)) || null,
  };
}

export function zugangSetzen(
  werte: { domaene?: string; name?: string; versandSchluessel?: string; eingangGeheimnis?: string },
  userId: string,
): void {
  /* Leere Felder lassen den bisherigen Wert stehen — so lässt sich der
     Anzeigename ändern, ohne den Schlüssel noch einmal einzugeben (den man
     ja nirgends mehr ablesen kann). Format der Domäne (kein "@", keine
     Leerzeichen) prüft die Route, nicht dieser Dienst — dieselbe Aufteilung
     wie bei der Mindestlänge des Eingangsgeheimnisses weiter unten, siehe
     routes.ts, `/api/post/zugang`. */
  if (werte.domaene) {
    setSetting(S_DOMAENE, encryptField(werte.domaene.trim().toLowerCase()), userId);
    /* Die neue, richtige Domäne steht jetzt am neuen Schlüssel — eine
       eventuell noch dort liegende Altadresse hat damit ausgedient und wird
       gleich mitgeräumt, statt als stille Karteileiche liegen zu bleiben
       (domaeneLesen() sähe sie ohnehin nicht mehr an, sobald S_DOMAENE
       einen Wert trägt — das hier ist nur Aufräumen, keine Notwendigkeit). */
    setSetting(S_ABSENDER_ALT, null, userId);
  }
  if (werte.name !== undefined) setSetting(S_NAME, werte.name ? encryptField(werte.name.trim()) : null, userId);
  if (werte.versandSchluessel) setSetting(S_VERSAND, encryptField(werte.versandSchluessel.trim()), userId);
  if (werte.eingangGeheimnis)  setSetting(S_EINGANG, encryptField(werte.eingangGeheimnis.trim()), userId);
}

export function zugangLoeschen(userId: string): void {
  for (const k of [S_DOMAENE, S_ABSENDER_ALT, S_NAME, S_VERSAND, S_EINGANG]) setSetting(k, null, userId);
}

/* ── Der ZWEITE Weg herein: ein fremdes Postfach abrufen ────────
 *
 * WARUM ES DAS GIBT, UND WARUM ES KEINE WEITERLEITUNG IST. An eine
 * Gmail-Adresse kommt gewöhnliche Post — Bestätigungen, Codes, Firmenpost.
 * Der naheliegende Weg wäre eine Weiterleitung bei Google an die
 * Stellium-Domäne; sie ist ausdrücklich verworfen. Der Grund ist nicht
 * Geschmack, sondern Arithmetik: ein Teil der Firmenpost, die an die
 * Stellium-Domäne geht, liegt ZUSÄTZLICH in diesem Gmail-Postfach. Eine
 * Weiterleitung lieferte davon jedes Stück ein zweites Mal ein, und der
 * Posteingang zeigte alles doppelt. Also holt Stellium die Post selbst und
 * entdublettet sie beim Aufnehmen (services/post.ts, `abdruckBilden()`).
 *
 * DER HOST STEHT NICHT HIER, SONDERN FEST IM CODE (services/postabruf.ts,
 * `IMAP_HOST`). Er ist bewusst keine Einstellung: das hier hinterlegte
 * Passwort geht bei jedem Lauf an genau diesen Rechner, und ein Feld, in das
 * sich ein Rechnername eintragen lässt, ist ein Feld, mit dem sich das
 * Passwort woandershin schicken lässt. Wer einen anderen Anbieter will,
 * ändert eine Zeile Code — und niemand kann es aus der Ferne über eine
 * Einstellung tun.
 *
 * DAS PASSWORT IST EIN APP-PASSWORT, kein Kontopasswort. Google lässt seit
 * Jahren kein Kontopasswort mehr an IMAP; es braucht die
 * Zwei-Faktor-Anmeldung und ein dort erzeugtes 16-stelliges App-Passwort.
 * Erzeugen kann es nur der Kontoinhaber selbst — Stellium kennt es nicht und
 * erzeugt es nicht, es wird hier nur entgegengenommen.
 */

/** Die Adresse des abzurufenden Postfachs — zugleich der IMAP-Benutzername.
    Verschlüsselt wie jede andere Adresse im Haus (crypto/pii.ts), aber KEIN
    Geheimnis im Sinne des Passworts: sie wird angezeigt, damit man sieht,
    welches Postfach da eigentlich geleert wird. */
const S_ABRUF_ADRESSE = 'mail.abruf.adresse';
/** Das App-Passwort. Geht nie wieder hinaus — weder gekürzt noch maskiert. */
const S_ABRUF_PASSWORT = 'mail.abruf.passwort';
/** Ob der Takt läuft. Getrennt vom Passwort, damit sich der Abruf anhalten
    lässt, ohne die Zugangsdaten wegzuwerfen und neu eintippen zu müssen. */
const S_ABRUF_AKTIV = 'mail.abruf.aktiv';

export interface AbrufZugang { adresse: string; passwort: string }

/** Nur für den Abruf — niemals in eine Antwort geben. */
export function abrufZugangLesen(): AbrufZugang | null {
  const adresse = decryptField(getSetting(S_ABRUF_ADRESSE)).trim();
  const passwort = decryptField(getSetting(S_ABRUF_PASSWORT));
  if (!adresse || !passwort) return null;
  return { adresse, passwort };
}

/** Ob der Takt laufen soll. Vorgabe ist AUS: ein frisch eingetragener Zugang
    beginnt nicht von selbst, ein fremdes Postfach leerzulesen. */
export function abrufAktiv(): boolean {
  return getSetting(S_ABRUF_AKTIV) === '1';
}

/** Was man ohne Geheimnisse über den Abruf sagen darf. */
export function abrufStand(): {
  adresse: string | null; passwortHinterlegt: boolean; aktiv: boolean;
} {
  return {
    adresse: decryptField(getSetting(S_ABRUF_ADRESSE)).trim() || null,
    /* Am gespeicherten Wert geprüft, nicht am entschlüsselten — derselbe
       Fallstrick wie bei `versandBereit` oben: decryptField() gibt für ein
       fehlendes Feld '' zurück und nie `null`. */
    passwortHinterlegt: getSetting(S_ABRUF_PASSWORT) !== null,
    aktiv: abrufAktiv(),
  };
}

export function abrufSetzen(
  werte: { adresse?: string; passwort?: string; aktiv?: boolean },
  userId: string,
): void {
  /* Wie oben: leere Felder lassen den bisherigen Wert stehen, damit sich der
     Takt ein- und ausschalten lässt, ohne das Passwort noch einmal
     einzugeben (das man nirgends mehr ablesen kann). */
  if (werte.adresse) setSetting(S_ABRUF_ADRESSE, encryptField(werte.adresse.trim().toLowerCase()), userId);
  if (werte.passwort) {
    /* Google zeigt das App-Passwort in vier Vierergruppen mit Leerzeichen an
       ("abcd efgh ijkl mnop"), erwartet es beim Anmelden aber ohne. Wer es
       kopiert, kopiert die Leerzeichen mit — und bekäme sonst eine
       Fehlermeldung, die nach einem falschen Passwort aussieht, obwohl das
       richtige dasteht. */
    setSetting(S_ABRUF_PASSWORT, encryptField(werte.passwort.replace(/\s+/g, '')), userId);
  }
  if (werte.aktiv !== undefined) setSetting(S_ABRUF_AKTIV, werte.aktiv ? '1' : '0', userId);
}

/** Zugang UND Merkposten wegräumen. Die Merkposten müssen mit: bliebe die
    zuletzt gesehene UID stehen, holte ein später eingetragener Zugang (ein
    anderes Postfach!) nur noch alles ab dieser Nummer — also so gut wie
    nichts, ohne dass jemand sähe, warum. */
export function abrufLoeschen(userId: string): void {
  for (const k of [S_ABRUF_ADRESSE, S_ABRUF_PASSWORT, S_ABRUF_AKTIV]) setSetting(k, null, userId);
  for (const k of ['mail.abruf.uidvalidity', 'mail.abruf.letzteUid', 'mail.abruf.stand']) {
    setSetting(k, null, userId);
  }
}
