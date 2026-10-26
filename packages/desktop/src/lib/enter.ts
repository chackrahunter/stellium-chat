/**
 * Enter, das wirklich Enter meint.
 *
 * Auf Japanisch, Chinesisch und Koreanisch entsteht ein Zeichen in mehreren
 * Anschlägen, und das erste Enter bestätigt nur die Umwandlung im
 * Eingabefenster des Systems. Wer darauf schon sendet, schickt ein halbes
 * Wort — bei drei der zweiundzwanzig Oberflächensprachen bei jeder Nachricht.
 *
 * `isComposing` allein reicht nicht: Safari meldet das bestätigende Enter
 * mit `isComposing: false`, aber mit dem Sondercode 229.
 */
export function istEnter(e: React.KeyboardEvent): boolean {
  return e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229;
}
