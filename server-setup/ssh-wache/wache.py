#!/usr/bin/env python3
"""
Ein Fenster, das zeigt, wenn jemand über SSH auf diesem Pi arbeitet.

Es erscheint, sobald eine Sitzung aufgeht, listet mit, welche Befehle laufen,
und verschwindet, wenn die letzte Sitzung endet. Gedacht als Mitleser, nicht
als Schloss: wer hier steht, soll sehen können, was aus der Ferne geschieht.

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
NACHLAUF = 60.0       # so lange bleibt das Fenster nach der letzten Sitzung
RUFEN = "/tmp/stellium-wache-zeigen"   # Datei als Klingel vom Desktop aus

# Eigene Geräte sollen das Fenster nicht auslösen — es geht um den Fernzugriff
# von außen, nicht um die eigene Verbindung aus dem Nebenzimmer. Wer hier steht,
# wird übergangen; die Liste lässt sich in der Datei daneben erweitern.
EIGENE = {"aryan-pc", "aryan"}
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


def herkunft_namen():
    """Welche Adresse hat sich zuletzt mit welchem Schlüssel angemeldet?"""
    namen = schluesselnamen()
    zuordnung = {}
    try:
        roh = subprocess.run(
            ["journalctl", "-u", "ssh", "-n", "300", "--no-pager", "-o", "cat"],
            capture_output=True, text=True, timeout=6).stdout
    except Exception:
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
    return zuordnung


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


class Fenster:
    def __init__(self):
        self.wurzel = tk.Tk()
        self.wurzel.title("Stellium — Fernzugriff")
        self.wurzel.configure(bg=FARBEN["grund"])
        self.wurzel.attributes("-topmost", True)
        # Ohne Fensterleiste gibt es auch kein Kreuz. Das ist der Sinn der Sache:
        # wer aus der Ferne arbeitet, soll sich nicht wegklicken lassen. Verschieben
        # und Einklappen bleiben möglich — nur Schließen nicht.
        self.wurzel.overrideredirect(True)
        self.wurzel.geometry(f"{BREIT}x{HOCH}+40+40")
        self.wurzel.withdraw()          # erst zeigen, wenn jemand da ist
        self.sichtbar = False
        try:
            self.wurzel.attributes("-alpha", 0.0)
        except tk.TclError:
            pass                        # ohne Compositor eben ohne Blende

        eng = tkfont.Font(family="DejaVu Sans Mono", size=10)
        fett = tkfont.Font(family="DejaVu Sans", size=14, weight="bold")
        klein = tkfont.Font(family="DejaVu Sans", size=9)

        # ── Kopf: Farbverlauf statt flacher Fläche ──────────────
        self.kopf = tk.Canvas(self.wurzel, height=KOPFHOCH, bd=0, highlightthickness=0,
                              bg=FARBEN["grund"])
        self.kopf.pack(fill="x")
        self.kopf.bind("<Configure>", self.kopf_malen)

        # Der Punkt atmet — so sieht man auf einen Blick, dass es lebt.
        self.punkt = self.kopf.create_oval(20, 26, 32, 38, fill=FARBEN["gut"], outline="")
        self.hof = self.kopf.create_oval(14, 20, 38, 44, fill="", outline=FARBEN["gut"], width=1)
        self.titel_id = self.kopf.create_text(
            48, 26, text="Fernzugriff läuft", anchor="w", fill=FARBEN["tinte"], font=fett)
        self.wer_id = self.kopf.create_text(
            48, 48, text="", anchor="w", fill=FARBEN["leise"], font=klein)

        # Knöpfe als Text auf der Leinwand — dann tragen sie den Verlauf mit.
        self.klappe_id = self.kopf.create_text(
            0, 32, text="▾", anchor="e", fill=FARBEN["leise"], font=fett)
        self.schliessen_id = self.kopf.create_text(
            0, 32, text="✕", anchor="e", fill=FARBEN["leise"], font=fett, state="hidden")
        for kennung, was in ((self.klappe_id, self.umschalten),
                             (self.schliessen_id, self.verstecken)):
            self.kopf.tag_bind(kennung, "<Button-1>", lambda _e, f=was: f())
            self.kopf.tag_bind(kennung, "<Enter>",
                               lambda _e, k=kennung: self.kopf.itemconfig(k, fill=FARBEN["tinte"]))
            self.kopf.tag_bind(kennung, "<Leave>",
                               lambda _e, k=kennung: self.kopf.itemconfig(k, fill=FARBEN["leise"]))

        # Verschieben: was keine Fensterleiste hat, muss man am Kopf anfassen können.
        self.kopf.bind("<Button-1>", self.griff_setzen)
        self.kopf.bind("<B1-Motion>", self.griff_ziehen)

        # ── Mitschrift ──────────────────────────────────────────
        self.rahmen = tk.Frame(self.wurzel, bg=FARBEN["linie"], bd=0)
        self.rahmen.pack(fill="both", expand=True, padx=14, pady=(4, 10))

        self.text = tk.Text(
            self.rahmen, bg=FARBEN["tief"], fg=FARBEN["tinte"], font=eng,
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

        self.fuss = tk.Label(
            self.wurzel,
            text="Mitschrift auch im Journal:  journalctl -t stellium-ssh",
            fg=FARBEN["zeit"], bg=FARBEN["grund"], anchor="w", font=klein,
        )
        self.fuss.pack(fill="x", padx=16, pady=(0, 10))

        self.namen = herkunft_namen()
        self.manuell = False
        self.verstecken_um = None
        self.eingeklappt = False
        self.takt = 0.0
        self.wurzel.protocol("WM_DELETE_WINDOW", self.einklappen)
        self.atmen()

        self.warteschlange = queue.Queue()
        threading.Thread(target=self.mitlesen, daemon=True).start()
        self.nachsehen()
        self.abarbeiten()

    # ── Aussehen und Bewegung ───────────────────────────────────
    def kopf_malen(self, _ereignis=None):
        """Farbverlauf und Knopfplätze neu setzen, wenn sich die Breite ändert."""
        breite = max(self.kopf.winfo_width(), 1)
        self.kopf.delete("verlauf")
        for y in range(KOPFHOCH):
            self.kopf.create_line(
                0, y, breite, y, tags="verlauf",
                fill=mischen(FARBEN["kopf1"], FARBEN["kopf2"], y / KOPFHOCH))
        # Ein violetter Faden ganz oben — das Erkennungszeichen von Stellium.
        self.kopf.create_line(0, 0, breite, 0, fill=FARBEN["rand"], width=2, tags="verlauf")
        self.kopf.tag_lower("verlauf")
        self.kopf.coords(self.klappe_id, breite - 18, 32)
        self.kopf.coords(self.schliessen_id, breite - 46, 32)

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
        if getattr(self, "lebendig", True):
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
        self.wurzel.after(60, self.atmen)

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
        self.rahmen.pack_forget()
        self.fuss.pack_forget()
        self.kopf.itemconfig(self.klappe_id, text="▴")
        self.hoehe_ziehen(KOPFHOCH)

    def ausklappen(self):
        if not self.eingeklappt:
            return
        self.namen = herkunft_namen()
        self.manuell = False
        self.verstecken_um = None
        self.eingeklappt = False
        self.rahmen.pack(fill="both", expand=True, padx=14, pady=(4, 10))
        self.fuss.pack(fill="x", padx=16, pady=(0, 10))
        self.kopf.itemconfig(self.klappe_id, text="▾")
        self.hoehe_ziehen(HOCH)

    def umschalten(self):
        self.ausklappen() if self.eingeklappt else self.einklappen()

    # ── Sitzungen beobachten ────────────────────────────────────
    def nachsehen(self):
        offen = sitzungen()

        # Klingel vom Desktop: dann zeigen, auch wenn niemand verbunden ist.
        if os.path.exists(RUFEN):
            try:
                os.remove(RUFEN)
            except OSError:
                pass
            self.manuell = True
            self.verstecken_um = None
            self.zeigen_lassen()

        if offen:
            self.manuell = False
            self.verstecken_um = None
            self.zeigen_lassen()
            self.lebendig = True
            self.setzen(titel=(
                f"{offen[0][0]} arbeitet gerade über SSH" if len(offen) == 1
                else f"{len(offen)} Fernzugriffe laufen"
            ), wer="   ·   ".join(
                f"{wer} · {herkunft}" for wer, herkunft, _seit in offen
            ))
            self.namen = herkunft_namen()
        elif self.sichtbar:
            self.lebendig = False
            if self.manuell:
                self.setzen(titel="Protokoll des Fernzugriffs",
                            wer="Gerade ist niemand verbunden.")
            else:
                # Noch eine Minute stehen lassen: die letzten Zeilen will man
                # meist noch lesen, wenn die Verbindung eben erst endete.
                if self.verstecken_um is None:
                    self.verstecken_um = time.monotonic() + NACHLAUF
                rest = int(self.verstecken_um - time.monotonic())
                self.setzen(titel="Fernzugriff beendet",
                            wer=f"schließt in {max(rest, 0)} s — später wieder über "
                                f"„Fernzugriff-Protokoll\u201c im Startmenü")
                if rest <= 0:
                    self.verstecken_um = None
                    self.blende(0.0, danach=self._wegraeumen)

        self.kopf.itemconfig(self.schliessen_id,
                             state="normal" if (self.sichtbar and not offen) else "hidden")
        self.wurzel.after(int(TAKT * 1000), self.nachsehen)

    def zeigen_lassen(self):
        if not self.sichtbar:
            self.wurzel.deiconify()
            self.wurzel.lift()
            self.sichtbar = True
            self.kopf_malen()
            self.blende(1.0)

    def verstecken(self):
        """Nur wegräumen, nicht beenden — der Wächter bleibt wach."""
        self.blende(0.0, danach=self._wegraeumen)

    def _wegraeumen(self):
        self.wurzel.withdraw()
        self.sichtbar = False
        self.manuell = False
        self.verstecken_um = None

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
            self.zeigen(uhr, text)
        self.wurzel.after(300, self.abarbeiten)

    def schreiben(self, stuecke):
        """Eine Zeile aus mehreren gefärbten Stücken setzen."""
        self.text.config(state="normal")
        anfang = self.text.index("end-1c")
        for inhalt, marke in stuecke:
            self.text.insert("end", inhalt, marke)
        self.text.insert("end", "\n")
        # Kurz aufleuchten lassen, damit das Auge das Neue findet.
        self.text.tag_add("frisch", anfang, "end-1c")
        self.wurzel.after(700, lambda a=anfang: self._abklingen(a))
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
            self.schreiben([(zeit, "zeit"), ("┌ ", "strich"), ("Verbindung geöffnet", "beginn"),
                            (f"  ·  {wer}" if wer else "", "leise")])
            self.offen = True
            self.zaehler = 0
        elif text.startswith("SCHLIESST"):
            anzahl = getattr(self, "zaehler", 0)
            hinweis = (f"  ·  {anzahl} Befehl" + ("e" if anzahl != 1 else "")) if anzahl else ""
            self.schreiben([(zeit, "zeit"), ("└ ", "strich"), ("Verbindung beendet", "ende"),
                            (hinweis, "leise")])
            self.offen = False
            self.schreiben([("", "leise")])
        elif text.startswith("DATEIEN"):
            self.schreiben([(zeit, "zeit"), ("│ ", "strich"), ("Dateiübertragung", "datei"),
                            (f"  ·  {text[7:].strip()}", "leise")])
        else:
            self.zaehler = getattr(self, "zaehler", 0) + 1
            zeilen = [z for z in text.splitlines() if z.strip()]
            if not zeilen:
                return
            balken = "│ " if getattr(self, "offen", False) else "  "
            self.schreiben([(zeit, "zeit"), (balken, "strich"), (zeilen[0].strip(), "befehl")])
            # Mehrzeiliges eingerückt darunter, damit es zusammenhängend bleibt.
            for weiter in zeilen[1:]:
                self.schreiben([(" " * len(zeit), "zeit"), (balken, "strich"),
                                ("  " + weiter.strip(), "leise")])


if __name__ == "__main__":
    Fenster().wurzel.mainloop()
