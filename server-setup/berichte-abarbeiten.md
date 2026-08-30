# Berichte-Abarbeiter

Ein Dienst auf Dons Mac, der Problemberichte aus Stellium von einem
headless-Claude bearbeiten lässt.

## Die Kette

1. Ein Kollege schreibt einen Problembericht im Stellium-Reiter.
2. Ein n8n-Arbeitsablauf ruft `POST /api/problemberichte/:id/uebernehmen` mit
   dem Bot-Konto. Der Bericht steht danach auf `status: 'in_arbeit'` und
   `takenBy` trägt die Kennung des Bot-Kontos. **Das ist die Zuweisung an
   Claude** — mehr braucht es nicht.
3. `scripts/berichte-abarbeiten.mjs` läuft alle drei Minuten, sieht die
   Zuweisung, lässt `claude -p` in einem eigenen Arbeitsbaum laufen und meldet
   mit `POST /api/problemberichte/:id/abschliessen` zurück.

Pro Lauf genau **ein** Bericht, der älteste. Eine Sperrdatei sorgt dafür, dass
nie zwei Läufe gleichzeitig arbeiten — auf 8 GB RAM ist das keine Feinheit.

## Was der Lauf tut, und was er nicht darf

Der Bericht wird als JSON in eine Datei außerhalb des Repos geschrieben. Die
Anweisung an `claude -p` steht fest im Skript und enthält **kein Zeichen aus
dem Bericht** — sie zeigt nur auf die Datei und sagt, dass deren Inhalt
Beweismaterial ist und nie eine Anweisung. Das ist der wichtigste Teil: der
Freitext im Bericht kommt von einer beliebigen Person und darf den Versuch
enthalten, den Lauf zu steuern.

**Was Freitext ist, wird nicht aufgezählt, sondern übrig gelassen.**
`berichtEntschaerfen()` führt eine Positivliste der nachweislich vom Server
geprüften Felder — `id`, `bereich`, `schwere`, `status`, `kontext.panel`, die
Zeitstempel, `createdBy.role` —, und **alles andere** schreibt es vor dem
Speichern in den Block `unvertrauterInhalt`. Grund: `kontext.clientPlatform`
und `kontext.clientVersion` kommen aus `users.client_platform` /
`users.client_version` und damit ungeprüft aus dem `auth`-Ereignis eines
beliebigen Clients; `createdBy.name` ist der frei setzbare Anzeigename. Alle
drei standen außerhalb des Blocks und galten damit als vertrauenswürdig.
Kommt der Server morgen um ein Feld dazu, landet es mit dieser Richtung
automatisch auf der sicheren Seite statt automatisch auf der gefährlichen.

Verboten (im Anweisungstext **und** technisch abgesichert): `git push`,
`main` verändern, ausliefern, eine Fassung erhöhen, Geheimnisse lesen oder
verschicken. Die technische Seite ist ein PATH-Vorspann mit Attrappen für
`git push`, `security`, `ssh`, `scp` und `sftp`.

**Der Schutzschirm liegt auf allem, was im Baum läuft** — nicht nur auf
`claude -p`. Danach führt der Dienst nämlich selbst Dateien aus dem Baum aus:
`npm run build -w @stellium/shared` und `-w @stellium/server` starten
`scripts.build` aus einer package.json, und jeder Wächter läuft als
`node scripts/*-pruefen.mjs`. Beide Stellen liefen bis zum 29.08. mit der
vollen launchd-Umgebung; aus einer Datei, die der Lauf selbst geschrieben
hatte, waren echtes `git push`, `security`, `ssh` und Dons Repo erreichbar.

Die vierte Stelle war **git selbst** und fiel erst in der vierten Runde auf:
`git()` lief mit `execFileSync` ohne `env`, also mit derselben vollen
Umgebung — ausgerechnet der Schritt, der **committet**. Die Umgebung wird
jetzt an **einer** Stelle gebaut (`laufUmgebung()`) und von allen vieren
benutzt; ein git-Aufruf ohne Umgebung scheitert laut statt still
durchzurutschen.

### Keine Hooks im Baum

