#!/usr/bin/env python3
"""
Die Stellium-Konsole als Fenster.

Zeigt denselben Stand wie `stellium-konsole` im Terminal — nur eben zum
Anschauen statt zum Lesen. Die Zahlen kommen aus genau derselben Quelle
(`stellium-konsole json`), damit beide Anzeigen nie auseinanderlaufen.

Zwei Betriebsarten:

  ohne Zusatz     ein gewöhnliches Fenster, das man öffnet und schließt.
  --hintergrund   der lebende Schreibtischgrund: randlos, ganz hinten, auf
                  allen Arbeitsflächen, ohne Eintrag in der Fensterleiste.
                  Wie das genau geht, steht bei `hintergrund_einrichten`.

Unten sitzt der Fernzugriff: derselbe Bereich, den auch das eigenständige
Wächterfenster zeigt (ssh-wache/wache.py) — hier fest eingebaut, statt
aufzuspringen.

Braucht nichts außer python3-tk.
"""
import glob
import importlib.util
import json
import math
import os
import re
import shlex
import subprocess
import sys
import threading
import time
import tkinter as tk
from tkinter import font as tkfont

KONSOLE = ["/usr/bin/node", "/opt/stellium/server-setup/stellium-konsole.mjs", "json"]
TAKT = 2.0
SPRACHDATEI = os.path.expanduser("~/.config/stellium-konsole-sprache")

# Aufruf mit „--hintergrund" macht aus dem Fenster den Schreibtischgrund.
HINTERGRUND = "--hintergrund" in sys.argv[1:]

# Woran der Fenstermanager seine Regel festmacht: der Klassenname des Fensters
# (bei labwc <windowRule identifier="…">). Nur im Hintergrundbetrieb heißt das
# Fenster so — eine von Hand geöffnete Konsole soll ein gewöhnliches Fenster
# bleiben und nicht ebenfalls nach ganz hinten rutschen.
FENSTERKLASSE = "stellium-hintergrund" if HINTERGRUND else "stellium-konsole"

# Wo die Mitschrift des Fernzugriffs zu finden ist. Sie bleibt ein eigenes
# Programm; hier wird nur ihr Anzeigeteil geholt und als Bereich eingesetzt,
# damit beide Fassungen dasselbe zeigen und niemand zwei pflegen muss.
WACHE_ORTE = (
    "/usr/local/lib/stellium/ssh-wache.py",                  # so liegt sie auf dem Pi
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "ssh-wache.py"),
    os.path.join(os.path.dirname(os.path.abspath(__file__)),
                 os.pardir, "ssh-wache", "wache.py"),        # so liegt sie im Quelltext
)


def wache_holen():
    """Den Anzeigeteil der SSH-Wache nachladen, wenn es ihn gibt.

    Bewusst über den Dateipfad statt über `import`: die Datei heißt auf dem Pi
    anders als im Quelltext und liegt in keinem Modulpfad. Findet sie sich
    nicht oder lässt sie sich nicht laden, läuft die Konsole ohne diesen
    Bereich weiter — sie ist nicht darauf angewiesen.
    """
    for ort in WACHE_ORTE:
        if not os.path.isfile(ort):
            continue
        try:
            angabe = importlib.util.spec_from_file_location("stellium_wache", ort)
            teil = importlib.util.module_from_spec(angabe)
            angabe.loader.exec_module(teil)
            return teil
        except Exception:                              # noqa: BLE001
            return None                                # lieber ohne als halb
    return None


WACHE = wache_holen()

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
        "stumm": "antwortet nicht", "ohne_modell": "kein Modell geladen",
        "seit": "seit", "nie_erreicht": "noch nie erreicht",
        "kein_zert": "keines — Verbindung offen", "noch_keine": "noch keine",
        "stand": "Stand", "staende": "Stände", "tage": "noch {n} Tage",
        "eigenes_netz": "im eigenen Netz", "offen": "unverschlüsselt",
        "tunnel": "durch den Tunnel", "aktiv": "aktiv",
        "gesperrt": "{n} gesperrt", "wacht": "wacht, nichts gesperrt",
        "konten": "Konten", "kanaele": "Kanäle", "nachrichten": "Nachrichten",
        "ablage": "Dateiablage", "dateien": "Dateien", "belegt": "belegt",
        "verbunden": "Verbunden", "verbindung": "Verbindung", "verbindungen": "Verbindungen",
        "person": "Person", "personen": "Personen", "niemand": "niemand",
        "empfangen": "empfangen", "gesendet": "gesendet",
        "fuss": "Aktualisiert sich alle zwei Sekunden  ·  im Terminal:  stellium-konsole",
        "verbinde": "verbinde …", "keine_verbindung": "Keine Verbindung zur Konsole: {f}",
        "tage_kurz": "Tage", "std": "Std", "min": "Min",
        # ── Ablage: die Leiste mit den Plätzen
        "ablage_titel": "Schnellzugriff",
        "ablage_hinweis": "Klicken zum Ablegen  ·  Umschalt und Klick zum Ändern",
        "was_ablegen": "Was soll hier liegen?",
        "art_anwendung": "Anwendung", "art_ordner": "Ordner", "art_datei": "Datei",
        "abbrechen": "Abbrechen", "ablegen": "Ablegen", "oeffnen": "Öffnen",
        "entfernen": "Entfernen", "austauschen": "Austauschen",
        "eintrag_aendern": "Diesen Platz ändern",
        "hoeher": "⟵  eine Ebene höher",
        "nichts_hier": "Hier ist nichts.",
        "fehlt": "nicht mehr da",
        "fehlt_lang": "„{name}“ gibt es nicht mehr. Entfernen oder austauschen?",
        "geht_nicht": "Ließ sich nicht öffnen.",
        "ordner_hier": "diesen Ordner nehmen",
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
        "stumm": "not responding", "ohne_modell": "no model loaded",
        "seit": "since", "nie_erreicht": "never reached",
        "kein_zert": "none — connection is open", "noch_keine": "none yet",
        "stand": "backup", "staende": "backups", "tage": "{n} days left",
        "eigenes_netz": "on this network", "offen": "unencrypted",
        "tunnel": "through the tunnel", "aktiv": "active",
        "gesperrt": "{n} blocked", "wacht": "watching, nothing blocked",
        "konten": "accounts", "kanaele": "channels", "nachrichten": "messages",
        "ablage": "File storage", "dateien": "files", "belegt": "used",
        "verbunden": "Connected", "verbindung": "connection", "verbindungen": "connections",
        "person": "person", "personen": "people", "niemand": "nobody",
        "empfangen": "received", "gesendet": "sent",
        "fuss": "Refreshes every two seconds  ·  in the terminal:  stellium-konsole",
        "verbinde": "connecting …", "keine_verbindung": "No connection to the console: {f}",
        "tage_kurz": "days", "std": "h", "min": "min",
        # ── Ablage: die Leiste mit den Plätzen
        "ablage_titel": "Quick access",
        "ablage_hinweis": "Click to place  ·  shift-click to change",
        "was_ablegen": "What goes here?",
        "art_anwendung": "Application", "art_ordner": "Folder", "art_datei": "File",
        "abbrechen": "Cancel", "ablegen": "Place", "oeffnen": "Open",
        "entfernen": "Remove", "austauschen": "Replace",
        "eintrag_aendern": "Change this slot",
        "hoeher": "⟵  one level up",
        "nichts_hier": "Nothing here.",
        "fehlt": "gone",
        "fehlt_lang": "“{name}” is no longer there. Remove or replace?",
        "geht_nicht": "Could not open it.",
        "ordner_hier": "take this folder",
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

