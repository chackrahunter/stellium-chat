/**
 * Stimmen die Einmalcodes?
 *
 * Ein falsch gerechneter Code sieht aus wie ein richtiger. Sechs Ziffern,
 * wechseln alle dreißig Sekunden — man merkt den Fehler erst, wenn Google
 * „falscher Code" sagt, und dann sieht es nach einem kaputten Programm aus
 * statt nach einer verrutschten Bitschieberei. Genau dagegen gibt es die
 * Prüfwerte in Anhang B der RFC 6238.
 *
 *     node scripts/einmalcode-pruefen.mjs
 *
 * Braucht keinen laufenden Server und keine Datenbank: services/
 * einmalcode-kern.ts kennt nur node:crypto.
 *
 * DIE FALLE IN ANHANG B
 *
 * Der Fließtext nennt EIN Geheimnis ("12345678901234567890"), die Tabelle
 * darunter listet Werte für SHA-1, SHA-256 und SHA-512. Wer das wörtlich
 * nimmt, prüft SHA-256 und SHA-512 mit dem falschen Schlüssel und bekommt
 * lauter Fehlschläge — oder, schlimmer, baut die Rechnung so lange um, bis
 * sie zu den falschen Erwartungen passt. Der Java-Code in Anhang A DERSELBEN
 * RFC verwendet drei Schlüssel: 20, 32 und 64 Byte, jeweils "1234567890"
 * wiederholt. Sie stehen unten ausgeschrieben.
 */
import {
  ausBase32, codeReihe, eingabeLesen, hotp, otpauthLesen, periodenNummer, restSekunden, totp,
} from '../packages/server/src/services/einmalcode-kern.ts';

const F = {
  aus: '\x1b[0m', fett: '\x1b[1m', grau: '\x1b[90m',
  gruen: '\x1b[38;5;42m', rot: '\x1b[38;5;203m', gelb: '\x1b[38;5;221m',
};

let gelaufen = 0;
let gefallen = 0;

