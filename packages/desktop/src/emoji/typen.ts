/**
 * Typen für den Emoji-Namensbestand.
 *
 * Eigene, winzige Datei statt gleich in katalog.ts: die erzeugten
 * Sprachdateien unter daten/*.ts importieren nur diese Typen, nicht die
 * Ladelogik. Würden sie katalog.ts importieren, zöge jede Sprachdatei beim
 * Bündeln den ganzen Lader mit in ihren Chunk — und genau das Nachladen je
 * Sprache (statt aller 18 auf einmal) ist der Punkt der ganzen Aufteilung.
 */

export interface EmojiEintrag {
  /** Anzeigename in der jeweiligen Sprache, z.B. "rotes Herz". */
  name: string;
  /**
   * Suchbegriffe derselben Sprache — Synonyme, Rechtschreibvarianten,
   * verwandte Wörter. Enthält den Namen selbst nicht zwingend noch einmal;
   * die Suche prüft beides (siehe katalog.ts).
   */
  keywords: string[];
}

/** Emoji-Zeichen (genau wie in EmojiPicker.tsx/GROUPS) -> Name + Stichwörter. */
export type EmojiKatalog = Record<string, EmojiEintrag>;
