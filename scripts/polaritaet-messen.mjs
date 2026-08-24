/**
 * Kippt Kontext die Polarität einer kurzen Absage/Zusage — und wenn ja, wie
 * oft, und lässt sich das mit einer ausdrücklichen Regel schließen?
 *
 * ANLASS
 *
 * Rückfrage der Koordination zu Beispiel 4 aus scripts/uebersetzung-messen.mjs
 * (Kontext-Vergleich): "lass mal lieber" (Absage) nach "sollen wir das jetzt
 * gleich live schalten?" kam MIT Kontext als "Let's just do it live" zurück —
 * das Gegenteil der Absage. In einem Firmen-Chat der gefährlichste Fehler:
 * eine Person wird angewiesen, NICHT auszuliefern, und liest, sie solle es
 * tun. Ein Treffer in einem 15 Fälle kleinen Korpus beweist aber nichts —
 * dieser Lauf misst gezielt und mit Wiederholungen, ob das systematisch ist.
 *
 * AUFBAU (siehe scripts/uebersetzung-korpus.mjs, POLARITAET_KORPUS)
 *
 *   Vier Gruppen: Absage/Zusage × enthusiastischer/neutraler Vorschlag. Die
 *   Zusage-Gruppen sind die Spiegel-Kontrolle für die Hypothese der
 *   Koordination: driftet das Modell einfach zur Stimmung der vorherigen
 *   Zeile, unabhängig davon, was die Antwort selbst sagt? Wenn ja, müssten
 *   AUCH Zusagen nach einem enthusiastischen Vorschlag auffällig oft "richtig"
 *   bleiben (sie sagen ja ohnehin dasselbe wie die Stimmung), während Absagen
 *   nach genau demselben Vorschlag kippen — asymmetrisch zwischen den beiden
 *   Spiegel-Gruppen. Der Vergleich enthusiastisch/neutral trennt zusätzlich
 *   "Kontext an sich riskant" von "Kontext riskant speziell bei Begeisterung
 *   in der vorherigen Zeile".
 *
 *   Jeder Fall läuft WIEDERHOLT (REPS, Vorgabe 3) bei temperature 0 je
 *   Bedingung — eine einzelne Messung reicht nicht: die zwei Ausgangsläufe
 *   für den ersten Bericht unterschieden sich bereits um ein halbes Prozent
 *   voneinander, ganz ohne jede Änderung dazwischen.
 *
 * GUARD=1 aktiviert eine zusätzliche Anweisungszeile (siehe POLARITAETS_WACHE
 * unten), probeweise VOR jedem Verankern in prompt.ts: die Polarität der zu
 * übersetzenden Nachricht selbst hat immer Vorrang vor der Stimmung des
 * Kontexts. Ohne GUARD misst dieser Lauf den JETZIGEN Stand (prompt.ts
 * unverändert); mit GUARD den Kandidaten für eine Korrektur — beides mit
 * derselben Messmethode, um wirklich vergleichbar zu sein.
 *
 *   ssh -f -N -L 11500:100.125.43.46:11500 stellium
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/polaritaet-messen.mjs
 *   MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b GUARD=1 node scripts/polaritaet-messen.mjs
 *   REPS=5 MODELL=... node scripts/polaritaet-messen.mjs   # mehr Wiederholungen
 */
import { detectLanguage, normalizeLang } from '../packages/shared/src/languages.ts';
import { maskText, unmaskText } from '../packages/shared/src/markup.ts';
import { istEcho } from '../packages/server/src/translation/echo.ts';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur }
  from '../packages/server/src/translation/prompt.ts';
import { uebersetzungAusAntwort } from '../packages/server/src/translation/antwort.ts';
import { verlaufAlsKontext } from '../packages/server/src/translation/verlauf.ts';
import { POLARITAET_KORPUS, POLARITAET_MEHRDEUTIG_KORPUS, KONTEXT_KORPUS } from './uebersetzung-korpus.mjs';
import { polaritaetsWiderspruch } from '../packages/server/src/translation/polaritaet.ts';

const ADRESSE = process.env.MODELL;
if (!ADRESSE) {
  console.error('MODELL=<baseUrl> setzen, z. B.:');
  console.error('  MODELL=http://127.0.0.1:11500/v1 MODELL_ID=qwen3-8b node scripts/polaritaet-messen.mjs');
  process.exit(1);
}
const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';
const REPS = Number(process.env.REPS) || 3;
const GUARD = process.env.GUARD === '1';

