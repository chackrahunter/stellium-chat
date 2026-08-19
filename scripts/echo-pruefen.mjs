/**
 * Gibt das Modell die Eingabe zurück, statt sie zu übersetzen?
 *
 * Am 19.08.2026 stand in Dons Fenster eine englische Nachricht mit dem
 * Vermerk „Übersetzt aus English" — der Text war englisch geblieben. Das
 * lokale qwen3-8b hatte den Satz nicht übersetzt, sondern aufgeräumt:
 * Kommas gesetzt, Wörter großgeschrieben, sonst nichts. Weil sich die
 * Zeichenketten dadurch unterschieden, galt das Ergebnis als Übersetzung.
 *
 * Teil 1 — Wortlaute (braucht nichts weiter):
 *   Echte Modellantworten von damals, festgehalten. Was hier durchrutscht,
 *   stünde morgen wieder falsch beschriftet im Fenster.
 *
 * Teil 2 — Messung am laufenden Modell (nur mit MODELL=…):
 *   Schickt einen Korpus echter Chat-Nachrichten durch dieselbe Anweisung,
 *   die auch im Betrieb hinausgeht, und zählt die Echos — einmal beim ersten
 *   Anlauf, einmal nach dem Nachfassen.
 *
 *   MODELL=http://127.0.0.1:11434/v1 MODELL_ID=qwen3-8b node scripts/echo-pruefen.mjs
 */
import { istEcho, woerter, wortAehnlichkeit } from '../packages/server/src/translation/echo.ts';
import { translationBudget, uebersetzungsRegeln, uebersetzungsTemperatur }
  from '../packages/server/src/translation/prompt.ts';
import { uebersetzungAusAntwort } from '../packages/server/src/translation/antwort.ts';

let bestanden = 0;
let gefallen = 0;
const pruefe = (name, bedingung, hinweis = '') => {
  if (bedingung) { bestanden++; console.log(`  ✓ ${name}`); }
  else { gefallen++; console.log(`  ✗ ${name}${hinweis ? ` — ${hinweis}` : ''}`); }
};

/* ── Teil 1: festgehaltene Wortlaute ──────────────────────────── */

/** Was das Modell zurückgab, ohne zu übersetzen. Muss erkannt werden. */
const ECHOS = [
  ['der Fall aus dem Fenster — nur Kommas und Großschreibung dazu',
    'oh weird anyways btw have to fix the website make sure when touching stuff like the caddy make sure claude doesnt affect the other website',
    'Oh weird, anyways btw have to fix the website, make sure when touching stuff like the caddy, make sure claude doesnt affect the other website'],
  ['derselbe Fall nach dem Nachfassen — immer noch englisch',
    'oh weird anyways btw have to fix the website make sure when touching stuff like the caddy make sure claude doesnt affect the other website',
    'Oh weird, any ways, btw, have to fix the website. Make sure when touching stuff like the caddy, make sure claude doesn\'t affect the other website'],
  ['Wort für Wort dieselbe Zeichenkette',
    'lol ok so the build is broken again gonna look at it after lunch',
    'lol ok so the build is broken again gonna look at it after lunch'],
  ['kurzer Satz, nur großgeschrieben',
    'sorry im late', 'Sorry im Late'],
  ['Tippfehler unangetastet zurück',
    'plesae reveiw my pr befor the meting tomorow',
    'plesae reveiw my pr befor the meting tomorow'],
  ['lange Nachricht, nur Zeichensetzung ergänzt',
    'so basically what happened is the caddy config got overwritten during the last deploy which took down the other site as well, i rolled it back manually and everything is up again',
    'So basically what happened is the caddy config got overwritten during the last deploy, which took down the other site as well. I rolled it back manually and everything is up again.'],
  ['auch andersherum: Deutsch bleibt Deutsch',
    'sorry bin spät dran', 'sorry bin spät dran'],
  ['ein einzelnes Wort ausgetauscht, der Rest englisch',
    'oh weird anyways btw have to fix the website make sure when touching stuff like the caddy make sure claude doesnt affect the other website',
    'Oh curious anyway, btw have to fix the website, make sure when touching stuff like the caddy, make sure claude doesnt affect the other website'],
];

