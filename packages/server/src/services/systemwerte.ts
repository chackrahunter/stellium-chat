/**
 * Die Werte des Servers für die App — dieselben, die die Konsole auf dem Pi
 * zeigt.
 *
 * Sie werden NICHT neu gemessen. `stellium-konsole.mjs json` liefert genau
 * diese Zahlen bereits, samt aller Sonderfälle, die sich über Monate
 * angesammelt haben: welcher Temperaturfühler auf diesem Gerät zählt, wie
 * die Drosselung des Pi zu lesen ist, wie die Besucherzahlen aus dem
 * Zugriffsprotokoll entstehen. Das ein zweites Mal zu schreiben hieße, zwei
 * Quellen zu haben, die auseinanderlaufen — und die zweite wäre die
 * schlechtere, weil sie die Sonderfälle nicht kennt.
 *
 * Gemessen: ein Aufruf dauert rund 460 ms. Das ist zu viel, um ihn bei jeder
 * Anfrage zu machen, und wenig genug, um ihn im Hintergrund zu wiederholen.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { ROLES } from '@stellium/shared';
import { tokenLesen } from './verkaufzugang.js';

const SKRIPT = process.env.STELLIUM_KONSOLE
  ?? '/opt/stellium/server-setup/stellium-konsole.mjs';

/*
 * Welche Rollen `stellium-konsole.mjs` (dort `kontenBedingung()`) aus
 * „Konten" und aus dem Nenner von „Team online" herausrechnet — abgeleitet
 * von ROLES/technical (@stellium/shared, derselben Quelle wie TeamAdmin.tsx
 * ZUWEISBARE_ROLLEN), nicht von Hand gepflegt. Das Skript ist ein
 * eigenständiger `node`-Aufruf ohne Zugriff auf dieses TypeScript-Paket,
 * deshalb geht die Liste als Umgebungsvariable mit — genau wie GUMROAD_TOKEN
 * unten, aus demselben Grund. Statisch berechnet: ROLES ändert sich nur mit
 * einer neuen Fassung, nicht zur Laufzeit.
 */
const TECHNISCHE_ROLLEN = ROLES.filter((r) => r.technical).map((r) => r.name).join(',');

/* Vier Sekunden: die Konsole selbst zeichnet alle drei Sekunden neu, und
   schneller ändern sich Auslastung und Temperatur ohnehin nicht sinnvoll. */
const FRIST_MS = 4000;

let stand: { zeit: number; werte: unknown } | null = null;
let laeuft: Promise<unknown> | null = null;

export function verfuegbar(): boolean {
  try { return fs.existsSync(SKRIPT); } catch { return false; }
}

function holen(): Promise<unknown> {
  return new Promise((fertig, scheitern) => {
    /*
     * Den Gumroad-Token als Umgebungsvariable durchreichen.
     *
     * Die Konsole sucht ihn zuerst dort (`process.env.GUMROAD_TOKEN`) und
     * erst danach in `/etc/stellium-triton.env`. So kann er in der App
     * hinterlegt werden — verschlüsselt in der Datenbank — statt im Klartext
     * in einer Datei auf dem Pi zu liegen.
     *
     * Nur gesetzt, wenn es ihn gibt: eine leere Variable würde die Datei
     * NICHT überschreiben (die Konsole prüft auf einen nichtleeren Wert),
     * aber ein leerer Eintrag in der Umgebung ist trotzdem Unordnung.
     */
    const gumroad = tokenLesen();
    execFile('node', [SKRIPT, 'json'], {
      timeout: 20_000,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        ...(gumroad ? { GUMROAD_TOKEN: gumroad } : {}),
        STELLIUM_TECHNISCHE_ROLLEN: TECHNISCHE_ROLLEN,
      },
    },
      (fehler, aus) => {
        if (fehler) { scheitern(fehler); return; }
        try { fertig(JSON.parse(aus)); } catch (f) { scheitern(f as Error); }
      });
  });
}

/**
 * Die aktuellen Werte, höchstens `FRIST_MS` alt.
 *
 * Mehrere gleichzeitige Anfragen teilen sich einen Aufruf. Ohne das startet
 * jeder Zuschauer seinen eigenen Prozess, und bei vier offenen Fenstern
 * liefen vier Messungen nebeneinander — auf einem Gerät mit vier Kernen ist
 * das kein Detail.
 */
export async function werte(): Promise<unknown> {
  const jetzt = Date.now();
  if (stand && jetzt - stand.zeit < FRIST_MS) return stand.werte;
  if (laeuft) return laeuft;
  laeuft = holen()
    .then((w) => { stand = { zeit: Date.now(), werte: w }; return w; })
    .finally(() => { laeuft = null; });
  try {
    return await laeuft;
  } catch (fehler) {
    /* Lieber alte Zahlen als gar keine — ein einzelner Fehlschlag soll die
       Anzeige nicht leeren. Erst wenn nie etwas kam, wird es weitergereicht. */
    if (stand) return stand.werte;
    throw fehler;
  }
}
