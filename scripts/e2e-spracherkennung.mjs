/**
 * Erkennt der Server die Sprache einer Nachricht richtig — und schweigt er,
 * wenn er es nicht weiss?
 *
 * Anlass waren zwei Meldungen aus dem Betrieb. Erst galt „Was meinst du?" als
 * Englisch, dann ein englischer Satz als Polnisch. Beide Male dieselbe
 * Gattung: ein haeufiges Wort stand in der Liste einer fremden Sprache und
 * fehlte in der eigenen. „was" hatte nur Englisch, „to" nur Polnisch, „no" nur
 * Spanisch — und ein kurzer Satz, dessen einziges Stoppwort so ein Wort war,
 * kippte samt hoher Sicherheit in die falsche Sprache.
 *
 * Der Lauf prueft deshalb dreierlei:
 *
 *   Korpus       Saetze in allen 22 Sprachen. Keine darf falsch herauskommen.
 *   Rueckhalt    Ein zweiter Satz Beispiele, der beim Bauen der Wortlisten
 *                nicht benutzt wurde — sonst misst man nur sich selbst.
 *   Fallgruben   Die gemeldeten Saetze, wortgenau.
 *
 * „Offen" ist kein Fehler: unterhalb der Schwelle traegt der Server gar keine
 * Sprache ein, und keine Angabe ist ehrlicher als eine falsche.
 *
 * Laeuft ohne Server und ohne Browser — reine Rechenarbeit.
 */
import { detectLanguage } from '../packages/shared/dist/index.js';

/** Ab hier traegt der Server die Sprache ein (services/messages.ts). */
const SCHWELLE = 0.35;

const ergebnisse = [];
const pruefe = (n, f) => {
  try { const x = f(); ergebnisse.push(1); console.log(`  \u2713 ${n}${x ? ` \u2014 ${x}` : ''}`); }
  catch (e) { ergebnisse.push(0); console.log(`  \u2717 ${n} \u2014 ${e.message}`); }
};
const muss = (b, m) => { if (!b) throw new Error(m); };

/* Saetze, wie sie im Chat vorkommen: kurz, oft ohne Satzzeichen. Genau daran
   scheitert die Erkennung, nicht an Absaetzen aus der Zeitung. */
