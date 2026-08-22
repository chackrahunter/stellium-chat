import { db } from './index.js';
import { blindIndex, decryptField, encryptField, encryptionActive } from '../crypto/pii.js';
import { abdruck, suchWorte } from '../crypto/nachrichten.js';

/**
 * Passt das Masterpasswort noch zu dieser Datenbank?
 *
 * DER BEFUND, DER DAZU GEFÜHRT HAT
 * `blindIndex()` ist ein deterministischer HMAC über den Benutzernamen — kein
 * Zufall, kein IV. Derselbe Klartext ergibt mit demselben Schlüssel immer
 * denselben Wert. In der laufenden Datenbank stehen trotzdem zwei Konten
 * namens `stelliumai` mit verschiedenen `handle_bidx`. Das kann nur eines
 * heißen: sie sind unter zwei verschiedenen Schlüsseln entstanden.
 *
 * Weit über zwei Bot-Konten hinaus reicht das, weil derselbe Blind-Index die
 * ANMELDUNG trägt (services/users.ts: `WHERE handle_bidx = ? OR email_bidx = ?`).
 * Ein Konto, dessen Index unter einem alten Schlüssel steht, ist mit dem
 * aktuellen nicht mehr auffindbar — kein Fehler, keine Warnung, nur ein leeres
 * Suchergebnis. Für die Person sieht das aus wie ein falsches Passwort.
 * `handleTaken()`/`emailTaken()` gäben vergebene Namen wieder als frei aus.
 *
 * WARUM NICHT WEITERLAUFEN
 * Der Zustand "Schlüssel passt nicht zu den Daten" ist gefährlicher als ein
 * Ausfall. Ein Ausfall ist sichtbar und endet, sobald das richtige Passwort
 * wieder dasteht. Ein weiterlaufender Server dagegen schreibt ab der ersten
 * Sekunde neue Konten, Nachrichten und Suchwerte unter dem falschen Schlüssel
 * in dieselbe Datei — und die sind auch mit dem richtigen Passwort nie wieder
 * lesbar. Der Schaden wächst mit der Laufzeit. Deshalb: gar nicht erst starten,
 * aber mit einer Meldung, die in einem Satz sagt, was los ist und was zu tun
 * ist, statt einer Ausnahme mit Stapelspur.
 *
 * DIE HINTERTÜR IST ABSICHT
 * Wer das Passwort wirklich wechseln will, kommt mit
 * STELLIUM_SCHLUESSELWECHSEL=ja vorbei. Ohne diesen Weg wäre ein bewusster
 * Wechsel nur noch durch eine Codeänderung möglich — auf einem Raspberry Pi
 * in Alaska, an den niemand physisch herankommt, ist das keine Option.
 *
 * VERRÄT DIE PROBE ETWAS?
 * Nein. Abgelegt wird ein AES-GCM-Chiffrat mit Zufalls-IV, kein HMAC: zwei
 * Installationen mit demselben Masterpasswort speichern verschiedene Werte,
 * man kann also nicht einmal erkennen, ob zwei Datenbanken zum selben Passwort
 * gehören. (Die alten Kennungen `fts_format`/`tm_format` können das, weil sie
 * blanke HMAC-Werte über einen festen Text sind.) Als Angriffsfläche kommt
 * nichts hinzu: wer die Datei hat, hat mit jeder verschlüsselten Nachricht
 * darin bereits dasselbe Orakel in der Hand.
 */

/* ── Kennungen, die es im Haus schon gab ──────────────────────────
 *
 * Zwei Stellen haben einen Schlüsselwechsel längst erkannt — nur eben nicht
 * gemeldet, sondern abgeleitete Daten weggeworfen:
 *
 *   fts_format  (db/index.ts)   baut den Volltextindex neu auf
 *   tm_format   (db/migrate.ts) leert den Übersetzungsspeicher
 *
 * Die Rezepte stehen deshalb hier, an einer Stelle, und werden von dort
 * geholt. Die WERTE bleiben Zeichen für Zeichen dieselben — änderten sie sich,
 * hielte jede bestehende Installation den nächsten Start für einen
 * Schlüsselwechsel und würfe ihren Übersetzungsspeicher weg.
 */

