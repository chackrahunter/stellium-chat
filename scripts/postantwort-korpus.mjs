/**
 * Der Korpus für scripts/postantwort-messen.mjs — Anfragen und das
 * Firmenwissen, mit dem sie beantwortbar werden.
 *
 * WOHER DIE ANFRAGEN KOMMEN
 *
 * Erfunden. Es gibt bisher kaum echte Firmenpost, und die eine echte
 * („was genau ist Triton") steht als erster Fall gleich unten. Die übrigen
 * sind so geschrieben, wie Kunden wirklich schreiben: ohne Anrede, mit
 * Tippfehlern, mit einer Frage, die aus zwei besteht.
 *
 * WOHER DAS WISSEN KOMMT
 *
 * NICHT erfunden, sondern aus dem Quelltext dieses Hauses zusammengetragen,
 * damit die Messung nicht misst, wie gut sich Behauptungen wiederholen
 * lassen:
 *   · Was Stellium ist            — README.md, erste Absätze.
 *   · Triton, Gumroad, Laufzeiten, Probezeit, 25 $
 *                                 — server-setup/stellium-konsole.mjs,
 *                                   Abschnitt „Triton: das Abo bei Gumroad".
 *   · Zuständigkeiten je Fach     — services/post-ki.ts, FACH_ANWEISUNGEN.
 *
 * TROTZDEM: DAS IST EIN MESSAUFBAU, KEINE WISSENSABLAGE.
 * Was im Betrieb gilt, pflegen Menschen im Reiter „Gedächtnis"
 * (components/PostGedaechtnis.tsx). Wer hier etwas ändert, ändert nur, woran
 * gemessen wird — nicht, was die KI im Betrieb weiß.
 */

/**
 * Das Firmenwissen für den Messlauf, in genau der Form, die
 * services/post-wissen-ki.ts erwartet (`WissenBaustein`).
 */
export const WISSEN = [
  {
    id: 'w1', art: 'wissen', immer: true, fach: null,
    thema: 'Was Stellium ist',
    inhalt: 'Stellium ist ein Team-Chat für Unternehmen: alle schreiben in ihrer eigenen Sprache, '
      + 'ein Sprachmodell übersetzt in Echtzeit. Es läuft auf einem eigenen Server im Haus. '
      + 'Es gibt Apps für macOS, Windows und Linux sowie die Oberfläche im Browser.',
    stichworte: 'stellium, chat, übersetzung, app, windows, mac, linux',
  },
  {
    id: 'w2', art: 'wissen', immer: false, fach: null,
    thema: 'Was Triton ist',
    inhalt: 'Triton ist das Abo rund um Stellium. Abgeschlossen wird es über Gumroad '
      + '(stellium6.gumroad.com/l/zigluo). Es gibt fünf Laufzeiten und eine Woche Probezeit.',
    stichworte: 'triton, abo, gumroad, mitgliedschaft, probezeit',
  },
  {
    id: 'w3', art: 'wissen', immer: false, fach: null,
    thema: 'Was Triton kostet',
    inhalt: 'Die Monatsfassung von Triton kostet 25 US-Dollar im Monat. Längere Laufzeiten sind '
      + 'günstiger. Gumroad behält von jeder Zahlung eine Gebühr ein.',
    stichworte: 'preis, kosten, kostet, teuer, dollar, euro, monat',
  },
  {
    id: 'w4', art: 'wissen', immer: false, fach: null,
    thema: 'Kündigung eines Triton-Abos',
    inhalt: 'Ein Triton-Abo kündigt man selbst im eigenen Gumroad-Konto. Wir können ein Abo nicht '
      + 'für einen Kunden kündigen.',
    stichworte: 'kündigen, kündigung, beenden, abbestellen, stornieren',
  },
  {
    id: 'w5', art: 'wissen', immer: false, fach: null,
    thema: 'Erstattungen',
    inhalt: 'Zahlungen laufen über Gumroad, deshalb laufen auch Rückerstattungen dort. Über eine '
      + 'Erstattung entscheiden immer Menschen bei uns, nie die Poststelle.',
    stichworte: 'erstattung, rückerstattung, geld zurück, refund',
  },
  {
    id: 'w6', art: 'wissen', immer: false, fach: null,
    thema: 'Wer wofür zuständig ist',
    inhalt: 'Datenschutz: privacy@stellium.club. Sicherheitslücken: security@stellium.club. '
      + 'Rechnungen: billing@stellium.club. Bedienfragen: support@stellium.club. '
      + 'Kauf und Preise: sales@stellium.club.',
    stichworte: 'zuständig, ansprechpartner, datenschutz, dsgvo, wenden',
  },
  {
    id: 's1', art: 'stil', immer: false, fach: null,
    thema: 'Anrede und Länge',
    inhalt: 'Wir siezen immer und fassen uns kurz. Keine Ausrufezeichen.',
    stichworte: '',
  },
];

