#!/usr/bin/env python3
"""
Zeigt, wenn jemand über SSH auf diesem Pi arbeitet.

Gedacht als Mitleser, nicht als Schloss: wer hier steht, soll sehen können,
was aus der Ferne geschieht.

Die Datei enthält zwei Dinge, die aufeinander aufbauen:

  `Mitschrift`  — der Bereich mit Kopf, Tagesauswahl und Verlauf. Er steckt
                  dauerhaft unten in der Stellium-Konsole (die ihn von hier
                  importiert) und ebenso in dem Fenster darunter.
  `Fenster`     — die eigenständige Fassung zum Nachlesen. Sie geht nur auf,
                  wenn man sie über „Fernzugriff-Protokoll" im Startmenü
                  aufruft — nicht mehr von selbst bei jeder Verbindung.

Direkt gestartet kommt die eigenständige Fassung.
Läuft auf dem Desktop des Pi, ohne Zusatzpakete außer python3-tk.
"""
import os
import json
import math
import queue
import subprocess
import threading
import time
import tkinter as tk
from tkinter import font as tkfont

LOG = "/var/log/stellium-ssh.log"
TAKT = 2.0            # wie oft nach Sitzungen gesehen wird
ZEILEN = 400          # so viele Zeilen bleiben im Fenster
RUFEN = "/tmp/stellium-wache-zeigen"   # Datei als Klingel vom Startmenü aus

# Eigene Geräte sollen das Fenster nicht auslösen — es geht um den Fernzugriff
# von außen, nicht um die eigene Verbindung aus dem Nebenzimmer. Wer hier steht,
# wird übergangen; die Liste lässt sich in der Datei daneben erweitern.
EIGENE = {"aryan-pc", "aryan"}
SPRACHDATEI = os.path.expanduser("~/.config/stellium-wache-sprache")

TEXTE = {
    "de": {
        "laeuft": "Fernzugriff läuft",
        "arbeitet": "{wer} arbeitet gerade über SSH",
        "mehrere": "{n} Fernzugriffe laufen",
        "protokoll": "Protokoll des Fernzugriffs",
        "niemand": "Gerade ist niemand verbunden.",
        "geoeffnet": "Verbindung geöffnet",
        "geschlossen": "Verbindung beendet",
        "dateien": "Dateiübertragung",
        "befehl": "Befehl",
        "befehle": "Befehle",
        "tag": "Tag",
        "heute": "heute · laufend",
        "nichts": "Am {tag} wurde nichts mitgeschrieben.",
        "live": "— ab hier wieder live —",
        "fuss": "Mitschrift auch im Journal:  journalctl -t stellium-ssh",
        "seit": "seit",
    },
    "en": {
        "laeuft": "Remote access active",
        "arbeitet": "{wer} is working over SSH",
        "mehrere": "{n} remote sessions active",
        "protokoll": "Remote access log",
        "niemand": "Nobody is connected right now.",
        "geoeffnet": "Connection opened",
        "geschlossen": "Connection closed",
        "dateien": "File transfer",
        "befehl": "command",
        "befehle": "commands",
        "tag": "Day",
        "heute": "today · live",
        "nichts": "Nothing was recorded on {tag}.",
        "live": "— live again from here —",
        "fuss": "Also in the journal:  journalctl -t stellium-ssh",
        "seit": "since",
    },
}

SPRACHE = "de"


def T(schluessel, **werte):
    text = TEXTE.get(SPRACHE, TEXTE["de"]).get(schluessel, schluessel)
    return text.format(**werte) if werte else text


def sprache_laden():
    global SPRACHE
    try:
        with open(SPRACHDATEI) as f:
            wahl = f.read().strip()
        if wahl in TEXTE:
            SPRACHE = wahl
    except OSError:
        pass


def sprache_sichern():
    try:
        os.makedirs(os.path.dirname(SPRACHDATEI), exist_ok=True)
        with open(SPRACHDATEI, "w") as f:
            f.write(SPRACHE)
    except OSError:
        pass


def sprache_setzen(wahl):
    """Die Sprache von außen vorgeben.

    Steckt die Mitschrift als Bereich in der Stellium-Konsole, dann gibt es
    dort nur noch einen Sprachknopf — und der muss beides umschalten können.
    Gemerkt wird die Wahl trotzdem hier, damit die eigenständige Fassung
    später in derselben Sprache aufgeht.
    """
    global SPRACHE
    if wahl in TEXTE and wahl != SPRACHE:
        SPRACHE = wahl
        sprache_sichern()


try:
    with open("/etc/stellium/ssh-wache-eigene", "r") as _f:
        EIGENE |= {z.strip() for z in _f if z.strip()}
except OSError:
    pass

FARBEN = {
    "grund": "#0b0d16",
    "rand": "#7c5cff",
    "tinte": "#e8eaf6",
    "leise": "#9aa0bd",
    "gut": "#34d399",
    "warn": "#fbbf24",
    "zeit": "#5c6384",     # Uhrzeit tritt zurück
    "strich": "#3a3f5c",   # die senkrechte Linie einer Sitzung
    "datei": "#60a5fa",
    "tief": "#06080f",     # Grund der Mitschrift
    "linie": "#1c2138",    # feiner Rahmen
    "kopf1": "#191d33",    # Farbverlauf oben …
    "kopf2": "#0b0d16",    # … nach unten
    "karte": "#141829",    # Auswahlfeld
}