const KORPUS = {
    de: [
      "Was meinst du?", "Wie sieht es aus?", "Passt das so?", "Kannst du das kurz prüfen?", "Wann treffen wir uns?",
      "Ich schaue mir das morgen an.", "Danke dir!", "Hast du kurz Zeit?", "Das Ergebnis liegt jetzt vor.",
      "Wer macht das?", "Warum geht das nicht?", "Alles klar bei dir?", "Wo finde ich die Datei?", "Kein Problem",
      "Ich melde mich später", "das passt so für mich"
    ],
    en: [
      "What do you think?", "How does it look?", "Can you check this quickly?", "When are we meeting?",
      "I will look at it tomorrow.", "Thanks a lot!", "Do you have a minute?", "The result is ready now.",
      "Who is doing this?", "Why does this not work?", "I have attached the draft.", "Where can I find the file?",
      "No problem", "I want to know", "sounds good to me", "happy to simplify it",
      "make it simpler to streamline everything", "feel free to make it simpler", "we need to ship it",
      "let me know when you are done"
    ],
    fr: [
      "Que penses-tu ?", "Peux-tu vérifier cela ?", "Quand nous voyons-nous ?", "Merci beaucoup !", "Bonjour à tous",
      "Je vais regarder demain.", "Il n'y a pas de problème", "C'est très bien comme ça"
    ],
    es: [
      "¿Qué piensas?", "¿Puedes revisar esto?", "¿Cuándo nos vemos?", "Muchas gracias", "Hola a todos",
      "El resultado ya está listo.", "No hay problema", "Me parece muy bien"
    ],
    it: [
      "Che ne pensi?", "Puoi controllare questo?", "Quando ci vediamo?", "Grazie mille", "Ciao a tutti",
      "Il risultato è pronto.", "Non c'è problema", "Va benissimo così"
    ],
    pt: [
      "O que você acha?", "Você pode verificar isso?", "Quando nos vemos?", "Muito obrigado", "Olá a todos",
      "O resultado está pronto.", "Não tem problema", "Para mim está bom"
    ],
    nl: [
      "Wat denk je?", "Kun je dit controleren?", "Wanneer zien we elkaar?", "Hartelijk bedankt", "Hallo allemaal",
      "Het resultaat is klaar.", "Geen probleem", "Dat is goed zo"
    ],
    pl: [
      "Co o tym myślisz?", "Czy możesz to sprawdzić?", "Dziękuję bardzo", "Dzień dobry wszystkim", "Nie ma problemu",
      "To jest dobre", "Kiedy się spotykamy?"
    ],
    cs: [
      "Co si o tom myslíš?", "Děkuji moc", "Ahoj všem", "Můžeš to zkontrolovat?", "Není problém", "Kdy se sejdeme?"
    ],
    ro: [
      "Ce părere ai?", "Poți să verifici asta?", "Mulțumesc mult", "Bună ziua tuturor", "Nicio problemă",
      "Când ne vedem?"
    ],
    tr: [
      "Ne düşünüyorsun?", "Bunu kontrol edebilir misin?", "Çok teşekkür ederim", "Herkese merhaba", "Sorun değil",
      "Ne zaman görüşüyoruz?"
    ],
    sv: [
      "Vad tycker du?", "Kan du kolla det här?", "Tack så mycket", "Hej allihopa", "När ses vi?", "Hur ser det ut?",
      "Inga problem"
    ],
    da: ["Hvad synes du?", "Kan du tjekke det?", "Mange tak", "Hej med jer", "Hvornår ses vi?", "Intet problem"],
    no: ["Hva synes du?", "Kan du sjekke det?", "Tusen takk", "Hei alle sammen", "Når ses vi?", "Ingen problemer"],
    fi: [
      "Mitä mieltä olet?", "Voitko tarkistaa tämän?", "Kiitos paljon", "Hei kaikille", "Ei ongelmaa",
      "Milloin tapaamme?"
    ],
    ru: ["Что ты думаешь?", "Спасибо большое", "Привет всем", "Можешь это проверить?", "Нет проблем"],
    uk: ["Що ти думаєш?", "Дякую дуже", "Привіт усім", "Можеш це перевірити?", "Немає проблем"],
    ar: ["ما رأيك؟", "شكرا جزيلا", "مرحبا بالجميع", "هل يمكنك التحقق من هذا؟"],
    hi: ["आपका क्या ख्याल है?", "बहुत धन्यवाद", "सभी को नमस्ते", "क्या आप इसे जांच सकते हैं?"],
    zh: ["你觉得怎么样？", "非常感谢", "大家好", "你能检查一下吗？"],
    ja: ["どう思いますか？", "ありがとうございます", "皆さんこんにちは", "これを確認できますか？"],
    ko: ["어떻게 생각하세요?", "정말 감사합니다", "여러분 안녕하세요", "이것을 확인해 주시겠어요?"],};

/* Beim Abstimmen der Wortlisten bewusst nicht angesehen. Ein Korpus, an dem
   man entwickelt hat, sagt nur, dass man ihn auswendig gelernt hat. */
