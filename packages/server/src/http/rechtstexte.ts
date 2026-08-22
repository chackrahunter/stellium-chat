import type { FastifyInstance } from 'fastify';

/**
 * Datenschutzerklärung und Nutzungsordnung unter sauberen Adressen.
 *
 * Ohne diese Datei fielen /privacy und /terms durch den Notfundhandler in
 * index.ts: der greift bei jedem Pfad ohne Dateiendung und liefert die
 * Oberfläche selbst aus (siehe dort, „Auf eine fehlende Datei niemals die
 * Startseite ausliefern" gilt nur für Pfade MIT Endung — ein endungsloser
 * Pfad zählt als Adresse der Oberfläche, nicht als fehlende Datei). Wer also
 * chat.stellium.club/privacy aufrief, bekam den Chat zu sehen statt der
 * Erklärung.
 *
 * `reply.sendFile()` steht erst zur Verfügung, nachdem @fastify/static in
 * index.ts registriert ist — diese Funktion wird deshalb bewusst aus
 * demselben `if (oberflaeche)`-Zweig heraus aufgerufen wie jene Registrierung,
 * nicht davor und nicht unabhängig davon. Ohne eine gebaute Oberfläche gibt
 * es auch kein dist/privacy.html — dann bleibt es beim bestehenden
 * Notfundhandler, der ohnehin schon eine verständliche Auskunft liefert.
 *
 * Die Reihenfolge zu setNotFoundHandler in index.ts ist für Fastifys eigenen
 * Router (find-my-way) ohne Belang: eine über app.get() eingetragene Route
 * wird immer zuerst geprüft, der Notfundhandler greift nur, wenn der Router
 * gar keine Route findet. Registriert wird trotzdem VOR setNotFoundHandler,
 * damit die Datei beim Lesen von oben nach unten genauso "speziell vor
 * allgemein" erzählt, wie es für den Router tatsächlich gilt.
 */
export async function registerRechtstexte(app: FastifyInstance): Promise<void> {
  for (const [pfad, datei] of [
    ['/privacy', 'privacy.html'],
    ['/terms', 'terms.html'],
  ] as const) {
    app.get(pfad, async (_req, reply) => reply.type('text/html; charset=utf-8').sendFile(datei));
  }
}
