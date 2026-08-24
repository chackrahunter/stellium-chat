/**
 * Erkennt einen Polaritäts-Widerspruch zwischen zwei Übersetzungen DERSELBEN
 * Nachricht — einmal ohne, einmal mit Gesprächskontext — und ist NICHTS
 * ANDERES als das.
 *
 * ANLASS (siehe Bericht, Rückfrage der Koordination)
 *
 * Gemessen (scripts/polaritaet-messen.mjs, 216 Läufe, temperature 0, je drei
 * Wiederholungen): Kontext kippt "lass mal lieber" (eine Absage) verlässlich
 * zu "Let's just do it live" (eine Zusage) — 6 von 6 Wiederholungen, sowohl
 * nach einem begeisterten als auch nach einem neutralen Vorschlag. Alle
 * anderen elf getesteten Absage-Floskeln und alle zwölf Zusage-Floskeln
 * blieben stabil. Eine Anweisungszeile ("die Polarität der Nachricht hat
 * immer Vorrang") wurde ebenso gemessen und schloss die Lücke NICHT — dafür
 * zerstörte sie den einen sauber belegten Gewinn der Kontext-Ergänzung (der
 * "geht klar"-Fall, siehe Rückfall-Kontrolle in polaritaet-messen.mjs).
 *
 * Entscheidung der Koordination: nicht verhindern, sondern erkennen.
 * translateMessage() (siehe index.ts) übersetzt die betroffene, enge
 * Bevölkerung — kurz UND mit echtem Verlauf, siehe kurzUndMitVerlauf dort —
 * zweimal: einmal mit Kontext, einmal ohne. Stimmen die beiden in der
 * Polarität übereinander, gewinnt die kontextreichere (der eigentliche
 * Zweck der Übung). Widersprechen sie sich, gewinnt die Version OHNE
 * Kontext — deren Fehlerbild ist eine falsche Übersetzung, die eine lesende
 * Person hinterfragt ("I'm not making a problem" klingt komisch), nicht eine
 * flüssige, plausible Anweisung, die falsch herum ist ("Let's just do it
 * live" klingt wie ein Startsignal).
 *
 * WAS DAS HIER AUSDRÜCKLICH NICHT IST
 *
 * Kein allgemeiner Stimmungs-/Politik-Klassifizierer. Er beurteilt nicht,
 * ob ein Text insgesamt positiv oder negativ klingt — nur, ob er eine klare,
 * unzweideutige ZUSAGE ("ich mache das") oder eine klare, unzweideutige
 * ABSAGE ("ich mache das nicht") zu einer vorgeschlagenen Handlung ist. Ein
 * Text, der keins von beidem eindeutig ist, gilt als UNKLAR — und ein
 * UNKLAR zählt nie als Widerspruch (siehe polaritaetsWiderspruch unten):
 * sonst wäre der "geht klar"-Gewinn selbst das erste Opfer (siehe dort,
 * "It's all good" ist weder Zusage noch Absage, und das ist richtig so).
 *
 * MEHRSPRACHIG, ABER NUR NACH PRÜFUNG (siehe ZIELSPRACHEN_MIT_GEPRUEFTER_
 * WACHE in index.ts) — WACHE ZUERST, DANN KONTEXT, NICHT UMGEKEHRT.
 *
 * Englisch: scripts/polaritaet-messen.mjs (216 Läufe, 6 echte Invertierungen
 * als Grundwahrheit) — 100 % Trefferquote, 0 % Fehlalarm auf echten Daten,
 * 15/16 auf einer unabhängigen gehaltenen Stichprobe. Deshalb in
 * ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE gelistet.
 *
 * Deutsch (EN→DE): scripts/polaritaet-de-messen.mjs, scripts/
 * polaritaet-de-entdecken.mjs — GEPRÜFT, ABSICHTLICH NICHT GEÖFFNET.
 * Im Entdeckungslauf (36 Standardfälle + 8 absichtlich extrem elliptische
 * Stichproben ohne jede Verneinung, um gezielt ein "lass mal lieber"-
 * Gegenstück zu suchen) fand sich KEINE einzige echte Invertierung —
 * anders als bei Englisch gibt es hier also keine bekannte Bedrohung, die
 * die Wortlisten unten nachweislich abfangen. Die Wortlisten selbst zeigen
 * durchgängig 0 Fehlalarm (84 Prüfungen: 44 echte Modellausgaben + 40
 * gehaltene Paare über vier Runden). Die TREFFERQUOTE auf frisch
 * erdachten, nie zum Bauen der Muster verwendeten Paaren fiel dagegen von
 * Runde zu Runde, je frischer die Stichprobe: 12/12, 9/9, 7/9, zuletzt
 * 4/10 auf der unberührtesten Runde — ein Hinweis, dass die
 * vorherigen Runden das Bild bereits beschönigten, nicht dass Deutsch
 * grundsätzlich schwerer zu fassen wäre. Diese Trefferquote erreicht
 * NICHT dieselbe Verlässlichkeit wie bei Englisch. Deshalb: Deutsch
 * bleibt NICHT in ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE, trotz der Vorarbeit
 * — eine Wache, die auf frischen Fällen nur 40 % einer erfundenen
 * Invertierung fängt, wäre genau das Risiko, vor dem die Koordination
 * gewarnt hat: sieht geprüft aus, ist es aber nicht verlässlich.
 * Vollständige Zahlen im Bericht; die Entscheidung kann mit dieser
 * Grundlage jederzeit anders getroffen werden.
 *
 * NACHTRAG — NUTZEN GEMESSEN, NICHT NUR SCHADENSABWESENHEIT: scripts/
 * kontext-de-messen.mjs (KONTEXT_KORPUS_DE), dieselbe Bauart wie die
 * ursprüngliche Kontext-Messung für Englisch. Ergebnis: 50 % → 58 % roh,
 * deutlich schwächer als die 88 % → 93 % bei Englisch. Wichtiger als die
 * Prozentzahl: der schärfste Testfall aus Runde 1 — derselbe Ausgangstext,
 * zwei Kontexte, zwei unterschiedlich richtige Übersetzungen ("geht klar")
 * — hat für Deutsch NICHT sauber repliziert. "I'm good" nach einem Angebot
 * blieb mit Kontext falsch (tendenziell sogar in eine andere falsche
 * Richtung: "Mir geht's gut", eine Befindensauskunft, wo eine Ablehnung
 * gemeint war) und "I'm good" nach einer Befindens-Nachfrage wurde nur in
 * zwei von drei Wiederholungen richtig. Ein Fall zeigte einen echten,
 * handfesten Gewinn ("you got it" nach einer Bitte: ohne "Du hast Recht"
 * (falsch), mit "Hab es kapiert" (richtige Richtung, wenn auch nicht
 * idiomatisch perfekt) — von den erwartet/verboten-Mustern nicht erfasst,
 * von Hand gelesen). Insgesamt: ein kleinerer, gemischter Nutzen, nicht der
 * klare Fall wie bei Englisch — dritter, unabhängiger Befund in dieselbe
 * Richtung wie die schwache Trefferquote oben.
 *
 * Für jede Zielsprache, die hier unten KEINEN eigenen Eintrag in `MUSTER`
 * hat, liefert klassifizierePolaritaet() immer 'unklar' — und
 * polaritaetsWiderspruch() damit immer `false`. Das ist beabsichtigt, kein
 * Bug: index.ts ruft diese Funktion für eine ungeprüfte Zielsprache ohnehin
 * nie auf (siehe ZIELSPRACHEN_MIT_GEPRUEFTER_WACHE dort), aber selbst wenn,
 * wäre "nie ein Widerspruch erkannt" der sichere Rückfall, nicht "jeder
 * Fall ein Widerspruch".
 */