const RUECKHALT = {
    de: [
      "Ich bin gleich zurück", "Können wir das verschieben?", "Der Termin steht", "Habe ich dir schon geschickt",
      "Das dauert noch etwas", "Lass uns kurz telefonieren", "Klingt gut", "Ich verstehe das nicht ganz"
    ],
    en: [
      "I am back in five minutes", "Can we move the meeting?", "The date is confirmed", "Already sent it over",
      "This will take a while", "Let us jump on a call", "Sounds good", "I do not quite get this",
      "please take a look at it", "it should be ready by friday"
    ],
    fr: [
      "Je reviens dans cinq minutes", "On peut décaler la réunion ?", "La date est confirmée",
      "Je te l'ai déjà envoyé", "Ça sonne bien", "Je ne comprends pas très bien"
    ],
    es: [
      "Vuelvo en cinco minutos", "¿Podemos mover la reunión?", "La fecha está confirmada", "Ya te lo he enviado",
      "Suena bien", "No lo entiendo del todo"
    ],
    it: [
      "Torno tra cinque minuti", "Possiamo spostare la riunione?", "La data è confermata", "Te l'ho già mandato",
      "Mi sembra buono", "Non ho capito bene"
    ],
    pt: [
      "Volto em cinco minutos", "Podemos adiar a reunião?", "A data está confirmada", "Já te enviei", "Parece bom",
      "Não entendi muito bem"
    ],
    nl: [
      "Ik ben zo terug", "Kunnen we de vergadering verzetten?", "De datum staat vast", "Heb ik je al gestuurd",
      "Klinkt goed", "Dat begrijp ik niet helemaal"
    ],
    pl: [
      "Zaraz wracam", "Czy możemy przełożyć spotkanie?", "Termin jest ustalony", "Już ci wysłałem", "Brzmi dobrze",
      "Nie rozumiem tego"
    ],
    cs: [
      "Hned jsem zpátky", "Můžeme přesunout schůzku?", "Termín je potvrzen", "Už jsem ti to poslal", "Zní to dobře",
      "Tomu nerozumím"
    ],
    ro: [
      "Mă întorc imediat", "Putem muta întâlnirea?", "Data este confirmată", "Ți-am trimis deja", "Sună bine",
      "Nu înțeleg prea bine"
    ],
    tr: [
      "Hemen döneceğim", "Toplantıyı erteleyebilir miyiz?", "Tarih kesinleşti", "Sana zaten gönderdim",
      "Kulağa iyi geliyor", "Bunu tam anlamadım"
    ],
    sv: [
      "Jag är strax tillbaka", "Kan vi flytta mötet?", "Datumet är bekräftat", "Jag har redan skickat det",
      "Låter bra", "Jag förstår inte riktigt"
    ],
    da: [
      "Jeg er straks tilbage", "Kan vi flytte mødet?", "Datoen er bekræftet", "Jeg har allerede sendt det",
      "Lyder godt", "Det forstår jeg ikke helt"
    ],
    no: [
      "Jeg er straks tilbake", "Kan vi flytte møtet?", "Datoen er bekreftet", "Jeg har allerede sendt det",
      "Høres bra ut", "Det forstår jeg ikke helt"
    ],
    fi: [
      "Palaan pian", "Voimmeko siirtää kokousta?", "Päivämäärä on vahvistettu", "Lähetin sen jo",
      "Kuulostaa hyvältä", "En ihan ymmärrä tätä"
    ],
    ru: ["Я скоро вернусь", "Можем перенести встречу?", "Дата подтверждена", "Я уже отправил", "Звучит хорошо"],
    uk: ["Я скоро повернуся", "Можемо перенести зустріч?", "Дата підтверджена", "Я вже надіслав", "Звучить добре"],
    ar: ["سأعود بعد قليل", "هل يمكننا تأجيل الاجتماع؟", "تم تأكيد الموعد"],
    hi: ["मैं अभी वापस आता हूँ", "क्या हम बैठक टाल सकते हैं?", "तारीख तय हो गई है"],
    zh: ["我马上回来", "我们可以改期吗？", "日期已确认"],
    ja: ["すぐ戻ります", "会議を延期できますか？", "日程が確定しました"],
    ko: ["곧 돌아올게요", "회의를 미룰 수 있을까요?", "날짜가 확정되었습니다"],};

/** Zaehlt aus, wie ein Korpus abschneidet. */
function durchgehen(korpus) {
  const proSprache = {};
  for (const [soll, saetze] of Object.entries(korpus)) {
    proSprache[soll] = { gut: 0, falsch: 0, offen: 0, fehlgriffe: [] };
    for (const satz of saetze) {
      const r = detectLanguage(satz);
      if (r.confidence < SCHWELLE) { proSprache[soll].offen++; continue; }
      if (r.lang === soll) { proSprache[soll].gut++; continue; }
      proSprache[soll].falsch++;
      proSprache[soll].fehlgriffe.push(`${satz} \u2192 ${r.lang} (${r.confidence.toFixed(2)})`);
    }
  }
  return proSprache;
}