# Notmaß für den Hintergrundbetrieb ohne Fensterregel: so hoch ist die Leiste
# am oberen Rand ungefähr. Mit Regel rechnet labwc das selbst und genauer.
RAND_OBEN = 40

# Der Fernzugriff unten bekommt gut ein Viertel der Höhe, aber nie weniger als
# nötig, um Kopf, Tagesauswahl und ein paar Zeilen Verlauf zu zeigen — und nie
# so viel, dass er den Karten darüber die Luft nimmt.
BAND_MIN, BAND_MAX = 210, 340


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


# ── Ablage: Anwendungen, Ordner und Dateien griffbereit ─────────
# Was dort liegt, steht in einer kleinen Datei neben der Spracheinstellung —
# so ist es nach dem Neustart noch da.
ABLAGEDATEI = os.path.expanduser("~/.config/stellium-konsole-ablage.json")
ANWENDUNGSORTE = ("/usr/share/applications", "/usr/local/share/applications",
                  os.path.expanduser("~/.local/share/applications"))
SYMBOLORTE = ("/usr/share/icons", "/usr/local/share/icons",
              os.path.expanduser("~/.local/share/icons"))
# Von groß nach klein gesucht: lieber ein Symbol herunterrechnen als ein
# kleines aufblasen — Tk kann nur ganzzahlig verkleinern, nicht schärfen.
SYMBOLGROESSEN = ("64x64", "48x48", "96x96", "128x128", "32x32", "256x256", "24x24")


def ablage_laden():
    """Die abgelegten Einträge holen — und Unsinn in der Datei überstehen."""
    try:
        with open(ABLAGEDATEI) as f:
            daten = json.load(f)
        eintraege = daten.get("eintraege")
    except (OSError, ValueError, AttributeError):
        return []
    if not isinstance(eintraege, list):
        return []
    return [e for e in eintraege if isinstance(e, dict) and e.get("pfad")]


def ablage_sichern(eintraege):
    try:
        os.makedirs(os.path.dirname(ABLAGEDATEI), exist_ok=True)
        with open(ABLAGEDATEI, "w") as f:
            json.dump({"eintraege": eintraege}, f, ensure_ascii=False, indent=1)
    except OSError:
        pass


def desktop_lesen(pfad):
    """Die Angaben aus einer .desktop-Datei holen.

    Gelesen wird nur der Abschnitt [Desktop Entry]; alles danach sind
    Zusatzaktionen, die hier nichts zu suchen haben.
    """
    angaben = {}
    drin = False
    try:
        with open(pfad, encoding="utf-8", errors="replace") as f:
            for zeile in f:
                zeile = zeile.strip()
                if zeile.startswith("["):
                    drin = zeile == "[Desktop Entry]"
                    continue
                if drin and "=" in zeile and not zeile.startswith("#"):
                    schluessel, wert = zeile.split("=", 1)
                    angaben.setdefault(schluessel.strip(), wert.strip())
    except OSError:
        return {}
    return angaben


def desktop_name(angaben, ersatz=""):
    """Der Name in der eingestellten Sprache, wenn die Datei einen anbietet."""
    return (angaben.get(f"Name[{SPRACHE}]") or angaben.get("Name") or ersatz)


def anwendungen_finden():
    """Alle Anwendungen, die auch im Startmenü stehen — Name, Datei, Symbol."""
    gefunden = {}
    for ort in ANWENDUNGSORTE:
        for pfad in sorted(glob.glob(os.path.join(ort, "*.desktop"))):
            angaben = desktop_lesen(pfad)
            if angaben.get("Type", "Application") != "Application":
                continue
            if angaben.get("NoDisplay", "").lower() == "true":
                continue
            name = desktop_name(angaben)
            if not name:
                continue
            # Spätere Orte überschreiben frühere: was im Heimordner liegt,
            # gilt vor dem, was das System mitbringt.
            gefunden[os.path.basename(pfad)] = (name, pfad, angaben.get("Icon", ""))
    return sorted(gefunden.values(), key=lambda e: e[0].lower())


def symboldatei(name):
    """Zu einem Symbolnamen die passende Bilddatei suchen.

    Tk liest PNG und GIF, kein SVG und kein XPM — deshalb wird auch nur danach
    gesucht. Findet sich nichts, malt die Ablage selbst ein Zeichen.
    """
    if not name:
        return None
    if os.path.isabs(name):
        return name if os.path.isfile(name) and name.endswith((".png", ".gif")) else None
    for groesse in SYMBOLGROESSEN:
        for ort in SYMBOLORTE:
            treffer = glob.glob(os.path.join(ort, "*", groesse, "*", name + ".png"))
            if treffer:
                return treffer[0]
    for ort in ("/usr/share/pixmaps", "/usr/share/icons"):
        treffer = glob.glob(os.path.join(ort, name + ".png"))
        if treffer:
            return treffer[0]
    return None


def eintrag_da(eintrag):
    """Gibt es noch, was da abgelegt wurde?"""
    return bool(eintrag.get("pfad")) and os.path.exists(eintrag["pfad"])