export type Polaritaet = 'zusage' | 'absage' | 'unklar' | 'beides';

interface Musterpaar { absage: RegExp; zusage: RegExp }

/**
 * Englische Muster — unverändert gegenüber der ersten Prüfung (siehe
 * scripts/polaritaet-messen.mjs: 100 % Trefferquote auf 6 bekannten
 * Invertierungen, 0 % Fehlalarm auf 108 echten Nicht-Widersprüchen, plus
 * eine unabhängige gehaltene Stichprobe).
 */
const ABSAGE_MUSTER_EN = new RegExp(
  [
    "let'?s not", 'rather not', 'better not', "i(?:'?d|\\s+would) (?:rather (?:not|skip|pass)|hold off|skip|pass)",
    "wouldn'?t", "(?:would|i would) not\\b", "won'?t", "shouldn'?t", "(?:should|i should) not\\b",
    "don'?t think (?:so|we should)", 'hold off', 'not (?:right )?now\\b', 'not yet\\b',
    "i(?:'?ll|\\s+will) (?:pass|skip)\\b", 'leave it(?: be)?\\b', 'let it be',
    'better (?:to )?hold off', 'not a good idea', "i(?:'?d|\\s+would) say (?:no|not)",
    "no,? let'?s", "i'?ll leave it", "can'?t\\b.{0,20}\\b(?:today|anymore)\\b",
    "not going to\\b", 'better wait', "i(?:'?d|\\s+would) wait", 'hold on (?:for now|a bit)',
    "let'?s wait", "i(?:'?d|\\s+would) hold off", 'not (?:really |)feeling (?:it|this)\\b', "i(?:'?m|\\s+am) not (?:feeling|up for) (?:it|this)",
    'no thanks', "i'?ll sit this one out",
  ].join('|'),
  'i',
);
const ZUSAGE_MUSTER_EN = new RegExp(
  [
    "let'?s\\b[^.!?]{0,20}\\b(?:do it|do that|do this|go for it|go ahead|proceed|launch it|go live)\\b",
    "let\\s+us\\b[^.!?]{0,20}\\b(?:do it|do that|do this|go for it|go ahead|proceed|launch it|go live)\\b",
    "yes,?\\s+let'?s\\b", 'sure\\b', 'of course', 'definitely', 'absolutely',
    "i(?:'?m|\\s+am) (?:in|down|game|for it|on board)\\b", 'sounds good', 'why not',
    'count me in', 'will do', 'on it\\b',
    "i(?:'?ll|\\s+will) (?:do it|take care|handle|get (?:it|that|on it))\\b",
    "let'?s go\\b", 'got it\\b', "i(?:'?m|\\s+am) on (?:it|top of it|board)\\b",
    'fine by me', 'works for me', "i(?:'?m|\\s+am) (?:happy|glad|game) to", 'sounds like a plan',
    'go for it\\b',
  ].join('|'),
  'i',
);

