/**
 * Findet Texte, die fest im Code stehen statt aus dem Wörterbuch zu kommen.
 *
 * Gesucht wird nach dem, was ein Mensch liest: JSX-Text, title=, placeholder=,
 * aria-label= und die Titel von Meldungen. Erkennungsmerkmal ist deutsche
 * Rechtschreibung — Umlaute oder eines der häufigen Wörter.
 */
import fs from 'node:fs';
import path from 'node:path';

const WURZEL = 'packages/desktop/src';
const AUS = ['i18n', 'lib/format.ts'];

const DEUTSCH = /[äöüÄÖÜß]|\b(der|die|das|und|oder|nicht|noch|schon|kein|keine|dir|dich|dein|deine|du|wird|wurde|werden|ist|sind|war|haben|hat|kann|darf|muss|soll|beim|zum|zur|vom|für|mit|ohne|über|unter|nach|von|auf|aus|als|wie|was|wer|wann|warum|hier|dort|jetzt|immer|nie|alle|alles|etwas|nichts|mehr|weniger|sehr|ganz|nur|auch|aber|denn|weil|damit|dass|wenn|dann|also|schließen|öffnen|senden|löschen|ändern|speichern|abbrechen|zurück|weiter|neu|alt|Nachricht|Kanal|Datei|Aufgabe|Person|Team|Sprache|Einstellung)\b/i;

const treffer = [];

function pruefeDatei(pfad) {
  const inhalt = fs.readFileSync(pfad, 'utf8');
  const zeilen = inhalt.split('\n');

  /* Blockkommentare überspannen mehrere Zeilen — ohne diesen Zustand landen
     die Fortsetzungszeilen als angebliche Oberflächentexte im Bericht. */
  let imBlock = false;

  zeilen.forEach((zeile, i) => {
    let ohneKommentar = zeile;
    if (imBlock) {
      const zu = ohneKommentar.indexOf('*/');
      if (zu === -1) return;
      imBlock = false;
      ohneKommentar = ohneKommentar.slice(zu + 2);
    }
    ohneKommentar = ohneKommentar.replace(/\/\*.*?\*\//g, '');
    const auf = ohneKommentar.indexOf('/*');
    if (auf !== -1) {
      imBlock = true;
      ohneKommentar = ohneKommentar.slice(0, auf);
    }
    ohneKommentar = ohneKommentar.replace(/\/\/.*$/, '');
    if (!DEUTSCH.test(ohneKommentar)) return;

    const funde = [];

    // title="…", placeholder="…", aria-label="…", label="…"
    for (const m of ohneKommentar.matchAll(/\b(title|placeholder|aria-label|label|subtitle)=["']([^"']{3,})["']/g)) {
      if (DEUTSCH.test(m[2])) funde.push(`${m[1]}="${m[2]}"`);
    }

    // Zeichenketten in Aufrufen: toast({ title: 'Deutsch' }), throw new Error('…')
    for (const m of ohneKommentar.matchAll(/(?:title|body|label|placeholder):\s*'([^']{3,})'/g)) {
      if (DEUTSCH.test(m[1])) funde.push(`'${m[1]}'`);
    }

    /* Zeichenketten als Argument: mit(…, 'Gesperrt'), confirm('… wirklich …').
       Diese Muster fehlten und haben ein gutes Dutzend Texte durchgelassen. */
    for (const m of ohneKommentar.matchAll(/(?:^|[(,?:]\s*)'([^']{4,})'/g)) {
      const text = m[1];
      if (!DEUTSCH.test(text)) continue;
      // Importpfade, Klassennamen und Schlüssel sind kein Oberflächentext.
      if (/^[a-z0-9_.\/-]+$/i.test(text)) continue;
      if (/^[a-z]+\.[a-zA-Z]/.test(text)) continue;
      // CSS-Auswahl und Protokollnamen: enthalten keine Satzzeichen und
      // stehen voller Bindestriche, Doppelpunkte oder eckiger Klammern.
      if (/^[[.#]/.test(text) || /\[data-|^[a-z]+:[a-z-]+$/.test(text)) continue;
      funde.push(`Argument: '${text}'`);
    }

    // JSX-Text, der mit einem Ausdruck in derselben Zeile steht.
    for (const m of ohneKommentar.matchAll(/[>}]\s*([A-ZÄÖÜ][^<>{}='"]{6,})\s*[<{]/g)) {
      const text = m[1].trim();
      if (DEUTSCH.test(text)) funde.push(`Text: ${text}`);
    }

    // Reiner JSX-Text zwischen den Zeichen > und <
    for (const m of ohneKommentar.matchAll(/>([^<>{}\n]{3,})</g)) {
      const text = m[1].trim();
      if (text && DEUTSCH.test(text) && !/^[{}\s]*$/.test(text)) funde.push(`Text: ${text}`);
    }

    // Alleinstehender JSX-Text am Zeilenanfang (mehrzeilige Absätze)
    const alleinstehend = ohneKommentar.trim();
    if (!funde.length && /^[A-ZÄÖÜ][^<>{}='"]{8,}$/.test(alleinstehend) && DEUTSCH.test(alleinstehend)) {
      funde.push(`Absatz: ${alleinstehend.slice(0, 60)}`);
    }

    for (const fund of funde) {
      treffer.push({ datei: pfad, zeile: i + 1, fund: fund.slice(0, 100) });
    }
  });
}

function durchlaufen(ordner) {
  for (const eintrag of fs.readdirSync(ordner, { withFileTypes: true })) {
    const pfad = path.join(ordner, eintrag.name);
    if (AUS.some((a) => pfad.includes(a))) continue;
    if (eintrag.isDirectory()) durchlaufen(pfad);
    else if (/\.tsx?$/.test(eintrag.name)) pruefeDatei(pfad);
  }
}

durchlaufen(WURZEL);

const nachDatei = new Map();
for (const t of treffer) {
  if (!nachDatei.has(t.datei)) nachDatei.set(t.datei, []);
  nachDatei.get(t.datei).push(t);
}

const sortiert = [...nachDatei.entries()].sort((a, b) => b[1].length - a[1].length);
for (const [datei, liste] of sortiert) {
  console.log(`\n${datei.replace(WURZEL + '/', '')} — ${liste.length}`);
  for (const t of liste.slice(0, 40)) console.log(`  ${String(t.zeile).padStart(4)}  ${t.fund}`);
  if (liste.length > 40) console.log(`  … ${liste.length - 40} weitere`);
}
console.log(`\nGesamt: ${treffer.length} in ${nachDatei.size} Dateien`);
