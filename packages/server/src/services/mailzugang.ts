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
