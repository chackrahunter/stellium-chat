/**
 * Korpus für scripts/uebersetzung-messen.mjs.
 *
 * Eigene Datei, damit sich Fälle ergänzen lassen, ohne den Prüflauf
 * anzufassen. Jeder Fall ist eine chat-typische Nachricht — keine Testfloskel
 * wie "Hello World", sondern das, was in einem Firmen-Chat wirklich steht:
 * Umgangssprache ohne Satzzeichen, Tippfehler, gemischte Sprachen in einem
 * Satz, technische Begriffe, sehr kurze Nachrichten, lange Absätze,
 * Aufzählungen, Code in Backticks, @Erwähnungen, Emojis.
 *
 * Sprachpaare: nicht geraten, sondern aus dem Repo — Schwerpunkt Deutsch↔
 * Englisch, weil das die einzige Richtung ist, für die es hier echte Belege
 * gibt (Vorgabesprache 'de' in seed.ts, und jeder real festgehaltene
 * Modellfehler in packages/server/src/translation/echo.ts sowie in
 * scripts/echo-pruefen.mjs ist Englisch→Deutsch oder Deutsch→Englisch).
 * Dazu die zwei Nebenrichtungen, die echo-pruefen.mjs bereits als geprüft
 * führt (en→tr, de→fr), für etwas Sprachenbreite ohne zu erfinden, wer sie
 * tatsächlich benutzt.
 *
 * Kategorie "umgangssprache-sauber": leicht umgangssprachliches, aber
 * ordentlich geschriebenes Deutsch/Englisch, wie Kollegen es tippen — Groß-
 * schreibung und Satzzeichen intakt, nichts abgehackt. Der erste Fall darin
 * ist ein realer Fehlerfall aus dem Betrieb (22.08.2026): "Oh wait, ich lade
 * die App gerade runter" kam als "oh wait ima download the app rn" zurück —
 * kein Wort falsch übersetzt, aber aus normalem Deutsch wurde Netzjargon.
 * Genau diese Rutsche prüft die Kategorie "ton" in uebersetzung-messen.mjs.
 */