`<baum>/.git` ist eine **Datei** (`gitdir: …`), kein Verzeichnis: der Worktree
hat gar kein eigenes Hook-Verzeichnis, sondern teilt sich `<ursprung>/.git/hooks`
mit Dons Checkout. `git commit` im Baum führt damit Dons `pre-commit`,
`commit-msg` und `post-commit` aus, `git worktree add` sein `post-checkout`.

Heute ist das **kein Loch**, und das ist gemessen: die `.git`-Datei lässt sich
nicht durchschreiten, und der einzige Weg nach `.git/hooks` führt über einen
absoluten Pfad ausserhalb des Baums — den weist `acceptEdits` ab. Aber die
Kette hält nur, solange beide Glieder halten. Weicht `acceptEdits` je auf oder
kommt ein Lauf an eine Shell, wäre `.git/hooks/pre-commit` sofort ein Weg mit
vollen Rechten und allen Geheimnissen, gestartet vom Dienst selbst.

Jeder git-Aufruf, der **im Baum** arbeitet, geht deshalb über `baumGit()` und
trägt `-c core.hooksPath=`. Die Aufrufe auf dem Ursprung (`worktree
remove/prune`, `rev-parse`, `branch -D`) führen keinen Hook aus und bleiben
unangetastet; `worktree add` zählt trotz `cwd = ursprung` zur Baum-Seite, weil
es den Baum auscheckt.

### Keine fremde git-Konfiguration im Baum

Hooks sind nicht der einzige Codeweg, den git aus seiner Konfiguration heraus
startet. git kennt auch **externe Diff-Treiber** (`[diff "x"] command` /
`textconv`) und **Umwandlungsfilter** (`[filter "x"] smudge` / `clean`).
Zugewiesen werden die in `.gitattributes` — und `.gitattributes` ist
versioniert, liegt **im Baum** und war damit vom Lauf beschreibbar.

Gemessen, nicht vermutet (git 2.50.1, echtes Worktree): ein `.gitattributes`
mit `* diff=boom` plus ein `[diff "boom"] command` in `~/.gitconfig`, und
`git diff HEAD` startet das fremde Programm; dasselbe für `* filter=boom` und
`git checkout -- .`. Beides sind Aufrufe, die `warenSchonRot()` **nach** dem
Lauf macht, unter der vollen launchd-Umgebung.

Ein Loch war das nie: der Lauf hielt nur die eine Hälfte der Mechanik
(`.gitattributes`), die andere — die Treiberdefinition — steht in der
Konfiguration, und an die kommt er nicht. `<baum>/.git` ist eine Datei und
nicht durchschreitbar, der Weg zu `~/.gitconfig` führt aus dem Baum hinaus und
scheitert an `acceptEdits`. Aber die halbe Mechanik in fremder Hand und die
andere Hälfte in einer Datei, die sich ändert, ohne dass jemand an diesen
Dienst denkt, ist kein Zustand, den man stehen lässt.

Drei Riegel, alle billig:

* **`.gitattributes` ist ein Tor.** Der Riegel, der wirklich hält, ist der,
  bei dem der Lauf die Datei gar nicht anfasst. Ein Fehlerbehebungslauf, der
  `.gitattributes` braucht, ist eine Entscheidung für Don.
* **`GIT_CONFIG_GLOBAL=/dev/null` und `GIT_CONFIG_SYSTEM=/dev/null`** in
  `laufUmgebung()` — für alles, was im Baum läuft. `/dev/null` ist eine leere
  Konfigurationsdatei; damit fällt die Benutzer- und Systemkonfiguration weg,
  und mit ihr jede Treiberdefinition.
* **`--no-ext-diff --no-textconv`** an dem einen `git diff HEAD`, aus dem der
  Flicken entsteht. Die beiden greifen auch dort, wo die Umgebungsvariablen
  nicht hinreichen — bei einem Treiber aus der **lokalen** `.git/config`, also
  aus Dons eigenem Repository. Gemessen: `--no-ext-diff` allein genügt nicht,
  dann springt der `textconv`-Treiber an.