function pruefe(name, ist, soll) {
  gelaufen += 1;
  const gleich = String(ist) === String(soll);
  if (!gleich) gefallen += 1;
  const marke = gleich ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`;
  const rechts = gleich ? `${F.grau}${soll}${F.aus}` : `${F.rot}${ist}${F.aus} ${F.grau}erwartet ${soll}${F.aus}`;
  console.log(`  ${marke} ${name.padEnd(58)} ${rechts}`);
}

function pruefeWirft(name, fn, teil = '') {
  gelaufen += 1;
  try {
    fn();
    gefallen += 1;
    console.log(`  ${F.rot}✗${F.aus} ${name.padEnd(58)} ${F.rot}kein Fehler geworfen${F.aus}`);
  } catch (e) {
    const passt = !teil || e.message.includes(teil);
    if (!passt) gefallen += 1;
    const marke = passt ? `${F.gruen}✓${F.aus}` : `${F.rot}✗${F.aus}`;
    console.log(`  ${marke} ${name.padEnd(58)} ${F.grau}${e.message}${F.aus}`);
  }
}

function abschnitt(titel) {
  console.log(`\n${F.fett}${titel}${F.aus}`);
}

/* Base32 des Prüfgeheimnisses — der Kern nimmt Base32 entgegen, die RFC
   nennt es in Hex. Einmal umgerechnet, damit die Tabelle unten wörtlich so
   dastehen kann wie in der RFC. */
const alsBase32 = (ascii) => Buffer.from(ascii, 'ascii').toString('base64')
  && [...Buffer.from(ascii, 'ascii')]
    .reduce((s, b) => s + b.toString(2).padStart(8, '0'), '')
    .match(/.{1,5}/g)
    .map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g.padEnd(5, '0'), 2)])
    .join('');

/* ── RFC 4226, Anhang D — HOTP ────────────────────────────────── */

abschnitt('RFC 4226 Anhang D — HOTP, Geheimnis "12345678901234567890", 6 Stellen');

const HOTP_SOLL = [
  '755224', '287082', '359152', '969429', '338314',
  '254676', '287922', '162583', '399871', '520489',
];
const hotpSchluessel = Buffer.from('12345678901234567890', 'ascii');
HOTP_SOLL.forEach((soll, zaehler) => {
  pruefe(`Zähler ${zaehler}`, hotp(hotpSchluessel, BigInt(zaehler), 6, 'SHA1'), soll);
});

/* ── RFC 6238, Anhang B — TOTP ────────────────────────────────── */

abschnitt('RFC 6238 Anhang B — TOTP, 8 Stellen, T0 = 0, X = 30');
console.log(`${F.grau}  Schlüssel nach Anhang A: SHA-1 20 Byte, SHA-256 32 Byte, SHA-512 64 Byte${F.aus}`);

const SCHLUESSEL = {
  SHA1: '12345678901234567890',
  SHA256: '12345678901234567890123456789012',
  SHA512: '1234567890123456789012345678901234567890123456789012345678901234',
};

/* Gegenprobe zur RFC: die Hex-Schreibweise aus Anhang A, Zeile für Zeile
   abgeschrieben — die Umbrüche stehen genau dort, wo sie in der RFC stehen.
   Diese Prüfung fängt genau den Fehler ab, den sie beim ersten Lauf auch
   gefunden hat: eine von Hand zusammengesetzte Kette, die um zwanzig Byte
   danebenlag. Die Codes darunter waren richtig — das Prüfmuster war falsch. */
const HEX_SOLL = {
  SHA1: '3132333435363738393031323334353637383930',
  SHA256: '3132333435363738393031323334353637383930'
        + '313233343536373839303132',
  SHA512: '3132333435363738393031323334353637383930'
        + '3132333435363738393031323334353637383930'
        + '3132333435363738393031323334353637383930'
        + '31323334',
};
for (const [verfahren, ascii] of Object.entries(SCHLUESSEL)) {
  pruefe(`Schlüssel ${verfahren} = seed aus Anhang A`, Buffer.from(ascii, 'ascii').toString('hex'), HEX_SOLL[verfahren]);
}

/* Tabelle 1 aus Anhang B, wörtlich abgeschrieben. */
const TOTP_TABELLE = [
  [59, '0000000000000001', '94287082', 'SHA1'],
  [59, '0000000000000001', '46119246', 'SHA256'],
  [59, '0000000000000001', '90693936', 'SHA512'],
  [1111111109, '00000000023523EC', '07081804', 'SHA1'],
  [1111111109, '00000000023523EC', '68084774', 'SHA256'],
  [1111111109, '00000000023523EC', '25091201', 'SHA512'],
  [1111111111, '00000000023523ED', '14050471', 'SHA1'],
  [1111111111, '00000000023523ED', '67062674', 'SHA256'],
  [1111111111, '00000000023523ED', '99943326', 'SHA512'],
  [1234567890, '000000000273EF07', '89005924', 'SHA1'],
  [1234567890, '000000000273EF07', '91819424', 'SHA256'],
  [1234567890, '000000000273EF07', '93441116', 'SHA512'],
  [2000000000, '0000000003F940AA', '69279037', 'SHA1'],
  [2000000000, '0000000003F940AA', '90698825', 'SHA256'],
  [2000000000, '0000000003F940AA', '38618901', 'SHA512'],
  [20000000000, '0000000027BC86AA', '65353130', 'SHA1'],
  [20000000000, '0000000027BC86AA', '77737706', 'SHA256'],
  [20000000000, '0000000027BC86AA', '47863826', 'SHA512'],
];

for (const [sekunden, tHex, soll, verfahren] of TOTP_TABELLE) {
  /* Auch die Fensternummer selbst prüfen — steht als Spalte "Value of T
     (hex)" in der Tabelle. Ein Code kann zufällig stimmen, die Nummer nicht. */
  const t = periodenNummer(sekunden, 30);
  pruefe(
    `T bei ${String(sekunden).padStart(11)} s`,
    t.toString(16).toUpperCase().padStart(16, '0'), tHex,
  );
  pruefe(
    `${verfahren.padEnd(6)} bei ${String(sekunden).padStart(11)} s`,
    totp({ geheimnisBase32: alsBase32(SCHLUESSEL[verfahren]), algorithmus: verfahren, stellen: 8, periode: 30 }, sekunden),
    soll,
  );
}

/* Dieselben Zeitpunkte auf sechs Stellen: das ist, was die Tafel wirklich
   anzeigt. Die RFC nennt dafür keine Werte — die letzten sechs Ziffern des
   achtstelligen Codes sind es NICHT zwangsläufig, weil modulo 10^6 und
   modulo 10^8 verschiedene Rechnungen sind. Hier wird deshalb nur geprüft,
   dass sechs Stellen herauskommen und dass sie den letzten sechs entsprechen
   (das gilt tatsächlich: (x mod 10^8) mod 10^6 = x mod 10^6). */
abschnitt('Sechs Stellen — was die Tafel zeigt');
for (const [sekunden, , soll, verfahren] of TOTP_TABELLE.filter((z) => z[3] === 'SHA1')) {
  const sechs = totp(
    { geheimnisBase32: alsBase32(SCHLUESSEL[verfahren]), algorithmus: verfahren, stellen: 6, periode: 30 },
    sekunden,
  );
  pruefe(`SHA1 6-stellig bei ${String(sekunden).padStart(11)} s`, sechs, soll.slice(-6));
}

/* ── Base32 (RFC 4648) ───────────────────────────────────────── */

abschnitt('Base32 — RFC 4648 Tabelle 3, und was Menschen tatsächlich einfügen');

const hex = (b) => b.toString('hex');
/* "Hello!\xDE\xAD\xBE\xEF" — das Beispiel aus dem Key-Uri-Format. */
pruefe('JBSWY3DPEHPK3PXP', hex(ausBase32('JBSWY3DPEHPK3PXP')), '48656c6c6f21deadbeef');
pruefe('Kleinbuchstaben', hex(ausBase32('jbswy3dpehpk3pxp')), '48656c6c6f21deadbeef');
pruefe('Gemischt', hex(ausBase32('JbSwY3dPeHpK3PxP')), '48656c6c6f21deadbeef');
pruefe('Googles Vierergruppen', hex(ausBase32('jbsw y3dp ehpk 3pxp')), '48656c6c6f21deadbeef');
pruefe('Mit Bindestrichen', hex(ausBase32('JBSW-Y3DP-EHPK-3PXP')), '48656c6c6f21deadbeef');
pruefe('Mit Zeilenumbruch', hex(ausBase32('JBSWY3DP\n EHPK3PXP')), '48656c6c6f21deadbeef');

/* RFC 4648, Abschnitt 10 — die Prüfwerte für Base32, rückwärts gelesen. */
pruefe('"MY======" → "f"', ausBase32('MY======').toString(), 'f');
pruefe('"MZXQ====" → "fo"', ausBase32('MZXQ====').toString(), 'fo');
pruefe('"MZXW6===" → "foo"', ausBase32('MZXW6===').toString(), 'foo');
pruefe('"MZXW6YQ=" → "foob"', ausBase32('MZXW6YQ=').toString(), 'foob');
pruefe('"MZXW6YTB" → "fooba"', ausBase32('MZXW6YTB').toString(), 'fooba');
pruefe('"MZXW6YTBOI======" → "foobar"', ausBase32('MZXW6YTBOI======').toString(), 'foobar');
pruefe('ohne Füllzeichen ("MZXW6")', ausBase32('MZXW6').toString(), 'foo');
pruefe('Füllzeichen klein geschrieben', ausBase32('mzxw6===').toString(), 'foo');

pruefeWirft('"0" ist kein Base32-Zeichen', () => ausBase32('JBSW03DP'), 'Stelle 5');
pruefeWirft('"1" ist kein Base32-Zeichen', () => ausBase32('1BSWY3DP'), 'Stelle 1');
pruefeWirft('"8" ist kein Base32-Zeichen', () => ausBase32('JBSWY8DP'), 'Stelle 6');
pruefeWirft('leere Eingabe', () => ausBase32('   '), 'Leeres Geheimnis');
pruefeWirft('nur Füllzeichen', () => ausBase32('===='), 'Leeres Geheimnis');

/* Ein Fehlertext darf das Geheimnis nicht mitschleppen. */
abschnitt('Kein Geheimnis in einer Fehlermeldung');
{
  gelaufen += 1;
  const geheim = 'JBSWY3DPEHPK3PX0';           // letztes Zeichen ungültig
  let text = '';
  try { ausBase32(geheim); } catch (e) { text = `${e.message} ${e.stack ?? ''}`; }
  /* Weder das Ganze noch ein längeres Stück davon darf im Text stehen. */
  const stuecke = [geheim, geheim.slice(0, 8), geheim.slice(-8), 'JBSWY3DP'];
  const verraten = stuecke.filter((s) => text.includes(s));
  if (verraten.length) {
    gefallen += 1;
    console.log(`  ${F.rot}✗${F.aus} ${'Fehlertext enthält nichts vom Geheimnis'.padEnd(58)} ${F.rot}${verraten.join(', ')}${F.aus}`);
  } else {
    console.log(`  ${F.gruen}✓${F.aus} ${'Fehlertext enthält nichts vom Geheimnis'.padEnd(58)} ${F.grau}"${text.split('\n')[0]}"${F.aus}`);
  }
}

/* ── otpauth:// ──────────────────────────────────────────────── */

abschnitt('otpauth:// — das, was hinter Googles QR-Code steckt');

{
  const u = otpauthLesen('otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP&issuer=Example');
  pruefe('Beispiel 1 — Geheimnis', u.geheimnisBase32, 'JBSWY3DPEHPK3PXP');
  pruefe('Beispiel 1 — Aussteller', u.aussteller, 'Example');
  pruefe('Beispiel 1 — Konto', u.konto, 'alice@google.com');
  pruefe('Beispiel 1 — Verfahren (Vorgabe)', u.algorithmus, 'SHA1');
  pruefe('Beispiel 1 — Stellen (Vorgabe)', u.stellen, 6);
  pruefe('Beispiel 1 — Periode (Vorgabe)', u.periode, 30);
}

{
  const u = otpauthLesen(
    'otpauth://totp/ACME%20Co:john.doe@email.com?secret=HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ'
    + '&issuer=ACME%20Co&algorithm=SHA1&digits=6&period=30',
  );
  pruefe('Beispiel 2 — Aussteller mit Leerzeichen', u.aussteller, 'ACME Co');
  pruefe('Beispiel 2 — Konto', u.konto, 'john.doe@email.com');
  pruefe('Beispiel 2 — Geheimnis', u.geheimnisBase32, 'HXDMVJECJJWSRB3HWIZR4IFUGFTMXBOZ');
}

{
  /* Das dritte Beispiel des Key-Uri-Formats: Doppelpunkt als %3A, danach ein
     kodiertes Leerzeichen, Konto ebenfalls kodiert. */
  const u = otpauthLesen('otpauth://totp/Big%20Corporation%3A%20alice%40bigco.com?secret=JBSWY3DPEHPK3PXP');
  pruefe('%3A als Trenner — Aussteller', u.aussteller, 'Big Corporation');
  pruefe('%3A als Trenner — Konto ohne führendes Leerzeichen', u.konto, 'alice@bigco.com');
}

{
  /* Aussteller MIT Doppelpunkt: im Etikett wäre er der Trenner, im Feld
     `issuer=` darf er stehen — und das Feld gewinnt. */
  const u = otpauthLesen(
    'otpauth://totp/Firma%3A%20Technik%3Aops%40firma.de?secret=JBSWY3DPEHPK3PXP&issuer=Firma%3A%20Technik',
  );
  pruefe('issuer= mit Doppelpunkt und Leerzeichen', u.aussteller, 'Firma: Technik');
  pruefe('Etikett teilt nur am ERSTEN Doppelpunkt', u.konto, 'Technik:ops@firma.de');
}

{
  const u = otpauthLesen('otpauth://totp/alice@google.com?secret=JBSWY3DPEHPK3PXP');
  pruefe('Etikett ohne Aussteller', u.aussteller, '');
  pruefe('Etikett ohne Aussteller — Konto', u.konto, 'alice@google.com');
}

{
  const u = otpauthLesen('OTPAUTH://TOTP/X:y?secret=jbswy3dpehpk3pxp&algorithm=sha-512&digits=8&period=60');
  pruefe('Schema und Art in Großbuchstaben', u.konto, 'y');
  pruefe('algorithm=sha-512', u.algorithmus, 'SHA512');
  pruefe('digits=8', u.stellen, 8);
  pruefe('period=60', u.periode, 60);
}

pruefeWirft('hotp wird abgewiesen', () => otpauthLesen('otpauth://hotp/X?secret=JBSWY3DPEHPK3PXP&counter=1'), 'hotp');
pruefeWirft('fremdes Schema', () => otpauthLesen('https://example.com/?secret=JBSWY3DPEHPK3PXP'), 'otpauth');
pruefeWirft('ohne secret', () => otpauthLesen('otpauth://totp/X?issuer=Y'), 'secret');
pruefeWirft('kaputtes secret', () => otpauthLesen('otpauth://totp/X?secret=NICHT!BASE32'), 'Base32');
pruefeWirft('digits=5 (unter RFC-Mindestmaß)', () => otpauthLesen('otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=5'), 'Stellenzahl');
pruefeWirft('digits=9', () => otpauthLesen('otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&digits=9'), 'Stellenzahl');
pruefeWirft('unbekanntes Verfahren', () => otpauthLesen('otpauth://totp/X?secret=JBSWY3DPEHPK3PXP&algorithm=MD5'), 'Verfahren');

abschnitt('Eingabefeld — Adresse ODER nacktes Geheimnis');
{
  const u = eingabeLesen('  jbsw y3dp ehpk 3pxp  ');
  pruefe('nacktes Geheimnis, klein, mit Lücken', u.geheimnisBase32, 'JBSWY3DPEHPK3PXP');
  pruefe('nacktes Geheimnis — Vorgaben', `${u.algorithmus}/${u.stellen}/${u.periode}`, 'SHA1/6/30');
}
{
  const u = eingabeLesen('  otpauth://totp/Example:alice@google.com?secret=JBSWY3DPEHPK3PXP  ');
  pruefe('Adresse mit Leerzeichen drumherum', u.konto, 'alice@google.com');
}
pruefeWirft('weder Adresse noch Geheimnis', () => eingabeLesen('hallo welt!'), 'Base32');

/* ── Restsekunden und Vorrat ─────────────────────────────────── */

abschnitt('Restsekunden im laufenden Fenster');
pruefe('t = 0 s   → 30 übrig', restSekunden(0, 30), 30);
pruefe('t = 1 s   → 29 übrig', restSekunden(1, 30), 29);
pruefe('t = 29 s  → 1 übrig', restSekunden(29, 30), 1);
pruefe('t = 30 s  → 30 übrig (neues Fenster)', restSekunden(30, 30), 30);
pruefe('t = 59 s  → 1 übrig', restSekunden(59, 30), 1);
pruefe('Periode 60, t = 45 s → 15 übrig', restSekunden(45, 60), 15);

abschnitt('Vorrat — aufeinanderfolgende Fenster');
{
  const vorgabe = { geheimnisBase32: alsBase32(SCHLUESSEL.SHA1), algorithmus: 'SHA1', stellen: 8, periode: 30 };
  const reihe = codeReihe(vorgabe, 1111111109, 3);
  pruefe('Vorrat Länge', reihe.length, 3);
  pruefe('Vorrat[0] = Code bei 1111111109', reihe[0].code, '07081804');
  pruefe('Vorrat[1] = Code bei 1111111111', reihe[1].code, '14050471');
  pruefe('Vorrat[0] Fenster', reihe[0].fenster, String(0x23523ec));
  pruefe('Vorrat[1] Fenster', reihe[1].fenster, String(0x23523ed));
  pruefe('Vorrat[0] gültig bis = Vorrat[1] gültig ab', reihe[0].gueltigBisMs, reihe[1].gueltigAbMs);
  pruefe('Vorrat[0] gültig ab liegt auf der Periodengrenze', reihe[0].gueltigAbMs % 30000, 0);
}

/* ── Zusammenfassung ─────────────────────────────────────────── */

console.log('');
if (gefallen) {
  console.log(`${F.rot}${F.fett}${gefallen} von ${gelaufen} Prüfungen gefallen.${F.aus}`);
  process.exit(1);
}
console.log(`${F.gruen}${F.fett}Alle ${gelaufen} Prüfungen bestanden.${F.aus}`);
