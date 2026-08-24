#!/usr/bin/env node
/**
 * Prüft lib/post-schreiben-entwurf.ts OHNE Browser/React: die Regel, wann
 * `textKi` im Schreibfenster geleert werden muss.
 *
 * DER FEHLER, DEN DAS FÄNGT
 *
 * `textKi` geht beim Senden unverändert an `/api/post/senden` und landet
 * dort in `post.ts::senden()` / `kiHerkunft()` (services/post-fussnote.ts).
 * Dort gilt: sobald `textKi` überhaupt gesetzt ist, bekommt die Mail
 * MINDESTENS die Fußzeile „mithilfe von … bearbeitet" — nie gar keine, egal
 * wie sehr sich `textKi` und der tatsächlich gesendete Text unterscheiden
 * (`kiHerkunft()` prüft nur `if (!textKi) return null`, sonst IMMER 'ki'
 * oder 'ki_bearbeitet'). Reitet ein veralteter KI-Entwurf an einem Text mit,
 * der nichts mehr mit ihm zu tun hat (Box geleert, neu von Hand
 * geschrieben), behauptet die ausgehende Mail eine KI-Beteiligung, die es
 * nicht gab — eine falsche Tatsachenbehauptung gegenüber dem Empfänger. Die
 * Bauart in PostSchreiben.tsx (siehe dort `kiSchreiben()`/`senden()`) macht
 * genau diesen Fehler unmöglich, indem sie den zuständigen Zustand nur über
 * `textKiNachTextaenderung()` weiterreicht.
 *
 * WARUM KEIN REACT/DOM
 * `textKiNachTextaenderung()` hat keinen einzigen Import (siehe Dateikopf
 * dort) — absichtlich, damit dieser Prüflauf das Modul direkt laden kann,
 * ohne React, Store, i18n oder ein CSS-Modul mitzuziehen (dasselbe Problem,
 * das scripts/benachrichtigung-lib-pruefen.mjs für ein anderes Modul mit
 * einem Loader-Hook löst — hier unnötig, weil es gar keine Geschwister-
 * Importe gibt, die laufen könnten).
 *
 * ACHT SZENARIEN, NICHT NUR DIE LEERE BOX
 * Die ersten drei sind die Gegenprobe: eine echte Bearbeitung (klein oder
 * groß, aber noch mit MINDESTENS einem gemeinsamen Wort AUSSERHALB von
 * Anrede/Grußformel) MUSS `textKi` stehen lassen, sonst verschwände der Fall
 * „mithilfe von KI bearbeitet" komplett aus der Oberfläche — Gegenprobe 3
 * ist absichtlich so gebaut, dass der bearbeitete Text ein einzelnes Wort
 * mit dem Entwurf teilt (ein anderer Fixture-Text ohne jede Überschneidung
 * hätte hier unbemerkt die FALSCHE Sache geprüft: „stark bearbeitet" sähe
 * dann identisch aus wie „komplett unabhängig", und genau diesen Unterschied
 * soll die Regel treffen). Danach kommt der eigentliche Fang in drei
 * Spielarten: eine geleerte Box setzt zurück, ein davon unabhängig neu
 * getippter Text bleibt danach frei von einem alten Entwurf, UND — der Fall
 * aus der Meldung — „alles markieren, neu tippen" ersetzt den Text, OHNE JE
 * DURCH `''` ZU LAUFEN, und muss trotzdem räumen. Szenario 7 ist die
 * GRUSSFORMEL-LÜCKE selbst (siehe post-schreiben-entwurf.ts, Dateikopf):
 * ein Entwurf UND eine davon völlig unabhängige, handschriftliche Antwort
 * teilen sich nur die Firmenanrede/-grußformel — das MUSS räumen, ist aber
 * genau der Fall, den die alte Regel ("ein geteiltes Wort reicht") verpasst
 * hat. Am Ende steht eine Kreuzprobe gegen das echte `veraenderung()` aus
 * post-wissen-ki.ts (Server): die beiden Regeln sind seit der
 * Grußformel-Lücke NICHT mehr identisch (siehe post-schreiben-entwurf.ts),
 * aber die eine Richtung, die trotzdem gelten MUSS, bleibt geprüft: räumt
 * der Server (kein gemeinsames Wort mehr, nicht einmal Anrede/Gruß), MUSS
 * dieser Client-Code auch räumen — eine schmalere Wortmenge kann eine
 * bereits leere Schnittmenge nicht wieder auffüllen. Szenario 7 belegt
 * ausdrücklich den Fall, in dem NUR die Client-Seite räumt, der Server aber
 * (noch, wegen Anrede/Gruß) nicht — das ist die gewollte Abweichung, keine
 * driftende.
 *
 * Aufruf:  node scripts/post-schreiben-textki-pruefen.mjs
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const wurzel = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modulPfad = path.join(wurzel, 'packages/desktop/src/lib/post-schreiben-entwurf.ts');
const veraenderungPfad = path.join(wurzel, 'packages/server/src/services/post-wissen-ki.ts');
const desktopPaket = path.join(wurzel, 'packages/desktop');

if (!fs.existsSync(modulPfad)) {
  console.error(`Nicht gefunden: ${modulPfad}`);
  process.exit(1);
}
if (!fs.existsSync(veraenderungPfad)) {
  console.error(`Nicht gefunden: ${veraenderungPfad}`);
  process.exit(1);
}

const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'stellium-post-schreiben-textki-'));
let fehler = 0;
try {
  const probeDatei = path.join(ordner, 'probe.mts');
  fs.writeFileSync(
    probeDatei,
    `import { textKiNachTextaenderung as f } from ${JSON.stringify(pathToFileUrlLiteral(modulPfad))};
import { veraenderung } from ${JSON.stringify(pathToFileUrlLiteral(veraenderungPfad))};

let fehler = 0;
const pruef = (name, ist, soll) => {
  const ok = JSON.stringify(ist) === JSON.stringify(soll);
  if (!ok) fehler++;
  console.log(\`  \${ok ? '\\x1b[32m✓\\x1b[0m' : '\\x1b[31m✗\\x1b[0m'} \${name}\${ok ? '' : \`  \${JSON.stringify(ist)} statt \${JSON.stringify(soll)}\`}\`);
};
const pruefWahr = (name, ist) => pruef(name, ist, true);

const ENTWURF = 'Guten Tag, wir pruefen Ihre Anfrage gerne und melden uns in Kuerze. Stellium Support Team';

// Gegenprobe 1: unveraendert uebernommen — textKi bleibt stehen, sonst gaebe
// es den Fall "automatisch erstellt" nie.
pruef('unveraendert uebernommen: textKi bleibt', f(ENTWURF, ENTWURF), ENTWURF);

// Gegenprobe 2: klein bearbeitet (Tippfehler, Anrede) — textKi bleibt stehen.
pruef('klein bearbeitet: textKi bleibt', f(ENTWURF, ENTWURF + ' Danke!'), ENTWURF);

// Gegenprobe 3: STARK bearbeitet, aber noch mit einem gemeinsamen Wort
// ("Stellium") — textKi bleibt stehen, das ist der gewollte Fall "mithilfe
// von KI bearbeitet". Absichtlich NICHT ueberschneidungsfrei: ein Fixture
// ohne jedes gemeinsame Wort wuerde unbemerkt denselben Pfad wie "komplett
// unabhaengig" pruefen und den Unterschied verdecken, den diese Regel
// gerade treffen soll.
const STARK_BEARBEITET = 'Ganz anderer Text zu Stellium, der sonst nichts mehr mit dem Entwurf gemein hat.';
pruef('stark bearbeitet, ein gemeinsames Wort: textKi bleibt', f(ENTWURF, STARK_BEARBEITET), ENTWURF);

// Der Fang, Teil 1: die Box vollstaendig geleert — textKi geht auf null.
pruef('Box geleert: textKi wird null', f(ENTWURF, ''), null);

// Der Fang, Teil 2: nach dem Leeren neu (und unabhaengig) getippt — textKi
// bleibt null. Genau diese Kette waere sonst das Leck: ein alter Entwurf,
// der an unabhaengigem Text mitreitet und beim Senden eine falsche
// KI-Beteiligung behauptet.
const nachDemLeeren = f(f(ENTWURF, ''), 'Hallo, das hier hat mit der KI nichts zu tun.');
pruef('nach dem Leeren neu getippt: textKi bleibt null', nachDemLeeren, null);

// Der Fang, Teil 3 — DER GEMELDETE FEHLER: alles markiert und ueberschrieben,
// OHNE dass die Box je durch '' lief. Kein einziges gemeinsames Wort mit dem
// Entwurf — textKi muss trotzdem auf null gehen, sonst behauptet die
// gesendete Mail eine KI-Beteiligung, die es nie gab.
const MARKIERT_UEBERSCHRIEBEN = 'Kannst du bitte den Termin auf Freitag verschieben? Danke, Sabine.';
pruef('markiert und ueberschrieben, nie leer: textKi wird null', f(ENTWURF, MARKIERT_UEBERSCHRIEBEN), null);

// Szenario 7 — DIE GRUSSFORMEL-LUECKE (der zweite gemeldete Fehler): Entwurf
// UND Antwort tragen dieselbe Firmenanrede/-grussformel, sind inhaltlich
// aber komplett unabhaengig voneinander. Vor dem Fix blieb "geehrte",
// "damen", "herren", "freundlichen", "gruessen" als "geteiltes Wort" stehen
// und textKi ritt mit -- die Mail haette faelschlich eine KI-Beteiligung
// behauptet, die es nie gab.
const KI_ENTWURF_MIT_GRUSS = 'Sehr geehrte Damen und Herren, wir pruefen Ihre Anfrage gerne und melden '
  + 'uns in Kuerze bei Ihnen. Mit freundlichen Gruessen';
const UNABHAENGIGE_ANTWORT_MIT_GRUSS = 'Sehr geehrte Damen und Herren, der Termin am Freitag passt uns '
  + 'leider nicht, bitte schlagen Sie einen neuen Termin vor. Mit freundlichen Gruessen';
pruef('nur Anrede/Grussformel geteilt, sonst unabhaengig: textKi wird null',
  f(KI_ENTWURF_MIT_GRUSS, UNABHAENGIGE_ANTWORT_MIT_GRUSS), null);

// Kreuzprobe: dieselben Textpaare gegen das echte veraenderung() aus
// post-wissen-ki.ts (Server) gehalten. Seit der Grussformel-Luecke ist das
// KEINE Gleichheitsprobe mehr (siehe post-schreiben-entwurf.ts, Dateikopf) —
// die Client-Regel ignoriert Anrede/Grussformel, die Server-Regel nicht, und
// darf deshalb OEFTER raeumen als der Server. Was bleiben MUSS: raeumt der
// Server (veraenderung() === 1, kein gemeinsames Wort mehr, nicht einmal
// Anrede/Gruss), MUSS der Client auch raeumen -- eine schmalere Wortmenge
// kann eine bereits leere Schnittmenge nicht wieder auffuellen. Die letzten
// beiden Paare zeigen ausdruecklich die GEWOLLTE Abweichung: Client raeumt,
// Server (noch) nicht.
const paare = [
  ['unveraendert', ENTWURF, ENTWURF, false],
  ['klein bearbeitet', ENTWURF, ENTWURF + ' Danke!', false],
  ['stark bearbeitet, ein gemeinsames Wort', ENTWURF, STARK_BEARBEITET, false],
  ['markiert und ueberschrieben', ENTWURF, MARKIERT_UEBERSCHRIEBEN, false],
  ['nach dem Leeren neu getippt', ENTWURF, 'Hallo, das hier hat mit der KI nichts zu tun.', false],
  ['nur Anrede/Grussformel geteilt (gewollte Abweichung)',
    KI_ENTWURF_MIT_GRUSS, UNABHAENGIGE_ANTWORT_MIT_GRUSS, true],
];
for (const [name, vorher, nachher, gewollteAbweichung] of paare) {
  const raeumtHier = f(vorher, nachher) === null;
  const raeumtDort = veraenderung(vorher, nachher) === 1;
  // Die einzige Regel, die IMMER gelten muss: Server raeumt ⇒ Client raeumt
  // auch. Umgekehrt (Client raeumt ⇒ Server raeumt) gilt bewusst NICHT mehr.
  pruefWahr(\`Kreuzprobe (Server raeumt ⇒ Client raeumt auch): \${name}\`, !raeumtDort || raeumtHier);
  if (gewollteAbweichung) {
    pruef(\`Kreuzprobe, gewollte Abweichung bestaetigt: \${name} (Client raeumt, Server nicht)\`,
      { raeumtHier, raeumtDort }, { raeumtHier: true, raeumtDort: false });
  } else {
    pruef(\`Kreuzprobe (weiterhin gleich, keine Anrede/Gruss-Ueberschneidung im Spiel): \${name}\`,
      raeumtHier, raeumtDort);
  }
}

console.log(fehler ? \`\\x1b[31m\${fehler} fehlgeschlagen\\x1b[0m\` : '\\x1b[32mok\\x1b[0m');
process.exit(fehler ? 1 : 0);
`,
  );

  execFileSync('npx', ['tsx', probeDatei], { cwd: desktopPaket, stdio: 'inherit' });
} catch {
  fehler += 1;
} finally {
  fs.rmSync(ordner, { recursive: true, force: true });
}

console.log(fehler
  ? '\n\x1b[31mtextKi-Räumpflicht verletzt\x1b[0m\n'
  : '\n\x1b[32mtextKi bleibt stehen, solange der neue Text mindestens ein Wort außerhalb von Anrede/'
    + 'Grußformel mit dem Entwurf teilt, so stark die Bearbeitung sonst auch ausfällt — geräumt wird,'
    + ' sobald kein solches Wort mehr übrig ist, ob die Box dabei je leer war (getippt oder'
    + ' markiert-und-überschrieben) oder nicht, oder ob nur noch die Firmenanrede/-grußformel geteilt'
    + ' ist. Das ist ENGER als das echte veraenderung() aus dem Server (das zählt auch Anrede/Gruß) —'
    + ' geprüft bleibt nur die eine Richtung, die gelten muss: räumt der Server, räumt der Client auch.'
    + '\x1b[0m\n');
process.exit(fehler ? 1 : 0);

/** file://-URL als Literal für die generierte Probedatei — Windows-Backslashes eingeschlossen. */
function pathToFileUrlLiteral(p) {
  return `file://${p.replace(/\\/g, '/')}`;
}
