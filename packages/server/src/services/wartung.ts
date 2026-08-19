import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/**
 * Angekündigte Auszeit des Servers.
 *
 * Wenn der Pi sich selbst aktualisiert, ist er ein, zwei Minuten weg. Das
 * kommentarlos zu tun wäre unhöflich — mitten im Satz bricht die Verbindung ab
 * und niemand weiß, warum. Deshalb kündigt er es an, mit fester Uhrzeit.
 *
 * Die Ankündigung liegt in einer Datei: das Aktualisierungsskript läuft als
 * eigener Prozess und kann dem laufenden Server nichts direkt sagen. Der
 * Server liest sie und schickt sie an alle weiter.
 */

export interface Wartung {
  version: string;
  notes: string | null;
  startetUm: number;
  dauertEtwa: number;
}

const DATEI = path.join(config.dataDir, 'wartung.json');

/** Eine Auszeit ankündigen — vom Aktualisierungsskript aufgerufen. */
export function ankuendigen(w: Wartung): void {
  fs.writeFileSync(DATEI, JSON.stringify(w), 'utf8');
}

/** Die anstehende Auszeit, falls es eine gibt und sie noch bevorsteht. */
export function anstehend(): Wartung | null {
  try {
    const w = JSON.parse(fs.readFileSync(DATEI, 'utf8')) as Wartung;
    // Abgelaufene Ankündigungen aufräumen: nach dem Neustart des Servers
    // stünde sonst ewig eine Uhr, die längst abgelaufen ist.
    if (w.startetUm + w.dauertEtwa < Date.now()) { absagen(); return null; }
    return w;
  } catch { return null; }
}

export function absagen(): void {
  fs.rmSync(DATEI, { force: true });
}