BREIT, HOCH = 760, 440
KOPFHOCH = 76


def lebt(pid):
    """Steht hinter dem Eintrag noch ein Prozess?

    `who` liest utmp, und dort bleiben abgebrochene Sitzungen als Karteileichen
    stehen — sonst zeigte das Fenster tagelang jemanden an, der längst weg ist.

    Nachgesehen wird in /proc und nicht mit kill(pid, 0): SSH-Sitzungen gehören
    root, und die Nachfrage von einem gewöhnlichen Konto beantwortet der Kern
    mit „keine Berechtigung" — was hieße, jede echte Sitzung gälte als tot.
    """
    try:
        return os.path.exists(f"/proc/{int(pid)}")
    except (TypeError, ValueError):
        return False


def schluesselnamen():
    """Fingerabdruck → Name, damit man sieht, *wer* da ist, nicht nur welches Konto."""
    namen = {}
    for heim in ("/home", "/root"):
        if not os.path.isdir(heim):
            continue
        kandidaten = ([os.path.join(heim, d, ".ssh/authorized_keys")
                       for d in os.listdir(heim)] if heim == "/home"
                      else [os.path.join(heim, ".ssh/authorized_keys")])
        for datei in kandidaten:
            if not os.path.isfile(datei):
                continue
            try:
                roh = subprocess.run(["ssh-keygen", "-lf", datei],
                                     capture_output=True, text=True, timeout=5).stdout
            except Exception:
                continue
            for zeile in roh.splitlines():
                teile = zeile.split()
                if len(teile) >= 3 and teile[1].startswith("SHA256:"):
                    bemerkung = " ".join(teile[2:-1]) if len(teile) > 3 else teile[2]
                    namen[teile[1]] = bemerkung
    return namen


# Die Zuordnung Adresse → Name zu holen kostet spürbar Zeit: einmal das
# Journal durchsehen und für jede Schlüsseldatei ssh-keygen starten. Alle zwei
# Sekunden ist das Verschwendung, denn sie ändert sich nur, wenn ein Schlüssel
# dazukommt. Seit die Mitschrift auch dauerhaft in der Konsole läuft, fiele das
# auf dem Pi ins Gewicht — deshalb wird das Ergebnis eine halbe Minute gehalten.
NAMEN_HALTBAR = 30.0
_namen_stand = (0.0, {})


