/**
 * Die eine Entscheidung, wann `textKi` im Schreibfenster (PostSchreiben.tsx)
 * geleert werden muss — als eigene, reine Funktion ausgelagert, damit sie
 * sich ohne React/DOM prüfen lässt (siehe
 * scripts/post-schreiben-textki-pruefen.mjs). Keine Importe hier, absichtlich:
 * jeder Import würde den Prüflauf zwingen, React, den Store, i18n und ein
 * CSS-Modul mitzuladen, nur um eine einzeilige Regel zu testen — und genau
 * deshalb wird `veraenderung()` aus post-wissen-ki.ts unten NACHGEBAUT statt
 * importiert: @stellium/desktop hat @stellium/server nicht einmal als
 * Abhängigkeit (siehe package.json — nur @stellium/shared), ein Import über
 * die Paketgrenze wäre ein Griff quer durchs Backend, nur um eine Wortmenge
 * zu bilden. Die REGEL ist NICHT exakt dieselbe wie `veraenderung()` — siehe
 * „DIE GRUSSFORMEL-LÜCKE" weiter unten für den bewussten Unterschied und
 * genau die Richtung, in der beide trotzdem übereinstimmen MÜSSEN — deshalb
 * prüft scripts/post-schreiben-textki-pruefen.mjs diese Funktion zusätzlich
 * GEGEN das echte `veraenderung()` aus dem Server (Kreuzprobe, keine zweite,
 * unabhängige Meinung, nur eben keine Gleichheitsprobe mehr).
 *
 * `textKi` ist der bytegleiche Wortlaut des zuletzt von der KI gelieferten
 * Entwurfs (PostSchreiben.tsx, `kiSchreiben()`) — geht beim Senden als
 * `textKi` an `/api/post/senden`, wo `post.ts::senden()` ihn gegen den
 * tatsächlich gesendeten Text vergleicht (`kiHerkunft()`,
 * services/post-fussnote.ts) und daraus die Fußzeile setzt. WICHTIG: dieser
 * Vergleich unterscheidet NIE zwischen „stark bearbeitet" und „unabhängig
 * davon neu geschrieben" — jedes gesetzte `textKi` führt zu MINDESTENS
 * „mithilfe von … bearbeitet", nie zu gar keiner Fußzeile (siehe
 * `kiHerkunft()`: `if (!textKi) return null;` ist der einzige Ausweg). Reitet
 * ein veraltetes `textKi` an unabhängigem Text mit, behauptet die
 * ausgehende Mail fälschlich eine KI-Beteiligung, die es nicht gab — eine
 * falsche Tatsachenbehauptung gegenüber dem Empfänger, und das nicht nur,
 * wenn die Box zwischenzeitlich LEER war: „alles markieren, neu tippen"
 * ersetzt den Text, ohne je durch `''` zu laufen.
 *
 * DIE REGEL — WORTMENGE, NICHT ZEICHENFOLGE, ÄHNLICH WIE `veraenderung()`
 * Wörter ab vier Buchstaben, kleingeschrieben, ohne Satzzeichen (derselbe
 * Zuschnitt wie `begriffe()` in post-wissen-ki.ts). Teilt der neue Text mit
 * `textKi` KEIN EINZIGES dieser Wörter, stammt er nicht von diesem Entwurf
 * ab — `textKi` geht auf `null` zurück, ob die Box dabei je leer war oder
 * nicht. Teilt er auch nur eines, bleibt `textKi` stehen, und sei die
 * Änderung sonst noch so groß: genau das ist der gewollte Fall „ein Mensch
 * hat den KI-Entwurf bearbeitet" (siehe post-fussnote.ts, Dateikopf: „im
 * Zweifel gilt eine Antwort als von der KI erstellt, nie umgekehrt" — das
 * gilt für die STÄRKE einer Bearbeitung, nicht dafür, ob überhaupt noch
 * derselbe Text vorliegt). Eine vollständig geleerte Box ist der Sonderfall
 * ohne jedes Wort auf beiden Seiten und fällt unter dieselbe Regel, wird
 * hier aber weiter zuerst und ohne Wortvergleich abgefangen — spart die
 * Fallunterscheidung „kein Wort auf keiner Seite = 0 % Änderung" aus
 * `veraenderung()`, die für eine leere Box ohnehin dasselbe Ergebnis liefert.
 *
 * DIE GRUSSFORMEL-LÜCKE — WARUM DIESE FUNKTION VON `veraenderung()` ABWEICHT
 * „Auch nur ein gemeinsames Wort reicht" war zu großzügig: die ganze
 * Mail steht in EINER Box, und eine unabhängig verfasste Antwort trägt in
 * aller Regel dieselbe Firmenanrede und -grußformel wie der KI-Entwurf —
 * „Sehr geehrte Damen und Herren" … „Mit freundlichen Grüßen" teilt fünf
 * Wörter ab vier Buchstaben mit praktisch jedem KI-Entwurf, der denselben
 * Hausstil trägt, ganz ohne dass der neue Text auch nur einen Satz vom alten
 * Entwurf übernommen hätte. Diese Wörter zählen deshalb NICHT als geteilter
 * Inhalt (siehe `ANREDE_GRUSS_WOERTER` unten) — nur Wörter AUSSERHALB von
 * Anrede und Grußformel machen `textKi` zu einer bearbeiteten Fassung DESSELBEN
 * Entwurfs. Das lässt `textKiNachTextaenderung()` bewusst von `veraenderung()`
 * im Server abweichen (das zählt jedes Wort, auch Anrede/Gruß, siehe dessen
 * Dateikopf in post-wissen-ki.ts — dort ist das richtig, weil es dort nur um
 * die STÄRKE einer bereits als „bearbeitet" erkannten Änderung geht, nicht
 * darum, ob überhaupt noch bearbeitet statt neu geschrieben wurde). Der
 * Kreuzprobe in scripts/post-schreiben-textki-pruefen.mjs bleibt trotzdem
 * etwas Festes übrig: räumt der Server (`veraenderung() === 1`, gar kein
 * gemeinsames Wort, nicht einmal Anrede/Gruß), räumt dieser Client-Code
 * IMMER auch — eine schmalere Wortmenge kann eine bereits leere Schnittmenge
 * nicht wieder auffüllen. Die Prüfdatei stellt diese einseitige Folgerung
 * jetzt sicher, statt Gleichheit zu verlangen, und benennt die Stelle, an
 * der beide bewusst auseinanderlaufen.
 *
 * WAS EIN NUTZER TUN MUSS, DAMIT DIE FUSSZEILE VERSCHWINDET: irgendetwas
 * abseits von Anrede und Grußformel aus dem KI-Entwurf loswerden — ein
 * einziges übernommenes Wort aus dem eigentlichen Anliegen reicht schon,
 * um `textKi` stehen zu lassen (gewollt, siehe oben); bleibt dagegen NICHTS
 * außer der Anrede/dem Gruß vom Entwurf übrig, geht `textKi` auf `null`,
 * und die Mail geht ohne KI-Fußzeile hinaus.
 *
 * Ein neuer KI-Entwurf ersetzt `textKi` ohnehin direkt mit dem neuen
 * Wortlaut, ohne über diese Funktion zu gehen (siehe PostSchreiben.tsx,
 * `kiSchreiben()`) — das ist kein Leeren, sondern ein Austausch.
 */
