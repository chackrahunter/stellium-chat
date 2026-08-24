/**
 * Miss, ob das Firmenwissen die Antworten der Poststelle wirklich besser
 * macht — am laufenden Modell, mit denselben Anweisungen, die im Betrieb
 * hinausgehen.
 *
 * Vorbild und Machart: scripts/uebersetzung-messen.mjs. Wie dort ist das eine
 * Standaufnahme, kein Grenzwert-Test: Sinn ist der Vergleich der drei Läufe
 * miteinander und mit dem nächsten Mal.
 *
 * DREI LÄUFE, NICHT ZWEI
 *
 *   1. `roh`    — die Anweisung, wie sie vor dieser Änderung hinausging:
 *                 Fachanweisung plus Sprachzeile. Kein Wissen, keine Regel.
 *   2. `regel`  — dieselbe Anweisung plus DEN EINEN Satz, der eine Lücke
 *                 markieren lässt statt zu raten (WISSENSREGEL).
 *   3. `wissen` — dazu das ausgewählte Firmenwissen.
 *
 * Warum drei: Ein anderer Lauf hat an genau diesem Modell gemessen, dass drei
 * zusätzliche Regeln einzeln gut wirkten, zusammen aber die Antwort ins
 * Englische kippen ließen. Länge ist hier ein Fehlerrisiko. Mit zwei Läufen
 * ließe sich eine Verschlechterung nicht zuordnen — man wüsste nur, dass
 * etwas schlechter wurde, nicht ob es an der Regel oder am Wissen lag.
 *
 * SECHS PRÜFPUNKTE, jeder so gebaut, dass er durchfallen kann:
 *   1. antwort       — kam überhaupt ein verwertbarer Entwurf?
 *   2. sprache       — steht die Antwort in der Sprache des Briefpartners?
 *   3. beantwortet   — stehen die erwarteten Tatsachen darin?
 *   4. nichtErfunden — steht nichts darin, was niemand geprüft hat?
 *   5. luecke        — wird eine Wissenslücke markiert statt gefüllt?
 *   6. kennzeichnung — trägt der Entwurf den Hinweis auf maschinelle Erstellung?
 *
 *   ssh -f -N -L 11500:100.125.43.46:11500 stellium
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/postantwort-messen.mjs
 */
import { detectLanguage, normalizeLang, languageInfo } from '../packages/shared/src/languages.ts';
import { anweisungFuerFach, mailAlsEingabe, KENNZEICHNUNG_DE, KENNZEICHNUNG_EN }
  from '../packages/server/src/services/post-ki.ts';
import { passendeEintraege, wissensBlock, wissenBudget, luecken, WISSENSREGEL }
  from '../packages/server/src/services/post-wissen-ki.ts';
import { markenSchaetzung } from '../packages/shared/src/marken.ts';
import { KORPUS, WISSEN } from './postantwort-korpus.mjs';

const ADRESSE = process.env.MODELL;
if (!ADRESSE) {
  console.error('MODELL=<baseUrl> setzen, z. B.:');
  console.error('  MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/postantwort-messen.mjs');
  process.exit(1);
}
const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';
/* Dasselbe Fenster, das translation/fenster.ts im Betrieb annimmt, wenn das
   Modell nichts anderes meldet — daran hängt, wie viel Wissen ausgewählt
   wird. Über die Umgebung überschreibbar, um den Fall „kleines Fenster"
   nachzustellen. */
const FENSTER = Number(process.env.FENSTER) || 8192;
const ANTWORT_MARKEN = 900;

const ERGEBNIS = { BESTANDEN: 'bestanden', DURCHGEFALLEN: 'durchgefallen', UEBERSPRUNGEN: 'übersprungen' };

/* ── Die drei Anweisungen ────────────────────────────────────────
   Gebaut aus denselben Bausteinen wie im Betrieb: anweisungFuerFach() aus
   post-ki.ts, die Sprachzeile wortgleich mit post-sichtung.ts
   (anweisungMitSprache), und der Wissensblock aus post-wissen-ki.ts. Würde
   hier etwas nachgebaut, misse dieser Lauf etwas anderes als das, was
   Benutzer bekommen. */

function sprachzeile(sprache) {
  const s = languageInfo(sprache);
  return `Die Antwort in \`entwurf\` schreibst du auf ${s.name} (${s.native}) — `
    + 'das ist die Sprache dieses Briefpartners, unabhängig davon, in welcher Sprache diese eine Mail verfasst ist.';
}