def herkunft_namen(frisch=False):
    """Welche Adresse hat sich zuletzt mit welchem Schlüssel angemeldet?"""
    global _namen_stand
    alter, gehalten = _namen_stand
    if not frisch and gehalten and time.monotonic() - alter < NAMEN_HALTBAR:
        return gehalten

    namen = schluesselnamen()
    zuordnung = {}
    try:
        roh = subprocess.run(
            ["journalctl", "-u", "ssh", "-n", "300", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=6).stdout
    except Exception:
        _namen_stand = (time.monotonic(), zuordnung)
        return zuordnung
    for zeile in roh.splitlines():
        if "Accepted publickey for" not in zeile:
            continue
        teile = zeile.split()
        try:
            adresse = teile[teile.index("from") + 1]
        except (ValueError, IndexError):
            continue
        abdruck = next((t for t in teile if t.startswith("SHA256:")), None)
        if abdruck and abdruck in namen:
            zuordnung[adresse] = namen[abdruck]
    _namen_stand = (time.monotonic(), zuordnung)
    return zuordnung


# Welche Tage es gibt, ändert sich höchstens einmal am Tag — die Antwort darf
# also stehen bleiben. Zwei Minuten sind reichlich und machen den Unterschied
# zwischen einer Anzeige, die auf einen Klick sofort reagiert, und einer, die
# erst einmal das Journal durchsieht.
TAGE_HALTBAR = 120.0
_tage_stand = (0.0, None)


def verfuegbare_tage(anzahl=14, frisch=False):
    """An welchen Tagen wurde überhaupt etwas mitgeschrieben?

    Fragt das Journal einmal nach den Zeitstempeln und zählt die Tage zusammen —
    so stehen in der Auswahl nur Tage, an denen es auch etwas zu sehen gibt.

    Das Ergebnis wird `TAGE_HALTBAR` Sekunden gehalten, und das ist kein
    Feinschliff: auf dem Pi nachgemessen kostet die Abfrage 0,4 s im Journal
    und noch einmal ähnlich viel, um 16 000 Zeilen JSON auseinanderzunehmen.
    Sie lief bisher bei jedem Sprachwechsel mitten im Hauptfaden — ein Klick
    auf DE/EN ließ die ganze Oberfläche dreiviertel Sekunden lang stehen, und
    genau das beschreibt man als „reagiert nicht".
    """
    global _tage_stand
    alter, gehalten = _tage_stand
    if not frisch and gehalten is not None and time.monotonic() - alter < TAGE_HALTBAR:
        return gehalten
    try:
        roh = subprocess.run(
            ["journalctl", "-t", "stellium-ssh", "--since", f"-{anzahl} days",
             "--no-pager", "-o", "json", "--output-fields=__REALTIME_TIMESTAMP"],
            capture_output=True, text=True, timeout=15).stdout
    except Exception:
        _tage_stand = (time.monotonic(), [])
        return []
    tage = []
    for zeile in roh.splitlines():
        try:
            roh_zeit = json.loads(zeile).get("__REALTIME_TIMESTAMP")
            tag = time.strftime("%Y-%m-%d", time.localtime(int(roh_zeit) / 1e6))
        except (ValueError, TypeError):
            continue
        if tag not in tage:
            tage.append(tag)
    tage = sorted(tage, reverse=True)
    _tage_stand = (time.monotonic(), tage)
    return tage


def tag_lesen(tag):
    """Alles, was an einem bestimmten Tag geschah."""
    try:
        roh = subprocess.run(
            ["journalctl", "-t", "stellium-ssh", "--since", f"{tag} 00:00:00",
             "--until", f"{tag} 23:59:59", "--no-pager", "-o", "json",
             "--output-fields=MESSAGE,__REALTIME_TIMESTAMP"],
            capture_output=True, text=True, timeout=20).stdout
    except Exception:
        return []
    aus = []
    for zeile in roh.splitlines():
        try:
            satz = json.loads(zeile)
        except ValueError:
            continue
        text = satz.get("MESSAGE") or ""
        if isinstance(text, list):
            text = bytes(text).decode("utf-8", "replace")
        try:
            uhr = time.strftime("%H:%M:%S", time.localtime(int(satz.get("__REALTIME_TIMESTAMP", 0)) / 1e6))
        except ValueError:
            uhr = ""
        aus.append((uhr, text))
    return aus


def sitzungen():
    """Wer ist gerade über SSH da? Gibt (name, herkunft, seit) zurück."""
    try:
        roh = subprocess.run(
            ["who", "-u"], capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:
        return []
    benannt = herkunft_namen()
    aus = []
    for zeile in roh.splitlines():
        # who zeigt die Herkunft in Klammern — lokal steht dort nichts.
        if "(" not in zeile:
            continue
        teile = zeile.split()
        if len(teile) < 5:
            continue
        herkunft = zeile[zeile.rfind("(") + 1: zeile.rfind(")")]
        if not herkunft or herkunft.startswith(":"):
            continue          # das ist der Bildschirm hier, keine Ferne
        if not lebt(teile[-2]):
            continue          # Karteileiche einer abgebrochenen Sitzung
        wer = benannt.get(herkunft, teile[0])
        if wer in EIGENE:
            continue
        aus.append((wer, herkunft, " ".join(teile[2:4])))
    return aus


def mischen(von, nach, anteil):
    """Zwei Farben mischen — für weiche Übergänge statt harter Sprünge."""
    a = [int(von[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(nach[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(int(x + (y - x) * anteil) for x, y in zip(a, b))


class Mitschrift(tk.Frame):
    """Der Bereich, der zeigt, was über SSH auf diesem Pi geschieht.

    Er lebt an zwei Orten: in seinem eigenen Fenster (die Klasse `Fenster`
    weiter unten) und als fester Bereich in der Stellium-Konsole. Damit beides
    dieselbe Mitschrift zeigt und gleich aussieht, wohnt hier alles, was mit
    Anzeigen zu tun hat — Kopf, Tagesauswahl, Verlauf. Das Fenster drumherum
    kümmert sich nur noch ums Auftauchen, Verschieben und Wegräumen.

    `sprachknopf` — das EN/DE oben rechts. In der Konsole nicht: die hat schon
                    einen eigenen und schaltet beide zusammen um.
    `klappen`     — was der Knopf ▾ tun soll, oder None für keinen Knopf.
    `schliessen`  — was der Knopf ✕ tun soll, oder None für keinen Knopf.
    `dauerhaft`   — der Bereich verschwindet nie. Dann steht die Tagesauswahl
                    immer bereit, denn es gibt nichts mehr, was sie verstecken
                    könnte, und wer hinsieht, will nachlesen können.
    `melden`      — wird nach jedem Nachsehen mit der Liste der laufenden
                    Sitzungen gerufen; daran hängt das Fenster sein Auf- und
                    Zumachen.
    """

    def __init__(self, eltern, sprachknopf=True, klappen=None, schliessen=None,
                 dauerhaft=False, melden=None):
        super().__init__(eltern, bg=FARBEN["grund"])
        self.dauerhaft = dauerhaft
        self.melden = melden

        eng = tkfont.Font(family="DejaVu Sans Mono", size=10)
        fett = tkfont.Font(family="DejaVu Sans", size=14, weight="bold")
        klein = tkfont.Font(family="DejaVu Sans", size=9)

        # ── Kopf: Farbverlauf statt flacher Fläche ──────────────
        self.kopf = tk.Canvas(self, height=KOPFHOCH, bd=0, highlightthickness=0,
                              bg=FARBEN["grund"])
        self.kopf.pack(fill="x")
        self.kopf.bind("<Configure>", self.kopf_malen)

        # Der Punkt atmet — so sieht man auf einen Blick, dass es lebt.
        self.punkt = self.kopf.create_oval(20, 26, 32, 38, fill=FARBEN["gut"], outline="")
        self.hof = self.kopf.create_oval(14, 20, 38, 44, fill="", outline=FARBEN["gut"], width=1)
        self.titel_id = self.kopf.create_text(
            48, 26, text=T("laeuft"), anchor="w", fill=FARBEN["tinte"], font=fett)
        self.wer_id = self.kopf.create_text(
            48, 48, text="", anchor="w", fill=FARBEN["leise"], font=klein)

        # Knöpfe als Text auf der Leinwand — dann tragen sie den Verlauf mit.
        # Es gibt sie nur, wo sie etwas bewirken: als Bereich in der Konsole
        # lässt sich nichts einklappen und nichts wegräumen.
        self.klappe_id = self.schliessen_id = self.sprach_id = None
        if klappen:
            self.klappe_id = self.kopf.create_text(
                0, 32, text="▾", anchor="e", fill=FARBEN["leise"], font=fett)
        if sprachknopf:
            # Ein Knopf, zwei Sprachen — die Wahl bleibt über Neustarts erhalten.
            self.sprach_id = self.kopf.create_text(
                0, 32, text="", anchor="e", fill=FARBEN["leise"],
                font=tkfont.Font(family="DejaVu Sans", size=10, weight="bold"))
            self.knopf_beleben(self.sprach_id, self.sprache_wechseln)
        if schliessen:
            self.schliessen_id = self.kopf.create_text(
                0, 32, text="✕", anchor="e", fill=FARBEN["leise"], font=fett, state="hidden")
        for kennung, was in ((self.klappe_id, klappen), (self.schliessen_id, schliessen)):
            if kennung is not None:
                self.knopf_beleben(kennung, was)

        # ── Tagesauswahl ────────────────────────────────────────
        # Nur beim Nachlesen sinnvoll: wer gerade zusieht, will das Laufende.
        self.leiste = tk.Frame(self, bg=FARBEN["grund"])
        self.tag_beschriftung = tk.Label(self.leiste, text=T("tag"), bg=FARBEN["grund"],
                                         fg=FARBEN["zeit"], font=klein)
        self.tag_beschriftung.pack(side="left", padx=(16, 8))
        # Zwei Größen für dieselbe Sache: `tag_wahl` hält den Tag, mit dem
        # gearbeitet wird ("heute" oder ein Datum), `tag_zeigt` das, was auf
        # dem Knopf steht. Sonst stünde dort das nackte Wort „heute" — auch im
        # Englischen und ohne den Zusatz „laufend".
        self.tag_wahl = tk.StringVar(value="heute")
        self.tag_zeigt = tk.StringVar(value=T("heute"))
        self.tag_menue = tk.OptionMenu(self.leiste, self.tag_wahl, "heute")
        self.tag_menue.config(bg=FARBEN["karte"], fg=FARBEN["tinte"], relief="flat",
                              highlightthickness=0, bd=0, activebackground=FARBEN["linie"],
                              activeforeground=FARBEN["tinte"], font=klein, cursor="hand2",
                              textvariable=self.tag_zeigt)
        self.tag_menue["menu"].config(bg=FARBEN["karte"], fg=FARBEN["tinte"],
                                      activebackground=FARBEN["rand"], bd=0)
        self.tag_menue.pack(side="left")

        # ── Fußzeile ────────────────────────────────────────────
        # Sie wird vor der Mitschrift gepackt und von unten her — sonst nimmt
        # sich der Verlauf in einem knappen Streifen den ganzen Platz und
        # Fußzeile und Tagesauswahl fallen unsichtbar hinten heraus.
        self.fuss = tk.Label(
            self, text=T("fuss"),
            fg=FARBEN["zeit"], bg=FARBEN["grund"], anchor="w", font=klein,
        )
        self.fuss.pack(side="bottom", fill="x", padx=16, pady=(0, 10))

        # ── Mitschrift ──────────────────────────────────────────
        self.rahmen = tk.Frame(self, bg=FARBEN["linie"], bd=0)
        self.rahmen.pack(side="top", fill="both", expand=True, padx=14, pady=(4, 10))

        # Die Höhe in Zeilen ist nur ein Wunsch — sie soll klein bleiben: was
        # übrig ist, holt sich der Verlauf ohnehin über `expand`. Stünde hier
        # eine große Zahl, verdrängte sie in der Konsole alles andere.
        self.text = tk.Text(
            self.rahmen, bg=FARBEN["tief"], fg=FARBEN["tinte"], font=eng, height=6,
            insertbackground=FARBEN["tinte"], relief="flat", padx=12, pady=10,
            wrap="word", state="disabled", spacing1=2, spacing3=1,
            selectbackground=FARBEN["rand"],
        )
        self.text.pack(fill="both", expand=True, padx=1, pady=1)
        # Umbrochene Fortsetzungen rücken ein, damit die Spalte stehen bleibt.
        self.text.tag_config("befehl", foreground=FARBEN["tinte"], lmargin2=96)
        self.text.tag_config("beginn", foreground=FARBEN["gut"])
        self.text.tag_config("ende", foreground=FARBEN["warn"])
        self.text.tag_config("zeit", foreground=FARBEN["zeit"])
        self.text.tag_config("strich", foreground=FARBEN["strich"])
        self.text.tag_config("datei", foreground=FARBEN["datei"])
        self.text.tag_config("leise", foreground=FARBEN["leise"])
        # Frisch Eingetroffenes leuchtet kurz auf und beruhigt sich dann.
        self.text.tag_config("frisch", foreground="#ffffff")

        self.namen = herkunft_namen()
        self.lebendig = True
        self.offen = False
        self.zaehler = 0
        self.takt = 0.0
        self.gezeigter_tag = "heute"
        self.tag_wahl.trace_add("write", lambda *_: self.tag_wechseln())
        if dauerhaft:
            self.tagesauswahl(True)
        self.atmen()

        self.warteschlange = queue.Queue()
        threading.Thread(target=self.mitlesen, daemon=True).start()
        # Erst nachsehen, wenn die Schleife läuft: `melden` greift auf das
        # Fenster zu, und das ist noch mitten im Aufbauen.
        self.after(100, self.nachsehen)
        self.after(300, self.abarbeiten)

    def knopf_beleben(self, kennung, was):
        """Einem Zeichen auf der Leinwand Klick und Aufleuchten beibringen."""
        self.kopf.tag_bind(kennung, "<Button-1>", lambda _e: was())
        self.kopf.tag_bind(kennung, "<Enter>",
                           lambda _e: self.kopf.itemconfig(kennung, fill=FARBEN["tinte"]))
        self.kopf.tag_bind(kennung, "<Leave>",
                           lambda _e: self.kopf.itemconfig(kennung, fill=FARBEN["leise"]))

    # ── Aussehen und Bewegung ───────────────────────────────────
    def kopf_malen(self, ereignis=None):
        """Farbverlauf und Knopfplätze neu setzen, wenn sich die Breite ändert.

        Die Breite kommt aus dem Ereignis, wenn es eines gibt: `winfo_width`
        hinkt beim Wachsen manchmal hinterher, und dann endete der Verlauf
        mitten im Kopf, wo vorher der Rand war.
        """
        breite = max(getattr(ereignis, "width", 0) or self.kopf.winfo_width(), 1)
        self.kopf.delete("verlauf")
        for y in range(KOPFHOCH):
            self.kopf.create_line(
                0, y, breite, y, tags="verlauf",
                fill=mischen(FARBEN["kopf1"], FARBEN["kopf2"], y / KOPFHOCH))
        # Ein violetter Faden ganz oben — das Erkennungszeichen von Stellium.
        self.kopf.create_line(0, 0, breite, 0, fill=FARBEN["rand"], width=2, tags="verlauf")
        self.kopf.tag_lower("verlauf")
        if self.klappe_id is not None:
            self.kopf.coords(self.klappe_id, breite - 18, 32)
        if self.schliessen_id is not None:
            self.kopf.coords(self.schliessen_id, breite - 46, 32)
        if self.sprach_id is not None:
            self.kopf.coords(self.sprach_id, breite - 74, 32)
            self.kopf.itemconfig(self.sprach_id, text="EN" if SPRACHE == "de" else "DE")

    def tage_auffrischen(self):
        """Die Auswahl mit den Tagen füllen, an denen etwas geschah."""
        tage = verfuegbare_tage()
        heute = time.strftime("%Y-%m-%d")
        eintraege = ["heute"] + [t for t in tage if t != heute]
        menue = self.tag_menue["menu"]
        menue.delete(0, "end")
        for eintrag in eintraege:
            beschriftung = T("heute") if eintrag == "heute" else eintrag
            menue.add_command(label=beschriftung,
                              command=lambda w=eintrag: self.tag_wahl.set(w))

    def tagesauswahl(self, zeigen):
        """Die Auswahl der Tage ein- oder ausblenden."""
        if zeigen and not self.leiste.winfo_ismapped():
            self.tage_auffrischen()
            self.leiste.pack(fill="x", pady=(6, 0), before=self.rahmen)
        elif not zeigen and self.leiste.winfo_ismapped():
            self.leiste.pack_forget()
            self.tag_wahl.set("heute")

    def koerper(self, zeigen):
        """Alles unter dem Kopf zeigen oder wegnehmen — fürs Einklappen."""
        if zeigen:
            # Erst die Fußzeile von unten, dann der Verlauf: in dieser
            # Reihenfolge bleibt für beide Platz.
            self.fuss.pack(side="bottom", fill="x", padx=16, pady=(0, 10))
            self.rahmen.pack(side="top", fill="both", expand=True, padx=14, pady=(4, 10))
        else:
            self.rahmen.pack_forget()
            self.fuss.pack_forget()
            self.leiste.pack_forget()

    def schliessknopf(self, zeigen):
        """Das ✕ nur anbieten, wenn es etwas wegzuräumen gibt."""
        if self.schliessen_id is not None:
            self.kopf.itemconfig(self.schliessen_id, state="normal" if zeigen else "hidden")

    def tag_wechseln(self):
        """Einen anderen Tag anzeigen — oder zurück ins Laufende."""
        tag = self.tag_wahl.get()
        self.tag_zeigt.set(T("heute") if tag == "heute" else tag)
        if tag == self.gezeigter_tag:
            return
        self.gezeigter_tag = tag
        self.text.config(state="normal")
        self.text.delete("1.0", "end")
        self.text.config(state="disabled")
        self.offen = False
        if tag == "heute":
            # Das Laufende kommt von selbst wieder — die Warteschlange füllt sich.
            self.zeigen("", T("live"))
            return
        eintraege = tag_lesen(tag)
        if not eintraege:
            self.zeigen("", T("nichts", tag=tag))
            return
        for uhr, text in eintraege:
            self.zeigen(uhr, text)

    def sprache_wechseln(self):
        """Am eigenen Knopf zwischen Deutsch und Englisch umschalten."""
        global SPRACHE
        SPRACHE = "en" if SPRACHE == "de" else "de"
        sprache_sichern()
        self.sprache_anwenden()

    def sprache_anwenden(self):
        """Die Beschriftungen in der eingestellten Sprache setzen.

        Der Verlauf bleibt stehen, wie er ist — nachträglich übersetzen hieße,
        Vergangenes umzuschreiben. Neues kommt in der neuen Sprache.
        """
        self.tag_beschriftung.config(text=T("tag"))
        self.fuss.config(text=T("fuss"))
        if self.gezeigter_tag == "heute":
            self.tag_zeigt.set(T("heute"))
        if self.leiste.winfo_ismapped():
            self.tage_auffrischen()
        self.kopf_malen()

    def setzen(self, titel=None, wer=None):
        if titel is not None:
            self.kopf.itemconfig(self.titel_id, text=titel)
        if wer is not None:
            self.kopf.itemconfig(self.wer_id, text=wer)

    def atmen(self):
        """Der Punkt pulsiert langsam, solange jemand verbunden ist.

        Eine ruhige Bewegung sagt „ich schaue zu" — ein starrer Punkt könnte
        auch ein eingefrorenes Fenster sein.
        """
        self.takt += 0.08
        welle = (math.sin(self.takt) + 1) / 2
        if self.lebendig:
            farbe = mischen("#116b4e", FARBEN["gut"], welle)
            hof = mischen(FARBEN["tief"], FARBEN["gut"], welle * 0.55)
            gross = 1.0 + welle * 0.8
        else:
            farbe, hof, gross = FARBEN["zeit"], FARBEN["tief"], 1.0
        self.kopf.itemconfig(self.punkt, fill=farbe)
        self.kopf.itemconfig(self.hof, outline=hof)
        mitte_x, mitte_y, r = 26, 32, 6
        self.kopf.coords(self.punkt, mitte_x - r, mitte_y - r, mitte_x + r, mitte_y + r)
        gr = r * (1.6 + gross * 0.5)
        self.kopf.coords(self.hof, mitte_x - gr, mitte_y - gr, mitte_x + gr, mitte_y + gr)
        self.after(60, self.atmen)

    # ── Sitzungen beobachten ────────────────────────────────────
    def nachsehen(self):
        """Wer ist gerade da? Der Kopf sagt es, das Fenster hört mit."""
        offen = sitzungen()
        if offen:
            self.lebendig = True
            self.namen = herkunft_namen()
            self.setzen(titel=(T("arbeitet", wer=offen[0][0]) if len(offen) == 1
                               else T("mehrere", n=len(offen))),
                        wer="   ·   ".join(f"{wer} · {herkunft}"
                                           for wer, herkunft, _seit in offen))
            # Wer zusieht, während jemand arbeitet, will das Laufende sehen —
            # die Tagesauswahl tritt so lange zurück. Im festen Bereich der
            # Konsole bleibt sie stehen: dort ist Platz genug für beides.
            if not self.dauerhaft:
                self.tagesauswahl(False)
        else:
            self.lebendig = False
            self.setzen(titel=T("protokoll"), wer=T("niemand"))
        if self.melden:
            self.melden(offen)
        self.after(int(TAKT * 1000), self.nachsehen)

    # ── Mitschrift lesen ────────────────────────────────────────
    def mitlesen(self):
        """Dem Journal folgen — und einer Datei, falls es eine gibt.

        Debian schreibt seit Bookworm nur noch ins Journal; eine eigene
        Logdatei entsteht erst, wenn rsyslog nachinstalliert wurde. Beides
        kann vorkommen, also wird genommen, was da ist.
        """
        if os.path.exists(LOG):
            self.datei_lesen()
        else:
            self.journal_lesen()

    def journal_lesen(self):
        """Das Journal als JSON lesen.

        Die Textausgabe von journalctl bricht lange Befehle über mehrere Zeilen
        um und stellt Rechnernamen davor — beides müsste man wieder auseinander
        pflücken. Als JSON kommt jede Meldung genau einmal und im Ganzen.
        """
        while True:
            try:
                lauf = subprocess.Popen(
                    ["journalctl", "-t", "stellium-ssh", "-f", "-n", "60",
                     "-o", "json", "--output-fields=MESSAGE,__REALTIME_TIMESTAMP"],
                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
                )
                for zeile in lauf.stdout:
                    try:
                        satz = json.loads(zeile)
                    except ValueError:
                        continue
                    text = satz.get("MESSAGE") or ""
                    if isinstance(text, list):        # Journal darf Bytes liefern
                        text = bytes(text).decode("utf-8", "replace")
                    roh = satz.get("__REALTIME_TIMESTAMP") or "0"
                    try:
                        uhr = time.strftime("%H:%M:%S", time.localtime(int(roh) / 1e6))
                    except ValueError:
                        uhr = "        "
                    self.warteschlange.put((uhr, text))
            except FileNotFoundError:
                return                      # kein journalctl — dann eben nichts
            except Exception:
                time.sleep(2.0)

    def datei_lesen(self):
        """Der Datei folgen, auch wenn sie zwischendurch gedreht wird."""
        while True:
            try:
                with open(LOG, "r", errors="replace") as f:
                    f.seek(0, os.SEEK_END)
                    while True:
                        zeile = f.readline()
                        if zeile:
                            self.warteschlange.put(("", zeile.rstrip("\n")))
                        else:
                            time.sleep(0.4)
                            if not os.path.exists(LOG):
                                break
            except FileNotFoundError:
                time.sleep(1.0)
            except Exception:
                time.sleep(2.0)

    def abarbeiten(self):
        while not self.warteschlange.empty():
            uhr, text = self.warteschlange.get()
            # Wer in einem alten Tag liest, soll nicht von Neuem überschrieben werden.
            if self.gezeigter_tag == "heute":
                self.zeigen(uhr, text)
        self.after(300, self.abarbeiten)

    def schreiben(self, stuecke):
        """Eine Zeile aus mehreren gefärbten Stücken setzen."""
        self.text.config(state="normal")
        anfang = self.text.index("end-1c")
        for inhalt, marke in stuecke:
            self.text.insert("end", inhalt, marke)
        self.text.insert("end", "\n")
        # Kurz aufleuchten lassen, damit das Auge das Neue findet.
        self.text.tag_add("frisch", anfang, "end-1c")
        self.after(700, lambda a=anfang: self._abklingen(a))
        # Nicht endlos wachsen lassen.
        if int(self.text.index("end-1c").split(".")[0]) > ZEILEN:
            self.text.delete("1.0", "2.0")
        self.text.see("end")
        self.text.config(state="disabled")

    def _abklingen(self, anfang):
        try:
            self.text.tag_remove("frisch", anfang, f"{anfang} lineend")
        except tk.TclError:
            pass

    def zeigen(self, uhr, text):
        """Eine Meldung einordnen und passend setzen.

        Der Aufbau folgt dem Verlauf einer Sitzung: sie beginnt, es geschieht
        etwas, sie endet. Die senkrechte Linie hält zusammen, was dazugehört —
        so sieht man auf einen Blick, welche Befehle zu welchem Besuch gehören.
        """
        zeit = (uhr + "  ") if uhr else ""
        if text.startswith("ÖFFNET"):
            wer = text[6:].strip()
            # "aryan von 1.2.3.4" sagt wenig — der Schlüssel weiß, wer es ist.
            adresse = wer.split(" von ")[-1].split()[0] if " von " in wer else ""
            name = self.namen.get(adresse)
            if name:
                wer = f"{name} · {adresse}"
            self.schreiben([(zeit, "zeit"), ("┌ ", "strich"), (T("geoeffnet"), "beginn"),
                            (f"  ·  {wer}" if wer else "", "leise")])
            self.offen = True
            self.zaehler = 0
        elif text.startswith("SCHLIESST"):
            anzahl = self.zaehler
            hinweis = (f"  ·  {anzahl} {T('befehl') if anzahl == 1 else T('befehle')}") if anzahl else ""
            self.schreiben([(zeit, "zeit"), ("└ ", "strich"), (T("geschlossen"), "ende"),
                            (hinweis, "leise")])
            self.offen = False
            self.schreiben([("", "leise")])
        elif text.startswith("DATEIEN"):
            self.schreiben([(zeit, "zeit"), ("│ ", "strich"), (T("dateien"), "datei"),
                            (f"  ·  {text[7:].strip()}", "leise")])
        else:
            self.zaehler += 1
            zeilen = [z for z in text.splitlines() if z.strip()]
            if not zeilen:
                return
            balken = "│ " if self.offen else "  "
            self.schreiben([(zeit, "zeit"), (balken, "strich"), (zeilen[0].strip(), "befehl")])
            # Mehrzeiliges eingerückt darunter, damit es zusammenhängend bleibt.
            for weiter in zeilen[1:]:
                self.schreiben([(" " * len(zeit), "zeit"), (balken, "strich"),
                                ("  " + weiter.strip(), "leise")])


class Fenster:
    """Das eigene Fenster um die Mitschrift herum — zum Nachlesen.

    Es geht nicht mehr von selbst auf. Früher sprang es hoch, sobald jemand
    über SSH arbeitete; seit die Mitschrift dauerhaft unten in der Konsole
    steht, sieht man dort ohnehin, was geschieht, und ein Fenster, das sich bei
    jeder Verbindung vordrängt, stört nur. Geöffnet wird es von Hand über
    „Fernzugriff-Protokoll" im Startmenü.

    Alles Inhaltliche macht die `Mitschrift` darin — hier geht es nur ums
    Verschieben, Einklappen und Schließen.
    """

    def __init__(self):
        self.wurzel = tk.Tk(className="stellium-fernzugriff")
        self.wurzel.title("Stellium — Fernzugriff")
        self.wurzel.configure(bg=FARBEN["grund"])
        self.wurzel.attributes("-topmost", True)
        # Ohne Fensterleiste: das Fenster bringt seine Knöpfe im Kopf mit und
        # lässt sich dort auch anfassen und verschieben.
        self.wurzel.overrideredirect(True)
        self.wurzel.geometry(f"{BREIT}x{HOCH}+40+40")
        try:
            self.wurzel.attributes("-alpha", 0.0)
        except tk.TclError:
            pass                        # ohne Compositor eben ohne Blende

        self.eingeklappt = False
        sprache_laden()

        # `dauerhaft`: wer das Fenster von Hand öffnet, will nachlesen — dann
        # steht die Tagesauswahl von Anfang an bereit.
        self.mitschrift = Mitschrift(self.wurzel, sprachknopf=True,
                                     klappen=self.umschalten,
                                     schliessen=self.schliessen,
                                     dauerhaft=True,
                                     melden=self.melden)
        self.mitschrift.pack(fill="both", expand=True)
        self.mitschrift.schliessknopf(True)
        # Verschieben: was keine Fensterleiste hat, muss man am Kopf anfassen können.
        self.mitschrift.kopf.bind("<Button-1>", self.griff_setzen)
        self.mitschrift.kopf.bind("<B1-Motion>", self.griff_ziehen)
        self.wurzel.protocol("WM_DELETE_WINDOW", self.schliessen)
        self.blende(1.0)

    # ── Auf- und abblenden ──────────────────────────────────────
    def blende(self, nach, schritt=0.12, danach=None):
        """Weich auf- oder abblenden statt hart erscheinen."""
        try:
            jetzt = float(self.wurzel.attributes("-alpha"))
        except (tk.TclError, ValueError):
            if danach:
                danach()
            return
        if abs(jetzt - nach) < 0.01:
            self.wurzel.attributes("-alpha", nach)
            if danach:
                danach()
            return
        weiter = jetzt + schritt if nach > jetzt else jetzt - schritt
        self.wurzel.attributes("-alpha", max(0.0, min(1.0, weiter)))
        self.wurzel.after(16, lambda: self.blende(nach, schritt, danach))

    def hoehe_ziehen(self, ziel, schritt=0):
        """Ein- und Ausklappen als Bewegung, nicht als Sprung."""
        jetzt = self.wurzel.winfo_height()
        if abs(jetzt - ziel) < 8 or schritt > 40:
            self.wurzel.geometry(f"{BREIT}x{ziel}+{self.wurzel.winfo_x()}+{self.wurzel.winfo_y()}")
            return
        # Je näher am Ziel, desto kleiner die Schritte — das wirkt weich.
        weiter = int(jetzt + (ziel - jetzt) * 0.28)
        self.wurzel.geometry(f"{BREIT}x{weiter}+{self.wurzel.winfo_x()}+{self.wurzel.winfo_y()}")
        self.wurzel.after(16, lambda: self.hoehe_ziehen(ziel, schritt + 1))

    # ── Verschieben ─────────────────────────────────────────────
    def griff_setzen(self, ereignis):
        self._griff = (ereignis.x_root, ereignis.y_root,
                       self.wurzel.winfo_x(), self.wurzel.winfo_y())

    def griff_ziehen(self, ereignis):
        if not getattr(self, "_griff", None):
            return
        zx, zy, fx, fy = self._griff
        self.wurzel.geometry(f"+{fx + ereignis.x_root - zx}+{fy + ereignis.y_root - zy}")

    # ── Ein- und ausklappen ─────────────────────────────────────
    def einklappen(self):
        if self.eingeklappt:
            return
        self.eingeklappt = True
        self.mitschrift.koerper(False)
        self.mitschrift.kopf.itemconfig(self.mitschrift.klappe_id, text="▴")
        self.hoehe_ziehen(KOPFHOCH)

    def ausklappen(self):
        if not self.eingeklappt:
            return
        self.eingeklappt = False
        self.mitschrift.namen = herkunft_namen(frisch=True)
        self.mitschrift.koerper(True)
        self.mitschrift.tagesauswahl(True)
        self.mitschrift.kopf.itemconfig(self.mitschrift.klappe_id, text="▾")
        self.hoehe_ziehen(HOCH)

    def umschalten(self):
        self.ausklappen() if self.eingeklappt else self.einklappen()

    # ── Was die Mitschrift beobachtet hat ───────────────────────
    def melden(self, _offen):
        """Nach jedem Nachsehen — hier bleibt nur die Klingel zu prüfen.

        Wird „Fernzugriff-Protokoll" noch einmal aufgerufen, während das
        Fenster schon läuft, legt der Aufruf eine Datei ab. Dann kommt dieses
        Fenster wieder nach vorn, statt dass ein zweites aufgeht.
        """
        if os.path.exists(RUFEN):
            try:
                os.remove(RUFEN)
            except OSError:
                pass
            self.ausklappen()
            self.wurzel.lift()
            self.blende(1.0)

    def schliessen(self):
        """Zumachen heißt zumachen — nachlesen kann man jederzeit wieder."""
        self.blende(0.0, danach=self.wurzel.destroy)


if __name__ == "__main__":
    # Eine Klingel, die noch vom Aufruf herumliegt, gehört nicht uns.
    try:
        os.remove(RUFEN)
    except OSError:
        pass
    Fenster().wurzel.mainloop()
