/**
 * Miss die Übersetzungsqualität am laufenden Modell — nicht nur, ob
 * überhaupt übersetzt wurde (das misst scripts/echo-pruefen.mjs), sondern ob
 * das Ergebnis taugt.
 *
 * Acht Prüfpunkte je Fall, jeder so gebaut, dass er wirklich durchfallen
 * kann:
 *   1. echo         — kam eine Übersetzung oder der Eingabetext zurück?
 *   2. zielsprache   — steht das Ergebnis wirklich in der Zielsprache?
 *   3. platzhalter   — sind {{0}}, {{1}} … vollzählig und unverändert?
 *   4. sinn          — Rückübersetzung, grober Sinnvergleich zum Original.
 *   5. ton           — kein Registerbruch (weder Behördenbrief noch Jargon).
 *   6. orthografie   — Großschreibung am Anfang, Satzzeichen am Ende erhalten.
 *   7. struktur      — Zeilenumbrüche und Markdown-Elemente erhalten.
 *   8. emoji         — Emojis unverändert; grobe Prüfung gegen erfundene Sätze.
 *
 * Läuft mit derselben Anweisung, die im Betrieb hinausgeht
 * (packages/server/src/translation/prompt.ts) und derselben Nachfass-Regel
 * wie translate() in packages/server/src/translation/index.ts — sonst würde
 * hier etwas anderes gemessen als das, was Benutzer tatsächlich bekommen.
 *
 * Der Korpus steht in scripts/uebersetzung-korpus.mjs, damit er sich
 * erweitern lässt, ohne diese Datei anzufassen.
 *
 *   ssh -f -N -L 11500:100.125.43.46:11500 stellium
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/uebersetzung-messen.mjs
 *
 * Das ist eine Standaufnahme, kein Grenzwert-Test: Sinn ist der Vergleich
 * mit dem nächsten Lauf, nicht ein grünes Ergebnis heute.
 */
import { detectLanguage, normalizeLang } from '../packages/shared/src/languages.ts';
import { maskText, unmaskText, placeholdersIntact } from '../packages/shared/src/markup.ts';
import { istEcho, woerter, wortAehnlichkeit, ECHO_MIN_WOERTER } from '../packages/server/src/translation/echo.ts';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur }
  from '../packages/server/src/translation/prompt.ts';
import { uebersetzungAusAntwort } from '../packages/server/src/translation/antwort.ts';
import { verlaufAlsKontext } from '../packages/server/src/translation/verlauf.ts';
import { KORPUS, KONTEXT_KORPUS } from './uebersetzung-korpus.mjs';

const ADRESSE = process.env.MODELL;
if (!ADRESSE) {
  console.error('MODELL=<baseUrl> setzen, z. B.:');
  console.error('  MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/uebersetzung-messen.mjs');
  process.exit(1);
}
const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';

/* Ein Produktname als Beispiel für die Platzhalter-Prüfung — echte Glossar-
   Begriffe kommen aus der Datenbank, die hier bewusst nicht angerührt wird
   (siehe echo-pruefen.mjs: diese Läufe hängen absichtlich an nichts). */
const PROTECTED_TERMS = ['Stellium'];

const ERGEBNIS = { BESTANDEN: 'bestanden', DURCHGEFALLEN: 'durchgefallen', UEBERSPRUNGEN: 'übersprungen' };

/* ── Anfrage ans Modell ───────────────────────────────────────────
   Ein Aufruf, mit genau der Anweisung aus dem Betrieb. `text` ist bereits
   maskiert — das ist es, was das Modell in Wirklichkeit sieht. */