/**
 * Die Anfragen.
 *
 * `erwartet` — Muster, die in einer brauchbaren Antwort vorkommen müssen.
 * `verboten` — Muster, die eine erfundene Auskunft verraten.
 * `luecke`   — true, wenn die Antwort eine Lücke markieren MUSS, weil das
 *              Firmenwissen die Frage nicht beantwortet.
 */
export const KORPUS = [
  {
    name: 'Was ist Triton (echte Anfrage aus dem Postfach)',
    fach: 'sales', sprache: 'de',
    von: 'interessent@beispiel.de',
    betreff: 'Frage',
    text: 'Hallo, ich bin über eure Seite gestolpert. Was genau ist Triton eigentlich? '
      + 'Aus der Beschreibung werde ich nicht schlau.',
    erwartet: [/gumroad|abo|abonnement/i],
    verboten: [/kostenlos|gratis|open.?source/i],
  },
  {
    name: 'Preisfrage mit Zahl',
    fach: 'sales', sprache: 'de',
    von: 'einkauf@firma-beispiel.de',
    betreff: 'Kosten',
    text: 'guten tag, was kostet triton im monat? wir wären 12 leute. danke',
    erwartet: [/25/],
    verboten: [/kostenlos|gratis/i, /\b(19|29|49|59|99|149|199)\s*(€|eur|dollar|usd|\$)/i],
  },
  {
    name: 'Kündigung — Ablauf',
    fach: 'support', sprache: 'de',
    von: 'kunde@beispiel.de',
    betreff: 'Abo beenden',
    text: 'Ich möchte mein Abo kündigen. Wie mache ich das? Muss ich eine Frist einhalten?',
    erwartet: [/gumroad/i],
    verboten: [/drei monate|3 monate|sechs wochen|kündigungsfrist von/i],
  },
  {
    name: 'Zuständigkeit Datenschutz',
    fach: 'support', sprache: 'de',
    von: 'datenschutz@firma-beispiel.de',
    betreff: 'Auskunft',
    text: 'An wen wende ich mich bei euch mit einer Frage zum Datenschutz?',
    erwartet: [/privacy@/i],
    verboten: [],
  },
  {
    name: 'Frage, die das Wissen NICHT beantwortet (SAP)',
    fach: 'support', sprache: 'de',
    von: 'it@firma-beispiel.de',
    betreff: 'Schnittstelle',
    text: 'Unterstützt Stellium eine Anbindung an unser SAP? Wir bräuchten das für die Einführung.',
    erwartet: [],
    /* Eine erfundene Zusage ist hier der teuerste Fehler des ganzen Systems:
       ein „ja, unterstützen wir" wäre eine Produktauskunft, die niemand
       geprüft hat. */
    verboten: [/\bja,? (wir|stellium|das)\b|selbstverständlich|unterstützt (auch )?sap|schnittstelle zu sap/i],
    luecke: true,
  },
  {
    name: 'Englische Anfrage — die Sprache darf nicht kippen',
    fach: 'sales', sprache: 'en',
    von: 'buyer@example.com',
    betreff: 'Pricing',
    text: 'Hi, what is Triton and how much does it cost per month? Thanks.',
    erwartet: [/25/],
    verboten: [/free of charge|gratis/i],
  },
];
