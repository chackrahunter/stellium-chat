#!/usr/bin/env python3
"""
Die Stellium-Konsole als Fenster.

Zeigt denselben Stand wie `stellium-konsole` im Terminal — nur eben zum
Anschauen statt zum Lesen. Die Zahlen kommen aus genau derselben Quelle
(`stellium-konsole json`), damit beide Anzeigen nie auseinanderlaufen.

Braucht nichts außer python3-tk.
"""
import json
import math
import os
import subprocess
import threading
import time
import tkinter as tk
from tkinter import font as tkfont

KONSOLE = ["/usr/bin/node", "/opt/stellium/server-setup/stellium-konsole.mjs", "json"]
TAKT = 2.0
SPRACHDATEI = os.path.expanduser("~/.config/stellium-konsole-sprache")

TEXTE = {
    "de": {
        "verbinden": "Verbinden", "chat": "Chat-Server", "aussen": "Weg nach außen",
        "leistung": "Leistung", "teile": "Bestandteile",
        "dienst": "Dienst", "uebersetzung": "Übersetzung", "modell": "Modell",
        "inhalt": "Inhalt", "datenbank": "Datenbank", "zertifikat": "Zertifikat",
        "sicherung": "Sicherung", "firewall": "Firewall", "netz": "Netz",
        "laeuft_seit": "Läuft seit", "auslagerung": "Auslagerung",
        "prozessor": "Prozessor", "speicher": "Speicher", "platte": "Platte",
        "temperatur": "Temperatur", "kerne": "Kerne", "frei": "frei",
        "laeuft_auto": "läuft · startet automatisch", "laeuft": "läuft",
        "aus": "AUS", "an": "an", "uebersetzung_aus": "aus",
        "kein_zert": "keines — Verbindung offen", "noch_keine": "noch keine",
        "stand": "Stand", "staende": "Stände", "tage": "noch {n} Tage",
        "eigenes_netz": "im eigenen Netz", "offen": "unverschlüsselt",
        "tunnel": "durch den Tunnel", "aktiv": "aktiv",
        "gesperrt": "{n} gesperrt", "wacht": "wacht, nichts gesperrt",
        "konten": "Konten", "kanaele": "Kanäle", "nachrichten": "Nachrichten",
        "ablage": "Dateiablage", "dateien": "Dateien", "belegt": "belegt",
        "empfangen": "empfangen", "gesendet": "gesendet",
        "fuss": "Aktualisiert sich alle zwei Sekunden  ·  im Terminal:  stellium-konsole",
        "verbinde": "verbinde …", "keine_verbindung": "Keine Verbindung zur Konsole: {f}",
        "tage_kurz": "Tage", "std": "Std", "min": "Min",
    },
    "en": {
        "verbinden": "Connect", "chat": "Chat server", "aussen": "Public access",
        "leistung": "Performance", "teile": "Components",
        "dienst": "Service", "uebersetzung": "Translation", "modell": "Model",
        "inhalt": "Content", "datenbank": "Database", "zertifikat": "Certificate",
        "sicherung": "Backups", "firewall": "Firewall", "netz": "Network",
        "laeuft_seit": "Uptime", "auslagerung": "Swap",
        "prozessor": "CPU", "speicher": "Memory", "platte": "Disk",
        "temperatur": "Temperature", "kerne": "cores", "frei": "free",
        "laeuft_auto": "running · starts automatically", "laeuft": "running",
        "aus": "OFF", "an": "on", "uebersetzung_aus": "off",
        "kein_zert": "none — connection is open", "noch_keine": "none yet",
        "stand": "backup", "staende": "backups", "tage": "{n} days left",
        "eigenes_netz": "on this network", "offen": "unencrypted",
        "tunnel": "through the tunnel", "aktiv": "active",
        "gesperrt": "{n} blocked", "wacht": "watching, nothing blocked",
        "konten": "accounts", "kanaele": "channels", "nachrichten": "messages",
        "ablage": "File storage", "dateien": "files", "belegt": "used",
        "empfangen": "received", "gesendet": "sent",
        "fuss": "Refreshes every two seconds  ·  in the terminal:  stellium-konsole",
        "verbinde": "connecting …", "keine_verbindung": "No connection to the console: {f}",
        "tage_kurz": "days", "std": "h", "min": "min",
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

# Dieselben Farben wie die Chat-App (packages/desktop/src/styles/tokens.css).
# Tk kennt keine Transparenz, deshalb sind die halbdurchsichtigen Werte der App
# hier auf den Grundton heruntergerechnet — das Ergebnis sieht gleich aus.
F = {
    "grund": "#05060f",      # --bg-void
    "tief": "#080b16",       # --bg-deep
    "karte": "#0e0f18",      # --bg-panel über dem Grund
    "karte2": "#111320",     # --bg-panel-2
    "erhoben": "#121526",    # --bg-elevated
    "linie": "#191a22",      # --line
    "linie_stark": "#232430",
    "tinte": "#eef1fb",      # --tx-hi
    "leise": "#a3a7bb",      # --tx-mid
    "zeit": "#6b6e80",       # --tx-lo
    "rand": "#7c5cff",       # --violet
    "rand_weich": "#9d86ff",
    "blau": "#22d3ee",       # --cyan
    "gut": "#34d399",        # --mint
    "warn": "#fbbf24",       # --amber
    "schlecht": "#fb7185",   # --rose
    "rosa": "#f472b6",
}

BREIT, HOCH, KOPFHOCH = 1020, 720, 84


def mischen(von, nach, anteil):
    a = [int(von[i:i + 2], 16) for i in (1, 3, 5)]
    b = [int(nach[i:i + 2], 16) for i in (1, 3, 5)]
    return "#%02x%02x%02x" % tuple(int(x + (y - x) * anteil) for x, y in zip(a, b))


def groesse(bytes_):
    if not bytes_:
        return "0 B"
    for einheit in ("B", "KB", "MB", "GB", "TB"):
        if abs(bytes_) < 1024 or einheit == "TB":
            return f"{bytes_:.0f} {einheit}" if einheit == "B" else f"{bytes_:.1f} {einheit}"
        bytes_ /= 1024
    return ""


def dauer(sekunden):
    tage, rest = divmod(int(sekunden), 86400)
    stunden, rest = divmod(rest, 3600)
    minuten = rest // 60
    if tage:
        return f"{tage} {T('tage_kurz')}, {stunden} {T('std')}"
    if stunden:
        return f"{stunden} {T('std')}, {minuten} {T('min')}"
    return f"{minuten} {T('min')}"


class Tacho(tk.Canvas):
    """Ein Messwert als Bogen.

    Zwei Dinge machen den Unterschied zu einem Balken: der Wert steht groß in
    der Mitte, und der Zeiger wandert weich statt zu springen — so sieht man
    Bewegung auch aus zwei Metern Abstand.
    """

    GROESSE = 132
    DICKE = 11
    ANFANG = 210          # oben links …
    WEITE = -240          # … im Uhrzeigersinn bis unten rechts

    def __init__(self, eltern, titel):
        super().__init__(eltern, width=self.GROESSE, height=self.GROESSE - 18,
                         bd=0, highlightthickness=0, bg=F["karte"])
        self.anteil = 0.0
        self.ziel = 0.0
        self.titel = titel
        self.unten = ""
        self.zahl_text = "—"
        self.malen()
        self.laufen()

    def setzen(self, anteil, zahl=None, unten=""):
        self.ziel = max(0.0, min(1.0, anteil or 0.0))
        self.zahl_text = zahl if zahl is not None else f"{round(self.ziel * 100)}%"
        self.unten = unten

    def laufen(self):
        if abs(self.anteil - self.ziel) > 0.003:
            # Weiche Annäherung: große Sprünge schnell, das letzte Stück ruhig.
            self.anteil += (self.ziel - self.anteil) * 0.18
            self.malen()
        self.after(40, self.laufen)

    def farbe(self):
        if self.anteil > 0.88:
            return F["schlecht"]
        if self.anteil > 0.72:
            return F["warn"]
        return F["gut"]

    def malen(self):
        self.delete("all")
        rand = self.DICKE / 2 + 6
        kasten = (rand, rand, self.GROESSE - rand, self.GROESSE - rand)

        # Der Grundbogen zeigt, wie weit es überhaupt gehen kann.
        self.create_arc(*kasten, start=self.ANFANG, extent=self.WEITE, style="arc",
                        width=self.DICKE, outline=F["linie"])

        weite = self.WEITE * self.anteil
        if abs(weite) > 0.6:
            self.create_arc(*kasten, start=self.ANFANG, extent=weite, style="arc",
                            width=self.DICKE, outline=self.farbe())
            # Ein Punkt am Ende des Bogens — das liest sich wie ein Zeiger.
            mitte = self.GROESSE / 2
            halb = (self.GROESSE - 2 * rand) / 2
            winkel = math.radians(self.ANFANG + weite)
            px = mitte + halb * math.cos(winkel)
            py = mitte - halb * math.sin(winkel)
            self.create_oval(px - 4, py - 4, px + 4, py + 4,
                             fill=self.farbe(), outline=F["karte"], width=2)

        self.create_text(self.GROESSE / 2, self.GROESSE / 2 - 4, text=self.zahl_text,
                         fill=F["tinte"],
                         font=tkfont.Font(family="DejaVu Sans", size=15, weight="bold"))
        self.create_text(self.GROESSE / 2, self.GROESSE / 2 + 16, text=self.titel,
                         fill=F["zeit"], font=tkfont.Font(family="DejaVu Sans", size=8))
        if self.unten:
            self.create_text(self.GROESSE / 2, self.GROESSE - 12, text=self.unten,
                             fill=F["leise"], font=tkfont.Font(family="DejaVu Sans", size=8))


class Karte(tk.Frame):
    """Ein abgesetzter Block mit Überschrift."""

    def __init__(self, eltern, titel_key, farbe=None):
        super().__init__(eltern, bg=F["karte"], highlightbackground=F["linie"],
                         highlightthickness=1, bd=0)
        self.titel_key = titel_key
        kopf = tk.Frame(self, bg=F["karte"])
        kopf.pack(fill="x", padx=16, pady=(12, 6))
        self.titel_label = tk.Label(kopf, text=T(titel_key), bg=F["karte"], fg=farbe or F["rand"],
                                    font=tkfont.Font(family="DejaVu Sans", size=11, weight="bold"),
                                    anchor="w")
        self.titel_label.pack(side="left")
        self.inhalt = tk.Frame(self, bg=F["karte"])
        self.inhalt.pack(fill="both", expand=True, padx=16, pady=(0, 12))
        self.zeilen = {}
        self.beschriftungen = {}
        self.tachos = {}

    def feld(self, name, wert, farbe=None, roh=None):
        """Eine Zeile setzen. `name` ist ein Schlüssel, `roh` eine feste Beschriftung."""
        if name not in self.zeilen:
            reihe = tk.Frame(self.inhalt, bg=F["karte"])
            reihe.pack(fill="x", pady=1)
            links = tk.Label(reihe, text=roh or T(name), bg=F["karte"], fg=F["zeit"], anchor="w",
                             width=16, font=tkfont.Font(family="DejaVu Sans", size=10))
            links.pack(side="left")
            if roh is None:
                self.beschriftungen[name] = links
            # Umbrechen statt abschneiden: lange Werte wie "8 Konten · 16 Kanäle
            # · 132 Nachrichten" passten sonst nicht in die Spalte.
            rechts = tk.Label(reihe, text="", bg=F["karte"], fg=F["tinte"], anchor="w",
                              justify="left", wraplength=1,
                              font=tkfont.Font(family="DejaVu Sans Mono", size=10))
            rechts.pack(side="left", fill="x", expand=True)
            reihe.bind("<Configure>",
                       lambda e, w=rechts: w.config(wraplength=max(e.width - 130, 120)))
            self.zeilen[name] = rechts
        self.zeilen[name].config(text=wert, fg=farbe or F["tinte"])

    def tacho(self, name, anteil, zahl=None, unten=""):
        """Einen Messwert als Bogen zeigen.

        Zwei nebeneinander, dann Umbruch: eine Reihe aus vier braucht über
        550 Pixel und fiel bei schmalem Fenster hinten heraus.
        """
        if not hasattr(self, "tacho_raster"):
            self.tacho_raster = tk.Frame(self.inhalt, bg=F["karte"])
            self.tacho_raster.pack(fill="x", pady=(2, 8))
            self.tacho_raster.columnconfigure(0, weight=1)
            self.tacho_raster.columnconfigure(1, weight=1)
        if name not in self.tachos:
            stelle = len(self.tachos)
            t = Tacho(self.tacho_raster, T(name))
            t.grid(row=stelle // 2, column=stelle % 2, padx=6, pady=4)
            self.tachos[name] = t
        self.tachos[name].titel = T(name)
        self.tachos[name].setzen(anteil, zahl, unten)

    def sprache_anwenden(self):
        self.titel_label.config(text=T(self.titel_key))
        for schluessel, label in self.beschriftungen.items():
            label.config(text=T(schluessel))
        for schluessel, t in self.tachos.items():
            t.titel = T(schluessel)
            t.malen()


def aurora(leinwand, breite, hoehe):
    """Der weiche Farbschimmer aus der App, mit den Mitteln von Tk.

    Die App legt drei große Farbverläufe über den Grund. Tk kann keine
    Transparenz, also entstehen sie hier aus ineinander liegenden Ovalen, die
    Ring für Ring zum Grundton hin verblassen. Wird nur bei Größenänderung
    gezeichnet — dazwischen kostet es nichts.
    """
    leinwand.delete("aurora")
    blasen = [
        (breite * 0.80, -hoehe * 0.10, max(breite, hoehe) * 0.75, F["rand"], 0.30),
        (breite * 0.08, hoehe * 1.05, max(breite, hoehe) * 0.62, F["blau"], 0.20),
        (breite * 0.98, hoehe * 0.80, max(breite, hoehe) * 0.52, F["rosa"], 0.17),
    ]
    ringe = 26
    for mx, my, r, farbe, staerke in blasen:
        for i in range(ringe, 0, -1):
            anteil = i / ringe
            ton = mischen(F["grund"], farbe, staerke * (1 - anteil) ** 2)
            gr = r * anteil
            leinwand.create_oval(mx - gr, my - gr, mx + gr, my + gr,
                                 fill=ton, outline="", tags="aurora")
    leinwand.tag_lower("aurora")


class Konsole:
    def __init__(self):
        self.wurzel = tk.Tk()
        self.wurzel.title("Stellium — Konsole")
        self.wurzel.configure(bg=F["grund"])
        self.wurzel.geometry(f"{BREIT}x{HOCH}")
        # Zwei Tachos (je 132) plus Ränder brauchen 340 je Spalte; darunter
        # klappen die Spalten untereinander, deshalb genügt eine Spaltenbreite.
        self.wurzel.minsize(380, 560)
        self.takt = 0.0
        self.stand = None

        gross = tkfont.Font(family="DejaVu Sans", size=17, weight="bold")
        klein = tkfont.Font(family="DejaVu Sans", size=9)

        # Eine Leinwand trägt alles: darauf liegen der Aurora-Schimmer und der
        # Kopf, und darüber schweben die Karten — genau wie in der App.
        self.buehne = tk.Canvas(self.wurzel, bd=0, highlightthickness=0, bg=F["grund"])
        self.buehne.pack(fill="both", expand=True)
        self.buehne.bind("<Configure>", self.buehne_richten)
        self.kopf = self.buehne          # Kopf-Elemente liegen auf derselben Leinwand

        self.stern = self.buehne.create_text(26, 36, text="✦", fill=F["rand"], font=gross)
        self.buehne.create_text(52, 36, text="Stellium", anchor="w", fill=F["tinte"], font=gross)
        self.version_id = self.buehne.create_text(160, 39, text="", anchor="w",
                                                  fill=F["leise"], font=klein)
        self.unterzeile = self.buehne.create_text(52, 60, text=T("verbinde"), anchor="w",
                                                  fill=F["zeit"], font=klein)

        # Sprache umschalten — ein Knopf, zwei Sprachen.
        self.sprach_knopf = self.buehne.create_text(
            0, 40, text="", anchor="e", fill=F["leise"],
            font=tkfont.Font(family="DejaVu Sans", size=10, weight="bold"))
        self.buehne.tag_bind(self.sprach_knopf, "<Button-1>", lambda _e: self.sprache_wechseln())
        self.buehne.tag_bind(self.sprach_knopf, "<Enter>",
                             lambda _e: self.buehne.itemconfig(self.sprach_knopf, fill=F["tinte"]))
        self.buehne.tag_bind(self.sprach_knopf, "<Leave>",
                             lambda _e: self.buehne.itemconfig(self.sprach_knopf, fill=F["leise"]))

        links = tk.Frame(self.buehne, bg=F["grund"])
        rechts = tk.Frame(self.buehne, bg=F["grund"])
        self.spalte_links = self.buehne.create_window(0, 0, window=links, anchor="nw")
        self.spalte_rechts = self.buehne.create_window(0, 0, window=rechts, anchor="nw")

        self.k_verbinden = Karte(links, "verbinden", F["blau"])
        self.k_verbinden.pack(fill="x", pady=(0, 12))
        self.adressen = tk.Frame(self.k_verbinden.inhalt, bg=F["karte"])
        self.adressen.pack(fill="x")

        self.k_chat = Karte(links, "chat", F["gut"])
        self.k_chat.pack(fill="x", pady=(0, 12))
        self.k_aussen = Karte(links, "aussen", F["blau"])
        self.k_aussen.pack(fill="x")

        self.k_leistung = Karte(rechts, "leistung", F["rand"])
        self.k_leistung.pack(fill="x", pady=(0, 12))
        self.k_teile = Karte(rechts, "teile", F["zeit"])
        self.k_teile.pack(fill="x")

        self.fuss_id = self.buehne.create_text(20, 0, text=T("fuss"), anchor="w",
                                               fill=F["zeit"], font=klein)


        threading.Thread(target=self.holen, daemon=True).start()
        sprache_laden()
        self.drehen()
        self.auffrischen()

    # ── Kopf ────────────────────────────────────────────────────
    def sprache_wechseln(self):
        global SPRACHE
        SPRACHE = "en" if SPRACHE == "de" else "de"
        sprache_sichern()
        for karte in (self.k_verbinden, self.k_chat, self.k_aussen,
                      self.k_leistung, self.k_teile):
            karte.sprache_anwenden()
        self.buehne.itemconfig(self.fuss_id, text=T("fuss"))
        self.adressen_stand = None      # Adressen mit neuen Hinweisen neu setzen
        self.buehne_richten()
        if self.stand:
            self.zeichnen(self.stand)

    def buehne_richten(self, _e=None):
        """Alles neu einpassen, wenn sich die Fenstergröße ändert."""
        breite = max(self.buehne.winfo_width(), 1)
        hoehe = max(self.buehne.winfo_height(), 1)

        aurora(self.buehne, breite, hoehe)
        # Ein violetter Faden ganz oben — das Erkennungszeichen von Stellium.
        self.buehne.delete("faden")
        self.buehne.create_line(0, 1, breite, 1, fill=F["rand"], width=2, tags="faden")

        self.buehne.coords(self.sprach_knopf, breite - 22, 40)
        self.buehne.itemconfig(self.sprach_knopf, text="EN" if SPRACHE == "de" else "DE")

        # Zwei Spalten, ab einer schmalen Breite untereinander.
        rand, luecke = 16, 16
        if breite < 780:
            spalte = breite - 2 * rand
            self.buehne.itemconfig(self.spalte_links, width=spalte)
            self.buehne.itemconfig(self.spalte_rechts, width=spalte)
            self.buehne.coords(self.spalte_links, rand, KOPFHOCH)
            links_hoch = self.buehne.bbox(self.spalte_links)
            versatz = (links_hoch[3] - links_hoch[1] + luecke) if links_hoch else 300
            self.buehne.coords(self.spalte_rechts, rand, KOPFHOCH + versatz)
        else:
            spalte = (breite - 2 * rand - luecke) / 2
            self.buehne.itemconfig(self.spalte_links, width=spalte)
            self.buehne.itemconfig(self.spalte_rechts, width=spalte)
            self.buehne.coords(self.spalte_links, rand, KOPFHOCH)
            self.buehne.coords(self.spalte_rechts, rand + spalte + luecke, KOPFHOCH)

        self.buehne.coords(self.fuss_id, 20, hoehe - 16)
        self.buehne.tag_raise(self.fuss_id)

    def sprache_wechseln(self):
        """Zwischen Deutsch und Englisch umschalten — und die Wahl merken."""
        global SPRACHE
        SPRACHE = "en" if SPRACHE == "de" else "de"
        sprache_sichern()
        for karte in (self.k_verbinden, self.k_chat, self.k_aussen,
                      self.k_leistung, self.k_teile):
            karte.sprache_anwenden()
        self.buehne.itemconfig(self.fuss_id, text=T("fuss"))
        self.adressen_stand = None      # Hinweise an den Adressen neu setzen
        self.buehne_richten()
        if self.stand and "fehler" not in self.stand:
            self.zeichnen(self.stand)

    def drehen(self):
        """Der Stern pulsiert leise — ein Zeichen, dass die Anzeige lebt."""
        self.takt += 0.06
        welle = (math.sin(self.takt) + 1) / 2
        self.kopf.itemconfig(self.stern, fill=mischen("#3c2f7a", F["rand"], welle))
        self.wurzel.after(60, self.drehen)

    # ── Daten ───────────────────────────────────────────────────
    def holen(self):
        while True:
            try:
                roh = subprocess.run(KONSOLE, capture_output=True, text=True, timeout=25)
                self.stand = json.loads(roh.stdout)
            except Exception as fehler:                     # noqa: BLE001
                self.stand = {"fehler": str(fehler)}
            time.sleep(TAKT)

    def auffrischen(self):
        d = self.stand
        if d and "fehler" not in d:
            self.zeichnen(d)
        elif d:
            self.kopf.itemconfig(self.unterzeile, text=T("keine_verbindung", f=d["fehler"][:70]))
        self.wurzel.after(600, self.auffrischen)

    def zeichnen(self, d):
        self.kopf.itemconfig(self.version_id, text=d.get("version") or "")
        self.kopf.itemconfig(self.unterzeile, text=(
            f"{d.get('modell') or ''}  ·  {time.strftime('%d.%m.%Y, %H:%M:%S')}"))

        # ── Adressen
        # Nur neu aufbauen, wenn sich wirklich etwas geändert hat. Vorher wurden die
        # Zeilen bei jedem Takt weggeworfen und neu gesetzt — das sah aus wie
        # Flackern, obwohl sich nichts tat.
        kennung = tuple((a["art"], a["url"]) for a in d.get("adressen", []))
        if kennung == getattr(self, "adressen_stand", None):
            self.rest_zeichnen(d)
            return
        self.adressen_stand = kennung
        for kind in self.adressen.winfo_children():
            kind.destroy()
        art_farbe = {"sicher": (F["gut"], "🔒"), "tunnel": (F["gut"], "🔒"),
                     "offen": (F["warn"], "⚠"), "lokal": (F["zeit"], "·")}
        gezeigt = 0
        for a in d.get("adressen", []):
            if a["art"] == "lokal" and gezeigt >= 4:
                continue
            farbe, zeichen = art_farbe.get(a["art"], (F["leise"], "·"))
            reihe = tk.Frame(self.adressen, bg=F["karte"])
            reihe.pack(fill="x", pady=1)
            tk.Label(reihe, text=zeichen, bg=F["karte"], fg=farbe, width=3,
                     font=tkfont.Font(family="DejaVu Sans", size=10)).pack(side="left")
            tk.Label(reihe, text=a["url"], bg=F["karte"],
                     fg=F["blau"] if a["art"] in ("sicher", "tunnel") else F["tinte"],
                     anchor="w", font=tkfont.Font(family="DejaVu Sans Mono", size=10)
                     ).pack(side="left")
            hinweis = {"offen": T("offen"), "lokal": T("eigenes_netz"),
                       "tunnel": T("tunnel")}.get(a["art"], "")
            if hinweis:
                tk.Label(reihe, text=f"   {hinweis}", bg=F["karte"], fg=F["zeit"], anchor="w",
                         font=tkfont.Font(family="DejaVu Sans", size=9)).pack(side="left")
            gezeigt += 1

        self.rest_zeichnen(d)

    def rest_zeichnen(self, d):
        # ── Chat-Server
        dienste = d.get("dienste", {})
        chat = dienste.get("chat", {})
        self.k_chat.feld("dienst",
                         T("laeuft_auto") if chat.get("an") and chat.get("auto")
                         else T("laeuft") if chat.get("an") else T("aus"),
                         F["gut"] if chat.get("an") and chat.get("auto")
                         else F["warn"] if chat.get("an") else F["schlecht"])
        ki = d.get("ki")
        if ki:
            an = ki.get("provider") and ki["provider"] != "demo"
            self.k_chat.feld("uebersetzung", f"{T('an')} · {ki['provider']}" if an
                             else T("uebersetzung_aus"),
                             F["gut"] if an else F["warn"])
            if ki.get("model"):
                self.k_chat.feld("modell", ki["model"])
        inhalt = d.get("inhalt") or {}
        teile = [f"{inhalt[k]} {T(n)}" for k, n in
                 (("users", "konten"), ("channels", "kanaele"), ("messages", "nachrichten"))
                 if inhalt.get(k) is not None]
        if teile:
            self.k_chat.feld("inhalt", "  ·  ".join(teile))
        if inhalt.get("groesse"):
            self.k_chat.feld("datenbank", groesse(inhalt["groesse"]))

        abl = d.get("ablage") or {}
        if abl.get("dateien"):
            teil = f"{groesse(abl['belegt'])} {T('belegt')}  ·  {abl['dateien']} {T('dateien')}"
            if abl.get("frei") is not None:
                teil += f"  ·  {groesse(abl['frei'])} {T('frei')}"
            self.k_chat.feld("ablage", teil)

        # ── Weg nach außen
        web = dienste.get("web", {})
        self.k_aussen.feld("nginx",
                           T("laeuft_auto") if web.get("an") and web.get("auto")
                           else T("laeuft") if web.get("an") else T("aus"),
                           F["gut"] if web.get("an") else F["schlecht"], roh="nginx")
        zert = d.get("zertifikat")
        if zert:
            tage = zert.get("tage", 0)
            self.k_aussen.feld("zertifikat", f"{zert['name']} · {T('tage', n=tage)}",
                               F["schlecht"] if tage < 10 else F["warn"] if tage < 25 else F["gut"])
        else:
            self.k_aussen.feld("zertifikat", T("kein_zert"), F["warn"])
        if d.get("firewall") is not None:
            self.k_aussen.feld("firewall", T("aktiv") if d["firewall"] else T("aus"),
                               F["gut"] if d["firewall"] else F["schlecht"])
        if d.get("gesperrt") is not None:
            n = d["gesperrt"]
            self.k_aussen.feld("fail2ban", T("gesperrt", n=n) if n else T("wacht"),
                               F["warn"] if n else F["gut"], roh="fail2ban")
        sicherung = d.get("sicherung")
        anzahl = sicherung["anzahl"] if sicherung else 0
        self.k_aussen.feld("sicherung",
                           f"{anzahl} {T('stand')}" if anzahl == 1
                           else f"{anzahl} {T('staende')}" if anzahl else T("noch_keine"),
                           F["gut"] if sicherung else F["warn"])

        # ── Leistung
        L = d.get("leistung", {})
        self.k_leistung.tacho("prozessor", L.get("cpu"),
                              unten=f"{L.get('kerne', '?')} {T('kerne')}"
                                    + (f" · {round(L['mhz'] / 1000, 1)} GHz" if L.get("mhz") else ""))
        self.k_leistung.tacho("speicher", L.get("ramAnteil"),
                              unten=f"{groesse(L.get('ramBelegt'))} / {groesse(L.get('ramGesamt'))}")
        if L.get("platte"):
            pl = L["platte"]
            self.k_leistung.tacho("platte", pl["belegt"] / max(pl["gesamt"], 1),
                                  unten=f"{groesse(pl['gesamt'] - pl['belegt'])} {T('frei')}")
        abl = d.get("ablage") or {}
        if abl.get("gesamt"):
            # Nicht der Anteil der Ablage an der Platte, sondern wie voll die
            # Platte ist, auf der sie liegt — das ist die Zahl, die zählt.
            self.k_leistung.tacho("ablage",
                                  1 - (abl["frei"] or 0) / max(abl["gesamt"], 1),
                                  unten=f"{groesse(abl['belegt'])} {T('belegt')}")

        temperaturen = L.get("temperaturen", [])
        if temperaturen:
            grad = temperaturen[0]["grad"]
            # 40 °C ist kühl, 85 °C die Grenze — dazwischen wird der Bogen voll.
            self.k_leistung.tacho("temperatur", max(0.0, min(1.0, (grad - 40) / 45)),
                                  zahl=f"{round(grad)}°", unten=T("prozessor"))

        if L.get("swap") and L["swap"]["belegt"] > 0:
            sw = L["swap"]
            self.k_leistung.feld("auslagerung",
                                 f"{groesse(sw['belegt'])} von {groesse(sw['gesamt'])}", F["warn"])
        if L.get("netz"):
            self.k_leistung.feld("netz", f"{groesse(L['netz']['rein'])} {T('empfangen')}"
                                         f"  ·  {groesse(L['netz']['raus'])} {T('gesendet')}")
        self.k_leistung.feld("laeuft_seit", dauer(L.get("laufzeit", 0)))

        for t in d.get("bestandteile", []):
            self.k_teile.feld(t["name"], t["fassung"], roh=t["name"])


if __name__ == "__main__":
    Konsole().wurzel.mainloop()
