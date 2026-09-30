import type { IdentitaetPaket } from '@stellium/shared';
import { db } from '../db/index.js';
import { abweisung } from '../util/abweisung.js';
import { aktuelleFassung } from './kontoschluessel.js';

/**
 * Die Kontoidentität — der private ECDH-Teil eines Kontos, verwahrt, nie
 * gelesen.
 *
 * WAS HIER PASSIERT UND WAS AUSDRÜCKLICH NICHT
 *
 * Wie services/kontoschluessel.ts nimmt diese Datei einen Haufen Bytes
 * entgegen und gibt ihn wieder heraus. Sie rechnet mit keinem Schlüssel,
 * leitet nichts ab und sieht nie einen privaten Teil im Klartext: `daten` ist
 * mit dem Kontoschlüssel verschlossen, und der entsteht ausschließlich auf
 * dem Gerät (PBKDF2 über das Passwort, siehe lib/kontoschluessel.ts).
 *
 * WOFÜR ES SIE GIBT
 *
 * Die ausführliche Begründung steht bei IdentitaetPaket in
 * shared/vertraulich.ts und noch einmal am Schema. Kurz: Notizen und
 * Tresoreinträge bekommen je Datensatz ein Kontopaket, private Dateien und
 * vertrauliche Kanäle können das prinzipiell nicht — die eine trägt ihren
 * Schlüssel im eigenen Umschlag, der andere ließe sich nur von einem Gerät
 * nachtragen, das gerade online sein müsste. Beide hängen aber am selben
 * ECDH-Schlüsselpaar. Also wandert das Paar selbst ans Konto.
 *
 * DIE EINE ENTSCHEIDUNG, AUF DER ALLES RUHT: WER ZUERST SCHREIBT, GILT
 *
 * `hinterlegen()` überschreibt nie. Das ist keine Vorsicht, sondern die
 * ganze Sicherung:
 *
 *   Ein frisch eingerichtetes Gerät hat ein EIGENES Schlüsselpaar, bevor es
 *   den Server fragt (es braucht eines, um überhaupt etwas zu tun). Dürfte
 *   es seines hinterlegen, wären in derselben Sekunde jedes
 *   `kanal_schluessel_pakete` und jede private Datei des Kontos an eine
 *   Identität gebunden, die niemand mehr hat. Ein Gerätewechsel würde damit
 *   genau das zerstören, was er retten soll.
 *
 * Ein abgewiesenes Gerät bekommt deshalb die GÜLTIGE Zeile zurück und
 * übernimmt sie. Der Rückgabewert ist immer das, was ab jetzt gilt — nie
 * eine bloße Bestätigung.
 *
 * DIE FASSUNG WIRD GEPRÜFT UND NICHT GEGLAUBT
 *
 * Ein Gerät mit veraltetem Kontoschlüssel darf keine Zeile schreiben, die
 * richtig aussieht und sich nie öffnen lässt — dieselbe Regel und derselbe
 * Grund wie bei den Notiz- und Tresorpaketen (services/notizen.ts). Beim
 * Lesen gilt sie ebenso: eine Zeile aus einer früheren Fassung wird gar
 * nicht erst herausgegeben.
 */

interface Zeile {
  konto_fassung: number;
  alg: string;
  iv: string;
  daten: string;
  abdruck: string;
}

function ausZeile(z: Zeile): IdentitaetPaket {
  return { alg: z.alg, kontoFassung: z.konto_fassung, iv: z.iv, daten: z.daten, abdruck: z.abdruck };
}

/**
 * Die geltende Identität dieses Kontos — oder `null`.
 *
 * `null` heißt eines von dreien, und für den Aufrufer sind sie dasselbe: es
 * gibt keine Zeile, es gibt keinen brauchbaren Kontoschlüssel (dann könnte
 * das Gerät die Zeile ohnehin nicht öffnen), oder die Zeile gehört zu einem
 * ERSETZTEN Kontoschlüssel. Der letzte Fall kann nach einem geordneten
 * Ersatz nicht vorkommen — kontoPaketeWegraeumen() räumt diese Tabelle mit
 * ab —, aber ein Lesefilter, der sich darauf verlässt, dass ein Wegräumen
 * wirklich jede Zeile erwischt hat, ist kein Lesefilter.
 */
