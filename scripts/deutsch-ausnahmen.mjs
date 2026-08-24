/**
 * Ausnahmeliste für scripts/deutsch-finden.mjs.
 *
 * Text, der auch dann kein Fund ist, wenn er fest im Code steht — mit Grund.
 * Bewusst von der Prüf-Logik getrennt: eine neue Ausnahme ändert nur diese
 * Datei, nie deutsch-finden.mjs selbst.
 *
 * ZWEI ARTEN VON EINTRAG
 *
 * TEXTE    Dieser genaue Text ist überall im Code in Ordnung — für
 *          Eigennamen und technische Token, die nirgends eine Übersetzung
 *          brauchen (Produktname, Firmenname, Signalton …). Der Abgleich ist
 *          eine exakte Gleichheit auf den bereits auf Leerraum reduzierten
 *          Fund-Text, kein Teiltreffer — sonst nähme "Groq" nebenbei jeden
 *          Satz mit heraus, in dem zufällig "Groq" vorkommt.
 *
 * STELLEN  Eine bestimmte Datei (oder eine Zeile darin) ist in Ordnung — für
 *          Stellen, an denen JEDER Text dort aus einem bestimmten Grund
 *          keine Übersetzung braucht (er wird nie von einem Menschen
 *          gelesen). `datei` ist ein Pfad relativ zur Wurzel des Projekts,
 *          mit / als Trenner.
 *            · endet `datei` auf "/**", gilt die Ausnahme für den ganzen
 *              Ordner (Präfix-Vergleich) — z. B. eine ganze Betreiberkonsole.
 *            · fehlt `zeile`, gilt die Ausnahme für die ganze Datei.
 *            · steht `zeile` dabei, gilt sie nur für diese eine Zeile — der
 *              Rest der Datei bleibt geprüft.
 *
 * PFLICHT: JEDE AUSNAHME TRÄGT EINEN GRUND
 * pruefeAusnahmen() unten wirft beim Start, wenn ein Eintrag ohne (oder mit
 * leerem) `grund` auftaucht. Eine Ausnahme ohne Begründung ist keine
 * Erleichterung, sondern eine Falle: niemand kann später beurteilen, ob sie
 * noch stimmt.
 *
 * VERWAISTE AUSNAHMEN
 * Am Ende jedes Laufs meldet deutsch-finden.mjs jede Ausnahme, die im
 * gesamten Durchlauf kein einziges Mal gegriffen hat. Das ist meist ein
 * Zeichen, dass der Text/Pfad nicht mehr stimmt (umbenannt, verschoben) oder
 * der Fund, für den sie einmal angelegt wurde, längst behoben ist — dann darf
 * die Zeile weg. Eine Ausnahme, die nichts mehr trifft, prüft nichts mehr.
 */

/** @type {{ text: string, grund: string }[]} */
export const TEXTE = [
  { text: 'Stellium', grund: 'Produktname — bleibt in jeder Sprache gleich; steht so auch in der Anweisung an den Übersetzer' },
  { text: 'StelliumAI', grund: 'Name/Kennzeichen des KI-Assistenten-Kontos — ein Eigenname, kein Satz' },
  { text: 'Groq', grund: 'Firmenname, steht als solcher in der Anbieterauswahl' },
  { text: 'OpenAI', grund: 'Firmenname, steht als solcher in der Anbieterauswahl' },
  { text: 'Ollama', grund: 'Programmname in der Anbieterauswahl' },
  { text: 'llama.cpp', grund: 'Programmname in der Anbieterauswahl' },
  { text: 'Patreon', grund: 'Firmenname (Zahlungsanbieter) — steht als solcher in der Verkaufsanbindung' },
  { text: 'Gumroad', grund: 'Firmenname (Zahlungsanbieter) — steht als solcher in der Verkaufsanbindung' },
  { text: 'Cloudflare', grund: 'Firmenname (Infrastrukturanbieter) — taucht in betreibernahen Texten auf, nie in der App-Oberfläche' },
  { text: 'Resend', grund: 'Firmenname (E-Mail-Versand) — steht als solcher in der Postfach-Anbindung' },
  { text: 'Ping', grund: 'Name eines Signaltons, lautmalerisch — in jeder Oberflächensprache derselbe Klang' },
  { text: 'Blip', grund: 'Name eines Signaltons, lautmalerisch — in jeder Oberflächensprache derselbe Klang' },
];

