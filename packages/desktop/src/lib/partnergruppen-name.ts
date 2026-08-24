/**
 * Kollidiert ein vorgeschlagener Gruppenname mit dem ANGEZEIGTEN Namen einer
 * eingebauten Gruppe — in einer gegebenen Sprache? Ausgelagert aus
 * PartnerGruppenPanel.tsx, damit sich die Regel ohne React/DOM/Store prüfen
 * lässt (siehe scripts/partnergruppen-anzeigename-pruefen.mjs) — nur `t()`
 * als Parameter, kein `useT()`: der Prüflauf ruft `translate()` aus
 * i18n/kern.ts direkt für jede der 22 Sprachen auf, ohne den Zustand
 * (state/store.ts) mitzuladen, den `useT()` braucht.
 *
 * DAS PROBLEM, DAS DIESE FUNKTION LÖST
 *
 * `gruppenNamePruefen()` auf dem Server (post-partnergruppen.ts) vergleicht
 * einen vorgeschlagenen Namen nur gegen die festen KENNUNGEN
 * (`PARTNER_GRUPPEN`: 'kunden', 'behoerden', …) — bewusst so, weil der
 * Server keine Abhängigkeit zu den 22 Wörterbüchern in
 * packages/desktop/src/i18n/ haben soll (siehe Funktionskopf dort). Das
 * Ergebnis: „Kunden" wird nur zufällig abgewiesen, weil die Kennung
 * zufällig gleich lautet wie der DEUTSCHE Anzeigename — „Behörden" wird
 * angenommen, obwohl direkt daneben schon ein eingebauter Chip mit genau
 * diesem Namen steht, und in den anderen 21 Sprachen trifft die serverseitige
 * Prüfung so gut wie nie, weil dort ganz andere Wörter auf den eingebauten
 * Chips stehen.
 *
 * Zwei optisch identische Chips nebeneinander sind eine Sache der
 * OBERFLÄCHE, nicht der Datenintegrität — deshalb hier, nicht auf dem
 * Server, und deshalb sprachbewusst: verglichen wird gegen den Namen, den
 * `t()` GERADE liefert, in welcher Sprache auch immer die Oberfläche steht.
 * Die serverseitige Kennungsprüfung bleibt daneben unverändert die letzte,
 * verbindliche Instanz (siehe dort) — diese Funktion hier ist eine
 * freundlichere Vorwarnung, keine Ersetzung.
 */
import { PARTNER_GRUPPEN } from '@stellium/shared';
import type { TranslationKey } from '../i18n/kern.js';

export function kollidiertMitEingebautemAnzeigenamen(
  roh: string,
  t: (key: TranslationKey, werte?: Record<string, string | number>) => string,
): boolean {
  const glatt = roh.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!glatt) return false;
  return PARTNER_GRUPPEN.some((id) => t(`partnerGruppen.gruppe.${id}` as TranslationKey).toLowerCase() === glatt);
}
