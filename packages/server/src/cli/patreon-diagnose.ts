import { diagnoseLauf, patreonKennzahlen } from '../services/patreon.js';
import { config } from '../config.js';

/**
 * Prüflauf gegen die echte Patreon-Schnittstelle, von der Kommandozeile aus.
 *
 * Dasselbe diagnoseLauf() wie hinter GET /api/verkauf/patreon/diagnose — nur
 * ohne HTTP-Anmeldung drumherum, für den einmaligen Nachweis auf dem Pi
 * selbst (siehe Auftrag: "Bau dir einen Diagnoseweg... Führ ihn aus"). Öffnet
 * dieselbe Datenbank wie der laufende Dienst (config.dbFile), rührt aber
 * nichts an, was der Dienst gerade offen hält — eine fällige Erneuerung
 * schreibt über dieselben Setter wie der Hintergrundlauf im Gateway, sonst
 * werden nur GET-Aufrufe gegen Patreon gemacht.
 *
 *   node dist/cli/patreon-diagnose.js              nur erneuern, wenn fällig
 *   node dist/cli/patreon-diagnose.js --erzwingen   Erneuerung immer versuchen
 *
 * Gibt ausschließlich Auskünfte aus — nie einen Token- oder Geheimniswert.
 */
async function main(): Promise<void> {
  /* Auf stderr, nicht stdout — stdout bleibt reines JSON. Nur ein Pfad, kein
     Geheimnis; dient allein dazu, vor dem Lauf sichtbar zu bestätigen, dass
     wirklich die echte Datenbank des laufenden Dienstes geöffnet wird und
     nicht versehentlich eine frische an einem falschen Ort (DATA_DIR nicht
     gesetzt). */
  console.error(`[patreon-diagnose] Datenbank: ${config.dbFile}`);
  const erzwingen = process.argv.includes('--erzwingen');
  const diagnose = await diagnoseLauf({ erneuernErzwingen: erzwingen });
  console.log(JSON.stringify({ diagnose }, null, 2));

  /* Zweiter, unabhängiger Aufruf gegen dieselbe Schnittstellenfunktion, die
     die künftige Verkaufskachel benutzen wird (patreonKennzahlen() — siehe
     GET /api/verkauf/patreon/kennzahlen) — damit der Nachweis nicht nur die
     Diagnose zeigt, sondern auch die Zahlen, die am Ende wirklich ankommen. */
  try {
    const kennzahlen = await patreonKennzahlen();
    console.log(JSON.stringify({ kennzahlen }, null, 2));
  } catch (err) {
    console.error(`[patreon-diagnose] Kennzahlen fehlgeschlagen: ${(err as Error).message}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFehler: ${(err as Error).message}`);
    process.exit(1);
  });
