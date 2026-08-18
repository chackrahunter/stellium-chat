# Warum es keine Ende-zu-Ende-Verschlüsselung gibt

Kurz: weil sie den Zweck dieser Anwendung aufheben würde. Ausführlich, damit
die Entscheidung nachvollziehbar bleibt.

## Was Ende-zu-Ende bedeutet

Nur die beteiligten Geräte können den Inhalt lesen. Der Server transportiert
Chiffrat und weiß nicht, was darin steht. Genau das ist die Stärke — und hier
das Problem.

## Was dabei wegfällt

Stellium ist gebaut, damit alle in ihrer Sprache lesen. Diese Arbeit macht der
Server: er schickt den Text an ein Sprachmodell und verteilt die Übersetzung.
Kann er den Text nicht lesen, kann er ihn nicht übersetzen.

Dasselbe gilt für:

| Funktion | Warum sie Klartext braucht |
|---|---|
| Live-Übersetzung | Der Server ruft das Modell auf |
| KI-Assistent | Er liest den Kanalverlauf |
| „Was habe ich verpasst?" | Fasst gespeicherte Nachrichten zusammen |
| Antwortvorschläge | Brauchen den bisherigen Verlauf |
| Volltextsuche | Der Index entsteht serverseitig |
| Sprachnachrichten | Whisper transkribiert auf dem Server |
| Link-Vorschauen | Der Server ruft die Seite ab |

Übrig bliebe ein Chat ohne alles, wofür man ihn genommen hat.

## Was stattdessen getan wurde

Der Angriff, gegen den E2EE im Firmenumfeld realistisch schützt, ist **Zugriff
auf gespeicherte Daten**: ein Backup, eine Festplatte, ein versehentlich
freigegebenes Verzeichnis. Dagegen hilft Verschlüsselung im Ruhezustand, und
die ist umgesetzt — für API-Schlüssel, E-Mails und Benutzernamen.

Gegen einen Angreifer, der Code als Serverbenutzer ausführt, hilft auch E2EE
nur bedingt: er könnte den Client verändern oder Schlüssel abgreifen.

## Wenn es doch sein muss

Der ehrliche Weg wäre eine **Wahl pro Unterhaltung**:

- Normale Kanäle: wie bisher, mit Übersetzung und KI
- Als „vertraulich" markierte Unterhaltungen: echtes E2EE, dafür **ohne**
  Übersetzung, Suche, Assistent und Transkription

Das ist ehrlich, weil die Kosten sichtbar bleiben. Nötig wären dafür
Geräteschlüssel je Person, ein Schlüsselaustausch beim Betreten einer
Unterhaltung, Umschlüsselung beim Hinzufügen von Personen, ein Umgang mit
verlorenen Geräten und ein Wiederherstellungsweg für den Fall, dass jemand
das Unternehmen verlässt.

Das ist ein eigenes Vorhaben, kein Schalter.

## Was heute schon geht

Wer bestimmte Inhalte gar nicht durch ein fremdes Modell schicken will, stellt
`AI_PROVIDER=libre` auf eine selbst gehostete LibreTranslate-Instanz um. Dann
verlässt kein Text das eigene Netz — die KI-Funktionen entfallen, die
Übersetzung bleibt.