/**
 * Deutsche Muster — gebaut aus 36 realen EN→DE-Übersetzungen (12 Absage- +
 * 12 Zusage-Floskeln × 2 Vorschlagsarten, je 3 Wiederholungen) plus 8
 * zusätzlichen, absichtlich extrem elliptischen Stichproben ("na", "eh,
 * later", "meh, later", "we'll see" — ohne jede explizite Verneinung, um
 * gezielt nach einem "lass mal lieber"-Gegenstück auf der Englisch-Seite zu
 * suchen). Keine davon kippte. Die Muster hier sind darum an ECHTEN
 * Modellausgaben kalibriert (0 Fehlalarm auf allen 44 Fällen), nicht nur
 * ausgedacht — siehe scripts/polaritaet-de-messen.mjs für den Lauf.
 */
const ABSAGE_MUSTER_DE = new RegExp(
  [
    'lass uns nicht', 'besser nicht', 'lieber nicht', 'eher nicht',
    'ich (?:würde|wuerde) (?:das |es )?nicht', 'nicht jetzt', 'nicht gerade jetzt',
    'ich passe\\b', 'vielleicht nicht', 'ich denke nicht', 'ich glaube?\\s+nicht',
    'ich halte mich zurück', 'ich (?:würde|wuerde) .{0,30}warten', 'ich überspringe',
    'für (?:jetzt|den moment) sein lassen', 'lass es für (?:jetzt|den moment) sein',
    '\\blass es(?: einfach)?\\b(?! nicht)', 'kein bock', 'schaffe ich nicht', 'ich schaffe das nicht',
    'ich mache das nicht', 'wir (?:werden sehen|sehen mal)', 'nicht das richtige für mich',
    '(?:äh|meh|hmm)?,? ?später\\b', '\\bna\\b(?! klar)',
    '(?:ich )?bin raus\\b', 'lieber (?:warten|nicht|lassen)', 'lass uns lieber\\b',
    'muss(?: das)?(?: nicht unbedingt| nicht)\\s+sein\\b',
    'eher (?:skeptisch|zurückhaltend|vorsichtig|unsicher|kritisch)\\b',
    'passt (?:mir |dir |)?(?:grad |gerade |)nicht\\b',
    '(?:würde?|wuerde?) ich lassen\\b', 'kein interesse\\b', 'keine kapazität\\b',
    '\\bsagen? .{0,10}ab\\b', '\\bsage ich ab\\b', '\\babsagen\\b', 'warten wir\\b',
  ].join('|'),
  'i',
);
const ZUSAGE_MUSTER_DE = new RegExp(
  [
    "machen wir(?:'s)?\\b", "(?:fangen|legen) wir .{0,10}an\\b",
    "lass uns\\b(?:[^.!?]{0,20}\\b(?:machen|anfangen|beginnen|loslegen|gehen|ran)\\b)?\\s*[.!]?$",
    '\\bklar\\b', 'natürlich', 'auf jeden fall', 'definitiv', 'absolut',
    '(?:ich )?bin\\s+(?:voll\\s+|total\\s+|)(?:dabei|drin|da|für|überzeugt)\\b',
    'zähl mich mit', 'kein problem', '\\bmach ich\\b', 'geht klar', 'gerne\\b',
    '(?<!nicht )(?<!nicht\\s)unbedingt\\b',
    "los geht's", '\\bleg los\\b', 'ich mache das\\b(?! nicht)', "ja,? (?:machen wir|lass uns|los)",
    'klingt gut', '\\bsage ich zu\\b', '\\bzusagen\\b',
  ].join('|'),
  'i',
);