/** Kennung des Volltextindex-Formats. Hängt am Suchschlüssel. */
export function indexKennung(): string {
  return `fingerabdruck-v1:${suchWorte('stellium')}`;
}

/** Kennung des Übersetzungsspeichers. Hängt am selben Suchschlüssel. */
export function tmKennung(): string {
  return `tm-v2:${abdruck('stellium')}`;
}

/* ── Die Probe ───────────────────────────────────────────────── */

const PROBE_SCHLUESSEL = 'schluessel_probe';

/**
 * Der bekannte Klartext. Sein Inhalt ist belanglos — er darf öffentlich sein,
 * geprüft wird ja, ob er sich mit dem heutigen Schlüssel wieder herstellen
 * lässt.
 */
const PROBE_SATZ = 'stellium/schluesselprobe/v1';

/**
 * Was abgelegt wird: der Satz selbst und die beiden deterministischen Werte,
 * die daraus entstehen — alles zusammen verschlüsselt.
 *
 * Der Satz allein prüfte nur den Feldschlüssel. `bidx` und `abdr` decken die
 * beiden INDEX-Schlüssel ab, und die tragen die Anmeldung. Praktisch stammen
 * alle vier Schlüssel aus demselben Masterpasswort; auseinanderlaufen können
 * sie trotzdem, nämlich wenn jemand in pii.ts oder nachrichten.ts an Salt oder
 * Zweckbezeichnung dreht. Genau dieser Fehler wäre sonst unsichtbar und macht
 * jede Anmeldung kaputt.
 */
function probeBauen(): string {
  return encryptField(JSON.stringify({
    satz: PROBE_SATZ,
    bidx: blindIndex(PROBE_SATZ),
    abdr: abdruck(PROBE_SATZ),
  }));
}

function probePasst(gespeichert: string): boolean {
  const roh = decryptField(gespeichert);
  if (!roh) return false;              // mit diesem Schlüssel nicht zu öffnen
  try {
    const p = JSON.parse(roh) as { satz?: string; bidx?: string; abdr?: string };
    return p.satz === PROBE_SATZ
      && p.bidx === blindIndex(PROBE_SATZ)
      && p.abdr === abdruck(PROBE_SATZ);
  } catch {
    return false;
  }
}

function einstellung(schluessel: string): string | undefined {
  try {
    return db.get<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', schluessel)?.value;
  } catch {
    return undefined;                  // Tabelle gibt es noch nicht
  }
}