def eintrag_oeffnen(eintrag):
    """Das Abgelegte starten. Gibt zurück, ob es geklappt hat."""
    pfad = eintrag.get("pfad", "")
    try:
        if eintrag.get("art") == "anwendung":
            angaben = desktop_lesen(pfad)
            # Die Platzhalter in Exec stehen für Dateien, die wir nicht
            # mitgeben — sie müssen raus, sonst startet nichts oder das
            # Programm bekommt "%U" als Dateinamen untergeschoben.
            befehl = re.sub(r"%[a-zA-Z]", "", angaben.get("Exec", "")).strip()
            if not befehl:
                return False
            teile = shlex.split(befehl)
            if angaben.get("Terminal", "").lower() == "true":
                teile = ["x-terminal-emulator", "-e"] + teile
            subprocess.Popen(teile, start_new_session=True)
        else:
            # Ordner und Dateien überlässt man am besten dem System: es weiß,
            # welcher Dateimanager und welches Programm zuständig sind.
            subprocess.Popen(["xdg-open", pfad], start_new_session=True)
        return True
    except Exception:                                   # noqa: BLE001
        return False


def prozent(anteil):
    """Ein Anteil als Prozentzahl — kleine Werte mit einer Stelle hinter dem Komma.

    109 MB auf einer 50-GB-Platte sind 0,2 %. Auf null gerundet sähe die
    Anzeige aus, als wäre sie kaputt — eine Stelle mehr sagt genau das, was
    los ist.
    """
    wert = (anteil or 0.0) * 100
    if 0 < wert < 0.05:
        # Noch feiner aufzuschlüsseln bringt nichts — „fast nichts" ist die
        # Aussage, und die steht so am kürzesten da.
        return "<0,1%" if SPRACHE == "de" else "<0.1%"
    if 0 < wert < 9.5:
        text = f"{wert:.1f}"
        return (text.replace(".", ",") if SPRACHE == "de" else text) + "%"
    return f"{round(wert)}%"


def dauer(sekunden):
    tage, rest = divmod(int(sekunden), 86400)
    stunden, rest = divmod(rest, 3600)
    minuten = rest // 60
    if tage:
        return f"{tage} {T('tage_kurz')}, {stunden} {T('std')}"
    if stunden:
        return f"{stunden} {T('std')}, {minuten} {T('min')}"
    return f"{minuten} {T('min')}"


def seit_wann(zeitpunkt):
    """Wie lange ist das her — knapp, in Worten.

    Nur der grobe Abstand: bei einem stummen Modell will man wissen, ob es
    seit Minuten oder seit Stunden schweigt. Die genaue Uhrzeit hilft dabei
    nicht, und sie stünde in einer Zeile, in der ohnehin wenig Platz ist.
    """
    if not zeitpunkt:
        return None
    sekunden = max(0, int(time.time() - zeitpunkt / 1000))
    if sekunden < 90:
        return f"{sekunden}s"
    if sekunden < 5400:
        return f"{sekunden // 60} min"
    if sekunden < 172800:
        return f"{sekunden // 3600} h"
    return f"{sekunden // 86400} d"


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
        ziel = max(0.0, min(1.0, anteil or 0.0))
        text = zahl if zahl is not None else prozent(ziel)
        neu = (text != self.zahl_text or unten != self.unten)
        self.ziel = ziel
        self.zahl_text = text
        self.unten = unten
        if abs(self.anteil - self.ziel) <= 0.003:
            # Zu wenig für die weiche Annäherung. Ohne diesen Sprung bliebe ein
            # winziger Wert — 0,2 % der Platte etwa — für immer bei null
            # stehen, und der Bogen sähe aus, als rechne er gar nicht.
            self.anteil = self.ziel
            neu = True
        if neu:
            self.malen()

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
        if 0 < self.anteil < 0.011:
            # Ein sehr kleiner Anteil bekommt trotzdem einen sichtbaren Anfang:
            # unter zweieinhalb Grad bliebe vom Bogen nichts übrig.
            weite = math.copysign(2.5, self.WEITE)
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


