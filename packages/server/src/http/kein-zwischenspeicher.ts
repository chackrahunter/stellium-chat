import type { FastifyReply } from 'fastify';

/**
 * „Diese Antwort darf nirgendwo liegen bleiben."
 *
 * WOFÜR DAS DA IST. Fastify schickt von sich aus KEIN `Cache-Control`. Eine
 * 200er-Antwort ohne Frischeangabe darf ein Browser nach eigenem Ermessen auf
 * die Platte legen — RFC 9111 nennt das heuristisches Zwischenspeichern, und
 * Chrome tut es. Bei einer Kanalliste ist das gleichgültig. Bei einer
 * Antwort, die ein Passwort, einen verschlossenen Kontoschlüssel oder einen
 * Notzugangsanteil trägt, heißt es: der Wert überlebt die Sitzung, in einem
 * Profilordner, den niemand nach Geheimnissen absucht. Auf einem geteilten
 * Rechner ist genau das der Schaden.
 *
 * WARUM ALS FUNKTION UND NICHT ALS ZEILE JE ROUTE. Die Zeile stand zweimal
 * in zwei Dateien und fehlte an fünf weiteren Wegen, die genauso Geheimnisse
 * tragen — das ist der Normalfall bei einer Vorsichtsmaßnahme, die man
 * abtippen muss. Ein Aufruf mit sprechendem Namen ist beim Anlegen einer
 * neuen Route sichtbar, eine vergessene Kopfzeile nicht. Wer hier vorbeikommt
 * und sich fragt, ob seine Route dazugehört, hat die Frage damit schon
 * gestellt.
 *
 * WAS DRINSTEHT UND WARUM ALLES DAVON.
 * - `no-store` ist die eigentliche Aussage: nicht ablegen, nirgends.
 * - `no-cache` und `must-revalidate` sind für Zwischenstationen, die
 *   `no-store` alt oder unvollständig umsetzen — sie kosten nichts.
 * - `private` verbietet einen gemeinsamen Zwischenspeicher (Firmenproxy).
 * - `pragma: no-cache` ist HTTP/1.0-Erbe und hier bewusst mit dabei: Stellium
 *   läuft auch hinter Vermittlern, die niemand von uns ausgesucht hat.
 *
 * WAS DAS NICHT IST. Keine Sicherheitsgrenze — die sitzt in der
 * Rechteprüfung davor. Das hier verhindert nur, dass ein Wert, den jemand
 * rechtmäßig geholt hat, länger herumliegt als die Handlung, für die er
 * geholt wurde. Und es hilft nicht gegen einen Client, der ihn selbst
 * wegschreibt.
 *
 * WANN MAN SIE RUFT: bei jeder Antwort, deren Rumpf ein Geheimnis, eine
 * Zugangspaarung oder verschlossenes Schlüsselmaterial enthält — auch dann,
 * wenn es verschlüsselt ist. Ein Chiffrat auf der Platte eines fremden
 * Rechners ist Angriffsfläche für einen Rateangriff, den es sonst gar nicht
 * gäbe. Bei POST ist sie streng genommen entbehrlich (Browser legen
 * POST-Antworten nicht heuristisch ab); sie steht dort trotzdem, damit
 * niemand die Frage „ist das POST oder GET?" beantworten muss, um zu wissen,
 * ob die Zeile fehlt.
 */
export function keinZwischenspeicher(reply: FastifyReply): void {
  reply.header('cache-control', 'no-store, no-cache, must-revalidate, private');
  reply.header('pragma', 'no-cache');
}