export const KORPUS = [
  /* ── umgangssprache-roh: ohne Satzzeichen, klein geschrieben ────── */
  { kategorie: 'umgangssprache-roh', quelle: 'en', ziel: 'de',
    text: 'oh weird anyways btw have to fix the website make sure when touching stuff like the caddy make sure claude doesnt affect the other website' },
  { kategorie: 'umgangssprache-roh', quelle: 'en', ziel: 'de',
    text: 'yeah nah im gonna push it later tonight dont worry about it' },
  { kategorie: 'umgangssprache-roh', quelle: 'en', ziel: 'de',
    text: 'lol ok so the build is broken again gonna look at it after lunch' },
  { kategorie: 'umgangssprache-roh', quelle: 'en', ziel: 'de',
    text: 'can u check the logs real quick smth looks off with the queue' },
  { kategorie: 'umgangssprache-roh', quelle: 'de', ziel: 'en',
    text: 'ja ne komm ich mach das heute abend noch mach dir keinen kopf' },
  { kategorie: 'umgangssprache-roh', quelle: 'de', ziel: 'en',
    text: 'boah der build ist schon wieder kaputt ich schau nach dem mittag' },
  { kategorie: 'umgangssprache-roh', quelle: 'de', ziel: 'en',
    text: 'kannst du kurz in die logs schauen irgendwas ist komisch bei der queue' },
  { kategorie: 'umgangssprache-roh', quelle: 'en', ziel: 'de',
    text: 'ngl that deploy was rough but we got there in the end' },

  /* ── umgangssprache-sauber: leicht locker, ordentlich geschrieben ──
     Genau der Stoff aus dem Nachtrag des Auftraggebers — Kollegenstil, keine
     abgehackte Umgangssprache, trotzdem nicht förmlich. */
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    notiz: 'realer Fehlerfall vom 22.08.2026 — Ausgabe war "oh wait ima download the app rn"',
    text: 'Oh wait, ich lade die App gerade runter' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Kannst du kurz draufschauen, wenn du Zeit hast?' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Ich bin in fünf Minuten da, muss nur noch tanken.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Gib mir kurz Bescheid, sobald es fertig ist.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Das klingt gut, lass uns das so machen.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Ich schau\'s mir heute Abend noch an, versprochen.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Kein Problem, ich kümmere mich morgen früh darum.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Warte kurz, ich muss nur noch was speichern.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'en', ziel: 'de',
    text: 'Can you take a quick look when you get a chance?' },
  { kategorie: 'umgangssprache-sauber', quelle: 'en', ziel: 'de',
    text: 'I\'ll be there in five minutes, just need to grab coffee.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'en', ziel: 'de',
    text: 'Sounds good, let\'s go with that then.' },
  /* Nachtrag 22.08.2026 — zwei weitere Registerrisiko-Fälle im Stil des realen
     Fehlerfalls oben, extra für die Anweisungs-Überarbeitung in prompt.ts
     ergänzt und NICHT beim Tunen benutzt (echtes Held-out-Material). */
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'en',
    text: 'Ich schreib dir gleich zurück, bin gerade kurz in einem Call.' },
  { kategorie: 'umgangssprache-sauber', quelle: 'en', ziel: 'de',
    text: 'I\'ll ping you as soon as it\'s deployed, shouldn\'t be long now.' },

  /* ── förmlich: die Gegenrichtung — förmlich darf nicht in Jargon abrutschen ── */
  { kategorie: 'foermlich', quelle: 'de', ziel: 'en',
    text: 'Könnten Sie mir bitte das Protokoll der letzten Sitzung zusenden?' },
  { kategorie: 'foermlich', quelle: 'de', ziel: 'en',
    text: 'Wir bitten Sie, die Unterlagen bis Freitag einzureichen.' },
  { kategorie: 'foermlich', quelle: 'en', ziel: 'de',
    text: 'Could you please confirm receipt of this document at your earliest convenience?' },

  /* ── kurz: zu kurz für ein sicheres Urteil bei Sprache/Sinn, Echo bleibt geprüft ── */
  { kategorie: 'kurz', quelle: 'de', ziel: 'en', text: 'ok' },
  { kategorie: 'kurz', quelle: 'de', ziel: 'en', text: 'passt' },
  { kategorie: 'kurz', quelle: 'en', ziel: 'de', text: 'np' },
  { kategorie: 'kurz', quelle: 'en', ziel: 'de', text: 'sure' },
  { kategorie: 'kurz', quelle: 'de', ziel: 'en', text: 'bin dabei' },
  { kategorie: 'kurz', quelle: 'en', ziel: 'de', text: 'on it' },

  /* ── tippfehler ───────────────────────────────────────────────── */
  { kategorie: 'tippfehler', quelle: 'en', ziel: 'de',
    text: 'teh server is dwon agian pls restrat it when u hav time' },
  { kategorie: 'tippfehler', quelle: 'en', ziel: 'de',
    text: 'i thnik the migraiton scipt didnt run corectly yesterdya' },
  { kategorie: 'tippfehler', quelle: 'de', ziel: 'en',
    text: 'der serevr ist wider unten bitt starte ihn neu wen du zeit hst' },
  { kategorie: 'tippfehler', quelle: 'de', ziel: 'en',
    text: 'kannst du das bitte nochmal pruefen ich glaub da fehlt was' },
  { kategorie: 'tippfehler', quelle: 'en', ziel: 'de',
    text: 'plesae reveiw my pr befor the meting tomorow' },

  /* ── gemischt: Sprachwechsel innerhalb eines Satzes ──────────────── */
  { kategorie: 'gemischt', quelle: 'de', ziel: 'en',
    text: 'ok also der deploy war weird but anyways it works now' },
  { kategorie: 'gemischt', quelle: 'en', ziel: 'de',
    text: 'so the meeting ist heute um drei uhr right?' },
  { kategorie: 'gemischt', quelle: 'de', ziel: 'en',
    text: 'können wir das quick besprechen bevor ich offline gehe' },

  /* ── technisch: Fachbegriffe, die nicht mitübersetzt werden dürfen ── */
  { kategorie: 'technisch', quelle: 'en', ziel: 'de',
    text: 'the websocket reconnects every 30s because the nginx proxy_read_timeout is too low' },
  { kategorie: 'technisch', quelle: 'de', ziel: 'en',
    text: 'die Datenbank-Migration ist beim dritten Schritt hängen geblieben, vermutlich ein Locking-Problem' },
  { kategorie: 'technisch', quelle: 'en', ziel: 'de',
    text: 'we need to rotate the API key before the certificate expires next week' },
  { kategorie: 'technisch', quelle: 'de', ziel: 'en',
    text: 'der Cache wird nicht invalidiert, wenn sich die Konfiguration ändert' },

  /* ── lang: längere Absätze ────────────────────────────────────── */
  { kategorie: 'lang', quelle: 'en', ziel: 'de',
    text: 'so basically what happened is the caddy config got overwritten during the last deploy which took down the other site as well, i rolled it back manually and everything is up again but we really need a proper staging environment before we touch that file again, otherwise this is going to keep happening every couple of weeks and someone is going to notice eventually' },
  { kategorie: 'lang', quelle: 'de', ziel: 'en',
    text: 'also im Grunde ist Folgendes passiert: die Caddy-Konfiguration wurde beim letzten Ausliefern überschrieben, dadurch war auch die andere Seite weg, ich habe das von Hand zurückgedreht und jetzt läuft wieder alles, aber wir brauchen wirklich eine richtige Testumgebung bevor wir diese Datei nochmal anfassen' },
  { kategorie: 'lang', quelle: 'en', ziel: 'de',
    text: 'Just a heads up, I spent most of the afternoon debugging the notification service and it turned out to be a race condition between the websocket reconnect and the initial state fetch, so messages arrived before the client actually knew which channel it was in. Fixed now, but it explains the weird duplicate alerts people were seeing yesterday.' },
  /* Nachtrag 22.08.2026 — zwei weitere lange, unpunktierte Fälle, extra für
     die Anweisungs-Überarbeitung in prompt.ts ergänzt und NICHT beim Tunen
     der Anweisung benutzt (echtes Held-out-Material für diese Kategorie). */
  { kategorie: 'lang', quelle: 'en', ziel: 'de',
    text: 'ok so turns out the reason the queue kept backing up is someone pointed the staging worker at the production database by accident and nobody noticed until customers started asking why their orders werent showing up which is obviously not great so please always double check the env file before you deploy anything' },
  { kategorie: 'lang', quelle: 'de', ziel: 'en',
    text: 'also ich hab grad gesehen dass der nightly build seit drei tagen rot ist keine ahnung wieso das niemandem aufgefallen ist aber ich schau mir das jetzt an und meld mich sobald ich weiß was da los ist' },

  /* ── aufzaehlung: Listen mit echten Zeilenumbrüchen ──────────────── */
  { kategorie: 'aufzaehlung', quelle: 'en', ziel: 'de',
    text: 'Quick update before the meeting:\n- backend deploy is done\n- frontend is still in review\n- docs need another pass\nLet me know if I missed anything.' },
  { kategorie: 'aufzaehlung', quelle: 'de', ziel: 'en',
    text: 'Kurzes Update:\n1. Server läuft wieder stabil\n2. Migration ist durchgelaufen\n3. Monitoring zeigt keine Fehler mehr\nMelde dich, falls noch was fehlt.' },
  { kategorie: 'aufzaehlung', quelle: 'en', ziel: 'de',
    text: 'Two things before we ship:\n- double check the rollback plan\n- make sure staging matches prod config' },

  /* ── code: Backticks und Codeblock, müssen als Platzhalter überleben ── */
  { kategorie: 'code', quelle: 'en', ziel: 'de',
    text: 'Can you check why `translate()` keeps returning `null` when the glossary is empty?' },
  { kategorie: 'code', quelle: 'de', ziel: 'en',
    text: 'Der Fehler steckt in diesem Block:\n```\nif (!opts.skipCache) {\n  const hot = memory.get(key);\n}\n```\nDer Cache wird nie invalidiert.' },
  { kategorie: 'code', quelle: 'en', ziel: 'de',
    text: 'Just run `npm run e2e` before you push, it catches most of this.' },

  /* ── erwaehnung: @Mentions, #Kanäle, Links, Produktname ──────────── */
  { kategorie: 'erwaehnung', quelle: 'de', ziel: 'en',
    text: '@sarah kannst du dir #deploy-log kurz anschauen? Da ist ein Fehler drin: https://example.com/logs/1234' },
  { kategorie: 'erwaehnung', quelle: 'en', ziel: 'de',
    text: '@don heads up, the release notes for Stellium are missing the fix from yesterday.' },
  { kategorie: 'erwaehnung', quelle: 'de', ziel: 'en',
    text: 'Schau mal in #allgemein, @team hat da eine Frage zu Stellium gestellt.' },

  /* ── emoji: müssen unverändert zurückkommen ──────────────────────── */
  { kategorie: 'emoji', quelle: 'de', ziel: 'en',
    text: 'Endlich fertig! 🎉 Danke für die Geduld 🙏' },
  { kategorie: 'emoji', quelle: 'en', ziel: 'de',
    text: 'Great work everyone 👏 let\'s ship it 🚀' },
  { kategorie: 'emoji', quelle: 'de', ziel: 'en',
    text: 'Kaffee ist alle ☕😩 wer macht neuen' },

  /* ── Nebenrichtungen: bereits in echo-pruefen.mjs als real geprüft geführt ── */
  { kategorie: 'umgangssprache-roh', quelle: 'en', ziel: 'tr',
    text: 'yeah nah im gonna push it later tonight dont worry about it' },
  { kategorie: 'umgangssprache-sauber', quelle: 'en', ziel: 'tr',
    text: 'Can you check the logs when you get a chance?' },
  { kategorie: 'kurz', quelle: 'en', ziel: 'tr', text: 'the deploy is done, everything looks fine' },
  { kategorie: 'umgangssprache-roh', quelle: 'de', ziel: 'fr',
    text: 'ja ne komm ich mach das heute abend noch mach dir keinen kopf' },
  { kategorie: 'umgangssprache-sauber', quelle: 'de', ziel: 'fr',
    text: 'Kannst du kurz draufschauen, wenn du Zeit hast?' },
  { kategorie: 'technisch', quelle: 'de', ziel: 'fr',
    text: 'die Migration ist durchgelaufen, alles läuft wieder' },
];