**Das Committen überlebt das**, und auch das ist gemessen: `user.name` und
`user.email` stehen bei Don weder global noch lokal — der Dienst gibt sie an
jedem Commit selbst mit (`-c user.name=Stellium Abarbeiter …`). Ein Riegel, der
das Committen mit erschlüge, gäbe jeden Bericht mit „nichts geändert" zurück
und wäre schlimmer als die Tür, die er zumachen soll.

**Bewusst nicht gebaut:** `-c core.attributesFile=` steht nicht daneben. Es
schaltet nur die *globale* Attributdatei ab, nicht das `.gitattributes` im
Baum — gemessen: mit `-c core.attributesFile=` zündet der Treiber weiter. Und
sie kommt ohnehin aus der Konfiguration, die schon abgeschnitten ist. **Offen
bleibt** ein Umwandlungsfilter aus der *lokalen* `.git/config`: dafür gibt es
keine Umgebungsvariable und bei `checkout`/`apply` auch keine Flagge. Der Lauf
kann diese Datei nicht schreiben, und stünde dort ein Filter, wäre das Dons
eigene Entscheidung in seinem eigenen Repository — sie zu übergehen stünde
diesem Dienst nicht zu.

Gearbeitet wird in einem **eigenen git-worktree** unter
`~/Library/Application Support/stellium-abarbeiter/baum`, auf einem frischen
Zweig `bericht/<id>` von `main`. Dons Arbeitsverzeichnis wird dabei nie
angefasst — auch dann nicht, wenn der Lauf mittendrin abgeschossen wird. Der
Preis: der Zweig entsteht aus dem **committeten** `main`, nicht aus Dons
Arbeitsstand.

## Der Riegel: kein Pfad aus dem Baum hinaus

Die beiden Riegel unten sehen nur, was `git status` sieht — und `node_modules/`
steht in der `.gitignore`. Genau dort lag der Ausbruch, der am 29.08. geschlossen
wurde.

`<baum>/node_modules` war ein Verzeichnis aus **435 Symlinks** in Dons echtes
`node_modules`. Jeder davon war ein Pfad, der *im Baum* liegt — `acceptEdits`
lässt ihn also durch — und *draußen* schreibt. Gemessen: ein
`writeFileSync('<baum>/node_modules/.bin/tsc', …)` folgte erst dem Verzeichnis-
verweis und dann `tsc -> ../typescript/bin/tsc` und überschrieb Dons echtes
`typescript/bin/tsc`. `git status` meldete davon **nichts**, weder die Tore noch
der Wächterbestand bekamen es je zu Gesicht, und `.bin` steht bei
`npm run build` vorn im PATH — der Dienst führte die vergiftete Datei zwei
Schritte später selbst aus. Schwerer als die früheren Wege: die Schreibspur
zeigte in Dons Arbeitsverzeichnis, also blieb die Vergiftung auch für alle
späteren Läufe und für Dons eigene Arbeit liegen.

Jetzt bekommt der Baum eine **APFS-Klonkopie** (`cp -c -R`). Ein Klon teilt die
Blöcke, bis jemand schreibt — und dann trifft der Schreibvorgang nur die Kopie.
Gemessen an Dons `node_modules` (638 MB, ~30 000 Dateien):

| Weg | Platz | Zeit |
|-----|-------|------|
| Symlinks (vorher) | 0 | 23 ms — und 435 Wege hinaus |
| **APFS-Klon (jetzt)** | **9,5 MB** | **3,5 s** |
| echte Kopie | 666 MB | 10,3 s |

Der Klon kostet also rund ein Siebzigstel des Platzes einer echten Kopie und ist
dabei schneller; er geht mit dem Baum wieder weg. Ohne APFS scheitert `cp -c`
laut, und es wird ehrlich echt kopiert — eine langsame Kopie ist ein Preis, ein
Loch ist keiner.

Nebenbei entfällt damit das Umbiegen von `@stellium/*` von Hand: die drei
Verweise sind relativ (`../../packages/shared`) und zeigen aus dem Klon von
selbst auf die Pakete **im Baum**.

