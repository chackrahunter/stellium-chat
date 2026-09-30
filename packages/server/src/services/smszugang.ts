/**
 * Der Twilio-Zugang — verschlüsselt im Tresor, unanzeigbar, ersetzbar.
 *
 * WARUM DER TRESOR UND NICHT DIE EINSTELLUNGEN. Gumroad, Patreon und der
 * Postfach-Zugang liegen in `app_settings`, mit `crypto/pii.ts` verschlüsselt;
 * der Groq-Schlüssel liegt in `data/secrets.enc` (services/kizugang.ts). Die
 * Twilio-Daten folgen dem Groq-Weg, und das ist keine Geschmacksfrage: der
 * Auth Token ist nicht bloß ein Schlüssel zum Senden, sondern zugleich der
 * HMAC-Schlüssel, mit dem `http/smseingang.ts` JEDE eingehende Anfrage
 * beglaubigt. Wer ihn hat, kann sich als Twilio ausgeben und beliebige SMS in
 * den Posteingang schreiben. Ein Geheimnis, an dem eine Signaturprüfung
 * hängt, gehört in den Tresor und nicht in eine Tabelle, die auch ohne
 * Masterpasswort noch beschreibbar wäre.
 *
 * DREI WERTE, EINE FAMILIE. Account SID, Auth Token und die eigene Nummer
 * liegen unter je einem eigenen Namen im Tresor, mit je einem Namen in der
 * Umgebung davor — dieselbe Vorrangregel wie beim Groq-Schlüssel
 * (`secret()` in config.ts). Dass auch SID und Nummer diesen Weg gehen,
 * obwohl beide für sich keine Geheimnisse sind, hat einen praktischen Grund:
 * die drei gehören zusammen und werden zusammen gesetzt, gewechselt und
 * gelöscht. Sie auf zwei Ablagen zu verteilen hieße, für ein einziges
 * Twilio-Konto zwei Wahrheiten zu führen — und irgendwann steht die SID eines
 * alten Kontos neben dem Token eines neuen.
 *
 * **Angezeigt wird keiner der drei.** Zurück geht nur der Stand: hinterlegt
 * ja/nein, Quelle Umgebung oder Tresor. Genau wie beim Groq-Schlüssel, und
 * aus demselben Grund — auch ein gekürzt angezeigter Token ist ein Token.
 *
 * DIE WEBHOOK-ADRESSE IST DAS GEGENTEIL: sie MUSS lesbar sein, denn Don trägt
 * sie von Hand in der Twilio-Console ein. Sie liegt deshalb nicht im Tresor,
 * sondern in `app_settings` (mit `crypto/pii.ts` verschlüsselt wie jede
 * andere Adresse im Haus) und geht vollständig in die Oberfläche zurück.
 * Sie ist zugleich mehr als eine Anzeige: `http/smseingang.ts` bildet die
 * Signatur GENAU über diese Adresse. Siehe `webhookAdresse()` unten.
 */
import { config, geheimStand, tresorSetzen, type GeheimStand } from '../config.js';
import { getSetting, setSetting } from './settings.js';
import { encryptField, decryptField, encryptionActive } from '../crypto/pii.js';
import { abweisung } from '../util/abweisung.js';

/* ── Die drei Werte im Tresor ─────────────────────────────────── */

const UMGEBUNG_SID    = 'TWILIO_ACCOUNT_SID';
const UMGEBUNG_TOKEN  = 'TWILIO_AUTH_TOKEN';
const UMGEBUNG_NUMMER = 'TWILIO_NUMMER';
const TRESOR_SID      = 'twilio_sid';
const TRESOR_TOKEN    = 'twilio_token';
const TRESOR_NUMMER   = 'twilio_nummer';

/** Die öffentlich erreichbare Wurzel, unter der dieser Server am Tunnel
    hängt — etwa `https://chat.stellium.club`. KEIN Geheimnis. */
const S_WEBHOOK_BASIS = 'sms.webhookBasis';

/** Der Pfad, unter dem `http/smseingang.ts` die Route registriert. Steht hier
    UND dort — aber nicht zweimal geschrieben: dort wird diese Konstante
    eingebunden. Ein zweiter Wortlaut hieße, dass die angezeigte Adresse eines
    Tages auf eine Route zeigt, die es nicht mehr gibt, und dass die Signatur
    über eine andere Adresse gerechnet wird als die, die Don eingetragen hat. */
export const EINGANG_PFAD = '/api/sms/eingang';