/**
 * Korpus für den Kontext-Vergleich in scripts/uebersetzung-messen.mjs
 * (Abschnitt "Kontext-Vergleich").
 *
 * WOHER
 *
 * Ausgangspunkt ist der gemeldete Fehlerfall des Auftraggebers, wortgleich
 * aus dem Auftrag übernommen (erster Fall unten): "mache ich kein problem"
 * als Antwort auf "kannst du das machen?" kam als "I'm not making a
 * problem" an — eine Verneinung statt der gemeinten Zusage ("Will do, no
 * problem."). Reproduziert an qwen3-8b vor jeder Änderung, deterministisch
 * bei temperature 0 über mehrere Läufe.
 *
 * Jeder Fall trägt `vorher` — ein bis zwei vorangegangene Nachrichten aus
 * demselben Gespräch, im selben Format (`{ wer, text }`), das
 * translation/verlauf.ts (verlaufAlsKontext) und damit translateMessage() im
 * Betrieb tatsächlich zusammensetzen. Der Prüflauf misst zwei Varianten pro
 * Fall: `ohne` (kein Kontext — der Zustand vor dieser Änderung: channel-
 * Context() aus ws/gateway.ts lieferte nie eine vorherige Nachricht, ist für
 * diese Messung also gleichbedeutend mit "kein Kontext") und `mit`
 * (Kontext = verlaufAlsKontext(vorher)).
 *
 * `erwartet`/`verboten` — Muster wie in postantwort-korpus.mjs, hier gegen
 * die ÜBERSETZTE Ausgabe geprüft (nicht gegen den Rohtext), nur für die
 * Fälle, wo Deutsch oder Englisch die Zielsprache ist: dort allein reicht
 * das Vokabular-Vertrauen für eine automatische Prüfung, dieselbe Grenze wie
 * bei FOERMLICH_MARKER/JARGON_MARKER weiter oben in uebersetzung-messen.mjs.
 * Leere Arrays heißen: nur beobachten, nicht automatisch werten (Sarkasmus-
 * und Fremdsprachen-Fälle unten) — echte Zurückhaltung statt einer Prüfung,
 * die nur so tut, als könnte sie etwas beurteilen.
 */