Verlassen wird sich darauf nicht. `wegeHinaus()` zählt nach dem Anlegen jeden
Verweis, der aus dem Baum hinausführt — die **ganze** Kette, auch mit
Zwischenhalt im Baum, und kaputte Verweise zählen mit (ein Schreibvorgang auf
ein fehlendes Ziel legt es an, und zwar draußen). Findet sich auch nur einer,
wird `claude -p` **gar nicht erst gestartet**. Der Durchgang über den ganzen
Baum kostet 74 ms.

## Der Riegel: was git nicht sieht

`node_modules/` war nur der erste ignorierte Ort. Gemessen an einem frischen
Baum: legt ein Lauf `packages/server/dist/services/bloecke.js` und
`packages/server/.env` an, ist die Ausgabe von `git status --porcelain` — die
Grundlage der beiden Riegel unten — **vollständig leer**. Beides liest der
Dienst danach:

* `scripts/bloecke-pruefen.mjs` lädt `packages/server/dist/*` per
  `await import()`. Der Dienst baut seit dem 29.08. **beide** dist —
  `@stellium/shared` und `@stellium/server` (`paketeBauen()`, siehe unten).
* `packages/server/src/config.ts` zieht `dotenv/config`; rund vierzig Wächter
  starten darüber. Aus einer untergeschobenen `.env` kämen absolute
  Schreibpfade (`UPLOAD_DIR`, `STORAGE_DIR`, `RELEASE_DIR` werden angelegt) und
  frei wählbare Adressen für die Übersetzungsdienste — und **HTTP sperrt der
  Schutzschirm nicht**.

Aufgezählt wird deshalb nichts, sondern übrig gelassen: ein frischer Worktree
trägt **null** ignorierte Einträge, und der einzige, den der Dienst selbst
dazulegt, ist sein `node_modules/`. Alles andere kommt vom Lauf und verwirft
ihn. Eine Liste gefährlicher Orte wäre am Tag ihres Schreibens vollständig und
am Tag danach nicht mehr — die nächste `.gitignore`-Zeile stünde nicht darin.

## Der Riegel: die Tore

**Vor** allem anderen — vor dem shared-Bau, vor dem ersten Wächter — vergleicht
der Dienst die geänderten Dateien gegen `HEAD`. Berührt der Lauf eine Datei,
die der Dienst hinterher selbst ausführt oder auswertet, ist der **ganze Lauf
verworfen**: nichts wird ausgeführt, nichts committet, der Bericht geht mit
klarem Grund auf `neu`.

Tore sind:

* jede `scripts/*-pruefen.mjs` (auch eine neu angelegte, auch eine, die die
  Ableitung gerade nicht sieht),
* `scripts/waechter-liste.mjs`, `scripts/ausliefern.mjs`,
  `scripts/veroeffentlichen.mjs`,