/**
 * Eine Nummer im E.164-Format: Pluszeichen, dann 7 bis 15 Ziffern.
 *
 * Exportiert, weil zwei ganz verschiedene Stellen genau diese Frage stellen:
 * dieser Dienst prüft damit die EIGENE hinterlegte Nummer, und
 * `/api/post/senden` entscheidet damit, ob eine Antwort als SMS oder als Mail
 * hinausgeht (siehe services/sms.ts, `istTelefonnummer()`). Zwei Regexe für
 * dieselbe Frage wären zwei Antworten, sobald jemand eine davon lockert.
 */
export const E164 = /^\+[1-9]\d{6,14}$/;

export function sidStand(): GeheimStand { return geheimStand(UMGEBUNG_SID, TRESOR_SID); }
export function tokenStand(): GeheimStand { return geheimStand(UMGEBUNG_TOKEN, TRESOR_TOKEN); }
export function nummerStand(): GeheimStand { return geheimStand(UMGEBUNG_NUMMER, TRESOR_NUMMER); }

/* ── Lesen: nur für den Versand und die Signaturprüfung ──────────
   Diese drei geben Klartext zurück und dürfen NIE in eine Antwort an den
   Browser fließen. Sie stehen absichtlich getrennt von `zugangStand()`
   darunter, damit an jeder Aufrufstelle sichtbar ist, welche der beiden
   Sorten gerade geholt wird. */

/** Die Konto-Kennung für die Adresse der Twilio-Schnittstelle. */
export function kontoSid(): string { return config.twilio.accountSid.trim(); }

/** Der Auth Token — Passwort für den Versand UND HMAC-Schlüssel für die
    Signaturprüfung eingehender Webhooks. */
export function authToken(): string { return config.twilio.authToken.trim(); }

/** Dons eigene Twilio-Nummer, aus der SMS hinausgehen. */
export function eigeneNummer(): string { return config.twilio.nummer.trim(); }

/**
 * Die vollständige Adresse, die in der Twilio-Console stehen muss — und über
 * die `http/smseingang.ts` die Signatur bildet.
 *
 * WARUM SIE HINTERLEGT WIRD UND NICHT AUS DER ANFRAGE STAMMT. Twilio
 * signiert die Adresse, die im Konto eingetragen ist. Der naheliegende Weg
 * wäre, sie aus `Host` und Pfad der eingehenden Anfrage zusammenzusetzen —
 * genau das ist die Lücke: `Host` kommt vom Aufrufer. Wer eine für IRGENDEINE
 * Twilio-Adresse gültige Signatur mitschneidet (eine andere Anwendung
 * desselben Kontos, ein alter Endpunkt), könnte sie hier einreichen und den
 * `Host` passend dazu setzen — und die Prüfung ginge auf. Eine hinterlegte
 * Adresse schließt das: die Signatur muss über GENAU diese eine Adresse
 * gerechnet worden sein, und über keine andere.
 *
 * `null`, solange nichts hinterlegt ist. Der Endpunkt weist dann alles ab
 * (fail closed) — nicht, weil eine Adresse fehlte, sondern weil sich ohne sie
 * überhaupt keine Signatur nachrechnen lässt.
 */
export function webhookAdresse(): string | null {
  const basis = webhookBasis();
  return basis ? `${basis}${EINGANG_PFAD}` : null;
}

/** Nur die Wurzel, ohne Pfad — der Wert, den jemand eingetragen hat und
    wieder im Eingabefeld sehen soll. Die vollständige Adresse daneben ist
    das, was in die Twilio-Console gehört; beide kommen aus dieser einen
    Quelle, damit die angezeigte Adresse nie eine andere ist als die, über
    die die Signatur gerechnet wird. */
export function webhookBasis(): string | null {
  return decryptField(getSetting(S_WEBHOOK_BASIS)).trim().replace(/\/+$/, '') || null;
}

/** Was man ohne Geheimnisse über den Zugang sagen darf. */
export function zugangStand(): {
  sid: GeheimStand; token: GeheimStand; nummer: GeheimStand;
  webhookBasis: string | null;
  webhookAdresse: string | null;
  sendenBereit: boolean; eingangBereit: boolean; verschluesselt: boolean;
} {
  const sid = sidStand();
  const token = tokenStand();
  const nummer = nummerStand();
  return {
    sid, token, nummer,
    webhookBasis: webhookBasis(),
    webhookAdresse: webhookAdresse(),
    /* Senden braucht alle drei: ohne Nummer gäbe es keinen Absender, ohne SID
       keine Adresse und ohne Token keine Anmeldung. */
    sendenBereit: sid.hinterlegt && token.hinterlegt && nummer.hinterlegt,
    /* Empfangen braucht nur zwei — die eigene Nummer steht in der Anfrage
       selbst. Getrennt gemeldet, damit die Maske nicht „nicht eingerichtet"
       sagt, während in Wahrheit schon SMS ankommen. */
    eingangBereit: token.hinterlegt && webhookAdresse() !== null,
    /* Ohne Masterpasswort liegt die Webhook-Adresse im Klartext in der
       Datenbank — kein Fehler, aber die Verwaltung soll es wissen. Derselbe
       Hinweis wie bei mailzugang.zugangStand(). */
    verschluesselt: encryptionActive(),
  };
}