function anweisung(fall, lauf) {
  const grund = `${anweisungFuerFach(fall.fach)}\n${sprachzeile(fall.sprache)}`;
  if (lauf === 'roh') return grund;
  if (lauf === 'regel') return `${grund}\n${WISSENSREGEL}`;
  const auswahl = passendeEintraege({
    eintraege: WISSEN,
    fach: fall.fach,
    betreff: fall.betreff,
    text: fall.text,
    budget: wissenBudget(FENSTER),
  });
  return { text: `${grund}\n${wissensBlock(auswahl)}`, auswahl };
}

/* ── Anfrage ans Modell ─────────────────────────────────────────── */

async function frage(system, user) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 120_000);
  try {
    const res = await fetch(`${ADRESSE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pruefung' },
      body: JSON.stringify({
        model: MODELL_ID,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        temperature: 0.2,
        max_completion_tokens: ANTWORT_MARKEN,
        response_format: { type: 'json_object' },
      }),
      signal: controller.signal,
    });
    if (!res.ok) return { fehler: `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}` };
    const inhalt = (await res.json())?.choices?.[0]?.message?.content;
    if (typeof inhalt !== 'string') return { fehler: 'keine Antwort' };
    /* Dieselbe Nachsicht wie provider.json() in
       translation/providers/openai-compatible.ts: manche Modelle stellen Text
       voran oder packen das JSON in einen Codeblock. */
    try { return { daten: JSON.parse(inhalt) }; } catch { /* zweiter Versuch */ }
    const m = inhalt.match(/\{[\s\S]*\}/);
    if (m) { try { return { daten: JSON.parse(m[0]) }; } catch { /* fällt durch */ } }
    return { fehler: 'kein gültiges JSON' };
  } catch (e) {
    return { fehler: e.name === 'AbortError' ? 'Zeitüberschreitung' : e.message };
  } finally {
    clearTimeout(timeout);
  }
}

/* ── Prüfpunkte ─────────────────────────────────────────────────── */

/* Dieselbe Zurückhaltung wie in uebersetzung-messen.mjs: eine unsichere
   Erkennung wird nicht beurteilt, statt einen Fehlalarm zu erzeugen. */
function pruefeSprache(text, ziel) {
  const erkannt = detectLanguage(text);
  if (erkannt.confidence < 0.35) return ERGEBNIS.UEBERSPRUNGEN;
  return erkannt.lang === normalizeLang(ziel) ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

function pruefeErwartet(text, muster) {
  if (!muster.length) return ERGEBNIS.UEBERSPRUNGEN;
  return muster.every((r) => r.test(text)) ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

function pruefeVerboten(text, muster) {
  if (!muster.length) return ERGEBNIS.UEBERSPRUNGEN;
  return muster.some((r) => r.test(text)) ? ERGEBNIS.DURCHGEFALLEN : ERGEBNIS.BESTANDEN;
}

function pruefeLuecke(text, noetig) {
  if (!noetig) return ERGEBNIS.UEBERSPRUNGEN;
  return luecken(text).length ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

function pruefeKennzeichnung(text) {
  return text.includes(KENNZEICHNUNG_DE) || text.includes(KENNZEICHNUNG_EN) || /StelliumAI/i.test(text)
    ? ERGEBNIS.BESTANDEN : ERGEBNIS.DURCHGEFALLEN;
}

/* ── Hauptlauf ──────────────────────────────────────────────────── */

const LAEUFE = ['roh', 'regel', 'wissen'];
const KATEGORIEN = [
  ['antwort', 'Verwertbarer Entwurf'],
  ['sprache', 'Sprache des Briefpartners gehalten'],
  ['beantwortet', 'Frage tatsächlich beantwortet'],
  ['nichtErfunden', 'Nichts erfunden'],
  ['luecke', 'Wissenslücke markiert statt gefüllt'],
  ['kennzeichnung', 'Kennzeichnung vorhanden'],
];

const zaehler = {};
for (const l of LAEUFE) {
  zaehler[l] = Object.fromEntries(
    KATEGORIEN.map(([k]) => [k, { bestanden: 0, durchgefallen: 0, uebersprungen: 0 }]),
  );
}
const ausgaben = {};

console.log(`\nMessung an ${MODELL_ID} über ${ADRESSE} — ${KORPUS.length} Anfragen × ${LAEUFE.length} Läufe`);
console.log(`Fenster ${FENSTER} Marken, Wissensbudget ${wissenBudget(FENSTER)} Marken, `
  + `${WISSEN.length} Einträge im Messgedächtnis\n`);

for (const fall of KORPUS) {
  console.log(`── ${fall.name}  [${fall.fach}@, ${fall.sprache}]`);
  const user = mailAlsEingabe({ von: fall.von, betreff: fall.betreff, text: fall.text });

  for (const lauf of LAEUFE) {
    const gebaut = anweisung(fall, lauf);
    const system = typeof gebaut === 'string' ? gebaut : gebaut.text;
    const auswahl = typeof gebaut === 'string' ? null : gebaut.auswahl;

    const antwort = await frage(system, user);
    const entwurf = typeof antwort.daten?.entwurf === 'string' ? antwort.daten.entwurf.trim() : '';
    const ergebnisse = {};

    if (!entwurf) {
      ergebnisse.antwort = ERGEBNIS.DURCHGEFALLEN;
      for (const [k] of KATEGORIEN) if (k !== 'antwort') ergebnisse[k] = ERGEBNIS.UEBERSPRUNGEN;
    } else {
      ergebnisse.antwort = ERGEBNIS.BESTANDEN;
      ergebnisse.sprache = pruefeSprache(entwurf, fall.sprache);
      ergebnisse.beantwortet = pruefeErwartet(entwurf, fall.erwartet);
      ergebnisse.nichtErfunden = pruefeVerboten(entwurf, fall.verboten);
      ergebnisse.luecke = pruefeLuecke(entwurf, Boolean(fall.luecke));
      ergebnisse.kennzeichnung = pruefeKennzeichnung(entwurf);
    }

    for (const [k] of KATEGORIEN) {
      const r = ergebnisse[k];
      if (r === ERGEBNIS.BESTANDEN) zaehler[lauf][k].bestanden += 1;
      else if (r === ERGEBNIS.DURCHGEFALLEN) zaehler[lauf][k].durchgefallen += 1;
      else zaehler[lauf][k].uebersprungen += 1;
    }

    ausgaben[fall.name] ??= {};
    ausgaben[fall.name][lauf] = entwurf || `(keine Antwort: ${antwort.fehler ?? 'leer'})`;

    const durchgefallen = KATEGORIEN.filter(([k]) => ergebnisse[k] === ERGEBNIS.DURCHGEFALLEN).map(([k]) => k);
    const marke = durchgefallen.length ? `✗ ${durchgefallen.join(',')}` : '✓';
    const wissenInfo = auswahl
      ? ` [${auswahl.wissen.length} Wissen, ${auswahl.stil.length} Stil, ${markenSchaetzung(system)} Marken]`
      : ` [${markenSchaetzung(system)} Marken]`;
    console.log(`   ${lauf.padEnd(7)} ${marke.padEnd(34)}${wissenInfo}`);
    console.log(`           ${(entwurf || '—').replace(/\s+/g, ' ').slice(0, 130)}`);
  }
  console.log('');
}

/* ── Bericht ────────────────────────────────────────────────────── */

console.log('── Ergebnis je Prüfpunkt und Lauf ──────────────────────────\n');
console.log(`  ${'Prüfpunkt'.padEnd(38)}${LAEUFE.map((l) => l.padEnd(14)).join('')}`);
for (const [k, label] of KATEGORIEN) {
  const spalten = LAEUFE.map((l) => {
    const z = zaehler[l][k];
    const geprueft = z.bestanden + z.durchgefallen;
    return (geprueft ? `${z.bestanden}/${geprueft}` : '—').padEnd(14);
  });
  console.log(`  ${label.padEnd(38)}${spalten.join('')}`);
}

console.log('\n── Gesamt ──────────────────────────────────────────────────\n');
for (const l of LAEUFE) {
  const b = KATEGORIEN.reduce((s, [k]) => s + zaehler[l][k].bestanden, 0);
  const d = KATEGORIEN.reduce((s, [k]) => s + zaehler[l][k].durchgefallen, 0);
  const quote = b + d ? Math.round((b / (b + d)) * 100) : 0;
  console.log(`  ${l.padEnd(8)} ${b} von ${b + d} Einzelprüfungen bestanden (${quote} %)`);
}

console.log('\n── Ausgaben im Wortlaut ────────────────────────────────────');
for (const [name, je] of Object.entries(ausgaben)) {
  console.log(`\n${name}`);
  for (const l of LAEUFE) {
    console.log(`  [${l}] ${(je[l] ?? '—').replace(/\n+/g, ' ⏎ ')}`);
  }
}

console.log('\nStandaufnahme, kein Grenzwert-Test — Ziel ist der Vergleich der Läufe untereinander.');