class Ablage:
    """Die Leiste mit Plätzen für Anwendungen, Ordner und Dateien.

    Sie wird nicht aus Widgets gebaut, sondern direkt auf die Leinwand
    gezeichnet — dorthin, wo unter der linken Spalte Platz frei bleibt. Das
    hält sie leicht und beweglich: Sie teilt sich bei jeder Größenänderung neu
    auf, und wie viele Plätze nebeneinander passen, ergibt sich aus der
    Fläche statt aus einer festen Zahl.

    Die Einträge stehen als Liste in einer Datei. Sie füllen die Plätze von
    links oben nach rechts unten; wird die Fläche kleiner, rücken sie
    zusammen, statt verlorenzugehen.
    """

    BREIT_MIN = 108        # schmaler wird ein Platz nicht
    HOCH_MIN = 58          # darunter passt kein Symbol mit Namen mehr
    HOCH_MAX = 96
    LUECKE = 10
    REIHEN = 2

    def __init__(self, konsole):
        self.k = konsole
        self.buehne = konsole.buehne
        self.eintraege = ablage_laden()
        self.bilder = {}                # Tk hält Bilder nur, solange man sie festhält
        self.flaeche = None             # (x, y, breite, hoehe)
        self.stand = None               # woraus das letzte Bild entstand
        self.plaetze = []               # (index, x, y, breite, hoehe)
        self.warm = {}                  # Platz → wohin die Helligkeit will
        self.helligkeit = {}            # Platz → wo sie gerade steht
        self.laufen()

    # ── Platz einteilen ─────────────────────────────────────────
    def setzen(self, x, y, breite, hoehe):
        """Sagen, wo Platz ist. Gezeichnet wird nur, wenn sich etwas ändert."""
        self.flaeche = (x, y, breite, hoehe)
        self.pruefen()

    def pruefen(self):
        if self.flaeche is None:
            return
        x, y, breite, hoehe = self.flaeche
        stand = (x, y, breite, hoehe, len(self.eintraege), SPRACHE,
                 tuple(e.get("pfad", "") for e in self.eintraege))
        if stand == self.stand:
            return
        self.stand = stand
        self.zeichnen()

    def zeichnen(self):
        self.buehne.delete("ablage")
        self.plaetze = []
        self.warm = {}
        self.helligkeit = {}
        if self.flaeche is None:
            return
        x, y, breite, hoehe = self.flaeche
        klein = tkfont.Font(family="DejaVu Sans", size=8)
        kopf = tkfont.Font(family="DejaVu Sans", size=9, weight="bold")

        # Überschrift und Hinweis kosten Höhe — nur wenn sie übrig ist.
        kopfhoch = 0
        if hoehe >= 2 * self.HOCH_MIN + self.LUECKE + 22:
            self.buehne.create_text(x, y, text=T("ablage_titel"), anchor="nw",
                                    fill=F["zeit"], font=kopf, tags="ablage")
            self.buehne.create_text(x + breite, y + 1, text=T("ablage_hinweis"), anchor="ne",
                                    fill=F["linie_stark"], font=klein, tags="ablage")
            kopfhoch = 22
        y += kopfhoch
        hoehe -= kopfhoch

        reihen = self.REIHEN
        kachel_h = (hoehe - self.LUECKE * (reihen - 1)) / reihen
        if kachel_h < self.HOCH_MIN:
            reihen = 1
            kachel_h = hoehe
        if kachel_h < self.HOCH_MIN:
            return                      # zu wenig Luft — dann lieber gar nichts
        kachel_h = min(kachel_h, self.HOCH_MAX)

        spalten = max(1, int((breite + self.LUECKE) // (self.BREIT_MIN + self.LUECKE)))
        kachel_b = (breite - self.LUECKE * (spalten - 1)) / spalten

        for stelle in range(spalten * reihen):
            spalte, reihe = stelle % spalten, stelle // spalten
            kx = x + spalte * (kachel_b + self.LUECKE)
            ky = y + reihe * (kachel_h + self.LUECKE)
            self.platz_malen(stelle, kx, ky, kachel_b, kachel_h)
            self.plaetze.append((stelle, kx, ky, kachel_b, kachel_h))

    def platz_malen(self, stelle, x, y, breite, hoehe):
        """Einen einzelnen Platz zeichnen — leer oder belegt."""
        marke = f"platz{stelle}"
        eintrag = self.eintraege[stelle] if stelle < len(self.eintraege) else None
        da = eintrag is None or eintrag_da(eintrag)

        if eintrag is None:
            # Ein leerer Platz soll einladen, nicht wie ein Loch wirken:
            # gestrichelter Rand, ein leises Plus, sonst nichts.
            self.buehne.create_rectangle(x, y, x + breite, y + hoehe, fill=F["tief"],
                                         outline=F["linie"], dash=(3, 4),
                                         tags=("ablage", marke, marke + "rand"))
            self.buehne.create_text(x + breite / 2, y + hoehe / 2, text="+",
                                    fill=F["linie_stark"],
                                    font=tkfont.Font(family="DejaVu Sans", size=15),
                                    tags=("ablage", marke, marke + "text"))
        else:
            rand = F["schlecht"] if not da else F["linie"]
            self.buehne.create_rectangle(x, y, x + breite, y + hoehe, fill=F["karte"],
                                         outline=rand,
                                         tags=("ablage", marke, marke + "rand"))
            self.symbol_malen(eintrag, stelle, x + breite / 2, y + hoehe / 2 - 9, da)
            name = eintrag.get("name") or os.path.basename(eintrag.get("pfad", ""))
            schrift = tkfont.Font(family="DejaVu Sans", size=8)
            self.buehne.create_text(x + breite / 2, y + hoehe - 13,
                                    text=self.kuerzen(name, schrift, breite - 12),
                                    fill=F["schlecht"] if not da else F["leise"],
                                    font=schrift, tags=("ablage", marke))
            if not da:
                self.buehne.create_text(x + breite / 2, y + hoehe - 3, text=T("fehlt"),
                                        fill=F["schlecht"], font=tkfont.Font(
                                            family="DejaVu Sans", size=7),
                                        tags=("ablage", marke))

        self.buehne.tag_bind(marke, "<Button-1>", lambda _e, s=stelle: self.klick(s))
        self.buehne.tag_bind(marke, "<Shift-Button-1>", lambda _e, s=stelle: self.aendern(s))
        self.buehne.tag_bind(marke, "<Enter>", lambda _e, s=stelle: self.warm.__setitem__(s, 1))
        self.buehne.tag_bind(marke, "<Leave>", lambda _e, s=stelle: self.warm.__setitem__(s, 0))
        self.warm[stelle] = 0.0
        self.helligkeit[stelle] = 0.0

    def symbol_malen(self, eintrag, stelle, mx, my, da=True):
        """Das Zeichen eines Eintrags setzen — Bild, wenn es eines gibt."""
        marke = f"platz{stelle}"
        if da and eintrag.get("art") == "anwendung":
            bild = self.bild_holen(eintrag.get("symbol", ""))
            if bild is not None:
                self.buehne.create_image(mx, my, image=bild, tags=("ablage", marke))
                return
        # Ohne Bilddatei ein gezeichnetes Zeichen: ein Ordner, ein Blatt oder
        # ein Fenster. Das braucht keine Schriftart und sieht überall gleich aus.
        farbe = F["schlecht"] if not da else {
            "ordner": F["warn"], "datei": F["blau"]}.get(eintrag.get("art"), F["rand_weich"])
        b, h = 15, 11
        if eintrag.get("art") == "ordner":
            self.buehne.create_polygon(
                mx - b, my + h, mx - b, my - h + 3, mx - 2, my - h + 3, mx + 1, my - h + 6,
                mx + b, my - h + 6, mx + b, my + h,
                fill="", outline=farbe, width=2, tags=("ablage", marke))
        elif eintrag.get("art") == "datei":
            self.buehne.create_polygon(
                mx - 9, my + h, mx - 9, my - h, mx + 3, my - h, mx + 9, my - h + 6,
                mx + 9, my + h,
                fill="", outline=farbe, width=2, tags=("ablage", marke))
        else:
            self.buehne.create_rectangle(mx - b + 3, my - h, mx + b - 3, my + h,
                                         outline=farbe, width=2, tags=("ablage", marke))

    def bild_holen(self, name):
        """Ein Symbolbild laden und auf Kachelmaß bringen — einmal je Name."""
        if name in self.bilder:
            return self.bilder[name]
        self.bilder[name] = None
        datei = symboldatei(name)
        if datei:
            try:
                bild = tk.PhotoImage(file=datei)
                # Tk kann nur ganzzahlig verkleinern; 32 Pixel sind das Maß,
                # das in einer Kachel neben dem Namen noch Luft lässt.
                faktor = max(1, round(bild.width() / 32))
                self.bilder[name] = bild.subsample(faktor) if faktor > 1 else bild
            except tk.TclError:
                self.bilder[name] = None
        return self.bilder[name]

    @staticmethod
    def kuerzen(text, schrift, breite):
        """Zu lange Namen abschneiden, aber sichtbar — mit Auslassung."""
        if schrift.measure(text) <= breite:
            return text
        while text and schrift.measure(text + "…") > breite:
            text = text[:-1]
        return text + "…"

    # ── Leben ───────────────────────────────────────────────────
    def laufen(self):
        """Das Aufleuchten unter dem Zeiger — weich, wie die Bogenanzeigen."""
        for stelle, ziel in list(self.warm.items()):
            jetzt = self.helligkeit.get(stelle, 0.0)
            if abs(jetzt - ziel) < 0.02:
                continue
            jetzt += (ziel - jetzt) * 0.30
            self.helligkeit[stelle] = jetzt
            belegt = stelle < len(self.eintraege)
            ruhe = F["linie"]
            self.buehne.itemconfig(f"platz{stelle}rand",
                                   outline=mischen(ruhe, F["rand_weich"], jetzt),
                                   fill=mischen(F["karte"] if belegt else F["tief"],
                                                F["erhoben"], jetzt))
            if not belegt:
                self.buehne.itemconfig(f"platz{stelle}text",
                                       fill=mischen(F["linie_stark"], F["rand_weich"], jetzt))
        self.k.wurzel.after(40, self.laufen)

    # ── Klicken ─────────────────────────────────────────────────
    def klick(self, stelle):
        """Belegter Platz: öffnen. Leerer Platz: etwas aussuchen."""
        if stelle >= len(self.eintraege):
            self.aussuchen(stelle)
            return
        eintrag = self.eintraege[stelle]
        if not eintrag_da(eintrag):
            # Ins Leere klicken lassen wäre gemein — lieber gleich anbieten,
            # den Platz in Ordnung zu bringen.
            self.aendern(stelle)
            return
        if not eintrag_oeffnen(eintrag):
            self.aendern(stelle)

    def aendern(self, stelle):
        if stelle >= len(self.eintraege):
            self.aussuchen(stelle)
            return
        eintrag = self.eintraege[stelle]
        Eintragsfenster(self.k.wurzel, eintrag,
                        entfernen=lambda s=stelle: self.entfernen(s),
                        austauschen=lambda s=stelle: self.aussuchen(s, tauschen=True),
                        fehlt=not eintrag_da(eintrag))

    def aussuchen(self, stelle, tauschen=False):
        art = self.eintraege[stelle]["art"] if tauschen and stelle < len(self.eintraege) \
            else "anwendung"
        Waehler(self.k.wurzel,
                fertig=lambda e, s=stelle, t=tauschen: self.ablegen(s, e, t),
                art=art if art in ("anwendung", "ordner", "datei") else "anwendung")

    def ablegen(self, stelle, eintrag, tauschen=False):
        if stelle < len(self.eintraege):
            self.eintraege[stelle] = eintrag    # austauschen
        else:
            self.eintraege.append(eintrag)      # der erste freie Platz ist der nächste
        ablage_sichern(self.eintraege)
        self.stand = None
        self.pruefen()

    def entfernen(self, stelle):
        if stelle < len(self.eintraege):
            del self.eintraege[stelle]
            ablage_sichern(self.eintraege)
            self.stand = None
            self.pruefen()


class Kleinfenster(tk.Toplevel):
    """Grundgerüst für die kleinen Fenster der Ablage.

    Sie tragen dieselben Farben wie die Konsole, stehen in der Mitte des
    Schirms und nehmen die Eingabe an sich, solange sie offen sind — ein
    Klick daneben soll nicht aus Versehen etwas starten.

    Die eigene Fensterklasse ist wichtiger, als sie aussieht: die Regel, die
    den Hintergrund ganz nach hinten schiebt, greift alles mit der Klasse des
    Hauptfensters. Diese Fenster tragen eine eigene und bleiben deshalb
    gewöhnliche Fenster — vorne, sichtbar, mit Rahmen.
    """

    def __init__(self, eltern, titel, breite, hoehe):
        super().__init__(eltern, bg=F["tief"], class_="stellium-fenster")
        self.title(f"Stellium — {titel}")
        self.configure(highlightbackground=F["rand"], highlightthickness=1)
        self.transient(eltern)
        self.resizable(False, False)
        x = (self.winfo_screenwidth() - breite) // 2
        y = (self.winfo_screenheight() - hoehe) // 2
        self.geometry(f"{breite}x{hoehe}+{max(x, 0)}+{max(y, 0)}")
        self.attributes("-topmost", True)

        self.kopfzeile = tk.Label(self, text=titel, bg=F["tief"], fg=F["tinte"],
                                  anchor="w", padx=18, pady=12,
                                  font=tkfont.Font(family="DejaVu Sans", size=12,
                                                   weight="bold"))
        self.kopfzeile.pack(fill="x")
        tk.Frame(self, bg=F["rand"], height=1).pack(fill="x", padx=18)

        self.bind("<Escape>", lambda _e: self.destroy())
        self.protocol("WM_DELETE_WINDOW", self.destroy)
        self.after(50, self._greifen)

    def _greifen(self):
        # Erst wenn das Fenster wirklich auf dem Schirm ist, lässt sich die
        # Eingabe an sich ziehen — vorher antwortet X mit „noch nicht sichtbar".
        try:
            self.grab_set()
            self.focus_force()
        except tk.TclError:
            self.after(50, self._greifen)

    def knopf(self, eltern, text, ruf, betont=False):
        """Ein Knopf im Stil der Konsole — flach, mit ruhiger Rückmeldung."""
        k = tk.Label(eltern, text=text, bg=F["rand"] if betont else F["erhoben"],
                     fg="#ffffff" if betont else F["leise"], padx=16, pady=7,
                     cursor="hand2", font=tkfont.Font(family="DejaVu Sans", size=10))
        ruhe, wach = (F["rand"], F["rand_weich"]) if betont else (F["erhoben"], F["linie_stark"])
        k.bind("<Button-1>", lambda _e: ruf())
        k.bind("<Enter>", lambda _e: k.config(bg=wach, fg=F["tinte"] if not betont else "#ffffff"))
        k.bind("<Leave>", lambda _e: k.config(bg=ruhe, fg=F["leise"] if not betont else "#ffffff"))
        return k


class Waehler(Kleinfenster):
    """Das Fenster, in dem man aussucht, was auf einen Platz gelegt wird.

    Drei Arten, ein Fenster: Anwendungen kommen aus den .desktop-Dateien,
    Ordner und Dateien aus dem Dateibaum. Der Weg ist derselbe, nur die Liste
    darunter wechselt — das erspart drei Fenster, die fast gleich aussehen.
    """

    def __init__(self, eltern, fertig, art="anwendung"):
        super().__init__(eltern, T("was_ablegen"), 620, 520)
        self.fertig = fertig
        self.art = art
        self.ordner = os.path.expanduser("~")
        self.zeilen = []                       # was in der Liste steht

        klein = tkfont.Font(family="DejaVu Sans", size=10)
        # ── Die drei Arten als Reiter
        self.reiter = {}
        leiste = tk.Frame(self, bg=F["tief"])
        leiste.pack(fill="x", padx=18, pady=(14, 8))
        for schluessel, marke in (("anwendung", "art_anwendung"),
                                  ("ordner", "art_ordner"), ("datei", "art_datei")):
            r = tk.Label(leiste, text=T(marke), bg=F["erhoben"], fg=F["leise"],
                         padx=18, pady=6, cursor="hand2", font=klein)
            r.pack(side="left", padx=(0, 8))
            r.bind("<Button-1>", lambda _e, s=schluessel: self.art_waehlen(s))
            self.reiter[schluessel] = r

        self.pfadzeile = tk.Label(self, text="", bg=F["tief"], fg=F["zeit"], anchor="w",
                                  font=tkfont.Font(family="DejaVu Sans Mono", size=9))
        self.pfadzeile.pack(fill="x", padx=20, pady=(0, 6))

        kasten = tk.Frame(self, bg=F["linie"])
        kasten.pack(fill="both", expand=True, padx=18)
        self.liste = tk.Listbox(kasten, bg=F["karte"], fg=F["tinte"], bd=0,
                                highlightthickness=0, activestyle="none",
                                selectbackground=F["rand"], selectforeground="#ffffff",
                                font=klein)
        self.liste.pack(side="left", fill="both", expand=True, padx=1, pady=1)
        rolle = tk.Scrollbar(kasten, command=self.liste.yview, bd=0,
                             highlightthickness=0, troughcolor=F["karte"], bg=F["erhoben"])
        rolle.pack(side="right", fill="y", padx=(0, 1), pady=1)
        self.liste.config(yscrollcommand=rolle.set)
        self.liste.bind("<Double-Button-1>", lambda _e: self.eintreten())
        self.liste.bind("<Return>", lambda _e: self.eintreten())

        fuss = tk.Frame(self, bg=F["tief"])
        fuss.pack(fill="x", padx=18, pady=14)
        self.knopf(fuss, T("ablegen"), self.nehmen, betont=True).pack(side="right")
        self.knopf(fuss, T("abbrechen"), self.destroy).pack(side="right", padx=(0, 10))

        self.art_waehlen(art)

    # ── Liste füllen ────────────────────────────────────────────
    def art_waehlen(self, art):
        self.art = art
        for schluessel, r in self.reiter.items():
            gewaehlt = schluessel == art
            r.config(bg=F["rand"] if gewaehlt else F["erhoben"],
                     fg="#ffffff" if gewaehlt else F["leise"])
        self.fuellen()

    def fuellen(self):
        self.liste.delete(0, "end")
        self.zeilen = []
        if self.art == "anwendung":
            self.pfadzeile.config(text="")
            for name, pfad, symbol in anwendungen_finden():
                self.zeilen.append({"art": "anwendung", "name": name,
                                    "pfad": pfad, "symbol": symbol})
                self.liste.insert("end", "   " + name)
            return

        self.pfadzeile.config(text=self.ordner)
        eltern = os.path.dirname(self.ordner.rstrip("/")) or "/"
        if eltern != self.ordner:
            self.zeilen.append({"art": "hoeher", "pfad": eltern})
            self.liste.insert("end", "   " + T("hoeher"))
        try:
            namen = sorted(os.listdir(self.ordner), key=str.lower)
        except OSError:
            namen = []
        for name in namen:
            if name.startswith("."):
                continue                       # Verstecktes bleibt versteckt
            voll = os.path.join(self.ordner, name)
            if os.path.isdir(voll):
                self.zeilen.append({"art": "ordner", "name": name, "pfad": voll})
                self.liste.insert("end", "   ▸  " + name)
            elif self.art == "datei":
                self.zeilen.append({"art": "datei", "name": name, "pfad": voll})
                self.liste.insert("end", "   ·  " + name)
        if len(self.zeilen) <= 1:
            self.liste.insert("end", "   " + T("nichts_hier"))

    def gewaehlt(self):
        wahl = self.liste.curselection()
        if not wahl or wahl[0] >= len(self.zeilen):
            return None
        return self.zeilen[wahl[0]]

    def eintreten(self):
        """Doppelklick: in einen Ordner hinein — oder gleich übernehmen."""
        zeile = self.gewaehlt()
        if not zeile:
            return
        if zeile["art"] in ("hoeher", "ordner") and self.art != "anwendung":
            if zeile["art"] == "hoeher" or self.art == "datei":
                self.ordner = zeile["pfad"]
                self.fuellen()
                return
        self.nehmen()

    def nehmen(self):
        zeile = self.gewaehlt()
        if self.art == "ordner" and (zeile is None or zeile["art"] == "hoeher"):
            # Nichts ausgesucht heißt: der Ordner, in dem man gerade steht.
            zeile = {"art": "ordner", "name": os.path.basename(self.ordner.rstrip("/")) or "/",
                     "pfad": self.ordner}
        if zeile is None or zeile["art"] == "hoeher":
            return
        if self.art == "datei" and zeile["art"] != "datei":
            self.ordner = zeile["pfad"]         # ein Ordner: erst hineingehen
            self.fuellen()
            return
        eintrag = {"art": zeile["art"], "name": zeile.get("name", ""),
                   "pfad": zeile["pfad"], "symbol": zeile.get("symbol", "")}
        self.destroy()
        self.fertig(eintrag)


class Eintragsfenster(Kleinfenster):
    """Das kleine Fenster hinter Umschalt und Klick: entfernen oder tauschen."""

    def __init__(self, eltern, eintrag, entfernen, austauschen, fehlt=False):
        super().__init__(eltern, T("eintrag_aendern"), 460, 230)
        klein = tkfont.Font(family="DejaVu Sans", size=10)

        tk.Label(self, text=eintrag.get("name") or eintrag.get("pfad", ""),
                 bg=F["tief"], fg=F["tinte"], anchor="w", padx=20,
                 font=tkfont.Font(family="DejaVu Sans", size=11, weight="bold")
                 ).pack(fill="x", pady=(16, 2))
        tk.Label(self, text=eintrag.get("pfad", ""), bg=F["tief"], fg=F["zeit"], anchor="w",
                 padx=20, wraplength=410, justify="left",
                 font=tkfont.Font(family="DejaVu Sans Mono", size=9)).pack(fill="x")
        if fehlt:
            tk.Label(self, text=T("fehlt_lang", name=eintrag.get("name", "")),
                     bg=F["tief"], fg=F["schlecht"], anchor="w", padx=20,
                     wraplength=410, justify="left", font=klein).pack(fill="x", pady=(10, 0))

        fuss = tk.Frame(self, bg=F["tief"])
        fuss.pack(side="bottom", fill="x", padx=18, pady=16)
        self.knopf(fuss, T("austauschen"),
                   lambda: (self.destroy(), austauschen()), betont=True).pack(side="right")
        self.knopf(fuss, T("entfernen"),
                   lambda: (self.destroy(), entfernen())).pack(side="right", padx=(0, 10))
        self.knopf(fuss, T("abbrechen"), self.destroy).pack(side="left")


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
            gr = r * anteil
            # Die Mitten der Blasen liegen absichtlich außerhalb des Bildes.
            # Von den kleinen, hellen Ringen dort ragt sonst nur eine Spitze
            # herein — und die sieht aus wie ein Keil, der da nicht hingehört.
            # Deshalb kommen nur Ringe aufs Bild, die auch ein Stück weit
            # hereinreichen; der Verlauf endet dadurch weich statt spitz.
            if (my + gr < hoehe * 0.12 or my - gr > hoehe * 0.88
                    or mx + gr < breite * 0.12 or mx - gr > breite * 0.88):
                continue
            ton = mischen(F["grund"], farbe, staerke * (1 - anteil) ** 2)
            leinwand.create_oval(mx - gr, my - gr, mx + gr, my + gr,
                                 fill=ton, outline="", tags="aurora")
    leinwand.tag_lower("aurora")


class Konsole:
    def __init__(self):
        self.wurzel = tk.Tk(className=FENSTERKLASSE)
        self.wurzel.title("Stellium Hintergrund" if HINTERGRUND else "Stellium — Konsole")
        self.wurzel.configure(bg=F["grund"])
        if HINTERGRUND:
            self.hintergrund_einrichten()
        else:
            self.wurzel.geometry(f"{BREIT}x{HOCH}")
            # Zwei Tachos (je 132) plus Ränder brauchen 340 je Spalte; darunter
            # klappen die Spalten untereinander, deshalb genügt eine Spaltenbreite.
            self.wurzel.minsize(380, 560)
        self.takt = 0.0
        self.stand = None
        # Zuerst die Sprache, dann die Beschriftungen: sonst stünden die
        # Überschriften der Karten in der Sprache von vorgestern, weil sie nur
        # beim Anlegen gesetzt werden.
        sprache_laden()

        gross = tkfont.Font(family="DejaVu Sans", size=17, weight="bold")
        klein = tkfont.Font(family="DejaVu Sans", size=9)

        # ── Fernzugriff ─────────────────────────────────────────
        # Als Bereich statt als eigenes Fenster: was aus der Ferne geschieht,
        # gehört zum Zustand des Servers wie die Zahlen darüber. Er bleibt auch
        # dann stehen, wenn niemand verbunden ist — dann zeigt er das
        # Protokoll und lässt einen darin zurückblättern.
        #
        # Er hängt direkt im Fenster, nicht auf der Leinwand: als eingebettetes
        # Leinwandfenster blieb die Tagesauswahl unsichtbar — Tk richtet sie
        # dort zwar ein, malt sie aber nicht. Unten angeschlagen ist er
        # außerdem einfacher zu bemessen.
        self.fern = None
        if WACHE is not None:
            WACHE.sprache_setzen(SPRACHE)
            self.fern = WACHE.Mitschrift(self.wurzel, sprachknopf=False, dauerhaft=True)
            # Derselbe feine Rahmen wie bei den Karten darüber. Die Höhe gibt
            # gleich `band_richten` vor, deshalb kein Mitwachsen mit dem Inhalt.
            self.fern.config(highlightbackground=F["linie"], highlightthickness=1)
            self.fern.pack_propagate(False)
            # Vor der Leinwand angemeldet, sonst nähme sich diese als
            # mitwachsendes Feld den ganzen Platz und für den Fernzugriff
            # bliebe nichts übrig.
            self.fern.pack(side="bottom", fill="x", padx=16, pady=(0, 14))

        # Eine Leinwand trägt den Rest: darauf liegen der Aurora-Schimmer und
        # der Kopf, und darüber schweben die Karten — genau wie in der App.
        self.buehne = tk.Canvas(self.wurzel, bd=0, highlightthickness=0, bg=F["grund"])
        self.buehne.pack(side="top", fill="both", expand=True)
        self.buehne.bind("<Configure>", self.buehne_richten)
        self.wurzel.bind("<Configure>", self.band_richten)
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

        # Die Ablage füllt, was unter der linken Spalte frei bleibt.
        self.ablage = Ablage(self)

        self.band_stand = None
        self.band_richten()
        threading.Thread(target=self.holen, daemon=True).start()
        self.drehen()
        self.auffrischen()

    # ── Hintergrundbetrieb ──────────────────────────────────────
    def hintergrund_einrichten(self):
        """Aus dem Fenster den lebenden Schreibtischgrund machen.

        Das Meiste davon kann ein Programm gar nicht selbst: wie tief ein
        Fenster liegt, entscheidet der Fenstermanager. Unter labwc — das auf
        dem Pi läuft — steht die Regel dafür in /etc/xdg/labwc/rc.xml und wird
        von `einrichten.sh` eingetragen. Sie nimmt dem Fenster den Rahmen,
        hält es ganz unten, zeigt es auf allen Arbeitsflächen, lässt es aus
        Fensterleiste und Umschalter heraus und legt es über die ganze
        nutzbare Fläche — also alles außer der Leiste am oberen Rand.

        Ganz nach hinten heißt hier: hinter alle gewöhnlichen Fenster. Noch
        weiter zurück — unter das Hintergrundbild und die Schreibtischsymbole
        — käme nur ein Wayland-eigenes Programm mit wlr-layer-shell; Tk läuft
        über XWayland und kann das nicht. Das Fenster liegt also *über* dem
        Hintergrundbild und würde Symbole verdecken; deshalb schaltet
        `einrichten.sh` die Schreibtischsymbole ab. Erreichbar bleibt alles
        über das Startmenü.

        Hier bleibt nur, für den Fall vorzusorgen, dass die Regel fehlt: dann
        stellt sich das Fenster wenigstens selbst hin — über die ganze Breite
        und unterhalb der Leiste am oberen Rand.
        """
        breit = self.wurzel.winfo_screenwidth()
        hoch = max(self.wurzel.winfo_screenheight() - RAND_OBEN, 480)
        self.wurzel.geometry(f"{breit}x{hoch}+0+{RAND_OBEN}")
        self.wurzel.minsize(380, 400)

    # ── Kopf ────────────────────────────────────────────────────
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
        self.ablage_richten(rand, spalte, luecke)
        self.band_richten()

    def ablage_richten(self, rand=16, spalte=None, luecke=16):
        """Der Ablage sagen, wie viel unter der linken Spalte frei ist.

        Die Karten wachsen, sobald Zahlen eintreffen — deshalb wird das immer
        wieder nachgerechnet. Die Ablage selbst zeichnet nur neu, wenn sich
        wirklich etwas geändert hat.
        """
        if getattr(self, "ablage", None) is None:
            return
        hoehe = max(self.buehne.winfo_height(), 1)
        if spalte is None:
            kasten = self.buehne.bbox(self.spalte_links)
            spalte = (kasten[2] - kasten[0]) if kasten else 0
        kasten = self.buehne.bbox(self.spalte_links)
        oben = (kasten[3] if kasten else KOPFHOCH) + luecke
        frei = hoehe - 26 - oben              # 26 Pixel bleiben für die Fußzeile
        if frei < Ablage.HOCH_MIN or spalte < Ablage.BREIT_MIN:
            self.ablage.setzen(0, 0, 0, 0)
        else:
            self.ablage.setzen(rand, oben, spalte, frei)

    def band_richten(self, ereignis=None):
        """Dem Fernzugriff unten seine Höhe geben.

        Er hängt am unteren Rand des Fensters und nimmt gut ein Viertel der
        Höhe. In einem kleinen Fenster tritt er ganz zurück: dort brauchen die
        Karten jeden Pixel, und ein auf drei Zeilen zusammengedrückter Verlauf
        nützt niemandem.
        """
        if self.fern is None:
            return
        if ereignis is not None and ereignis.widget is not self.wurzel:
            return                      # Kindfenster ändern sich dauernd
        hoehe = max(self.wurzel.winfo_height(), 1)
        platz = 0 if hoehe < 620 else max(BAND_MIN, min(BAND_MAX, int(hoehe * 0.26)))
        if platz == self.band_stand:
            return
        self.band_stand = platz
        if not platz:
            self.fern.pack_forget()
            return
        self.fern.config(height=platz)
        if not self.fern.winfo_ismapped():
            self.fern.pack(side="bottom", fill="x", padx=16, pady=(0, 14),
                           before=self.buehne)

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
        # Der Fernzugriff hat unten keinen eigenen Knopf mehr — dieser hier
        # schaltet für beide um, und die Wache merkt sich die Wahl auch für
        # ihre eigenständige Fassung.
        if self.fern is not None:
            WACHE.sprache_setzen(SPRACHE)
            self.fern.sprache_anwenden()
        self.ablage.stand = None        # Überschrift und Hinweise neu setzen
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
        # Die Karten sind eben vielleicht gewachsen — dann rücken Ablage und
        # Fernzugriff darunter nach.
        self.ablage_richten()
        self.band_richten()
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
            # „an" hing früher allein am gewählten Anbieter — bei einem lokalen
            # Modell also immer, auch wenn dort niemand antwortete. Der Server
            # liefert jetzt einen tatsächlich gemessenen Zustand; steht der zur
            # Verfügung, entscheidet er. Eine Anzeige, die grün leuchtet, ohne
            # nachgesehen zu haben, ist schlimmer als gar keine.
            zustand = ki.get("lokalerZustand")
            if zustand == "antwortet-nicht":
                text = T("stumm")
                seit = seit_wann(ki.get("lokalErfolgAm"))
                text += "  ·  " + (T("seit") + " " + seit if seit else T("nie_erreicht"))
                self.k_chat.feld("uebersetzung", text, F["schlecht"])
            elif zustand == "kein-modell":
                self.k_chat.feld("uebersetzung", T("ohne_modell"), F["schlecht"])
            else:
                an = bool(ki.get("translation")) and ki.get("provider") != "demo"
                self.k_chat.feld("uebersetzung", f"{T('an')} · {ki['provider']}" if an
                                 else T("uebersetzung_aus"),
                                 F["gut"] if an else F["warn"])
            if ki.get("model"):
                self.k_chat.feld("modell", ki["model"])
        verbunden = d.get("verbunden") or {}
        clients = verbunden.get("clients", 0)
        leute = verbunden.get("benutzer", 0)
        self.k_chat.feld("verbunden",
                         f"{clients} {T('verbindung') if clients == 1 else T('verbindungen')}"
                         f"  ·  {leute} {T('person') if leute == 1 else T('personen')}"
                         if clients else T("niemand"),
                         F["gut"] if clients else F["zeit"])

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