/* Kandidat für prompt.ts, siehe Bericht — NICHT dort verankert, solange
   dieser Lauf nicht zeigt, dass er hilft, ohne den ursprünglich behobenen
   Fall (KONTEXT_KORPUS, "mache ich kein problem") wieder zu verschlechtern. */
const POLARITAETS_WACHE = 'Die Polarität der zu übersetzenden Nachricht selbst hat immer Vorrang vor der '
  + 'Stimmung des Kontexts: Ist die Nachricht eine Absage oder Ablehnung, bleibt sie eine Absage, auch wenn der '
  + 'vorherige Vorschlag begeistert klang. Der Kontext hilft nur bei der Deutung, welche Bedeutung eine kurze '
  + 'Antwort hat — er darf ihre Polarität nie umdrehen.';

/* ── Anfrage ans Modell (wie in uebersetzung-messen.mjs) ─────────── */
async function einzelneAnfrage(text, ziel, quelle, nachdruck, context = null) {
  const req = { text, targetLang: ziel, sourceLang: quelle, nachdruck, context };
  const rules = uebersetzungsRegeln(req);
  if (GUARD && context) rules.push(POLARITAETS_WACHE);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45_000);
  try {
    const res = await fetch(`${ADRESSE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pruefung' },
      body: JSON.stringify({
        model: MODELL_ID,
        messages: [{ role: 'system', content: rules.join('\n') }, { role: 'user', content: text }],
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

/* ── Polaritäts-Klassifizierer ──────────────────────────────────────
   Dieselbe Bauart wie FOERMLICH_MARKER/JARGON_MARKER in
   uebersetzung-messen.mjs: kein Anspruch auf jede denkbare Formulierung,
   aber breit genug für das, was ein 8B-Modell hier tatsächlich ausgibt —
   und jeder Treffer wird unten trotzdem im Wortlaut ausgegeben, damit eine
   Person nachliest statt dem Muster blind zu vertrauen. */
const AGREEMENT_MARKER_EN = /\b(let'?s\b[^.!?]{0,20}\b(do it|do that|go for it|go ahead|proceed|launch it|go live)\b|yes,?\s+let'?s\b|sure\b|of course|definitely|absolutely|i'?m (in|down|game|for it)|sounds good|why not|count me in|will do|on it\b|i'?ll (do it|take care|handle|get it)|let'?s go\b|got it\b)/i;
const DECLINE_MARKER_EN = /\b(let'?s not|rather not|better not|i'?d (rather not|hold off|skip|pass)|wouldn'?t|would not\b|won'?t|shouldn'?t|should not\b|don'?t think (so|we should)|hold off|not (right )?now\b|i'?ll (pass|skip)\b|leave it( be)?\b|let it be|better (to )?hold off|not a good idea|i'?d say (no|not)|no,? let'?s|i'?ll leave it|can'?t\b.*\b(today|anymore)\b)/i;

function classifyPolarity(text) {
  const zusage = AGREEMENT_MARKER_EN.test(text);
  const absage = DECLINE_MARKER_EN.test(text);
  if (zusage && !absage) return 'zusage';
  if (absage && !zusage) return 'absage';
  if (zusage && absage) return 'beides';
  return 'unklar';
}

/* ── Hauptlauf: Absage/Zusage-Korpus ───────────────────────────────── */

console.log(`\nPolaritäts-Messung an ${MODELL_ID} über ${ADRESSE}`);
console.log(`${POLARITAET_KORPUS.length} Fälle × 2 Bedingungen (ohne/mit Kontext) × ${REPS} Wiederholungen`
  + `${GUARD ? '  [GUARD aktiv — Polaritäts-Wache in der Anweisung]' : '  [ohne Wache — heutiger Stand]'}\n`);

const LAEUFE = ['ohne', 'mit'];
/** Zählung je Gruppe (absage-enthusiastisch, ...) × Bedingung. */
const gruppenZaehler = {};
/** Rohe Einzelergebnisse für die Inversions-Liste am Ende. */
const inversionen = [];
let gesamtLaeufe = 0;
let gesamtInvertiert = 0;

/* ── Wächter-Prüfung: die eigentliche Produktionsprüfung ──────────────
   Ob EIN gegebenes Fallpaar (ohne, mit) eine ECHTE Inversion ist, wird
   NICHT über den Klassifizierer dieses Skripts entschieden (der ist für
   die KORPUS-BEWERTUNG gebaut, nicht als Grundwahrheit) — sondern über die
   sorgfältig von Hand gelesene Grundwahrheit aus dem ersten Lauf: In 216
   Einzelläufen kippte GENAU EINE Floskel ("lass mal lieber", beide
   Vorschlagsarten) — jede Zeile jedes Transkripts einzeln gelesen, nicht nur
   die Musterklassen. Deshalb hier wörtlich benannt statt neu geraten. */
const bekannteInversion = (fall) => fall.text === 'lass mal lieber';
const waechter = { richtigErkannt: 0, verpasst: 0, unnoetigAusgeloest: 0, richtigRuhig: 0 };

for (const fall of POLARITAET_KORPUS) {
  const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
  const kontext = verlaufAlsKontext(fall.vorher);
  gruppenZaehler[fall.gruppe] ??= { ohne: { zusage: 0, absage: 0, unklar: 0, beides: 0 }, mit: { zusage: 0, absage: 0, unklar: 0, beides: 0 } };

  const ausgabenJeLauf = {};
  for (const lauf of LAEUFE) {
    const ausgaben = [];
    for (let i = 0; i < REPS; i++) {
      const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
      const text = ergebnis ? unmaskText(ergebnis.translation, tokens) : null;
      const klasse = text ? classifyPolarity(text) : 'unklar';
      gruppenZaehler[fall.gruppe][lauf][klasse]++;
      ausgaben.push({ text, klasse });
      gesamtLaeufe++;

      const falscheRichtung = fall.erwartetePolaritaet === 'absage' ? 'zusage' : 'absage';
      if (klasse === falscheRichtung) {
        gesamtInvertiert++;
        inversionen.push({
          gruppe: fall.gruppe, name: fall.name, lauf, text, vorher: fall.vorher, ziel: fall.erwartetePolaritaet,
        });
      }
    }
    ausgabenJeLauf[lauf] = ausgaben;
  }

  /* Wächter je Wiederholung, gepaart über denselben Index i — jede
     Wiederholung ist ein unabhängiger Testfall für die Wächter-Prüfung,
     nicht nur eine Wiederholung derselben Frage. */
  const istBekannt = bekannteInversion(fall);
  for (let i = 0; i < REPS; i++) {
    const ohneText = ausgabenJeLauf.ohne[i]?.text;
    const mitText = ausgabenJeLauf.mit[i]?.text;
    if (!ohneText || !mitText) continue;
    const ausgeloest = polaritaetsWiderspruch(ohneText, mitText, fall.ziel);
    if (istBekannt) {
      if (ausgeloest) waechter.richtigErkannt++; else waechter.verpasst++;
    } else if (ausgeloest) {
      waechter.unnoetigAusgeloest++;
      console.log(`    [WÄCHTER LÖST AUS, OBWOHL KEINE BEKANNTE INVERSION] ${fall.name}`);
      console.log(`      ohne: ${ohneText}`);
      console.log(`      mit:  ${mitText}`);
    } else {
      waechter.richtigRuhig++;
    }
  }

  const zeile = (lauf) => {
    const ks = ausgabenJeLauf[lauf].map((a) => a.klasse[0].toUpperCase());
    const beispiel = ausgabenJeLauf[lauf].find((a) => a.text)?.text ?? '(keine Antwort)';
    return `${lauf.padEnd(6)} [${ks.join('')}]  ${beispiel}`;
  };
  console.log(`  ${fall.name.padEnd(48)} erwartet: ${fall.erwartetePolaritaet}`);
  console.log(`    ${zeile('ohne')}`);
  console.log(`    ${zeile('mit')}`);
}

/* ── Bericht: Inversionsrate je Gruppe ─────────────────────────────── */

console.log('\n── Inversionsrate je Gruppe (Anteil der Läufe mit VERKEHRTER Polarität) ──\n');
console.log(`  ${'Gruppe'.padEnd(24)}${'ohne'.padEnd(16)}${'mit'.padEnd(16)}`);
const gruppenNamen = ['absage-enthusiastisch', 'zusage-enthusiastisch', 'absage-neutral', 'zusage-neutral'];
const rateJeGruppe = {};
for (const g of gruppenNamen) {
  const z = gruppenZaehler[g];
  if (!z) continue;
  const erwartet = g.startsWith('absage') ? 'absage' : 'zusage';
  const falsch = erwartet === 'absage' ? 'zusage' : 'absage';
  const spalten = LAEUFE.map((l) => {
    const gesamt = z[l].zusage + z[l].absage + z[l].unklar + z[l].beides;
    const rate = gesamt ? Math.round((z[l][falsch] / gesamt) * 100) : 0;
    rateJeGruppe[`${g}-${l}`] = { falsch: z[l][falsch], gesamt, rate };
    return `${z[l][falsch]}/${gesamt} (${rate} %)`.padEnd(16);
  });
  console.log(`  ${g.padEnd(24)}${spalten.join('')}`);
}

console.log('\n── Gesamt-Inversionsrate (alle Absage- und Zusage-Gruppen zusammen) ──\n');
for (const lauf of LAEUFE) {
  let gesamt = 0; let falsch = 0;
  for (const g of gruppenNamen) {
    const z = gruppenZaehler[g];
    if (!z) continue;
    const erwartet = g.startsWith('absage') ? 'absage' : 'zusage';
    const falscheRichtung = erwartet === 'absage' ? 'zusage' : 'absage';
    gesamt += z[lauf].zusage + z[lauf].absage + z[lauf].unklar + z[lauf].beides;
    falsch += z[lauf][falscheRichtung];
  }
  const rate = gesamt ? ((falsch / gesamt) * 100).toFixed(1) : '0.0';
  console.log(`  ${lauf.padEnd(6)} ${falsch} von ${gesamt} Läufen invertiert (${rate} %)`);
}

/* Nur die Absage-Gruppen, enthusiastisch vs. neutral — die eigentliche
   Antwort auf die Hypothese der Koordination. */
console.log('\n── Speziell: Absagen nach enthusiastischem vs. neutralem Vorschlag, NUR "mit" ──\n');
for (const [g, label] of [['absage-enthusiastisch', 'enthusiastisch'], ['absage-neutral', 'neutral']]) {
  const r = rateJeGruppe[`${g}-mit`];
  if (r) console.log(`  ${label.padEnd(16)} ${r.falsch} von ${r.gesamt} zu "zusage" invertiert (${r.rate} %)`);
}

if (inversionen.length) {
  console.log(`\n── Alle ${inversionen.length} Invertierungen im Wortlaut ────────────────────\n`);
  for (const inv of inversionen) {
    console.log(`  [${inv.lauf}] ${inv.gruppe} — ${inv.name} (erwartet: ${inv.ziel})`);
    if (inv.lauf === 'mit') for (const v of inv.vorher) console.log(`         vorher  ${v.wer}: ${v.text}`);
    console.log(`         -> ${inv.text}`);
  }
} else {
  console.log('\n✓ Keine einzige Invertierung in diesem Lauf.');
}

/* ── Mehrdeutig-Kontrolle ───────────────────────────────────────────── */

console.log('\n\n══ Mehrdeutig-Kontrolle (Positivkontrolle für die Messmethode) ═══════\n');
let mehrdeutigBestanden = 0; let mehrdeutigGesamt = 0;
for (const fall of POLARITAET_MEHRDEUTIG_KORPUS) {
  const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
  const kontext = verlaufAlsKontext(fall.vorher);
  console.log(`  ${fall.name}`);
  const texteJeLauf = {};
  for (const lauf of LAEUFE) {
    const treffer = [];
    const texte = [];
    for (let i = 0; i < REPS; i++) {
      const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
      const text = ergebnis ? unmaskText(ergebnis.translation, tokens) : '';
      const erwartetOk = !fall.erwartet.length || fall.erwartet.every((r) => r.test(text));
      const verbotenOk = !fall.verboten.length || !fall.verboten.some((r) => r.test(text));
      const ok = erwartetOk && verbotenOk;
      mehrdeutigGesamt++;
      if (ok) mehrdeutigBestanden++;
      treffer.push(`${ok ? '✓' : '✗'} ${text}`);
      texte.push(text);
    }
    console.log(`    ${lauf.padEnd(6)} ${treffer.join('  |  ')}`);
    texteJeLauf[lauf] = texte;
  }
  // Wächter darf hier NIE auslösen — beide Seiten sind je Fall dieselbe
  // gewollte Deutung, keine Absage, siehe Doku in polaritaet.ts.
  for (let i = 0; i < REPS; i++) {
    const ausgeloest = polaritaetsWiderspruch(texteJeLauf.ohne[i], texteJeLauf.mit[i], fall.ziel);
    if (ausgeloest) {
      waechter.unnoetigAusgeloest++;
      console.log(`    [WÄCHTER LÖST AUS — POSITIVKONTROLLE, DARF NICHT SEIN] ${fall.name}`);
    } else {
      waechter.richtigRuhig++;
    }
  }
}
console.log(`\n  ${mehrdeutigBestanden} von ${mehrdeutigGesamt} Einzelläufen wie erwartet.`);

/* ── Rückfall-Kontrolle (nur bei GUARD=1) ────────────────────────────
   Schließt die Wache die Invertierung, ohne den ursprünglich behobenen Fall
   wieder zu verschlechtern? Dieselben Fälle wie im ersten Bericht
   (KONTEXT_KORPUS), hier nur die, die dort tatsächlich eine Verbesserung
   zeigten — mit denselben Wiederholungen wie oben, damit ein "sieht noch
   gut aus" nicht an einem einzigen günstigen Lauf hängt. */
if (GUARD) {
  const RUECKFALL_NAMEN = [
    'Auftraggeber-Beispiel: Zusage ohne Komma',
    'Naher Verwandter: Zusage mit "kein Ding"',
    '"geht klar" nach einer Nachfrage zum Befinden (Status, keine Aufgabe)',
  ];
  console.log('\n\n══ Rückfall-Kontrolle: bricht die Wache den ursprünglich behobenen Fall? ══\n');
  for (const fall of KONTEXT_KORPUS.filter((f) => RUECKFALL_NAMEN.includes(f.name))) {
    const { masked, tokens } = maskText(fall.text, { protectedTerms: [] });
    const kontext = verlaufAlsKontext(fall.vorher);
    console.log(`  ${fall.name}`);
    for (const lauf of ['ohne', 'mit']) {
      const treffer = [];
      for (let i = 0; i < REPS; i++) {
        const ergebnis = await uebersetzeMitNachfassen(masked, fall.ziel, fall.quelle, lauf === 'mit' ? kontext : null);
        const text = ergebnis ? unmaskText(ergebnis.translation, tokens) : '';
        const erwartetOk = !fall.erwartet.length || fall.erwartet.every((r) => r.test(text));
        const verbotenOk = !fall.verboten.length || !fall.verboten.some((r) => r.test(text));
        treffer.push(`${erwartetOk && verbotenOk ? '✓' : '✗'} ${text}`);
      }
      console.log(`    ${lauf.padEnd(6)} ${treffer.join('  |  ')}`);
    }
  }
}

console.log(`\n\nZusammenfassung: ${gesamtInvertiert} von ${gesamtLaeufe} Einzelläufen (Absage/Zusage-Korpus) mit `
  + `verkehrter Polarität${GUARD ? ' — MIT Polaritäts-Wache' : ' — ohne Wache (heutiger Stand)'}.`);

console.log('\n\n══ Wächter (translation/polaritaet.ts): erkennt er die Invertierung? ══\n');
const waechterGesamt = waechter.richtigErkannt + waechter.verpasst + waechter.unnoetigAusgeloest + waechter.richtigRuhig;
console.log(`  Bekannte Invertierungen erkannt:      ${waechter.richtigErkannt} von ${waechter.richtigErkannt + waechter.verpasst}`
  + ` (Trefferquote ${waechter.richtigErkannt + waechter.verpasst ? Math.round((waechter.richtigErkannt / (waechter.richtigErkannt + waechter.verpasst)) * 100) : 0} %)`);
console.log(`  Unnötig ausgelöst (falscher Alarm):    ${waechter.unnoetigAusgeloest} von ${waechter.unnoetigAusgeloest + waechter.richtigRuhig}`
  + ` (${waechter.unnoetigAusgeloest + waechter.richtigRuhig ? Math.round((waechter.unnoetigAusgeloest / (waechter.unnoetigAusgeloest + waechter.richtigRuhig)) * 100) : 0} % Fehlalarmquote)`);
console.log(`  Geprüfte Einzelläufe insgesamt: ${waechterGesamt}`);

console.log('\nStandaufnahme, kein Grenzwert-Test — Ziel ist der Vergleich zwischen ohne/mit Kontext und zwischen GUARD 0/1.');
process.exit(gesamtInvertiert > 0 && waechter.verpasst > 0 ? 1 : 0);