/** Echte Übersetzungen. Dürfen nicht als Echo gelten. */
const UEBERSETZUNGEN = [
  ['der Fall aus dem Fenster, richtig übersetzt',
    'oh weird anyways btw have to fix the website make sure when touching stuff like the caddy make sure claude doesnt affect the other website',
    'Oh weird, jedenfalls btw muss die Website repariert werden, achte darauf, dass beim Berühren von Dingen wie dem Caddy, Claude die andere Website nicht beeinflusst.'],
  ['kurzer Satz, übersetzt',
    'on my way', 'Auf dem Weg'],
  ['kurzer Satz, übersetzt',
    'looks good to me', 'Das sieht gut aus für mich'],
  ['Tippfehler sinngemäß übertragen',
    'plesae reveiw my pr befor the meting tomorow', 'Bitte überprüfe meinen PR vor der Meeting morgen'],
  ['Deutsch nach Englisch',
    'Die Auslieferung ist durchgelaufen und alle Prüfungen sind grün.',
    'The delivery has been completed and all tests are green.'],
  ['lange Nachricht, übersetzt',
    'so basically what happened is the caddy config got overwritten during the last deploy which took down the other site as well',
    'Also im Grunde ist passiert, dass die Caddy-Konfiguration während der letzten Bereitstellung überschrieben wurde, wodurch auch die andere Seite ausfiel'],
  ['gemeinsame Fachbegriffe reichen nicht für ein Echo',
    'die Websocket-Verbindung bricht alle 30 Sekunden ab weil proxy_read_timeout im nginx zu niedrig steht',
    'The WebSocket connection breaks every 30 seconds because proxy_read_timeout in nginx is set too low'],
  ['Uhrzeit und Eigenname überschneiden sich, der Rest nicht',
    'Meeting um 14 Uhr im großen Raum', 'Meeting at 2 pm in the big room'],
];

/** Zu kurz zum Urteilen — hier ist die unveränderte Rückgabe richtig. */
const ZU_KURZ = [
  ['ok', 'ok'],
  ['Stellium', 'Stellium'],
  ['danke!', 'thanks!'],
  ['+1', '+1'],
];

console.log('\nTeil 1 — festgehaltene Wortlaute\n');

console.log(' Echos, die auffallen müssen:');
for (const [name, ein, aus] of ECHOS) {
  pruefe(name, istEcho(ein, aus), `nur ${Math.round(wortAehnlichkeit(ein, aus) * 100)} % Übereinstimmung gemessen`);
}

console.log('\n Übersetzungen, die durchgehen müssen:');
for (const [name, ein, aus] of UEBERSETZUNGEN) {
  pruefe(name, !istEcho(ein, aus), `fälschlich als Echo verworfen (${Math.round(wortAehnlichkeit(ein, aus) * 100)} %)`);
}

console.log('\n Zu kurz für ein Urteil:');
for (const [ein, aus] of ZU_KURZ) {
  pruefe(`„${ein}" bleibt ungeprüft`, !istEcho(ein, aus), 'wurde geprüft, obwohl zu kurz');
}

console.log('\n Antworten deuten:');
const gedeutet = (roh, ein = 'hello there friend') => uebersetzungAusAntwort(roh, ein)?.translation ?? null;
pruefe('JSON-Objekt wie von Groq',
  gedeutet('{"translation":"Hallo","detected_source_language":"en","confidence":0.9}') === 'Hallo');
pruefe('JSON-Objekt mit vorangestelltem Geschwätz',
  gedeutet('Klar!\n{"translation":"Hallo"}') === 'Hallo');
pruefe('nackte JSON-Zeichenkette (llama.cpp)',
  gedeutet('"Merhaba arkadaşım"') === 'Merhaba arkadaşım');
pruefe('blanker Text ohne JSON (llama.cpp)',
  gedeutet('İşte bu deploy zorlaştı ama sonunda oraya vardık') === 'İşte bu deploy zorlaştı ama sonunda oraya vardık');
pruefe('zerbrochenes JSON wird nicht geraten',
  gedeutet('{"translation":"Hallo') === null);
pruefe('ein Vorwort ist keine Übersetzung',
  gedeutet('Here is the translation you asked for') === null);