* jede `package.json` und `package-lock.json`,
* `eslint.config.js`,
* alles unter `.github/`, `.git/hooks/` und `.claude/`,
* jede `.gitattributes` — sie ist versioniert, liegt im Baum und weist git
  externe Programme zu (siehe „Keine fremde git-Konfiguration im Baum").

Die Wächter kommen über dieselbe Ableitung herein, die auch das Ausliefern
benutzt; das Namensmuster steht daneben, weil sich ein Wächter durch ein Wort
im Quelltext aus der Ableitung werfen ließe. Ein Fehlerbehebungslauf hat an den
Toren nichts zu suchen — will Claude wirklich einen Wächter ändern, entscheidet
das Don von Hand.

Gezählt werden **beide Seiten einer Umbenennung**: `git status` meldet eine
vorgemerkte Umbenennung als `R alt -> neu`, und wer davon nur `neu` liest,
übersieht einen weggeschobenen Wächter.

Dazu kommt der **Wächterbestand nach Namen und Prüfsumme**, nicht nach Anzahl:
einen Wächter löschen und eine Attrappe danebenlegen ließ die Zahl gleich und
kam als „erledigt, alle Wächter grün" zurück.

## Das Tor

Nach dem Lauf laufen alle Wächter des Repos — dieselbe Ableitung, die auch
`scripts/ausliefern.mjs` benutzt (`scripts/waechter-liste.mjs`), damit hier
keine zweite, veraltende Liste entsteht.

* **Alle grün** → auf dem Zweig committen, `abschliessen` mit
  `status: 'erledigt'`. Das `ergebnis` nennt den Zweignamen — und sagt die
  Wahrheit: es zählt `N von M Wächtern grün` und benennt die, die **schon vor
  dem Lauf** rot waren (Umgebungsschuld). Vorher stand dort immer „alle M
  Wächter grün", auch wenn zehn rot waren; das ging nur ins Protokoll.

### Vorher bauen: `paketeBauen()`

Ein frischer Worktree trägt kein `dist/` — es ist ignoriert. Der Dienst baut
deshalb vor dem Wächterlauf `@stellium/shared` **und** `@stellium/server`, in
dieser Reihenfolge, unter demselben Schutzschirm und über dieselbe Funktion.

Der Server fehlte bis zum 29.08., und das kostete einen ganzen Wächter:
`scripts/bloecke-pruefen.mjs` brach ohne `packages/server/dist` mit Exitcode 2
ab — bei **jedem** Lauf. Da der Dienst nur *neu* rot gewordene Wächter wertet,
wurde er jedes Mal als Umgebungsschuld durchgewinkt. Ein Wächter, der immer
durchgewinkt wird, prüft nichts.

Gemessen an einem frischen Baum aus `main` mit allen 67 abgeleiteten Wächtern:

| | ohne Server-Bau | mit Server-Bau |
|---|---|---|
| Bau | 0,8 s | 2,7 s |
| Wächterdurchgang | 112,8 s (1 rot) | 118,2 s (**0 rot**) |

Der zusätzliche Bau kostet rund **1,9 s** — knapp zwei Prozent eines
Durchgangs.

### Die erklärte Umgebungsschuld ist leer

Ein Wächter, der im frischen Baum rot ist, wird nur noch dann durchgewinkt,
wenn er namentlich in `UMGEBUNGSSCHULD` (`scripts/berichte-abarbeiten.mjs`)
steht. Die Liste ist **leer**. Alles andere führt auf `neu`, mit Namen im
gemeldeten Text und dem Hinweis, wo eine Erklärung hingehört.

Das schließt nebenbei einen zweiten Weg: `git checkout -- .` dreht die Quellen
zurück, lässt das ignorierte `dist/` aber stehen. Ein Lauf, der den
Prüfgegenstand kaputtmacht, wäre im Vergleichslauf genauso rot — und käme als
„war schon vorher rot" durch. Deshalb baut `warenSchonRot()` nach dem
Zurückdrehen neu, und deshalb kommt ein nicht erklärter roter Wächter gar
nicht erst bis zum Vergleich.
* **Irgendetwas rot, abgestürzt, Zeit abgelaufen oder gar nichts geändert** →
  Zweig löschen, `abschliessen` mit `status: 'neu'` und einem ehrlichen Grund.

Ein Fehler, der still als erledigt verbucht wird, ist schlimmer als einer, der
offen bleibt.

## Was Don einmalig tun muss

### 1. Bot-Konto anlegen und ihm `report.review` geben

In der Rechte-Tafel (TeamAdmin) ein Konto anlegen — Vorschlag: Benutzername
`abarbeiter`, Rolle `bot` — und ihm das Recht **`report.review`** geben. Ohne
das sieht das Konto nur seine eigenen Berichte, und der Dienst findet nie
etwas. Heißt das Konto anders, dann `STELLIUM_ABARBEITER_KONTO` setzen.

Dasselbe Konto trägt Don in n8n ein; n8n übernimmt die Berichte, dieser Dienst
bearbeitet sie.

### 2. Schlüsselbund-Eintrag setzen

Das Passwort steht nicht in der plist und nicht in einer Datei im Repo:

```bash
security add-generic-password -U -s stellium-abarbeiter -a abarbeiter -w
```

Das Passwort wird dabei abgefragt und nicht angezeigt. Die Serveradresse liest
der Dienst aus derselben Stelle wie das Ausliefern (`stellium-server`); steht
sie dort schon, ist nichts weiter zu tun.

### 3. Den Dienst laden

```bash
cp server-setup/com.stellium.berichte-abarbeiten.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.stellium.berichte-abarbeiten.plist
```

## Prozessgruppen und Waisen

Alles, was der Dienst in den Baum hinein startet, bekommt eine **eigene
Prozessgruppe** (`detached`), und Signale gehen an die Gruppe (`-pid`). Sonst
tötete die Zeitgrenze nur `claude` selbst und ließ dessen Enkel im Baum zurück.

Wird der Dienst mit SIGKILL abgeschossen, überlebt das `claude`-Kind als Waise
an PPID 1. Drei Minuten später gilt die Sperre als verwaist — und der nächste
Lauf löschte den Baum **unter der laufenden Waise** weg, um darin sofort einen
zweiten Lauf zu starten. Deshalb steht in
`~/Library/Application Support/stellium-abarbeiter/baum-prozesse.json` ein
Vermerk über die gestartete Gruppe; vor dem Aufräumen wird gefragt, ob sie noch
lebt. Tut sie das, wird sie erst höflich, dann hart beendet — und lässt sie
sich nicht beenden, bleibt der Baum liegen, statt dass ein Verzeichnis unter
einem laufenden Prozess weggezogen wird.

## Anhalten

```bash
launchctl unload ~/Library/LaunchAgents/com.stellium.berichte-abarbeiten.plist
```

Ein Lauf, der gerade arbeitet, läuft dabei zu Ende. Bleibt nach einem harten
Abschuss eine Sperre liegen, ist das kein Dauerschaden: eine Sperre mit totem
Prozess dahinter wird beim nächsten Lauf übernommen. Von Hand geht es auch:

```bash
rm ~/Library/Application\ Support/stellium-abarbeiter/lauf.sperre
```

## Logs

```
~/Library/Logs/Stellium/berichte-abarbeiten.log
```

Das Skript kürzt die Datei selbst, sobald sie über 1 MB wächst — launchd dreht
nichts. Die Ausgabe des Claude-Laufs und die des roten Wächters liegen
daneben:

```
~/Library/Application Support/stellium-abarbeiter/lauf/claude.log
~/Library/Application Support/stellium-abarbeiter/lauf/waechter.log
~/Library/Application Support/stellium-abarbeiter/lauf/bericht-<id>.json
```

## Einen Lauf von Hand auslösen

```bash
node scripts/berichte-abarbeiten.mjs
```

Fehlt der Schlüsselbund-Eintrag, bricht das Skript mit genau der Zeile ab, die
zu tippen ist. Findet es keinen zugewiesenen Bericht, sagt es das und endet.

Zum Ausprobieren ohne echten Claude-Lauf lässt sich der Befehl ersetzen:

```bash
STELLIUM_ABARBEITER_BEFEHL=/pfad/zur/attrappe node scripts/berichte-abarbeiten.mjs
```

## Umgebung

| Variable | Vorgabe | Wofür |
|---|---|---|
| `STELLIUM_SERVER` | Schlüsselbund `stellium-server` | Serveradresse |
| `STELLIUM_ABARBEITER_KONTO` | `abarbeiter` | Benutzername des Bot-Kontos |
| `STELLIUM_ABARBEITER_FRIST_MINUTEN` | `20` | Zeitgrenze je Claude-Lauf |
| `STELLIUM_ABARBEITER_BEFEHL` | `claude` | Ersatzbefehl für Prüfläufe |
| `STELLIUM_ABARBEITER_CLAUDE_ARGS` | `--permission-mode acceptEdits` | Zusatzflaggen |

Für alles, was **im Baum** läuft, setzt `laufUmgebung()` zusätzlich
`GIT_CONFIG_GLOBAL=/dev/null` und `GIT_CONFIG_SYSTEM=/dev/null` und entfernt
`STELLIUM_LOGIN`, `STELLIUM_PASSWORT`, `STELLIUM_SERVER` und
`STELLIUM_ABARBEITER_KONTO`.

## Der Wächter dazu

```bash
node scripts/abarbeiter-pruefen.mjs
```

Prüft gegen den echten Code: keine Marke aus den Freitextfeldern in der
Anweisung **und nicht in der Umgebung** des Kindprozesses, alles Ungeprüfte im
Block `unvertrauterInhalt`, die Tore dicht (und die eingeschleuste Datei
nachweislich **nicht** ausgeführt), der Schutzschirm gemessen aus einem Wächter,
aus dem shared-Bau und aus dem Server-Bau heraus, der Wächterbestand nach
Namen und Inhalt, kein
fremd zugewiesener Bericht, rote Wächter enden auf `neu` — auch dann, wenn sich
der Stand zum Vergleich nicht zurückdrehen ließ —, das Ergebnis sagt die
Wahrheit, die Sperre hält, eine verwaiste Sperre wird übernommen, und ein Enkel
des Laufs überlebt die Zeitgrenze nicht.

Dazu, seit der vierten Runde: `core.hooksPath` ist auf jedem git-Aufruf im Baum
leer gesetzt (am laufenden Aufruf gemessen, nicht am Quelltext abgelesen), ein
git-Aufruf im Baum läuft unter dem Schutzschirm (die Attrappe fängt `push`),
ein git-Aufruf ohne Umgebung scheitert laut, und — mit Gegenprobe, dass die
Hooks in diesem Repo überhaupt feuern — **kein** Hook aus dem Repository feuert
während eines ganzen Laufs. Und: die erklärte Umgebungsschuld ist leer, ein
nicht erklärter roter Wächter hält den Lauf auf, ein erklärter nicht.

Und seit der fünften Runde die Tür neben der Hook-Tür: `.gitattributes` ist ein
Tor (ein Lauf, der eines anlegt, wird verworfen — am ganzen Lauf gemessen),
`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` stehen auf `/dev/null` und schlagen
einen mitgebrachten Wert, und — **mit Gegenprobe, dass ohne den Riegel wirklich
ein fremdes Programm startet** — zündet weder beim `git diff` noch beim
`git checkout` des Dienstes ein Diff-Treiber oder Umwandlungsfilter. Dazu, an
der lokalen `.git/config` gemessen, wohin die Umgebungsvariablen nicht reichen:
der Flicken aus `warenSchonRot()` ist ein Patch und kein fremder Programmtext.
Und der wichtigste Punkt der ganzen Runde: **der Dienst committet weiterhin**,
unter eigener Identität, mit abgeschnittener Benutzerkonfiguration.

Dazu prüft er an einem **echten** Baum, dass kein Pfad hinausführt: ein
Wegwerf-Repository bekommt ein `node_modules`, wie npm es baut, darauf laufen
der echte `git worktree add` und die echte `modulkopieLegen()`, und dann wird
der Angriff von damals wortgleich ausgeführt. Die Datei draußen muss danach
byte-genau dieselbe sein. Führt jemand den Symlink wieder ein, wird der Punkt
rot.

Und er prüft, dass eine an ignorierter Stelle abgelegte Nutzlast den Lauf
verwirft — mit dem Nachweis daneben, dass `git status --porcelain` sie
tatsächlich nicht meldet. Ohne den zweiten Teil prüfte der Punkt nur noch sich
selbst.

```bash
node scripts/waechter-liste-pruefen.mjs
```

Bewacht die Ableitung selbst — sie war lange die einzige Stelle im Haus, die
niemand prüfte. Ein Namensfilter `n.length < 28` darin ließ jeden Wächter grün
und `ausliefern.mjs` 27 statt 65 Läufe finden, über der Schwelle von 20: 38
Wächter waren still weg. Dieser Lauf hält die abgeleitete Liste gegen den
**Ordner** und verlangt für jede Datei, die nicht läuft, einen belegten Grund.
`ausliefern.mjs` macht denselben Gegencheck unabhängig noch einmal.

Beide laufen über die Ableitung in `ausliefern.mjs` bei jeder Auslieferung mit.