/** @type {{ datei: string, zeile?: number, grund: string }[]} */
export const STELLEN = [
  {
    datei: 'packages/server/src/http/posteingang.ts',
    grund: 'Die deutschen Fehlertexte hier gehen über einen Server-zu-Server-Webhook an einen '
      + 'Cloudflare Worker — kein Mensch bekommt sie je zu sehen.',
  },
  {
    datei: 'packages/server/src/http/konsole.ts',
    grund: 'Registriert die Routen der Betreiberkonsole (nurVonHier()-Gate) und liefert deren HTML aus '
      + 'konsole/seite.ts aus — derselbe Vertrauensbereich wie der Ordner im nächsten Eintrag, nur als '
      + 'Datei DANEBEN statt DARIN. Braucht einen eigenen Eintrag: seit ausgenommeneStelle() in '
      + 'deutsch-finden.mjs bei "ordner/**" korrekt einen abschließenden Schrägstrich verlangt, deckt '
      + '"konsole/**" einen gleichnamigen Datei-Nachbarn ohne Schrägstrich nicht mehr mit ab — zu Recht: '
      + 'sonst würde derselbe Ordnereintrag auch jede andere Datei erfassen, die zufällig genauso beginnt.',
  },
  {
    datei: 'packages/server/src/http/konsole/**',
    grund: 'Lokale Betreiberkonsole für den Pi. nurVonHier() lässt nur 127.0.0.1 ohne Vermittler '
      + 'durch — ihre Seiten liest ausschließlich die Person, die den Server betreibt, nie ein '
      + 'Benutzer der App.',
  },
  {
    datei: 'packages/server/src/services/push.ts',
    zeile: 87,
    grund: 'Intl.DateTimeFormat(\'en-US\', …) dient hier nur dazu, aus einem Zeitpunkt Stunde und '
      + 'Minute als Zahl herauszulesen, für die Ruhezeiten-Arithmetik — das Ergebnis wird nie '
      + 'angezeigt. Von einem früheren Review bereits geprüft und bestätigt.',
  },
  {
    datei: 'packages/server/src/cli/**',
    grund: 'Kommandozeilen-Werkzeuge für die Person, die den Server betreibt (z. B. '
      + '"npm run secret -w @stellium/server -- setzen groq") — Ausgabe erscheint ausschließlich '
      + 'im eigenen Terminal der Betreiberin/des Betreibers, nie in der App. Dieselbe Kategorie '
      + 'wie die Betreiberkonsole oben.',
  },
];

/**
 * Wirft, wenn irgendein Eintrag ohne Grund dasteht. Wird von
 * deutsch-finden.mjs vor jedem Lauf aufgerufen — eine Ausnahme ohne
 * Begründung soll den Lauf nicht leise durchwinken, sondern laut stoppen.
 */
export function pruefeAusnahmen() {
  for (const eintrag of TEXTE) {
    if (!eintrag.text || typeof eintrag.text !== 'string') {
      throw new Error(`deutsch-ausnahmen.mjs: TEXTE-Eintrag ohne 'text': ${JSON.stringify(eintrag)}`);
    }
    if (!eintrag.grund || !eintrag.grund.trim()) {
      throw new Error(`deutsch-ausnahmen.mjs: TEXTE-Eintrag "${eintrag.text}" hat keinen Grund.`);
    }
  }
  for (const eintrag of STELLEN) {
    if (!eintrag.datei || typeof eintrag.datei !== 'string') {
      throw new Error(`deutsch-ausnahmen.mjs: STELLEN-Eintrag ohne 'datei': ${JSON.stringify(eintrag)}`);
    }
    if (!eintrag.grund || !eintrag.grund.trim()) {
      throw new Error(`deutsch-ausnahmen.mjs: STELLEN-Eintrag "${eintrag.datei}" hat keinen Grund.`);
    }
    if (eintrag.zeile !== undefined && (!Number.isInteger(eintrag.zeile) || eintrag.zeile < 1)) {
      throw new Error(`deutsch-ausnahmen.mjs: STELLEN-Eintrag "${eintrag.datei}" hat eine ungültige Zeile: ${eintrag.zeile}`);
    }
  }
}
