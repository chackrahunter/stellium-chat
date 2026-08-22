/**
 * Einen fremden Dateinamen auf ein sicheres Maß bringen.
 *
 * Vorher stand diese Funktion nur lokal in services/files.ts. Jetzt braucht
 * sie auch services/post.ts für Mailanhänge — und ausgerechnet dort ist der
 * Name die gefährlichste Zeichenkette im ganzen System: er kommt von einem
 * Fremden im Internet, nicht von einem angemeldeten Kollegen. Eine zweite,
 * eigene Fassung dort anzulegen hieße, denselben Angriff zweimal zu Ende zu
 * denken — deshalb hierher gezogen, an einen Ort ohne Abhängigkeit zu Kanälen
 * oder Nachrichten, und von beiden Diensten importiert.
 *
 * Der Ansatz ist eine ERLAUBNISLISTE, keine Verbotsliste: nur Buchstaben
 * (jeder Schrift, `\p{L}`), Ziffern (`\p{N}`) und eine Handvoll Satzzeichen
 * überleben, alles andere wird zu `_`. Das ist absichtlich strenger als nötig
 * für den Normalfall, aber genau deshalb robust gegen Fälle, an die man erst
 * nachträglich denkt:
 *
 *   · `../../etc/passwd`      — `path.basename()` entfernt jeden Ordnerteil,
 *                                übrig bleibt nur `passwd`. Für die Ablage auf
 *                                der Platte zählt das ohnehin nicht: der Pfad
 *                                dort entsteht immer aus einer eigenen,
 *                                zufälligen Kennung, nie aus diesem Namen.
 *   · Steuerzeichen, U+202E   — beides fällt unter „kein Buchstabe, keine
 *     (Rechts-nach-links-Override)  Ziffer" (Unicode-Kategorie Cc bzw. Cf)
 *                                und wird ersetzt. Eine Rechnung, die als
 *                                `exe.gnp_egnahcer` ankommt, weil U+202E die
 *                                Endung von rechts nach links dreht, verliert
 *                                dabei ihr Override-Zeichen und zeigt wieder
 *                                den wahren, wenn auch unleserlichen Namen.
 *
 * Was diese Funktion NICHT tut: `rechnung.pdf.exe` bleibt `rechnung.pdf.exe`.
 * Eine zweite Endung ist kein Zeichen, das sich säubern ließe — das ist eine
 * Aussage über den Dateityp, keine über das Alphabet. Die Antwort darauf ist
 * eine andere: nie ausführen, nie inline anzeigen, immer mit erzwungenem
 * Download ausliefern (siehe die Auslieferungsroute in http/routes.ts).
 */
import path from 'node:path';

export function saubererDateiname(name: string, maxLaenge = 160): string {
  return path.basename(name).replace(/[^\p{L}\p{N}._ ()-]/gu, '_').slice(0, maxLaenge).trim();
}
