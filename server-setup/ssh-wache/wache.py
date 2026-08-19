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
import queue
import subprocess
import threading
import time
import tkinter as tk
from tkinter import font as tkfont

LOG = "/var/log/stellium-ssh.log"
TAKT = 2.0            # wie oft nach Sitzungen gesehen wird
ZEILEN = 400          # so viele Zeilen bleiben im Fenster

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
}


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
        aus.append((wer, herkunft, " ".join(teile[2:4])))
    return aus


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
        self.wurzel.geometry("720x420+40+40")
        self.wurzel.withdraw()          # erst zeigen, wenn jemand da ist
        self.sichtbar = False

        eng = tkfont.Font(family="DejaVu Sans Mono", size=10)
        fett = tkfont.Font(family="DejaVu Sans", size=13, weight="bold")

        kopf = tk.Frame(self.wurzel, bg=FARBEN["grund"])
        kopf.pack(fill="x", padx=14, pady=(12, 6))

        self.punkt = tk.Label(kopf, text="●", fg=FARBEN["gut"], bg=FARBEN["grund"], font=fett)
        self.punkt.pack(side="left", padx=(0, 8))

        self.titel = tk.Label(
            kopf, text="Fernzugriff läuft",
            fg=FARBEN["tinte"], bg=FARBEN["grund"], font=fett, anchor="w",
        )
        self.titel.pack(side="left")

        # Schließen soll nicht gehen — wer aus der Ferne arbeitet, soll nicht
        # unsichtbar werden können. Einklappen genügt: dann bleibt eine
        # schmale Leiste stehen, die weiterhin zeigt, dass jemand da ist.
        self.klappe = tk.Button(
            kopf, text="▾", command=self.umschalten, relief="flat",
            bg=FARBEN["grund"], fg=FARBEN["leise"], activebackground=FARBEN["grund"],
            activeforeground=FARBEN["tinte"], bd=0, highlightthickness=0,
            font=fett, cursor="hand2", padx=8,
        )
        self.klappe.pack(side="right")

        # Verschieben: was keine Fensterleiste hat, muss man am Kopf anfassen können.
        for teil in (kopf, self.titel, self.punkt):
            teil.bind("<Button-1>", self.griff_setzen)
            teil.bind("<B1-Motion>", self.griff_ziehen)

        self.wer = tk.Label(
            self.wurzel, text="", fg=FARBEN["leise"], bg=FARBEN["grund"],
            font=eng, anchor="w", justify="left",
        )
        self.wer.pack(fill="x", padx=14)

        self.rahmen = tk.Frame(self.wurzel, bg=FARBEN["rand"], bd=0)
        self.rahmen.pack(fill="both", expand=True, padx=14, pady=12)

        self.text = tk.Text(
            self.rahmen, bg="#070912", fg=FARBEN["tinte"], font=eng,
            insertbackground=FARBEN["tinte"], relief="flat", padx=10, pady=8,
            wrap="none", state="disabled", spacing1=1,
        )
        self.text.pack(fill="both", expand=True, padx=1, pady=1)
        self.text.tag_config("befehl", foreground=FARBEN["tinte"])
        self.text.tag_config("beginn", foreground=FARBEN["gut"])
        self.text.tag_config("ende", foreground=FARBEN["warn"])
        self.text.tag_config("zeit", foreground=FARBEN["zeit"])
        self.text.tag_config("strich", foreground=FARBEN["strich"])
        self.text.tag_config("datei", foreground=FARBEN["datei"])
        self.text.tag_config("leise", foreground=FARBEN["leise"])

        self.fuss = tk.Label(
            self.wurzel,
            text="Alles Mitgeschriebene steht auch im Journal:  journalctl -t stellium-ssh",
            fg=FARBEN["leise"], bg=FARBEN["grund"], anchor="w",
        )
        self.fuss.pack(fill="x", padx=14, pady=(0, 10))

        self.eingeklappt = False
        self.wurzel.protocol("WM_DELETE_WINDOW", self.einklappen)

        self.warteschlange = queue.Queue()
        threading.Thread(target=self.mitlesen, daemon=True).start()
        self.nachsehen()
        self.abarbeiten()

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
        self.wer.pack_forget()
        self.klappe.config(text="▴")
        self.wurzel.geometry(f"420x74+{self.wurzel.winfo_x()}+{self.wurzel.winfo_y()}")

    def ausklappen(self):
        if not self.eingeklappt:
            return
        self.eingeklappt = False
        self.wer.pack(fill="x", padx=14)
        self.rahmen.pack(fill="both", expand=True, padx=14, pady=12)
        self.fuss.pack(fill="x", padx=14, pady=(0, 10))
        self.klappe.config(text="▾")
        self.wurzel.geometry(f"720x420+{self.wurzel.winfo_x()}+{self.wurzel.winfo_y()}")

    def umschalten(self):
        self.ausklappen() if self.eingeklappt else self.einklappen()

    # ── Sitzungen beobachten ────────────────────────────────────
    def nachsehen(self):
        offen = sitzungen()
        if offen and not self.sichtbar:
            self.wurzel.deiconify()
            self.wurzel.lift()
            self.sichtbar = True
        elif not offen and self.sichtbar:
            self.wurzel.withdraw()
            self.sichtbar = False

        if offen:
            self.titel.config(text=(
                f"{offen[0][0]} arbeitet gerade über SSH" if len(offen) == 1
                else f"{len(offen)} Fernzugriffe laufen"
            ))
            self.wer.config(text="\n".join(
                f"{wer} · {herkunft} · seit {seit}" for wer, herkunft, seit in offen
            ))
        self.wurzel.after(int(TAKT * 1000), self.nachsehen)

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
        for inhalt, marke in stuecke:
            self.text.insert("end", inhalt, marke)
        self.text.insert("end", "\n")
        # Nicht endlos wachsen lassen.
        if int(self.text.index("end-1c").split(".")[0]) > ZEILEN:
            self.text.delete("1.0", "2.0")
        self.text.see("end")
        self.text.config(state="disabled")

    def zeigen(self, uhr, text):
        """Eine Meldung einordnen und passend setzen.

        Der Aufbau folgt dem Verlauf einer Sitzung: sie beginnt, es geschieht
        etwas, sie endet. Die senkrechte Linie hält zusammen, was dazugehört —
        so sieht man auf einen Blick, welche Befehle zu welchem Besuch gehören.
        """
        zeit = (uhr + "  ") if uhr else ""
        if text.startswith("ÖFFNET"):
            wer = text[6:].strip()
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
