import { geheimStand, tresorSetzen, type GeheimStand } from '../config.js';
import { abweisung } from '../util/abweisung.js';
import { dropForeignTranslations, providerNeuAufbauen } from '../translation/index.js';

/**
 * Der Groq-Schlüssel — hinterlegen und wechseln, ohne SSH und ohne Neustart.
 *
 * WARUM ES DAS GIBT. Er ließ sich bis hierher nur über `GROQ_API_KEY` in der
 * .env setzen oder über `npm run secret -w @stellium/server -- setzen groq`.
 * Beides braucht eine Sitzung auf dem Server, und beides wirkte erst beim
 * nächsten Start. Damit war der Schlüssel, an dem die gesamte KI hängt, das
 * einzige Geheimnis des Hauses ohne Weg über die Oberfläche — Gumroad,
 * Patreon, Postfach und Fernzugang haben ihn längst.
 *
 * WO ER LIEGT, UND WARUM NICHT DORT, WO DIE ANDEREN LIEGEN. Gumroad und die
 * übrigen stehen in `app_settings`, mit `crypto/pii.ts` verschlüsselt. Der
 * Groq-Schlüssel liegt seit jeher im Tresor `data/secrets.enc` (config.ts,
 * `secret('GROQ_API_KEY', 'groq')`), und dabei bleibt es. Ihn zusätzlich in
 * die Datenbank zu legen, hieße denselben Schlüssel an zwei Orten zu führen
 * — und dann müsste irgendjemand entscheiden, welcher der beiden gilt.
 * Genau diese Frage soll hier niemand stellen müssen: es gibt zwei Quellen,
 * die Umgebung und den Tresor, und die Vorrangregel dazwischen ist eine
 * einzige Zeile in `secret()`.
 *
 * WAS ZURÜCKKOMMT: nie der Schlüssel, auch nicht gekürzt — siehe
 * `GeheimStand` in config.ts. Nur Wahrheitswerte, und einer davon ist der
 * wichtigste: `quelle`. Steht `GROQ_API_KEY` in der Umgebung, schlägt sie den
 * Tresor, und dann muss die Maske sagen, dass das Speichern zwar geklappt
 * hat, aber nicht wirkt. Ein „Gespeichert." über einem Wert, den niemand
 * benutzt, ist schlimmer als eine Fehlermeldung.
 */

const UMGEBUNGSNAME = 'GROQ_API_KEY';
const TRESORNAME = 'groq';

export function schluesselStand(): GeheimStand {
  return geheimStand(UMGEBUNGSNAME, TRESORNAME);
}

/**
 * Setzen — oder, bei leerem Wert, entfernen.
 *
 * LEER HEISST LÖSCHEN, NICHT „leeren Text ablegen". Ein Eintrag mit leerem
 * Wert stünde in der Tresorliste als vorhanden und wäre für jede Prüfung
 * („ist ein Schlüssel da?") trotzdem nichts. Danach fällt der Server sauber
 * in den Zustand ohne KI zurück: `aiConfigured()` sagt nein, `build()` in
 * translation/index.ts setzt den Demo-Anbieter, und die Einstellungen zeigen
 * `hinweis.keinSchluessel`.
 *
 * DER ANBIETER WIRD NEU GEBAUT, sonst wäre die halbe Arbeit umsonst.
 * `config.ai.groq.apiKey` ist seit dieser Änderung ein Getter und damit
 * sofort aktuell — die Anbieter-INSTANZ hat den alten Schlüssel aber beim
 * Bauen mitgenommen (openai-compatible.ts, `createGroqProvider()`) und
 * schickte ihn weiter an Groq. Erst `providerNeuAufbauen()` schließt die
 * Lücke; danach benutzt die nächste Anfrage wirklich den neuen Wert.
 *
 * DASS DABEI ÜBERSETZUNGEN WEGFALLEN, ist Absicht und kein Nebenschaden.
 * Bis hierher konnte ein Schlüssel nur vor dem Start dazukommen, und dann
 * räumte index.ts die Reste des Demo-Anbieters beim Hochfahren weg
 * (dropForeignTranslations, siehe Kommentar dort — der beschreibt genau
 * diesen Fall). Ohne Neustart gibt es dieses Aufräumen nicht mehr, also
 * gehört es hierher: sonst bliebe der unübersetzte Demo-Text stehen,
 * ausgerechnet nachdem jemand die Übersetzung gerade eingeschaltet hat.
 */
export async function schluesselSetzen(wert: string, userId: string): Promise<GeheimStand> {
  const sauber = wert.trim();

  /* Vorher fragen statt hinterher übersetzen: `tresorSetzen()` wirft einen
     gewöhnlichen Error mit deutschem Satz — richtig für eine Ablage, die
     nichts von Oberflächensprachen weiß. Die Grenze nach draußen braucht
     dagegen eine Kennung, sonst steht der deutsche Satz auf jedem Schirm
     (siehe util/abweisung.ts). `tresorSetzen()` prüft es zusätzlich selbst;
     diese Zeile nimmt ihm nur die Aufgabe ab, die Meldung zu formulieren. */
  if (!geheimStand(UMGEBUNGSNAME, TRESORNAME).schreibbar) {
    throw abweisung('fehler.tresorOhneMasterpasswort',
      'Ohne Masterpasswort lässt sich der verschlüsselte Tresor nicht beschreiben.');
  }

  try {
    tresorSetzen(TRESORNAME, sauber || null);
  } catch (err) {
    /* Die Ursache geht mit (`cause`), damit im Protokoll steht, woran es lag —
       draußen bleibt ein Satz, der niemandem etwas über den Inhalt verrät. */
    throw abweisung('fehler.tresorSchreibprobe',
      'Der Tresor ließ sich nicht beschreiben.', undefined, err);
  }

  await providerNeuAufbauen();
  dropForeignTranslations();

  /* Eine Spur, ohne Spur des Werts: WER wann etwas verändert hat, gehört ins
     Protokoll — WAS er eingetragen hat, unter keinen Umständen. */
  console.log(`[secrets] Groq-Schlüssel über die Einstellungen ${sauber ? 'gesetzt' : 'entfernt'} (von ${userId}).`);

  return schluesselStand();
}
