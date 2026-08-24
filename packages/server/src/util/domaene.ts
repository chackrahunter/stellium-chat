/**
 * Domänen-Abgleich für die Adresse eines Briefpartners — ob eine Adresse zur
 * eigenen Versanddomäne der Firma gehört (Gruppe "intern", siehe
 * services/post-partnergruppen.ts).
 *
 * EIGENE, ABHÄNGIGKEITSFREIE DATEI
 * Kein Zugriff auf `db`, keine Verschlüsselung, kein Import aus `services/`
 * — genau deshalb gefahrlos sowohl vom laufenden Dienst
 * (services/post-partnergruppen.ts) als auch vom einmaligen Nachtrag beim
 * Hochfahren (db/migrate.ts, internBackfillEinmalig-Gegenstück dort) nutzbar.
 * migrate.ts hält sich bewusst an reine db-/crypto-Grundbausteine (siehe
 * dort, etwa echosVergessen()) statt Dienste aus services/ zu importieren —
 * ein Import von services/post-partnergruppen.ts aus migrate.ts würde einen
 * Kreis aufmachen: post-partnergruppen.ts -> db/index.ts -> migrate.ts ->
 * (zurück zu) post-partnergruppen.ts. Diese Datei bricht den Kreis, weil sie
 * selbst nichts importiert, das ihrerseits zu migrate.ts zurückführt.
 */

/**
 * Eine roh gespeicherte Domänen-Einstellung (services/mailzugang.ts,
 * `mail.domaene`) in eine Liste zerlegen.
 *
 * Heute liefert diese Einstellung immer nur EINEN Wert. Trotzdem schon hier
 * als Liste behandelt: käme die Firma später auf mehrere Domänen (zwei
 * Marken unter einem Dach, ein laufendes Rebranding), reicht
 * "firma.de, firma-neu.de" im selben Textfeld, um beide zu erfassen — keine
 * neue Spalte, keine Migration, nur ein geänderter Einstellungswert.
 */
export function domaenenAusText(roh: string | null | undefined): string[] {
  return (roh ?? '')
    .split(/[,;]/)
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * Liegt eine Adresse auf einer der angegebenen Domänen?
 *
 * - Groß-/Kleinschreibung ist bei Domänen nie bedeutsam — beide Seiten werden
 *   klein verglichen.
 * - Plus-Adressierung (`name+tag@firma.de`) braucht keine eigene Behandlung:
 *   der Teil VOR dem "@" spielt für diesen Vergleich gar keine Rolle, nur der
 *   Teil danach zählt.
 * - Der Teil NACH DEM LETZTEN "@" gilt als Domäne — robuster als das erste
 *   Vorkommen, falls eine kaputte Adresse im lokalen Teil selbst ein "@"
 *   trüge.
 * - Subdomänen zählen bewusst NICHT automatisch mit: exakter Vergleich, kein
 *   `endsWith()`/`includes()` — sonst träfe "firma.de" auch auf
 *   "boesefirma.de" oder auf "firma.de.andere-domain.example" zu. Wer
 *   "mail.firma.de" ebenfalls als intern zählen lassen will, trägt sie als
 *   eigenen, zusätzlichen Eintrag ein (siehe domaenenAusText oben) — explizit
 *   entschieden, nicht erraten.
 */
export function istAdresseAufDomaene(adresse: string, domaenen: readonly string[]): boolean {
  if (!domaenen.length) return false;
  const wert = adresse.trim().toLowerCase();
  const trennstelle = wert.lastIndexOf('@');
  if (trennstelle < 0) return false;
  const domaene = wert.slice(trennstelle + 1);
  return domaene.length > 0 && domaenen.includes(domaene);
}