export function holen(userId: string): IdentitaetPaket | null {
  const fassung = aktuelleFassung(userId);
  if (!fassung) return null;
  const z = db.get<Zeile>(
    'SELECT konto_fassung, alg, iv, daten, abdruck FROM identitaet_konto_pakete WHERE user_id = ?',
    userId,
  );
  if (!z || z.konto_fassung !== fassung) return null;
  return ausZeile(z);
}

function vollstaendig(p: IdentitaetPaket | undefined | null): boolean {
  return Boolean(
    p && p.alg && p.iv && p.daten && p.abdruck && Number.isInteger(p.kontoFassung),
  );
}

/**
 * Eine Identität anbieten. Zurück kommt die, die ab jetzt gilt.
 *
 * Steht schon eine passende Zeile, bleibt sie stehen und wird
 * zurückgegeben — das Gerät übernimmt sie dann und wirft sein eigenes Paar
 * NICHT weg, sondern behält es als Rückfall zum Auspacken (lib/vertraulich.ts).
 *
 * Beides in EINER Transaktion, obwohl es nur ein INSERT ist: zwischen dem
 * Lesen und dem Schreiben liegt sonst der Augenblick, in dem zwei Geräte
 * gleichzeitig eines anbieten und beide "meins gilt" zurückbekommen.
 */
export function hinterlegen(userId: string, paket: IdentitaetPaket): IdentitaetPaket {
  if (!vollstaendig(paket)) {
    throw abweisung('fehler.schluesselUnvollstaendig', 'Die Identität ist unvollständig.');
  }
  /* EINE Abweisung für beide Fälle, und zwar die vorhandene: „es gibt gar
     keinen Kontoschlüssel" (Fassung 0) und „das Gerät rechnet mit einem
     veralteten" laufen für das Gerät auf dasselbe hinaus — es darf nicht
     schreiben und soll es später noch einmal versuchen. Ein eigener Text je
     Fall verlangte zwei neue Einträge in 22 Wörterbüchern und sagte dem
     Gerät nichts, was es anders machen könnte. */
  const fassung = aktuelleFassung(userId);
  if (!fassung || paket.kontoFassung !== fassung) {
    throw abweisung('fehler.schluesselfassungUnbekannt', 'Diese Schlüsselfassung gibt es nicht.');
  }

  return db.transaction(() => {
    const alt = db.get<Zeile>(
      'SELECT konto_fassung, alg, iv, daten, abdruck FROM identitaet_konto_pakete WHERE user_id = ?',
      userId,
    );
    /* WER ZUERST SCHREIBT, GILT — siehe Dateikopf. Eine Zeile aus einer
       FRÜHEREN Fassung zählt dabei nicht als "schon da": sie ist mit einem
       ersetzten Kontoschlüssel verpackt und niemand bekommt sie mehr auf.
       (Ein geordneter Ersatz räumt sie ohnehin weg — diese Bedingung ist die
       Wache darüber, nicht der Normalfall.) */
    if (alt && alt.konto_fassung === fassung) return ausZeile(alt);

    db.run(
      `INSERT INTO identitaet_konto_pakete (user_id, konto_fassung, alg, iv, daten, abdruck, erstellt_am)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(user_id) DO UPDATE SET
         konto_fassung = excluded.konto_fassung, alg = excluded.alg, iv = excluded.iv,
         daten = excluded.daten, abdruck = excluded.abdruck, erstellt_am = excluded.erstellt_am`,
      userId, paket.kontoFassung, paket.alg, paket.iv, paket.daten, paket.abdruck, Date.now(),
    );
    return paket;
  });
}