/** Nur Zielsprachen mit einer geprüften Wache stehen hier — siehe oben. */
const MUSTER: Record<string, Musterpaar> = {
  en: { absage: ABSAGE_MUSTER_EN, zusage: ZUSAGE_MUSTER_EN },
  de: { absage: ABSAGE_MUSTER_DE, zusage: ZUSAGE_MUSTER_DE },
};

/**
 * Klassifiziert EINEN Text in seiner Zielsprache. `beides` (beide Muster
 * treffen) zählt bewusst NICHT als eindeutig — siehe polaritaetsWiderspruch().
 * Eine Zielsprache ohne Eintrag in MUSTER liefert immer 'unklar' (siehe
 * Dateikopf).
 */
export function klassifizierePolaritaet(text: string, zielsprache: string): Polaritaet {
  const paar = MUSTER[zielsprache];
  if (!paar) return 'unklar';
  const absage = paar.absage.test(text);
  const zusage = paar.zusage.test(text);
  if (absage && zusage) return 'beides';
  if (absage) return 'absage';
  if (zusage) return 'zusage';
  return 'unklar';
}

/**
 * true, wenn `ohne` und `mit` sich WIDERSPRECHEN — eine Seite eindeutig
 * Zusage, die andere eindeutig Absage. Alles andere (eine oder beide Seiten
 * `unklar`/`beides`, oder beide Seiten dieselbe Richtung) ist KEIN
 * Widerspruch: die Messlatte ist absichtlich hoch, damit dieselbe Prüfung
 * nicht bei jeder bloß andersartigen (aber gleichsinnigen) Formulierung
 * anschlägt — genau das hätte den "geht klar"-Gewinn gekostet (siehe oben).
 */
export function polaritaetsWiderspruch(ohne: string, mit: string, zielsprache: string): boolean {
  const o = klassifizierePolaritaet(ohne, zielsprache);
  const m = klassifizierePolaritaet(mit, zielsprache);
  return (o === 'absage' && m === 'zusage') || (o === 'zusage' && m === 'absage');
}
