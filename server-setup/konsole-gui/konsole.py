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
import subprocess
import threading
import time
import tkinter as tk
from tkinter import font as tkfont

KONSOLE = ["/usr/bin/node", "/opt/stellium/server-setup/stellium-konsole.mjs", "json"]
TAKT = 4.0

F = {
    "grund": "#0b0d16",
    "tief": "#06080f",
    "karte": "#111527",
    "linie": "#1c2138",
    "rand": "#7c5cff",
    "tinte": "#e8eaf6",
    "leise": "#9aa0bd",
    "zeit": "#5c6384",
    "gut": "#34d399",
    "warn": "#fbbf24",
    "schlecht": "#f87171",
    "blau": "#60a5fa",
    "kopf1": "#191d33",
    "kopf2": "#0b0d16",
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
        return f"{tage} Tage, {stunden} Std"
    if stunden:
        return f"{stunden} Std, {minuten} Min"
    return f"{minuten} Min"


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

    def __init__(self, eltern, titel, farbe=None):
        super().__init__(eltern, bg=F["karte"], highlightbackground=F["linie"],
                         highlightthickness=1, bd=0)
        kopf = tk.Frame(self, bg=F["karte"])
        kopf.pack(fill="x", padx=16, pady=(12, 6))
        tk.Label(kopf, text=titel, bg=F["karte"], fg=farbe or F["rand"],
                 font=tkfont.Font(family="DejaVu Sans", size=11, weight="bold"),
                 anchor="w").pack(side="left")
        self.inhalt = tk.Frame(self, bg=F["karte"])
        self.inhalt.pack(fill="both", expand=True, padx=16, pady=(0, 12))
        self.zeilen = {}
        self.tachos = {}

    def feld(self, name, wert, farbe=None):
        if name not in self.zeilen:
            reihe = tk.Frame(self.inhalt, bg=F["karte"])
            reihe.pack(fill="x", pady=1)
            links = tk.Label(reihe, text=name, bg=F["karte"], fg=F["zeit"], anchor="w",
                             width=16, font=tkfont.Font(family="DejaVu Sans", size=10))
            links.pack(side="left")
            rechts = tk.Label(reihe, text="", bg=F["karte"], fg=F["tinte"], anchor="w",
                              justify="left",
                              font=tkfont.Font(family="DejaVu Sans Mono", size=10))
            rechts.pack(side="left", fill="x", expand=True)
            self.zeilen[name] = rechts
        self.zeilen[name].config(text=wert, fg=farbe or F["tinte"])

    def tacho(self, name, anteil, zahl=None, unten=""):
        """Einen Messwert als Bogen zeigen — vier passen nebeneinander."""
        if not hasattr(self, "tacho_reihe"):
            self.tacho_reihe = tk.Frame(self.inhalt, bg=F["karte"])
            self.tacho_reihe.pack(fill="x", pady=(2, 8))
        if name not in self.tachos:
            t = Tacho(self.tacho_reihe, name)
            t.pack(side="left", padx=(0, 6))
            self.tachos[name] = t
        self.tachos[name].setzen(anteil, zahl, unten)


class Konsole:
    def __init__(self):
        self.wurzel = tk.Tk()
        self.wurzel.title("Stellium — Konsole")
        self.wurzel.configure(bg=F["grund"])
        self.wurzel.geometry(f"{BREIT}x{HOCH}")
        self.wurzel.minsize(720, 480)
        self.takt = 0.0
        self.stand = None

        gross = tkfont.Font(family="DejaVu Sans", size=17, weight="bold")
        klein = tkfont.Font(family="DejaVu Sans", size=9)

        self.kopf = tk.Canvas(self.wurzel, height=KOPFHOCH, bd=0, highlightthickness=0,
                              bg=F["grund"])
        self.kopf.pack(fill="x")
        self.kopf.bind("<Configure>", self.kopf_malen)
        self.stern = self.kopf.create_text(26, 36, text="✦", fill=F["rand"], font=gross)
        self.kopf.create_text(52, 36, text="Stellium", anchor="w", fill=F["tinte"], font=gross)
        self.version_id = self.kopf.create_text(160, 39, text="", anchor="w",
                                                fill=F["leise"], font=klein)
        self.unterzeile = self.kopf.create_text(52, 60, text="verbinde …", anchor="w",
                                                fill=F["zeit"], font=klein)

        koerper = tk.Frame(self.wurzel, bg=F["grund"])
        koerper.pack(fill="both", expand=True, padx=16, pady=(4, 12))
        links = tk.Frame(koerper, bg=F["grund"])
        links.pack(side="left", fill="both", expand=True, padx=(0, 8))
        rechts = tk.Frame(koerper, bg=F["grund"])
        rechts.pack(side="left", fill="both", expand=True, padx=(8, 0))

        self.k_verbinden = Karte(links, "Verbinden", F["blau"])
        self.k_verbinden.pack(fill="x", pady=(0, 12))
        self.adressen = tk.Frame(self.k_verbinden.inhalt, bg=F["karte"])
        self.adressen.pack(fill="x")

        self.k_chat = Karte(links, "Chat-Server", F["gut"])
        self.k_chat.pack(fill="x", pady=(0, 12))
        self.k_aussen = Karte(links, "Weg nach außen", F["blau"])
        self.k_aussen.pack(fill="x")

        self.k_leistung = Karte(rechts, "Leistung", F["rand"])
        self.k_leistung.pack(fill="x", pady=(0, 12))
        self.k_teile = Karte(rechts, "Bestandteile", F["zeit"])
        self.k_teile.pack(fill="x")

        self.fuss = tk.Label(
            self.wurzel, bg=F["grund"], fg=F["zeit"], anchor="w", font=klein,
            text="Aktualisiert sich alle vier Sekunden  ·  im Terminal:  stellium-konsole")
        self.fuss.pack(fill="x", padx=18, pady=(0, 10))

        threading.Thread(target=self.holen, daemon=True).start()
        self.drehen()
        self.auffrischen()

    # ── Kopf ────────────────────────────────────────────────────
    def kopf_malen(self, _e=None):
        breite = max(self.kopf.winfo_width(), 1)
        self.kopf.delete("verlauf")
        for y in range(KOPFHOCH):
            self.kopf.create_line(0, y, breite, y, tags="verlauf",
                                  fill=mischen(F["kopf1"], F["kopf2"], y / KOPFHOCH))
        self.kopf.create_line(0, 0, breite, 0, fill=F["rand"], width=2, tags="verlauf")
        self.kopf.tag_lower("verlauf")

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
            self.kopf.itemconfig(self.unterzeile, text=f"Keine Verbindung zur Konsole: {d['fehler'][:70]}")
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
            hinweis = {"offen": "unverschlüsselt", "lokal": "im eigenen Netz",
                       "tunnel": "durch den Tunnel"}.get(a["art"], "")
            if hinweis:
                tk.Label(reihe, text=f"   {hinweis}", bg=F["karte"], fg=F["zeit"], anchor="w",
                         font=tkfont.Font(family="DejaVu Sans", size=9)).pack(side="left")
            gezeigt += 1

        self.rest_zeichnen(d)

    def rest_zeichnen(self, d):
        # ── Chat-Server
        dienste = d.get("dienste", {})
        chat = dienste.get("chat", {})
        self.k_chat.feld("Dienst",
                         "läuft · startet automatisch" if chat.get("an") and chat.get("auto")
                         else "läuft · KEIN Autostart" if chat.get("an") else "AUS",
                         F["gut"] if chat.get("an") and chat.get("auto")
                         else F["warn"] if chat.get("an") else F["schlecht"])
        ki = d.get("ki")
        if ki:
            an = ki.get("provider") and ki["provider"] != "demo"
            self.k_chat.feld("Übersetzung", f"an · {ki['provider']}" if an else "aus",
                             F["gut"] if an else F["warn"])
            if ki.get("model"):
                self.k_chat.feld("Modell", ki["model"])
        inhalt = d.get("inhalt") or {}
        teile = [f"{inhalt[k]} {n}" for k, n in
                 (("users", "Konten"), ("channels", "Kanäle"), ("messages", "Nachrichten"))
                 if inhalt.get(k) is not None]
        if teile:
            self.k_chat.feld("Inhalt", "  ·  ".join(teile))
        if inhalt.get("groesse"):
            self.k_chat.feld("Datenbank", groesse(inhalt["groesse"]))

        # ── Weg nach außen
        web = dienste.get("web", {})
        self.k_aussen.feld("nginx",
                           "läuft · startet automatisch" if web.get("an") and web.get("auto")
                           else "läuft" if web.get("an") else "AUS",
                           F["gut"] if web.get("an") else F["schlecht"])
        zert = d.get("zertifikat")
        if zert:
            tage = zert.get("tage", 0)
            self.k_aussen.feld("Zertifikat", f"{zert['name']} · noch {tage} Tage",
                               F["schlecht"] if tage < 10 else F["warn"] if tage < 25 else F["gut"])
        else:
            self.k_aussen.feld("Zertifikat", "keines — Verbindung offen", F["warn"])
        if d.get("firewall") is not None:
            self.k_aussen.feld("Firewall", "aktiv" if d["firewall"] else "AUS",
                               F["gut"] if d["firewall"] else F["schlecht"])
        if d.get("gesperrt") is not None:
            n = d["gesperrt"]
            self.k_aussen.feld("fail2ban", f"{n} gesperrt" if n else "wacht, nichts gesperrt",
                               F["warn"] if n else F["gut"])
        sicherung = d.get("sicherung")
        anzahl = sicherung["anzahl"] if sicherung else 0
        self.k_aussen.feld("Sicherung",
                           f"{anzahl} Stand" if anzahl == 1
                           else f"{anzahl} Stände" if anzahl else "noch keine",
                           F["gut"] if sicherung else F["warn"])

        # ── Leistung
        L = d.get("leistung", {})
        self.k_leistung.tacho("Prozessor", L.get("cpu"),
                              unten=f"{L.get('kerne', '?')} Kerne"
                                    + (f" · {round(L['mhz'] / 1000, 1)} GHz" if L.get("mhz") else ""))
        self.k_leistung.tacho("Speicher", L.get("ramAnteil"),
                              unten=f"{groesse(L.get('ramBelegt'))} / {groesse(L.get('ramGesamt'))}")
        if L.get("platte"):
            pl = L["platte"]
            self.k_leistung.tacho("Platte", pl["belegt"] / max(pl["gesamt"], 1),
                                  unten=f"{groesse(pl['gesamt'] - pl['belegt'])} frei")
        temperaturen = L.get("temperaturen", [])
        if temperaturen:
            grad = temperaturen[0]["grad"]
            # 40 °C ist kühl, 85 °C die Grenze — dazwischen wird der Bogen voll.
            self.k_leistung.tacho("Temperatur", max(0.0, min(1.0, (grad - 40) / 45)),
                                  zahl=f"{round(grad)}°", unten="Prozessor")

        if L.get("swap") and L["swap"]["belegt"] > 0:
            sw = L["swap"]
            self.k_leistung.feld("Auslagerung",
                                 f"{groesse(sw['belegt'])} von {groesse(sw['gesamt'])}", F["warn"])
        if L.get("netz"):
            self.k_leistung.feld("Netz", f"{groesse(L['netz']['rein'])} empfangen"
                                         f"  ·  {groesse(L['netz']['raus'])} gesendet")
        self.k_leistung.feld("Läuft seit", dauer(L.get("laufzeit", 0)))

        for t in d.get("bestandteile", []):
            self.k_teile.feld(t["name"], t["fassung"])


if __name__ == "__main__":
    Konsole().wurzel.mainloop()
