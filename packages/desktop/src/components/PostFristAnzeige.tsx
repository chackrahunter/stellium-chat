/**
 * Restzeit bis eine einzelne Mail durch die Aufbewahrungsfrist IHRES FACHS
 * gelöscht wird — `Nachricht.verfaelltAm` (services/post.ts, Dateikopf).
 *
 * Eigene, kleine Komponente statt eines Blocks in PostPanel.tsx: an
 * PostPanel.tsx (wie auch an services/post.ts, services/mailzugang.ts und
 * Settings.tsx) arbeitet gerade ein anderer Auftrag, der die Absenderadresse
 * aufs Fach umstellt. Diese Datei hängt sich dort mit einer einzigen Zeile
 * ein (siehe VerlaufEintrag in PostPanel.tsx) und kennt sonst nichts von der
 * Tafel, die sie umgibt — dasselbe Muster wie PostAnhaenge.tsx daneben.
 *
 * OHNE FRIST STEHT HIER NICHTS: `verfaelltAm === null` ist heute der
 * Normalfall (kein Fach hat eine Frist gesetzt) — kein „unbegrenzt", kein
 * Platzhalter, keine leere Zeile. `null` liefert bewusst `null` zurück,
 * nicht einen leeren Rahmen.
 *
 * JE NÄHER, DESTO AUFFÄLLIGER: Der Text kommt aus `verfaelltIn()`
 * (lib/format.ts) — wählt Tag/Woche/Monat/Jahr selbst, so wie ein Mensch es
 * sagen würde, über `Intl.RelativeTimeFormat`. Die Farbe kommt aus
 * `restfristFarbe()` (lib/post-farben.ts) — dieselben drei Farbwerte wie die
 * KI-Dringlichkeit nebenan, aber eine eigene, klar benannte Achse (siehe
 * dort). Kein `color`-Wert extra auf dem Symbol: lucide-react-Symbole ohne
 * eigene `color`-Angabe stehen auf `currentColor`, darum färbt die eine
 * `color`-Eigenschaft auf dem umgebenden <p> Text UND Uhr-Symbol gemeinsam.
 */
import { CalendarClock } from 'lucide-react';
import { useT } from '../i18n/index.js';
import { verfaelltIn } from '../lib/format.js';
import { restfristFarbe } from '../lib/post-farben.js';

export function PostFristAnzeige({ verfaelltAm }: { verfaelltAm: number | null }) {
  const t = useT();
  if (verfaelltAm === null) return null;

  return (
    <p className="post__eintrag-frist" style={{ color: restfristFarbe(verfaelltAm) }}>
      <CalendarClock size={11} aria-hidden="true" />
      {t('post.verfaelltIn', { frist: verfaelltIn(verfaelltAm) })}
    </p>
  );
}