function probeSchreiben(): void {
  db.run(
    `INSERT INTO app_settings (key, value, updated_by, updated_at) VALUES (?, ?, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    PROBE_SCHLUESSEL, probeBauen(), Date.now(),
  );
}

/**
 * Auskunft aus den alten Kennungen — für Datenbanken, die noch keine Probe
 * tragen.
 *
 * Das ist der Grund, warum diese Prüfung schon beim ALLERERSTEN Start nach
 * dieser Änderung greift und nicht erst beim zweiten: `fts_format` und
 * `tm_format` stehen auf jedem laufenden Server längst in app_settings und
 * sind nichts anderes als Fingerabdrücke des Suchschlüssels.
 */
function altkennungUrteil(): 'passt' | 'weicht ab' | 'unbekannt' {
  const tm = einstellung('tm_format');
  if (tm) return tm === tmKennung() ? 'passt' : 'weicht ab';
  const fts = einstellung('fts_format');
  if (fts) return fts === indexKennung() ? 'passt' : 'weicht ab';
  return 'unbekannt';
}

/**
 * Hängt in dieser Datenbank überhaupt etwas am alten Schlüssel?
 *
 * Ein Schlüsselwechsel ist nur dann eine Katastrophe, wenn es Zeilen gibt, die
 * ohne den alten Schlüssel unlesbar werden. Auf einer frischen Datenbank, oder
 * auf einer, die nie ein Masterpasswort hatte, ist er harmlos: die Nachrüstung
 * in migrate.ts verschlüsselt den vorhandenen Klartext dann einfach mit dem
 * neuen Schlüssel. Diesen Weg — "erst ohne Masterpasswort betrieben, jetzt
 * eines gesetzt" — darf die Prüfung nicht zusperren, er ist der vorgesehene.
 */
function anDenSchluesselGebunden(): boolean {
  const gibtEs = (sql: string): boolean => {
    try { return Boolean(db.get(sql)); } catch { return false; }
  };
  return gibtEs("SELECT 1 AS x FROM users WHERE handle LIKE 'v1:%' OR email LIKE 'v1:%' LIMIT 1")
    || gibtEs("SELECT 1 AS x FROM messages WHERE text LIKE 'm1:%' LIMIT 1");
}

function wechselAusdruecklichErlaubt(): boolean {
  const wert = (process.env.STELLIUM_SCHLUESSELWECHSEL ?? '').trim().toLowerCase();
  return wert === 'ja' || wert === '1';
}

/**
 * Die Meldung. Kein Stapelspur-Auswurf, keine Geheimnisse — weder das
 * Passwort noch die Probe noch ein Ausschnitt davon steht hier drin, denn ein
 * gekürzter Schlüssel ist immer noch ein Schlüssel.
 */
function meldenUndAufhoeren(): never {
  const strich = '━'.repeat(70);
  const satz = encryptionActive()
    ? 'das Masterpasswort passt nicht zu den Daten in dieser Datenbank.'
    : 'es ist kein Masterpasswort gesetzt, die Daten in dieser Datenbank sind aber damit verschlüsselt.';

  process.stderr.write(`
${strich}
  Stellium startet nicht: ${satz}

  Konten, Nachrichten und die Suchwerte, über die die Anmeldung läuft, sind
  unter einem anderen Schlüssel entstanden. Mit dem jetzigen findet niemand
  mehr sein Konto — für jeden sähe das aus wie ein falsches Passwort —, und
  alles ab jetzt Geschriebene wäre mit dem richtigen Schlüssel nie wieder
  lesbar.

  Zu tun: das frühere Masterpasswort wieder bereitstellen und neu starten.
    Server    STELLIUM_MASTER_PASSPHRASE in der Umgebung des Dienstes
    Mac       Schlüsselbund-Eintrag "stellium-master"
  Ohne dieses Passwort lassen sich die vorhandenen Konten nicht zurückholen:
  Benutzername und E-Mail stehen selbst verschlüsselt in der Datenbank.

  Ist der Wechsel gewollt und der Verlust der alten Konten und Nachrichten
  hingenommen: STELLIUM_SCHLUESSELWECHSEL=ja setzen. Es wird dann nichts
  umgerechnet — die alten Zeilen bleiben liegen und bleiben unlesbar.
${strich}
`);
  process.exit(1);
}

/**
 * Wird beim Start gerufen, VOR migrate().
 *
 * Die Reihenfolge ist kein Zufall: `uebersetzungsspeicherPruefen()` in
 * migrate.ts LÖSCHT bei einem Schlüsselwechsel den gesamten
 * Übersetzungsspeicher. Bei einem versehentlich falschen Passwort wäre das
 * echter Datenverlust für nichts. Steht diese Prüfung davor, kommt es dazu
 * gar nicht erst — und in den Fällen, in denen der Start weitergeht, ist der
 * Wechsel entweder harmlos oder ausdrücklich gewollt, und dann ist das Leeren
 * genau richtig.
 */
export function schluesselProbePruefen(): void {
  const stand = einstellung(PROBE_SCHLUESSEL);
  const urteil = stand
    ? (probePasst(stand) ? 'passt' : 'weicht ab')
    : altkennungUrteil();

  if (urteil === 'weicht ab') {
    const gebunden = anDenSchluesselGebunden();
    if (gebunden && !wechselAusdruecklichErlaubt()) meldenUndAufhoeren();
    if (gebunden) {
      console.warn(
        '[schluessel] Der Schlüssel hat gewechselt — Start nur, weil '
        + 'STELLIUM_SCHLUESSELWECHSEL gesetzt ist. Die vorhandenen Konten und '
        + 'Nachrichten bleiben unlesbar; es wird nichts umgerechnet.',
      );
    } else {
      // Nichts hängt am alten Schlüssel. Die Nachrüstung verschlüsselt den
      // vorhandenen Klartext gleich mit dem neuen — das ist der gute Fall.
      console.log('[schluessel] Neuer Schlüssel, keine verschlüsselten Daten vorhanden — nichts geht verloren.');
    }
  }

  if (!stand || urteil !== 'passt') probeSchreiben();
}