pruefe('eine Erklärung statt einer Übersetzung fällt durch',
  gedeutet('Das ist eine sehr lange Erläuterung darüber, warum sich dieser Text nicht übersetzen lässt, '
    + 'und was der Verfasser stattdessen gemeint haben könnte, samt Beispielen und Gegenbeispielen, '
    + 'die alle nichts damit zu tun haben, was hier eigentlich gefragt war.', 'hi') === null);

console.log('\n Wortzerlegung:');
pruefe('Umlaute bleiben ein Wort', woerter('über').length === 1, `zerfiel in ${JSON.stringify(woerter('über'))}`);
pruefe('Akzente stören den Vergleich nicht', wortAehnlichkeit('cafe creme', 'café crème') === 1);
pruefe('Satzzeichen trennen Wörter', woerter('a,b.c').join(' ') === 'a b c');

/* ── Teil 2: Messung am laufenden Modell ──────────────────────── */

const ADRESSE = process.env.MODELL;
if (!ADRESSE) {
  console.log('\nTeil 2 übersprungen — für die Messung am echten Modell MODELL=<baseUrl> setzen.');
} else {
  const MODELL_ID = process.env.MODELL_ID ?? 'qwen3-8b';

  /* Umgangssprache, kurze Sätze, Tippfehler, gemischte Sprachen und sehr lange
     Nachrichten — das ist der Stoff, an dem kleine Modelle scheitern. Saubere
     Sätze stehen zur Gegenprobe daneben. */
  const KORPUS = [
    ['umgangssprache', 'en', 'de', 'oh weird anyways btw have to fix the website make sure when touching stuff like the caddy make sure claude doesnt affect the other website'],
    ['umgangssprache', 'en', 'de', 'yeah nah im gonna push it later tonight dont worry about it'],
    ['umgangssprache', 'en', 'de', 'lol ok so the build is broken again gonna look at it after lunch'],
    ['umgangssprache', 'en', 'de', 'ngl that deploy was rough but we got there in the end'],
    ['umgangssprache', 'en', 'de', 'can u check the logs real quick smth looks off with the queue'],
    ['kurz', 'en', 'de', 'on my way'],
    ['kurz', 'en', 'de', 'looks good to me'],
    ['kurz', 'en', 'de', 'sorry im late'],
    ['kurz', 'en', 'de', 'can we push it to friday'],
    ['tippfehler', 'en', 'de', 'teh server is dwon agian pls restrat it when u hav time'],
    ['tippfehler', 'en', 'de', 'i thnik the migraiton scipt didnt run corectly yesterdya'],
    ['tippfehler', 'en', 'de', 'plesae reveiw my pr befor the meting tomorow'],
    ['gemischt', 'en', 'de', 'ok also der deploy war weird but anyways it works now'],
    ['sauber', 'en', 'de', 'Could you please review the pull request before tomorrow morning?'],
    ['sauber', 'en', 'de', 'The deployment finished successfully and all health checks are green.'],
    ['lang', 'en', 'de', 'so basically what happened is the caddy config got overwritten during the last deploy which took down the other site as well, i rolled it back manually and everything is up again but we really need a proper staging environment before we touch that file again, otherwise this is going to keep happening every couple of weeks and someone is going to notice eventually'],
    ['technisch', 'en', 'de', 'the websocket reconnects every 30s because the nginx proxy_read_timeout is too low'],
    ['umgangssprache', 'de', 'en', 'ja ne komm ich mach das heute abend noch mach dir keinen kopf'],
    ['umgangssprache', 'de', 'en', 'boah der build ist schon wieder kaputt ich schau nach dem mittag'],
    ['kurz', 'de', 'en', 'bin unterwegs'],
    ['kurz', 'de', 'en', 'sorry bin spät dran'],
    ['tippfehler', 'de', 'en', 'der serevr ist wider unten bitt starte ihn neu wen du zeit hst'],
    ['sauber', 'de', 'en', 'Könntest du den Pull Request bitte bis morgen früh durchsehen?'],
    ['lang', 'de', 'en', 'also im Grunde ist Folgendes passiert: die Caddy-Konfiguration wurde beim letzten Ausliefern überschrieben, dadurch war auch die andere Seite weg, ich habe das von Hand zurückgedreht und jetzt läuft wieder alles, aber wir brauchen wirklich eine richtige Testumgebung bevor wir diese Datei nochmal anfassen'],
    ['umgangssprache', 'en', 'tr', 'yeah nah im gonna push it later tonight dont worry about it'],
    ['umgangssprache', 'en', 'tr', 'ngl that deploy was rough but we got there in the end'],
    ['umgangssprache', 'de', 'fr', 'ja ne komm ich mach das heute abend noch mach dir keinen kopf'],
  ];

  /** Ein Anlauf, mit genau der Anweisung aus dem Betrieb. */
  async function frage(text, ziel, quelle, nachdruck) {
    const req = { text, targetLang: ziel, sourceLang: quelle, nachdruck };
    const res = await fetch(`${ADRESSE.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer pruefung' },
      body: JSON.stringify({
        model: MODELL_ID,
        messages: [
          { role: 'system', content: uebersetzungsRegeln(req).join('\n') },
          { role: 'user', content: text },
        ],
        temperature: uebersetzungsTemperatur(req),
        max_completion_tokens: translationBudget(text),
        response_format: { type: 'json_object' },
      }),
    });
    if (!res.ok) return null;
    const inhalt = (await res.json())?.choices?.[0]?.message?.content;
    if (typeof inhalt !== 'string') return null;
    return uebersetzungAusAntwort(inhalt.trim(), text)?.translation ?? null;
  }

  console.log(`\nTeil 2 — Messung an ${MODELL_ID} über ${ADRESSE}\n`);

  let ersterAnlauf = 0;
  let nachNachfassen = 0;
  let ohneAntwort = 0;
  const nachKategorie = {};
  const nachRichtung = {};

  for (const [kat, quelle, ziel, text] of KORPUS) {
    const richtung = `${quelle}→${ziel}`;
    nachKategorie[kat] ??= { n: 0, echo: 0 };
    nachRichtung[richtung] ??= { n: 0, echo: 0 };
    nachKategorie[kat].n++; nachRichtung[richtung].n++;

    const erste = await frage(text, ziel, quelle, false);
    if (erste === null) { ohneAntwort++; console.log(`  —     ${richtung} ${kat.padEnd(15)} keine verwertbare Antwort`); continue; }

    const echo1 = istEcho(text, erste);
    if (echo1) ersterAnlauf++;

    let endstand = erste;
    if (echo1) {
      const zweite = await frage(text, ziel, quelle, true);
      if (zweite !== null && !istEcho(text, zweite)) endstand = zweite;
    }
    const echo2 = istEcho(text, endstand);
    if (echo2) { nachNachfassen++; nachKategorie[kat].echo++; nachRichtung[richtung].echo++; }

    const marke = echo2 ? 'ECHO ' : echo1 ? 'gerettet' : 'ok   ';
    console.log(`  ${marke.padEnd(8)} ${richtung} ${kat.padEnd(15)} ${endstand.slice(0, 70).replace(/\s+/g, ' ')}`);
  }

  const n = KORPUS.length;
  const anteil = (x) => `${x} von ${n} (${Math.round((x / n) * 100)} %)`;
  console.log(`\n  Erster Anlauf gab die Eingabe zurück: ${anteil(ersterAnlauf)}`);
  console.log(`  Nach dem Nachfassen noch:             ${anteil(nachNachfassen)}`);
  console.log(`  Ohne verwertbare Antwort:             ${anteil(ohneAntwort)}`);
  console.log('\n  je Richtung:');
  for (const [k, v] of Object.entries(nachRichtung)) console.log(`    ${k.padEnd(8)} ${v.echo}/${v.n}`);
  console.log('  je Art:');
  for (const [k, v] of Object.entries(nachKategorie)) console.log(`    ${k.padEnd(16)} ${v.echo}/${v.n}`);

  /* Ein Modell ist nie ganz zuverlässig — was übrig bleibt, wird als
     unübersetzt gekennzeichnet und nicht als Übersetzung ausgegeben. Reißt die
     Quote aber aus, taugt das Modell für Live-Übersetzung nicht mehr. */
  pruefe('höchstens 15 % Echos nach dem Nachfassen',
    nachNachfassen / n <= 0.15, `${Math.round((nachNachfassen / n) * 100)} % gemessen`);
}

console.log(`\n${gefallen ? '✗' : '✓'} ${bestanden} bestanden, ${gefallen} gefallen`);
process.exit(gefallen ? 1 : 0);
