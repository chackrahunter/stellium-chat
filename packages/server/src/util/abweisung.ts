/**
 * Eine Abweisung, die der Client übersetzen kann.
 *
 * Dienste werfen bei ungültigen Eingaben einen Fehler, und die Route gibt
 * dessen Text an den Client weiter. Ein gewöhnlicher `Error` trägt aber nur
 * einen deutschen Satz — und der stand dann in jeder Sprache auf dem Schirm.
 *
 * Deshalb dieselbe Machart wie überall sonst: der Wurf trägt eine Kennung aus
 * dem Wörterbuch der Oberfläche, der deutsche Text bleibt als Rückfall daneben
 * stehen. Wer hier eine neue Kennung einführt, legt sie in
 * packages/desktop/src/i18n/de.ts an; scripts/e2e-fehlertexte.mjs vergleicht
 * beide Seiten und schlägt an, wenn eine ins Leere zeigt.
 *
 * Die Ursache geht dabei nicht verloren: `cause` trägt den ursprünglichen
 * Fehler weiter, auch wenn draußen nur noch der freundliche Satz sichtbar
 * ist. Ohne das stand am Ende nur noch "Die KI konnte das gerade nicht
 * erledigen" da — weder beim Benutzer (richtig so) noch im Protokoll
 * (falsch): eine Umwandlung, die wörtlich vergisst, woran es lag. Wer die
 * Abweisung fängt, kann `error.cause` mitprotokollieren und hat damit eine
 * zweite, von der Einordnung unabhängige Chance, den echten Grund
 * festzuhalten.
 */
export class Abweisung extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly werte?: Record<string, string>,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = 'Abweisung';
  }
}

/** Kurzform, damit ein Wurf eine Zeile bleibt. */
export function abweisung(
  code: string, message: string, werte?: Record<string, string>, cause?: unknown,
): Abweisung {
  return new Abweisung(code, message, werte, cause);
}

/** Kennung und Werte eines Fehlers, falls er welche trägt. */
export function kennungVon(err: unknown): { code?: string; werte?: Record<string, string> } {
  return err instanceof Abweisung ? { code: err.code, werte: err.werte } : {};
}