export function textKiNachTextaenderung(
  bisherigerTextKi: string | null,
  neuerText: string,
): string | null {
  if (bisherigerTextKi === null) return null;
  if (neuerText === '') return null;
  const alt = begriffe(bisherigerTextKi);
  const neu = begriffe(neuerText);
  let gemeinsam = 0;
  // Ein reines Anrede-/Gruß-Wort zählt nicht als geteilter Inhalt -- siehe
  // "DIE GRUSSFORMEL-LÜCKE" oben. Nur die UNION (`vereinigung` unten) bleibt
  // ungefiltert: die geht nur in die Sonderfall-Prüfung "gibt es überhaupt
  // Wörter auf beiden Seiten", nicht in den Wortvergleich selbst.
  for (const wort of alt) if (neu.has(wort) && !ANREDE_GRUSS_WOERTER.has(wort)) gemeinsam += 1;
  const vereinigung = alt.size + neu.size - gemeinsam;
  // Kein einziges (echtes, nicht nur Anrede-/Gruß-)Wort gemeinsam, aber
  // überhaupt welche vorhanden: der neue Text stammt nicht von diesem
  // Entwurf ab (ähnlich `veraenderung(bisherigerTextKi, neuerText) === 1`
  // in post-wissen-ki.ts, aber schmaler -- siehe "DIE GRUSSFORMEL-LÜCKE").
  if (vereinigung > 0 && gemeinsam === 0) return null;
  return bisherigerTextKi;
}

/**
 * Anrede- und Grußformel-Wörter, die für sich allein NICHT als geteilter
 * Inhalt zählen (siehe „DIE GRUSSFORMEL-LÜCKE" oben). Bewusst schmal
 * gehalten: nur Anrede und Grußformel, keine allgemeinen Höflichkeitswörter
 * wie „danke" -- die können mitten in einer echten Bearbeitung stehen und
 * sollen weiter zählen. Kein Anspruch auf jede denkbare Anrede der Welt,
 * nur auf die, die als Hausstil tatsächlich in KI-Entwürfen UND in davon
 * unabhängigen Antworten gleichermaßen auftaucht.
 */
const ANREDE_GRUSS_WOERTER = new Set([
  'sehr', 'geehrte', 'geehrter', 'geehrten', 'damen', 'herren',
  'liebe', 'lieber', 'hallo', 'guten', 'morgen', 'abend',
  'freundlichen', 'freundlichem', 'freundliche',
  // Jeweils mit ß/ü UND der "ss"/"ue"-Schreibweise -- `begriffe()` normalisiert
  // Umlaute nicht, beide Schreibweisen kommen in echter Post gleichermaßen vor.
  'grüßen', 'grüssen', 'gruessen', 'grüße', 'grüsse', 'gruesse', 'gruß', 'gruss',
  'hochachtungsvoll', 'beste', 'herzliche', 'herzlichen',
  'dear', 'regards', 'sincerely', 'faithfully',
]);

/** Nachbau von `begriffe()` aus post-wissen-ki.ts — muss wortgleich bleiben, siehe Dateikopf. */
function begriffe(text: string): Set<string> {
  const worte = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ');
  return new Set(worte.filter((w) => w.length >= 4));
}