export const KONTEXT_KORPUS = [
  /* ── Der gemeldete Fall, wortgleich ──────────────────────────────── */
  {
    name: 'Auftraggeber-Beispiel: Zusage ohne Komma',
    kategorie: 'kontext-zusage', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Anna', text: 'kannst du das machen?' }],
    text: 'mache ich kein problem',
    erwartet: [/\b(will do|i(?:'| a)?ll (?:do|take care of|handle|get)|sure|no problem|of course|got it|on it)\b/i],
    verboten: [/i(?:'m| am) not (?:making|doing|causing|creating)/i],
  },
  /* Naher Verwandter desselben Musters, andere Wortwahl — prüft, ob der
     Effekt am Wortlaut "kein Problem" hängt oder wirklich am Satzbau. */
  {
    name: 'Naher Verwandter: Zusage mit "kein Ding"',
    kategorie: 'kontext-zusage', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Ben', text: 'schaffst du das heute noch?' }],
    text: 'mach ich kein ding',
    /* "i(?:'| a)?ll (?:do|...)" allein hätte "I'll do NOTHING about it" fälschlich
       bestehen lassen — genau so real beobachtet (Bericht). Deshalb hier per
       Wortgrenze auf "do" ohne folgendes "nothing" eingeschränkt, und dieselbe
       Formulierung zusätzlich unten in `verboten` ausdrücklich verboten, statt
       sich allein auf die (löchrige) Erlaubnisliste zu verlassen. */
    erwartet: [/\b(will do|i(?:'| a)?ll (?:do(?! nothing)|take care of|handle|get)|sure|no big deal|no problem|of course|got it|on it)\b/i],
    verboten: [/i(?:'m| am) not (?:making|doing|causing|creating)/i, /\b(?:i(?:'| a)?ll do nothing|nothing about it)\b/i],
  },

  /* ── weitere Zusage-Floskeln ──────────────────────────────────────── */
  {
    name: 'geht klar — Zusage zu einer Bitte',
    kategorie: 'kontext-zusage', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Ben', text: 'kannst du die rechnung heute noch schreiben' }],
    text: 'geht klar',
    erwartet: [/\b(will do|sure|on it|got it|no problem|of course|i(?:'| a)?ll)\b/i],
    verboten: [],
  },
  {
    name: 'passt schon, kein stress — Beruhigung nach Entschuldigung',
    kategorie: 'kontext-zusage', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Mara', text: 'sorry, ich bin etwas später dran' }],
    text: 'passt schon kein stress',
    erwartet: [/\b(no (?:stress|worries|problem|rush)|it'?s fine|all good|take your time)\b/i],
    verboten: [/\bstressed?\b|\bstressful\b/i],
  },

  /* ── Absage-Floskeln — dieselbe Kürze, umgekehrte Bedeutung ─────────── */
  {
    name: 'lass mal lieber — Absage zu einem Vorschlag',
    kategorie: 'kontext-absage', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Tom', text: 'sollen wir das jetzt gleich live schalten' }],
    text: 'lass mal lieber',
    erwartet: [/\b(let'?s not|rather not|better not|hold off|not (?:yet|now))\b/i],
    verboten: [/\blet'?s do it\b|\bsure,? let'?s\b|\byes,? let'?s\b/i],
  },
  {
    name: 'schaff ich heute nicht mehr — Absage mit Zeitangabe',
    kategorie: 'kontext-absage', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Nils', text: 'kannst du den Bericht noch heute fertig machen' }],
    text: 'schaff ich heute nicht mehr',
    erwartet: [/\b(can'?t|won'?t|not (?:going to|able to)|not\b.*today|no longer.*today)\b/i],
    verboten: [/\bsure\b|\bwill do\b|\bno problem\b/i],
  },

  /* ── deutsche Partikeln (doch, mal, halt, eh) ───────────────────────── */
  {
    name: 'Partikel "doch" — Ermutigung',
    kategorie: 'kontext-partikel', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Jo', text: 'ich weiß nicht ob ich das anfassen soll' }],
    text: 'mach das doch einfach',
    erwartet: [/\bjust (?:do it|go for it|try it)\b/i],
    verboten: [],
  },
  {
    name: 'Partikel "halt" — resignierte Feststellung',
    kategorie: 'kontext-partikel', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Lea', text: 'der Server ist wieder down' }],
    text: 'ist halt so',
    /* "it'?s just how it is" ergänzt: gemessen (Bericht) traf die engere
       Fassung "that's just how it is" eine tatsächlich richtige Übersetzung
       nicht, nur weil "it's" statt "that's" davorstand. */
    erwartet: [/\b((?:that'?s|it'?s) just how it is|it is what it is|(?:that'?s|it'?s) just the way|can'?t be helped)\b/i],
    verboten: [],
  },
  {
    name: 'Partikel "eh" — Zusage, die ohnehin schon feststand',
    kategorie: 'kontext-partikel', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Sam', text: 'kannst du das noch übernehmen' }],
    text: 'wollte ich eh machen',
    erwartet: [/\b(anyway|going to.*anyway|was (?:going|planning) to)\b/i],
    verboten: [],
  },

  /* ── dieselbe Kurzantwort, zwei Kontexte, zwei richtige Übersetzungen —
     der schärfste Test: ändert der Kontext wirklich die Deutung, oder klingt
     nur die Übersetzung allgemein etwas glatter? ────────────────────────── */
  {
    name: '"geht klar" nach einer Bitte (Aufgaben-Zusage)',
    kategorie: 'kontext-doppeldeutig', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Ben', text: 'kannst du das bis morgen früh fertig machen' }],
    text: 'geht klar',
    erwartet: [/\b(will do|sure|on it|got it|no problem|i(?:'| a)?ll)\b/i],
    verboten: [],
  },
  {
    name: '"geht klar" nach einer Nachfrage zum Befinden (Status, keine Aufgabe)',
    kategorie: 'kontext-doppeldeutig', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Ben', text: 'ist bei dir gerade alles okay' }],
    text: 'geht klar',
    erwartet: [/\b(i'?m (?:good|fine|okay|alright)|all good|doing (?:fine|okay|well))\b/i],
    verboten: [/\bwill do\b|\bon it\b|\bgot it\b/i],
  },

  /* ── Sarkasmus — bewusst ohne erwartet/verboten: bekannt schwer, wird nur
     beobachtet und im Bericht im Wortlaut ausgegeben, nicht automatisch
     wie ein Bestehen/Durchfallen gewertet. ───────────────────────────────── */
  {
    name: 'Sarkasmus nach einem Fehler (nur Beobachtung)',
    kategorie: 'kontext-sarkasmus', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Kim', text: 'ich hab aus Versehen die prod datenbank gelöscht' }],
    text: 'ja klar, sehr professionell',
    erwartet: [], verboten: [],
  },

  /* ── bekannte Grenze: die Bitte liegt nicht unmittelbar davor ────────────
     Gemessen (Bericht): mit ALLEN drei vorherigen Zeilen bleibt dieser Fall
     falsch — dieselbe Verneinung wie im Auftraggeber-Fall. Die eigentliche
     Bitte ("kannst du dich um das Ticket kümmern") liegt zwei Redebeiträge
     vor der Antwort, dazwischen eine Rückfrage und eine Klärung; ein 8B-
     Modell verknüpft das offenbar nicht zuverlässig über zwei Züge hinweg.
     Bewusst im Korpus belassen statt entfernt: eine ehrliche Messung zeigt
     auch, was NICHT behoben ist (siehe Auftrag). `erwartet` trägt die
     tatsächlich richtige Deutung — dieser Fall SOLL heute durchfallen. */
  {
    name: 'Mehrstufig: Bitte liegt zwei Züge zurück (bekannte Grenze)',
    kategorie: 'kontext-mehrstufig', quelle: 'de', ziel: 'en',
    vorher: [
      { wer: 'Anna', text: 'kannst du dich um das kundenticket 4521 kümmern' },
      { wer: 'Ben', text: 'welches nochmal' },
      { wer: 'Anna', text: 'das mit der rechnung' },
    ],
    text: 'mache ich kein problem',
    erwartet: [/\b(will do|i(?:'| a)?ll (?:do(?! nothing)|take care of|handle|get)|sure|no problem|of course|got it|on it)\b/i],
    verboten: [/i(?:'m| am) not (?:making|doing|causing|creating)/i],
  },

  /* ── Stichprobe andere Sprachpaare — nur Beobachtung, siehe Kommentar oben ── */
  {
    name: 'Stichprobe en→tr mit Kontext (nur Beobachtung)',
    kategorie: 'kontext-zusage', quelle: 'en', ziel: 'tr',
    vorher: [{ wer: 'Ayse', text: 'sorry I broke the build again' }],
    text: 'sure, no worries',
    erwartet: [], verboten: [],
  },
  {
    name: 'Stichprobe de→fr mit Kontext (nur Beobachtung)',
    kategorie: 'kontext-zusage', quelle: 'de', ziel: 'fr',
    vorher: [{ wer: 'Marie', text: 'kannst du das übernehmen' }],
    text: 'mach ich kein thema',
    erwartet: [], verboten: [],
  },
];

/**
 * Korpus für den Polaritäts-Vergleich in scripts/uebersetzung-messen.mjs
 * (Abschnitt "Polaritäts-Vergleich").
 *
 * WOHER
 *
 * Rückfrage der Koordination zu Beispiel 4 im ersten Bericht: "lass mal
 * lieber" (Absage) nach "sollen wir das jetzt gleich live schalten?" kam MIT
 * Kontext als "Let's just do it live" zurück — das Gegenteil der Absage,
 * nicht nur ein Ausrutscher im Ton. Frage: systematisch, oder ein Einzelfall
 * in einem 15 Fälle kleinen Korpus? Und: driftet das Modell einfach zur
 * Stimmung der vorherigen Nachricht, unabhängig davon, was die Antwort
 * selbst sagt (Hypothese der Koordination)?
 *
 * AUFBAU
 *
 *   ABSAGEN × ENTHUSIASTISCH  — 12 Absage-Floskeln, immer nach demselben
 *     Vorschlag wie im gemeldeten Fall. Die Haupt-Messung für die Frage
 *     "systematisch oder Einzelfall".
 *   ZUSAGEN × ENTHUSIASTISCH  — dieselben 12 Vorschläge, aber mit echten
 *     Zusage-Floskeln beantwortet. Spiegel-Menge: bleiben Zusagen stabil, ist
 *     das Problem absage-spezifisch, nicht ein allgemeines "Stimmung
 *     nachplappern".
 *   ABSAGEN/ZUSAGEN × NEUTRAL — Teilmenge (die ersten sechs Floskeln je
 *     Richtung) nach einem neutralen, nicht-enthusiastischen Vorschlag mit
 *     GLEICHER Bedeutung ("sollen wir das noch heute machen?" statt "...jetzt
 *     gleich live..."). Trennt "Kontext hilft/schadet grundsätzlich" von
 *     "Kontext schadet speziell bei Begeisterung in der vorherigen Zeile".
 *   MEHRDEUTIG — das bereits bewährte "geht klar"-Paar aus KONTEXT_KORPUS,
 *     hier mit denselben Wiederholungen erneut gemessen: Kontrolle, dass die
 *     Messmethode einen ECHTEN, gewollten Kontext-Effekt auch als solchen
 *     erkennt, statt bei jedem Kontext-Effekt "Alarm" zu schlagen.
 *
 * Jeder Fall trägt `erwartetePolaritaet` ('absage' | 'zusage') statt
 * einzeln ausformulierter erwartet/verboten-Muster — bei zwei klar
 * entgegengesetzten Bedeutungsrichtungen und vierunddreißig Fällen lohnt sich
 * ein gemeinsamer Klassifizierer (siehe AGREEMENT_MARKER/DECLINE_MARKER in
 * uebersetzung-messen.mjs) mehr als vierunddreißig einzelne Musterpaare.
 */

/** Kleiner Baustein, um die Wiederholung (Vorschlag, Sprachen, Polarität) nicht
 *  vierunddreißig Mal einzeln auszuschreiben — die Fälle selbst bleiben Daten,
 *  keine Funktion, jederzeit einzeln lesbar in POLARITAET_KORPUS unten. */
function polKorpus(vorher, texte, erwartetePolaritaet, gruppe) {
  return texte.map((text) => ({
    name: `${gruppe}: "${text}"`, gruppe, quelle: 'de', ziel: 'en', vorher, text, erwartetePolaritaet,
  }));
}

const VORSCHLAG_ENTHUSIASTISCH = [{ wer: 'Tom', text: 'sollen wir das jetzt gleich live schalten?' }];
const VORSCHLAG_NEUTRAL = [{ wer: 'Tom', text: 'sollen wir das noch heute machen?' }];

const ABSAGEN = [
  'lass mal lieber', 'lieber nicht', 'besser nicht', 'lass gut sein', 'eher nicht', 'würd ich lassen',
  'bloß nicht', 'nee lass mal', 'ich lass das lieber', 'lass es lieber', 'nee eher nicht',
  'lieber nicht würd ich sagen',
];
const ZUSAGEN = [
  'ja klar, lass uns', 'auf jeden fall', 'klar, machen wir', 'unbedingt', 'gerne', 'können wir machen',
  'bin dabei', 'na klar doch', 'ich bin dafür', 'machen wir\'s', 'na klar, auf jeden fall', 'klar würd ich sagen',
];

export const POLARITAET_KORPUS = [
  ...polKorpus(VORSCHLAG_ENTHUSIASTISCH, ABSAGEN, 'absage', 'absage-enthusiastisch'),
  ...polKorpus(VORSCHLAG_ENTHUSIASTISCH, ZUSAGEN, 'zusage', 'zusage-enthusiastisch'),
  ...polKorpus(VORSCHLAG_NEUTRAL, ABSAGEN.slice(0, 6), 'absage', 'absage-neutral'),
  ...polKorpus(VORSCHLAG_NEUTRAL, ZUSAGEN.slice(0, 6), 'zusage', 'zusage-neutral'),
];

/* Mehrdeutig-Kontrolle — dasselbe Paar wie in KONTEXT_KORPUS, hier erneut
   aufgeführt (nicht importiert), damit dieser Abschnitt für sich lauffähig
   bleibt und mit denselben Wiederholungen wie der Rest dieses Korpus läuft. */
export const POLARITAET_MEHRDEUTIG_KORPUS = [
  {
    name: 'mehrdeutig: "geht klar" nach Aufgaben-Bitte',
    gruppe: 'mehrdeutig', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Ben', text: 'kannst du das bis morgen früh fertig machen' }],
    text: 'geht klar',
    erwartet: [/\b(will do|sure|on it|got it|no problem|i(?:'| a)?ll)\b/i],
    verboten: [],
  },
  {
    name: 'mehrdeutig: "geht klar" nach Befindens-Nachfrage',
    gruppe: 'mehrdeutig', quelle: 'de', ziel: 'en',
    vorher: [{ wer: 'Ben', text: 'ist bei dir gerade alles okay' }],
    text: 'geht klar',
    erwartet: [/\b(i'?m (?:good|fine|okay|alright)|all good|doing (?:fine|okay|well))\b/i],
    verboten: [/\bwill do\b|\bon it\b|\bgot it\b/i],
  },
];

/**
 * EN→DE-Gegenstück zu POLARITAET_KORPUS — für die Koordinationsvorgabe
 * "Deutsch als Zielsprache validieren, dieselbe Sorgfalt wie bei Englisch".
 *
 * Die tatsächliche Nutzung: Deutsch↔Englisch in beiden Richtungen, eine
 * Person schreibt Deutsch, die andere Englisch. Deutsch→Englisch ist bereits
 * geprüft (POLARITAET_KORPUS, Zielsprache Englisch). Dies hier ist die
 * andere Richtung: eine englische Absage-/Zusage-Floskel, übersetzt ins
 * Deutsche, nach einem englischen Vorschlag — spiegelbildlich zum
 * Aufbau oben, nicht neu erfunden.
 */
const VORSCHLAG_ENTHUSIASTISCH_EN = [{ wer: 'Tom', text: 'should we push this live right now?' }];
const VORSCHLAG_NEUTRAL_EN = [{ wer: 'Tom', text: 'should we do this today?' }];

const ABSAGEN_EN = [
  "let's not", 'better not', "I'd rather not", "let's just leave it", "nah, I'll pass",
  "I wouldn't", 'not right now', "I'll skip this one", "I'd hold off", "let's leave it for now",
  'maybe not', "I don't think so",
];
const ZUSAGEN_EN = [
  "sure, let's do it", "yeah let's go", 'definitely', "I'm in", 'sounds good', "let's do this",
  'for sure', 'absolutely', "yeah, let's", 'count me in', "let's go for it", "I'm down",
];

export const POLARITAET_KORPUS_DE = [
  ...polKorpus(VORSCHLAG_ENTHUSIASTISCH_EN, ABSAGEN_EN, 'absage', 'absage-en-enthusiastisch').map((f) => ({ ...f, quelle: 'en', ziel: 'de' })),
  ...polKorpus(VORSCHLAG_ENTHUSIASTISCH_EN, ZUSAGEN_EN, 'zusage', 'zusage-en-enthusiastisch').map((f) => ({ ...f, quelle: 'en', ziel: 'de' })),
  ...polKorpus(VORSCHLAG_NEUTRAL_EN, ABSAGEN_EN.slice(0, 6), 'absage', 'absage-en-neutral').map((f) => ({ ...f, quelle: 'en', ziel: 'de' })),
  ...polKorpus(VORSCHLAG_NEUTRAL_EN, ZUSAGEN_EN.slice(0, 6), 'zusage', 'zusage-en-neutral').map((f) => ({ ...f, quelle: 'en', ziel: 'de' })),
];

/* Mehrdeutig-Kontrolle, spiegelbildlich: "will do" nach einer Aufgaben-Bitte
   vs. nach einer Befindens-Nachfrage — Deutsch als Zielsprache. */
export const POLARITAET_MEHRDEUTIG_KORPUS_DE = [
  {
    name: 'mehrdeutig (de): "sure thing" nach Aufgaben-Bitte',
    gruppe: 'mehrdeutig', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Ben', text: 'can you get this done by tomorrow morning' }],
    text: 'sure thing',
    erwartet: [/\b(mach ich|klar|kein problem|erledige ich|kümmere mich)\b/i],
    verboten: [],
  },
  {
    name: 'mehrdeutig (de): "sure thing" nach Befindens-Nachfrage',
    gruppe: 'mehrdeutig', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Ben', text: 'is everything okay with you right now' }],
    text: 'sure thing',
    erwartet: [/\b(alles (gut|klar|bestens)|passt (schon)?|mir geht'?s gut)\b/i],
    verboten: [/\bmach ich\b|\berledige ich\b/i],
  },
];

/**
 * EN→DE-Gegenstück zu KONTEXT_KORPUS — misst den NUTZEN von Kontext für
 * Deutsch als Zielsprache, nicht das Schadensrisiko (das ist
 * POLARITAET_KORPUS_DE). Rückfrage der Koordination: "du hast die
 * Abwesenheit von Schaden gemessen, nicht die Anwesenheit von Nutzen."
 *
 * Dieselbe Bauart wie KONTEXT_KORPUS (Runde 1, Deutsch→Englisch): englische
 * Alltagsfloskeln, die ohne den vorherigen Satz mehrdeutig sind — und mit
 * ihm eindeutig. `erwartet`/`verboten` sind auf die deutsche Ausgabe
 * gemünzt, keine erfundenen Wortlisten, sondern das, was eine richtige
 * bzw. eine falsche Deutung tatsächlich sagen würde.
 */
export const KONTEXT_KORPUS_DE = [
  /* ── Flaggschiff-Paar: derselbe englische Text, zwei Kontexte, zwei
     richtige deutsche Übersetzungen — derselbe schärfste Test wie
     "geht klar" in Runde 1. ─────────────────────────────────────────── */
  {
    name: '"I\'m good" nach einem Angebot (Ablehnung, keine Befindensauskunft)',
    kategorie: 'kontext-de-mehrdeutig', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Anna', text: 'want me to grab you a coffee?' }],
    text: "I'm good",
    erwartet: [/\b(schon versorgt|brauch(?:e)? (?:ich )?nicht|nein,? danke|ist gut so|bin schon|passt schon|muss nicht)\b/i],
    verboten: [/\b(mir geht'?s gut|es geht mir gut|geht mir gut)\b/i],
  },
  {
    name: '"I\'m good" nach einer Befindens-Nachfrage (Auskunft, keine Ablehnung)',
    kategorie: 'kontext-de-mehrdeutig', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Anna', text: 'you doing okay after yesterday?' }],
    text: "I'm good",
    erwartet: [/\b(mir geht'?s gut|es geht mir gut|geht mir gut|alles gut(?:,| )bei mir|passt (?:alles|schon))\b/i],
    verboten: [/\b(brauch(?:e)? (?:ich )?nicht|schon versorgt)\b/i],
  },

  /* ── Idiom, das wörtlich genommen die falsche Zeitrichtung/Bedeutung
     ergibt, wenn es niemand als Redewendung erkennt. ──────────────────── */
  {
    name: '"you got it" — Zusage, kein Aussagesatz über einen Erhalt',
    kategorie: 'kontext-de-idiom', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Ben', text: 'can you send that file over by end of day?' }],
    text: 'you got it',
    erwartet: [/\b(mach ich|kriegst du|bekommst du|kein problem|klar,? mach ich|erledige ich)\b/i],
    verboten: [/\bdu hast es (?:bekommen|erhalten)\b/i],
  },

  /* ── Zusage-Idiom zu einem konkreten Vorschlag ───────────────────────── */
  {
    name: '"that works" — Zusage zu einem Terminvorschlag',
    kategorie: 'kontext-de-zusage', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Tom', text: 'should we meet at 3?' }],
    text: 'that works',
    erwartet: [/\b(passt|funktioniert|klingt gut|geht klar|geht (?:für mich|bei mir))\b/i],
    verboten: [],
  },

  /* ── Beruhigung nach einer Entschuldigung ────────────────────────────── */
  {
    name: '"no worries" — Beruhigung, keine Aussage über Sorgen',
    kategorie: 'kontext-de-zusage', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Mara', text: "sorry I'm running a few minutes late" }],
    text: 'no worries',
    erwartet: [/\b(kein problem|alles (?:klar|gut)|kein stress|macht nichts|halb so schlimm)\b/i],
    verboten: [],
  },

  /* ── vage, absichtlich ohne erwartet/verboten: Kontrolle, dass Kontext
     eine echt unentschiedene Antwort nicht zu einer erfundenen Festlegung
     verengt. ───────────────────────────────────────────────────────────── */
  {
    name: '"eh, maybe" — vage bleibt vage (Beobachtung)',
    kategorie: 'kontext-de-vage', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Kim', text: 'are you coming to the offsite next month?' }],
    text: 'eh, maybe',
    erwartet: [], verboten: [],
  },

  /* ── Ablehnung mit höflichem Register — Kontext darf die Höflichkeit
     nicht wegübersetzen. ───────────────────────────────────────────────── */
  {
    name: "\"I'd rather not, if that's alright\" — höfliche Absage",
    kategorie: 'kontext-de-absage', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Sam', text: 'would you be up for presenting this one to the client?' }],
    text: "I'd rather not, if that's alright",
    erwartet: [/\b(lieber nicht|würde (?:ich )?lieber nicht|eher nicht)\b/i],
    verboten: [/\b(mach ich|klar,? gerne)\b/i],
  },

  /* ── Register-Kontrolle: sehr locker, ohne Satzzeichen — darf mit Kontext
     nicht förmlicher werden. ───────────────────────────────────────────── */
  {
    name: 'Register-Kontrolle: sehr locker bleibt locker',
    kategorie: 'kontext-de-register', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Sam', text: 'hey are you around later today' }],
    text: 'lemme know when ur free, no rush',
    erwartet: [],
    verboten: [/\b(bitte teilen sie mir mit|sehr geehrte|würden sie mir freundlicherweise)\b/i],
  },

  /* ── Sarkasmus, bewusst nur Beobachtung. ──────────────────────────────── */
  {
    name: 'Sarkasmus nach einer schlechten Nachricht (Beobachtung)',
    kategorie: 'kontext-de-sarkasmus', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Kim', text: 'the client just doubled the scope with the same deadline' }],
    text: 'oh great, love that for us',
    erwartet: [], verboten: [],
  },

  /* ── neutraler Fall, ehrlich als "ändert nichts" erwartet ─────────────── */
  {
    name: 'Bereits eindeutig — Kontext soll (und darf) nichts ändern',
    kategorie: 'kontext-de-neutral', quelle: 'en', ziel: 'de',
    vorher: [{ wer: 'Ben', text: 'should we ship the update tonight?' }],
    text: 'sounds great, see you then',
    erwartet: [/\b(klingt (?:gut|super|great)|hört sich gut an)\b/i],
    verboten: [],
  },
];