/**
 * Setzen — leere Felder lassen den bisherigen Wert stehen.
 *
 * Dieselbe Zusage wie bei `mailzugang.zugangSetzen()`: die Webhook-Adresse
 * lässt sich ändern, ohne den Auth Token noch einmal einzutippen, den man
 * nirgends mehr ablesen kann. Wer wirklich löschen will, nimmt
 * `zugangLoeschen()` weiter unten — ein leeres Feld ist im Zweifel ein
 * vergessenes Feld, kein Löschbefehl.
 *
 * DER TRESOR WIRD VORHER GEFRAGT, nicht hinterher entschuldigt: ohne
 * Masterpasswort bricht `tresorSetzen()` ab, und dann darf nicht die halbe
 * Eingabe (die Webhook-Adresse in `app_settings`) schon gespeichert sein,
 * während die andere Hälfte fehlschlägt. Deshalb steht die Prüfung ganz
 * oben — vor der ersten Schreiboperation.
 */
export function zugangSetzen(
  werte: { sid?: string; token?: string; nummer?: string; webhookBasis?: string },
  userId: string,
): void {
  const willTresor = Boolean(werte.sid || werte.token || werte.nummer);
  if (willTresor && !sidStand().schreibbar) {
    throw abweisung('fehler.tresorOhneMasterpasswort',
      'Ohne Masterpasswort lässt sich der verschlüsselte Tresor nicht beschreiben.');
  }

  try {
    if (werte.sid)    tresorSetzen(TRESOR_SID, werte.sid.trim());
    if (werte.token)  tresorSetzen(TRESOR_TOKEN, werte.token.trim());
    if (werte.nummer) tresorSetzen(TRESOR_NUMMER, werte.nummer.trim());
  } catch (err) {
    /* Die Ursache geht mit (`cause`), damit im Protokoll steht, woran es lag —
       draußen bleibt ein Satz ohne Hinweis auf den Inhalt. Wortgleich mit
       services/kizugang.ts. */
    throw abweisung('fehler.tresorSchreibprobe',
      'Der Tresor ließ sich nicht beschreiben.', undefined, err);
  }

  if (werte.webhookBasis) {
    setSetting(S_WEBHOOK_BASIS,
      encryptField(werte.webhookBasis.trim().replace(/\/+$/, '')), userId);
  }

  /* Eine Spur, ohne Spur der Werte: WER wann WELCHE der vier Angaben
     angefasst hat, gehört ins Protokoll — WAS er eingetragen hat, unter
     keinen Umständen. Dieselbe Zeile wie in kizugang.ts. */
  const angefasst = [
    werte.sid && 'SID', werte.token && 'Token',
    werte.nummer && 'Nummer', werte.webhookBasis && 'Webhook-Adresse',
  ].filter(Boolean).join(', ');
  console.log(`[secrets] Twilio-Zugang über die Einstellungen geändert (${angefasst || 'nichts'}, von ${userId}).`);
}

/** Alles wegräumen — die drei Tresoreinträge UND die Webhook-Adresse.
    Die Adresse muss mit: bliebe sie stehen, zeigte die Oberfläche weiter eine
    Adresse an, hinter der kein Konto mehr steht, und der Endpunkt nähme
    weiter Anfragen entgegen, die er mangels Token ohnehin nie beglaubigen
    kann. Ein halb entfernter Zugang ist schlimmer als gar keiner. */
export function zugangLoeschen(userId: string): void {
  if (!sidStand().schreibbar) {
    throw abweisung('fehler.tresorOhneMasterpasswort',
      'Ohne Masterpasswort lässt sich der verschlüsselte Tresor nicht beschreiben.');
  }
  for (const name of [TRESOR_SID, TRESOR_TOKEN, TRESOR_NUMMER]) tresorSetzen(name, null);
  setSetting(S_WEBHOOK_BASIS, null, userId);
  console.log(`[secrets] Twilio-Zugang über die Einstellungen entfernt (von ${userId}).`);
}
