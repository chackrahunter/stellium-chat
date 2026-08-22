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