function bericht(titel, korpus) {
  const p = durchgehen(korpus);
  const s = Object.values(p).reduce((a, b) => ({
    gut: a.gut + b.gut, falsch: a.falsch + b.falsch, offen: a.offen + b.offen,
  }), { gut: 0, falsch: 0, offen: 0 });
  console.log(`\n${titel} \u2014 ${s.gut} richtig, ${s.falsch} falsch, ${s.offen} offen`);
  for (const [sprache, v] of Object.entries(p)) {
    pruefe(`${sprache}: keine falsche Sprache (${v.gut} richtig, ${v.offen} offen)`, () => {
      muss(v.falsch === 0, v.fehlgriffe.join('; '));
    });
  }
  /* Die Zusagen oben verbieten nur den Fehlgriff — sie verlangen keinen
     Treffer. Ein `detectLanguage`, das auf jeden Satz `confidence: 0`
     zurückgibt, hätte für alle 22 Sprachen `falsch === 0` und wäre damit
     lückenlos grün gewesen, ohne eine einzige Sprache zu erkennen. Deshalb
     zusätzlich eine Untergrenze für das Erkennen selbst. */
  pruefe(`${titel}: es wird auch wirklich erkannt (${s.gut} von ${s.gut + s.falsch + s.offen})`, () => {
    const gesamt = s.gut + s.falsch + s.offen;
    muss(gesamt > 0, 'der Korpus ist leer');
    muss(s.gut / gesamt >= 0.6,
      `nur ${s.gut} von ${gesamt} erkannt (${s.offen} offen, ${s.falsch} falsch) — `
      + 'die Erkennung schweigt sich durch');
    return `${Math.round((s.gut / gesamt) * 100)} % erkannt`;
  });
  return s;
}

bericht('Korpus', KORPUS);
bericht('Rueckhalt', RUECKHALT);

/* Die beiden gemeldeten Faelle, wortgenau. Sie stehen hier getrennt vom
   Korpus, damit klar bleibt, was der Anlass war. */
console.log('\nDie gemeldeten Faelle');

const fallgruben = [
  ['de', 'Was meinst du?'],
  ['de', 'Wie sieht es aus?'],
  ['en', 'I want to know'],
  ['en', 'sounds good to me'],
  ['en', 'happy to simplify it'],
  ['en', 'make it simpler to streamline everything'],
  ['en', "that's fine, make it simpler, streamline everything"],
  ['en', 'No problem'],
];
for (const [soll, satz] of fallgruben) {
  pruefe(`\u201e${satz}" ist nicht die falsche Sprache`, () => {
    const r = detectLanguage(satz);
    muss(r.confidence < SCHWELLE || r.lang === soll,
      `erkannt als ${r.lang} mit ${r.confidence.toFixed(2)}`);
    return r.confidence < SCHWELLE ? 'offen' : `${r.lang} (${r.confidence.toFixed(2)})`;
  });
}

/* Der eigentliche Schutz gegen die ganze Gattung: steht es zwischen zwei
   Sprachen unentschieden, darf keine davon behauptet werden. Vorher trug ein
   Gleichstand allein durch die Satzlaenge bis zu 0,69 Sicherheit davon, und
   welche Sprache gewann, entschied die Reihenfolge der Listen. */
console.log('\nGleichstand');

pruefe('Ein Gleichstand kommt nicht ueber die Schwelle', () => {
  // Jedes Wort steht in genau zwei Listen und zieht beide gleich weit hoch.
  const unentschieden = ['was', 'to', 'no', 'die', 'na', 'je', 'a'];
  const belege = [];
  for (const w of unentschieden) {
    const r = detectLanguage(w);
    if (r.confidence >= SCHWELLE) belege.push(`${w} \u2192 ${r.lang} (${r.confidence.toFixed(2)})`);
  }
  muss(belege.length === 0, belege.join('; '));
  return `${unentschieden.length} geteilte Woerter bleiben offen`;
});

pruefe('Ein eindeutiger Treffer kommt weiterhin durch', () => {
  const klar = [['tr', '\u00e7ok te\u015fekk\u00fcr'], ['de', 'Ich habe den Entwurf angeh\u00e4ngt.'],
    ['en', 'I have attached the draft.'], ['ja', '\u3069\u3046\u601d\u3044\u307e\u3059\u304b\uff1f']];
  for (const [soll, satz] of klar) {
    const r = detectLanguage(satz);
    muss(r.lang === soll && r.confidence >= SCHWELLE,
      `${satz} \u2192 ${r.lang} (${r.confidence.toFixed(2)})`);
  }
  return `${klar.length} eindeutige Saetze`;
});

const gut = ergebnisse.filter(Boolean).length;
console.log(`\n${gut}/${ergebnisse.length} bestanden\n`);
process.exit(gut === ergebnisse.length ? 0 : 1);