async function einzelneAnfrage(text, ziel, quelle, nachdruck, context = null) {
  const req = { text, targetLang: ziel, sourceLang: quelle, nachdruck, context };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${ADRESSE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pruefung' },
      body: JSON.stringify({
        model: MODELL_ID,
        messages: [
          { role: 'system', content: uebersetzungsRegeln(req).join('\n') },
          { role: 'user', content: text },
        ],
        temperature: uebersetzungsTemperatur(req),
        max_completion_tokens: translationBudget(text),
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const inhalt = (await res.json())?.choices?.[0]?.message?.content;
    if (typeof inhalt !== 'string') return null;
    return uebersetzungAusAntwort(inhalt.trim(), text);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Ein Anlauf mit derselben Nachfass-Regel wie translate() in index.ts: bei
 * einem Echo wird genau einmal mit `nachdruck` erneut gefragt — außer das
 * Modell hat die Ausgangssprache bereits als Zielsprache erkannt, dann ist
 * die unveränderte Rückgabe richtig und kein Fehler.
 */
async function uebersetzeMitNachfassen(masked, ziel, quelle, context = null) {
  const erste = await einzelneAnfrage(masked, ziel, quelle, false, context);
  if (!erste || !erste.translation?.trim()) return null;
  const erkannteQuelle = erste.detected ? normalizeLang(erste.detected) : quelle;
  if (erkannteQuelle === ziel) return erste;
  if (!istEcho(masked, erste.translation)) return erste;
  const zweite = await einzelneAnfrage(masked, ziel, quelle, true, context);
  if (zweite?.translation?.trim() && !istEcho(masked, zweite.translation)) return zweite;
  return zweite?.translation?.trim() ? zweite : erste;
}

/** Maskieren, übersetzen (mit Nachfassen), demaskieren — die volle Runde. */
async function uebersetzeText(text, ziel, quelle) {
  const { masked, tokens } = maskText(text, { protectedTerms: PROTECTED_TERMS });
  const ergebnis = await uebersetzeMitNachfassen(masked, ziel, quelle);
  if (!ergebnis) return null;
  return { masked, tokens, roh: ergebnis.translation, text: unmaskText(ergebnis.translation, tokens) };
}

/* ── Prüfpunkt 2: Zielsprache ─────────────────────────────────────
   Kurze Ausgaben und unsichere Erkennungen werden nicht beurteilt — genau
   dieselbe Grenze, die languages.ts selbst zieht, bevor sie einer Erkennung
   traut ("alles unter 0,35 wird gar nicht erst als Sprache eingetragen"). */
function pruefeZielsprache(ausgabe, ziel) {
  if (woerter(ausgabe).length < ECHO_MIN_WOERTER) return ERGEBNIS.UEBERSPRUNGEN;
  const erkannt = detectLanguage(ausgabe);
  if (erkannt.confidence < 0.35) return ERGEBNIS.UEBERSPRUNGEN;
  return erkannt.lang === normalizeLang(ziel) ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Prüfpunkt 3: Platzhalter ─────────────────────────────────────── */
function pruefePlatzhalter(masked, rohAusgabe, tokenAnzahl) {
  if (tokenAnzahl === 0) return ERGEBNIS.UEBERSPRUNGEN;
  return placeholdersIntact(masked, rohAusgabe) ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Prüfpunkt 4: Sinn — Rückübersetzung ─────────────────────────────
   Dieselbe Messlatte wie bei der Echo-Erkennung (wortAehnlichkeit) und
   derselbe Weg wie roundTrip() in index.ts: zurück in die Ausgangssprache
   und mit dem Original vergleichen. Grob, aber es fängt die groben Fehler.

   Schwelle kalibriert am Lauf vom 22.08.2026 (qwen3-8b, 55 beurteilbare
   Fälle): zwei echte Bedeutungsfehler lagen bei 11 % und 25 % Übereinstimmung
   ("pr" wurde zu "Präsentation", "yeah nah ... dont worry" wurde im
   Türkischen zu einem wörtlichen "ja nein"). Die nächsthöheren, richtig
   übersetzten Fälle lagen bei 31-32 % — meist Tippfehler-Sätze, bei denen
   selbst eine korrekte Übersetzung nach zwei Sprachsprüngen weniger
   Wortüberlappung hat. 0,3 trennt beide Gruppen, liegt aber knapp: bei mehr
   Tippfehler-Fällen im Korpus kann diese Schwelle nachjustiert werden müssen. */
const SINN_SCHWELLE = 0.3;

async function pruefeSinn(original, ausgabe, quelle, ziel) {
  if (woerter(original).length < ECHO_MIN_WOERTER) return { status: ERGEBNIS.UEBERSPRUNGEN, aehnlichkeit: null };
  const rueck = await uebersetzeText(ausgabe, quelle, ziel);
  if (!rueck) return { status: ERGEBNIS.DURCHGEFALLEN, aehnlichkeit: null };
  const aehnlichkeit = wortAehnlichkeit(original, rueck.text);
  return {
    status: aehnlichkeit >= SINN_SCHWELLE ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN,
    aehnlichkeit, rueckuebersetzung: rueck.text,
  };
}

/* ── Prüfpunkt 5: Ton ──────────────────────────────────────────────
   Nur für de/en, weil nur dort genug Sicherheit im Vokabular besteht, um
   ohne viele Fehlalarme zu urteilen. Zwei Register-Brüche werden erkannt,
   in beide Richtungen wirksam:
     - normal → förmlich  ("Behördenbrief"-Fall)
     - normal → Netzjargon (realer Fall vom 22.08.2026: "ich lade die App
       gerade runter" → "oh wait ima download the app rn" — kein Wort falsch,
       trotzdem der falsche Ton für einen Firmen-Chat)
   Geprüft wird nicht der Registerwert an sich, sondern der SPRUNG: taucht
   ein starkes Signal in der Ausgabe auf, das im Original nicht da war? Ist
   das Original selbst schon förmlich oder schon Jargon, ist dasselbe Signal
   in der Übersetzung keine Verletzung, sondern die richtige Antwort. */
const FOERMLICH_MARKER = {
  de: /sehr geehrte[rs]?|hochachtungsvoll|mit freundlichen grüßen|wir bitten sie|würden sie|könnten sie|ihrerseits|zur kenntnisnahme|wir würden uns freuen|zögern sie nicht|wir bedauern/i,
  en: /dear sir|dear madam|to whom it may concern|kindly\b|we hereby|please be advised|yours sincerely|yours faithfully|we would like to inform you|should you require|at your earliest convenience|we would appreciate|please do not hesitate|we regret to inform|please find attached/i,
};
const JARGON_MARKER = {
  de: /\bfr\s?fr\b|\bwtf\b|\blmao\b|\blol\b|\bxd\b/i,
  en: /\bima\b|\brn\b|\bfr\s?fr\b|\bngl\b|\blowkey\b|\bhighkey\b|\btbh\b|\bsmh\b|\bbruh\b|\byeet\b|\bnocap\b|\blol\b|\blmao\b/i,
};

function pruefeTon(original, ausgabe, quelle, ziel) {
  if (!FOERMLICH_MARKER[quelle] || !FOERMLICH_MARKER[ziel]) return ERGEBNIS.UEBERSPRUNGEN;
  const quellFoermlich = FOERMLICH_MARKER[quelle].test(original);
  const auswFoermlich = FOERMLICH_MARKER[ziel].test(ausgabe);
  if (!quellFoermlich && auswFoermlich) return ERGEBNIS.DURCHGEFALLEN;
  const quellJargon = JARGON_MARKER[quelle].test(original);
  const auswJargon = JARGON_MARKER[ziel].test(ausgabe);
  if (!quellJargon && auswJargon) return ERGEBNIS.DURCHGEFALLEN;
  return ERGEBNIS.BESTANDEN;
}

/* ── Prüfpunkt 6: Großschreibung / Satzzeichen ────────────────────────
   Objektiv und billig zu prüfen, deshalb eine eigene, einfache Größe statt
   im Ton-Urteil versteckt: Fängt genau den Fall, in dem eine Übersetzung
   nicht mehr wie dieselbe Person klingt, die geschrieben hat. */
function ersterBuchstabeGross(text) {
  const m = text.trim().match(/\p{L}/u);
  if (!m) return null;
  return m[0] === m[0].toUpperCase() && m[0] !== m[0].toLowerCase();
}
function endetMitSatzzeichen(text) {
  return /[.!?…]["')\]]*\s*$/.test(text.trim());
}
function pruefeOrthografie(original, ausgabe) {
  const quellGross = ersterBuchstabeGross(original);
  const quellSatzzeichen = endetMitSatzzeichen(original);
  if (quellGross === null && !quellSatzzeichen) return ERGEBNIS.UEBERSPRUNGEN;
  const grossOk = quellGross !== true || ersterBuchstabeGross(ausgabe) === true;
  const satzzeichenOk = !quellSatzzeichen || endetMitSatzzeichen(ausgabe);
  return grossOk && satzzeichenOk ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Prüfpunkt 7: Struktur (Zeilenumbrüche, Markdown) ─────────────────
   Verglichen wird das, was das Modell tatsächlich gesehen hat (maskiert) mit
   dem, was es tatsächlich zurückgab (noch maskiert) — Code-Blöcke stecken
   dann in einem einzigen Platzhalter und verfälschen die Zeilenzahl nicht. */
function struktur(text) {
  return {
    zeilenumbrueche: (text.match(/\n/g) ?? []).length,
    aufzaehlungen: (text.match(/^\s*[-*•]\s+/gm) ?? []).length,
    nummeriert: (text.match(/^\s*\d+[.)]\s+/gm) ?? []).length,
    fett: (text.match(/\*\*/g) ?? []).length,
    zitat: (text.match(/^\s*>\s+/gm) ?? []).length,
  };
}
function pruefeStruktur(masked, rohAusgabe) {
  const q = struktur(masked);
  const hatStruktur = Object.values(q).some((n) => n > 0);
  if (!hatStruktur) return ERGEBNIS.UEBERSPRUNGEN;
  const a = struktur(rohAusgabe);
  const passt = Object.keys(q).every((k) => q[k] === a[k]);
  return passt ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Prüfpunkt 8a: Emojis ─────────────────────────────────────────── */
const EMOJI_RE = /\p{Extended_Pictographic}/gu;
function emojis(text) { return [...(text.match(EMOJI_RE) ?? [])].sort(); }
function pruefeEmoji(original, ausgabe) {
  const q = emojis(original);
  if (q.length === 0) return ERGEBNIS.UEBERSPRUNGEN;
  const a = emojis(ausgabe);
  const gleich = q.length === a.length && q.every((e, i) => e === a[i]);
  return gleich ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Prüfpunkt 8b: keine erfundenen Sätze ─────────────────────────────
   Grobe Näherung über die Satzzahl, mit einem Satz Toleranz für
   Interpunktions-Unterschiede zwischen den Sprachen. */
function satzZahl(text) {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean).length;
}
function pruefeErfindung(masked, rohAusgabe) {
  if (woerter(masked).length < ECHO_MIN_WOERTER) return ERGEBNIS.UEBERSPRUNGEN;
  return satzZahl(rohAusgabe) <= satzZahl(masked) + 1 ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Prüfpunkte 10/11 (nur Kontext-Vergleich): erwartet/verboten ──────
   Dieselbe Machart wie postantwort-korpus.mjs/postantwort-messen.mjs:
   Muster, die in einer richtigen Übersetzung vorkommen müssen bzw. nie
   vorkommen dürfen. Leere Arrays heißen ausdrücklich "nicht automatisch
   beurteilbar", nicht "bestanden" — siehe uebersetzung-korpus.mjs. */
function pruefeErwartet(text, muster) {
  if (!muster.length) return ERGEBNIS.UEBERSPRUNGEN;
  return muster.every((r) => r.test(text)) ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}
function pruefeVerboten(text, muster) {
  if (!muster.length) return ERGEBNIS.UEBERSPRUNGEN;
  return muster.some((r) => r.test(text)) ? ERGEBNIS.DURCHGEFALLEN : ERGEBNIS.BESTANDEN;
}

/* ── Hauptlauf ─────────────────────────────────────────────────────── */

const KATEGORIEN = [
  ['echo', 'Übersetzt (kein Echo)'],
  ['zielsprache', 'Ergebnis wirklich in der Zielsprache'],
  ['platzhalter', 'Platzhalter vollzählig und unverändert'],
  ['sinn', 'Sinn erhalten (Rückübersetzung)'],
  ['ton', 'Ton erhalten (kein Registerbruch)'],
  ['orthografie', 'Großschreibung/Satzzeichen am Rand erhalten'],
  ['struktur', 'Zeilenumbrüche/Markdown erhalten'],
  ['emoji', 'Emojis unverändert'],
  ['erfindung', 'Keine erfundenen Sätze'],
];
const zaehler = Object.fromEntries(KATEGORIEN.map(([k]) => [k, { bestanden: 0, durchgefallen: 0, uebersprungen: 0 }]));
const jeKorpusKategorie = {};
let ohneAntwort = 0;

console.log(`\nMessung an ${MODELL_ID} über ${ADRESSE} — ${KORPUS.length} Fälle\n`);

let laufNr = 0;
for (const fall of KORPUS) {
  laufNr++;
  const richtung = `${fall.quelle}→${fall.ziel}`;
  const { masked, tokens } = maskText(fall.text, { protectedTerms: PROTECTED_TERMS });
  const ergebnisModell = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle);

  const ergebnisse = {};
  let zusatz = '';

  if (!ergebnisModell) {
    ohneAntwort++;
    ergebnisse.echo = ERGEBNIS.DURCHGEFALLEN;
    for (const [k] of KATEGORIEN) if (k !== 'echo') ergebnisse[k] = ERGEBNIS.UEBERSPRUNGEN;
    zusatz = 'keine verwertbare Antwort';
  } else {
    const ausgabe = unmaskText(ergebnisModell.translation, tokens);
    ergebnisse.echo = istEcho(masked, ergebnisModell.translation) ? ERGEBNIS.DURCHGEFALLEN : ERGEBNIS.BESTANDEN;
    ergebnisse.zielsprache = pruefeZielsprache(ausgabe, fall.ziel);
    ergebnisse.platzhalter = pruefePlatzhalter(masked, ergebnisModell.translation, tokens.length);
    ergebnisse.ton = pruefeTon(fall.text, ausgabe, fall.quelle, fall.ziel);
    ergebnisse.orthografie = pruefeOrthografie(fall.text, ausgabe);
    ergebnisse.struktur = pruefeStruktur(masked, ergebnisModell.translation);
    ergebnisse.emoji = pruefeEmoji(fall.text, ausgabe);
    ergebnisse.erfindung = pruefeErfindung(masked, ergebnisModell.translation);

    if (ergebnisse.echo === ERGEBNIS.DURCHGEFALLEN) {
      ergebnisse.sinn = ERGEBNIS.UEBERSPRUNGEN;
    } else {
      const sinn = await pruefeSinn(fall.text, ausgabe, fall.quelle, fall.ziel);
      ergebnisse.sinn = sinn.status;
      if (sinn.aehnlichkeit !== null) zusatz = `Sinn ${Math.round(sinn.aehnlichkeit * 100)} %`;
    }
    zusatz = `${ausgabe.slice(0, 55).replace(/\s+/g, ' ')}${zusatz ? `  [${zusatz}]` : ''}`;
  }

  jeKorpusKategorie[fall.kategorie] ??= { bestanden: 0, durchgefallen: 0 };
  for (const [k] of KATEGORIEN) {
    const r = ergebnisse[k];
    if (r === ERGEBNIS.BESTANDEN) { zaehler[k].bestanden++; jeKorpusKategorie[fall.kategorie].bestanden++; }
    else if (r === ERGEBNIS.DURCHGEFALLEN) { zaehler[k].durchgefallen++; jeKorpusKategorie[fall.kategorie].durchgefallen++; }
    else zaehler[k].uebersprungen++;
  }

  const fehler = KATEGORIEN.filter(([k]) => ergebnisse[k] === ERGEBNIS.DURCHGEFALLEN).map(([k]) => k);
  const marke = fehler.length ? `✗ ${fehler.join(',')}` : '✓';
  console.log(`  [${String(laufNr).padStart(2)}/${KORPUS.length}] ${richtung.padEnd(7)} ${fall.kategorie.padEnd(22)} ${marke.padEnd(26)} ${zusatz}`);
}

/* ── Bericht ───────────────────────────────────────────────────────── */

console.log('\n── Ergebnis je Prüfpunkt ───────────────────────────────────\n');
for (const [k, label] of KATEGORIEN) {
  const z = zaehler[k];
  const geprueft = z.bestanden + z.durchgefallen;
  const text = geprueft ? `${z.bestanden} von ${geprueft} (${Math.round((z.bestanden / geprueft) * 100)} %)` : 'keine geprüften Fälle';
  console.log(`  ${label.padEnd(44)} ${text}${z.uebersprungen ? `  [${z.uebersprungen} übersprungen]` : ''}`);
}

console.log('\n── Durchfallquote je Korpus-Kategorie (über alle Prüfpunkte hinweg) ──\n');
const sortiert = Object.entries(jeKorpusKategorie).sort((a, b) => {
  const qa = a[1].durchgefallen / Math.max(1, a[1].bestanden + a[1].durchgefallen);
  const qb = b[1].durchgefallen / Math.max(1, b[1].bestanden + b[1].durchgefallen);
  return qb - qa;
});
for (const [kat, z] of sortiert) {
  const geprueft = z.bestanden + z.durchgefallen;
  const quote = geprueft ? Math.round((z.durchgefallen / geprueft) * 100) : 0;
  console.log(`  ${kat.padEnd(24)} ${String(z.durchgefallen).padStart(3)} von ${String(geprueft).padEnd(3)} Einzelprüfungen durchgefallen (${quote} %)`);
}

console.log(`\n  Fälle insgesamt: ${KORPUS.length}, ohne verwertbare Antwort: ${ohneAntwort}`);

const gesamtBestanden = KATEGORIEN.reduce((s, [k]) => s + zaehler[k].bestanden, 0);
const gesamtDurchgefallen = KATEGORIEN.reduce((s, [k]) => s + zaehler[k].durchgefallen, 0);
console.log(`\n${gesamtDurchgefallen ? '✗' : '✓'} ${gesamtBestanden} von ${gesamtBestanden + gesamtDurchgefallen} Einzelprüfungen bestanden (Hauptkorpus).`);

/* ── Kontext-Vergleich ─────────────────────────────────────────────────
   Eigener Abschnitt, eigene Zählung — prüft nicht dasselbe wie oben, sondern
   gezielt die eine Frage aus dem Auftrag: sieht translateMessage() die
   vorige Nachricht, und ändert das die Übersetzung RICHTIG (nicht nur
   irgendwie anders)?
     `ohne` — kein `context` — der Stand vor dieser Änderung: channelContext()
              aus ws/gateway.ts lieferte nie eine vorherige Nachricht, für
              diese Messung also gleichbedeutend mit keinem Kontext.
     `mit`  — Kontext über dieselbe Funktion, die im Betrieb läuft
              (translation/verlauf.ts, verlaufAlsKontext), aus fall.vorher
              gebaut. */
console.log('\n\n══ Kontext-Vergleich (translation/verlauf.ts) ═══════════════════════');
console.log(`${KONTEXT_KORPUS.length} Fälle × 2 Läufe (ohne Kontext / mit Gesprächsverlauf)\n`);

const KONTEXT_LAEUFE = ['ohne', 'mit'];
const KONTEXT_KATEGORIEN = [
  ['echo', 'Übersetzt (kein Echo)'],
  ['zielsprache', 'Zielsprache'],
  ['ton', 'Ton erhalten'],
  ['orthografie', 'Großschreibung/Satzzeichen'],
  ['erfindung', 'Keine erfundenen Sätze'],
  ['erwartet', 'Erwartetes Muster (richtige Deutung)'],
  ['verboten', 'Kein verbotenes Muster (falsche Deutung)'],
];
const kontextZaehler = {};
for (const l of KONTEXT_LAEUFE) {
  kontextZaehler[l] = Object.fromEntries(KONTEXT_KATEGORIEN.map(([k]) => [k, { bestanden: 0, durchgefallen: 0, uebersprungen: 0 }]));
}
let kontextNr = 0;
for (const fall of KONTEXT_KORPUS) {
  kontextNr++;
  const { masked, tokens } = maskText(fall.text, { protectedTerms: PROTECTED_TERMS });
  const kontext = verlaufAlsKontext(fall.vorher);
  console.log(`  [${String(kontextNr).padStart(2)}/${KONTEXT_KORPUS.length}] ${fall.name} [${fall.quelle}→${fall.ziel}]`);
  if (fall.vorher?.length) {
    for (const z of fall.vorher) console.log(`           vorher  ${z.wer}: ${z.text}`);
  }
  console.log(`           Text    ${fall.text}`);

  for (const lauf of KONTEXT_LAEUFE) {
    const ergebnisModell = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
    const ergebnisse = {};
    let ausgabe = null;

    if (!ergebnisModell) {
      ergebnisse.echo = ERGEBNIS.DURCHGEFALLEN;
      for (const [k] of KONTEXT_KATEGORIEN) if (k !== 'echo') ergebnisse[k] = ERGEBNIS.UEBERSPRUNGEN;
    } else {
      ausgabe = unmaskText(ergebnisModell.translation, tokens);
      ergebnisse.echo = istEcho(masked, ergebnisModell.translation) ? ERGEBNIS.DURCHGEFALLEN : ERGEBNIS.BESTANDEN;
      ergebnisse.zielsprache = pruefeZielsprache(ausgabe, fall.ziel);
      ergebnisse.ton = pruefeTon(fall.text, ausgabe, fall.quelle, fall.ziel);
      ergebnisse.orthografie = pruefeOrthografie(fall.text, ausgabe);
      ergebnisse.erfindung = pruefeErfindung(masked, ergebnisModell.translation);
      ergebnisse.erwartet = pruefeErwartet(ausgabe, fall.erwartet);
      ergebnisse.verboten = pruefeVerboten(ausgabe, fall.verboten);
    }

    for (const [k] of KONTEXT_KATEGORIEN) {
      const r = ergebnisse[k];
      if (r === ERGEBNIS.BESTANDEN) kontextZaehler[lauf][k].bestanden++;
      else if (r === ERGEBNIS.DURCHGEFALLEN) kontextZaehler[lauf][k].durchgefallen++;
      else kontextZaehler[lauf][k].uebersprungen++;
    }

    const fehler = KONTEXT_KATEGORIEN.filter(([k]) => ergebnisse[k] === ERGEBNIS.DURCHGEFALLEN).map(([k]) => k);
    const marke = fehler.length ? `✗ ${fehler.join(',')}` : '✓';
    console.log(`           ${lauf.padEnd(6)} ${marke.padEnd(28)} ${ausgabe ?? '(keine verwertbare Antwort)'}`);
  }
  console.log('');
}

console.log('── Kontext-Vergleich: Ergebnis je Prüfpunkt, ohne vs. mit ─────\n');
console.log(`  ${'Prüfpunkt'.padEnd(40)}${KONTEXT_LAEUFE.map((l) => l.padEnd(10)).join('')}`);
for (const [k, label] of KONTEXT_KATEGORIEN) {
  const spalten = KONTEXT_LAEUFE.map((l) => {
    const z = kontextZaehler[l][k];
    const geprueft = z.bestanden + z.durchgefallen;
    return (geprueft ? `${z.bestanden}/${geprueft}` : '—').padEnd(10);
  });
  console.log(`  ${label.padEnd(40)}${spalten.join('')}`);
}
console.log('');
for (const l of KONTEXT_LAEUFE) {
  const b = KONTEXT_KATEGORIEN.reduce((s, [k]) => s + kontextZaehler[l][k].bestanden, 0);
  const d = KONTEXT_KATEGORIEN.reduce((s, [k]) => s + kontextZaehler[l][k].durchgefallen, 0);
  const quote = b + d ? Math.round((b / (b + d)) * 100) : 0;
  console.log(`  ${l.padEnd(6)} ${b} von ${b + d} Einzelprüfungen bestanden (${quote} %)`);
}

const kontextBestanden = KONTEXT_LAEUFE.reduce((s, l) => s + KONTEXT_KATEGORIEN.reduce((s2, [k]) => s2 + kontextZaehler[l][k].bestanden, 0), 0);
const kontextDurchgefallen = KONTEXT_LAEUFE.reduce((s, l) => s + KONTEXT_KATEGORIEN.reduce((s2, [k]) => s2 + kontextZaehler[l][k].durchgefallen, 0), 0);

console.log(`\n${kontextDurchgefallen ? '✗' : '✓'} ${kontextBestanden} von ${kontextBestanden + kontextDurchgefallen} Einzelprüfungen bestanden (Kontext-Vergleich, beide Läufe zusammen).`);
console.log('\nStandaufnahme, kein Grenzwert-Test — Ziel ist der Vergleich mit dem nächsten Lauf.');
process.exit(gesamtDurchgefallen || kontextDurchgefallen ? 1 : 0);
