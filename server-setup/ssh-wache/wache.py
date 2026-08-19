#!/usr/bin/env python3
"""
Ein Fenster, das zeigt, wenn jemand über SSH auf diesem Pi arbeitet.

Es erscheint, sobald eine Sitzung aufgeht, listet mit, welche Befehle laufen,
und verschwindet, wenn die letzte Sitzung endet. Gedacht als Mitleser, nicht
als Schloss: wer hier steht, soll sehen können, was aus der Ferne geschieht.

Läuft auf dem Desktop des Pi, ohne Zusatzpakete außer python3-tk.
"""
import os
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
}


def sitzungen():
    """Wer ist gerade über SSH da? Gibt (konto, herkunft, seit) zurück."""
    try:
        roh = subprocess.run(
            ["who", "-u"], capture_output=True, text=True, timeout=5
        ).stdout
    except Exception:
        return []
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
        aus.append((teile[0], herkunft, " ".join(teile[2:4])))
    return aus


class Fenster:
    def __init__(self):
        self.wurzel = tk.Tk()
        self.wurzel.title("Stellium — Fernzugriff")
        self.wurzel.configure(bg=FARBEN["grund"])
        self.wurzel.attributes("-topmost", True)
        self.wurzel.overrideredirect(False)
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
            kopf, text="Jemand arbeitet gerade über SSH",
            fg=FARBEN["tinte"], bg=FARBEN["grund"], font=fett, anchor="w",
        )
        self.titel.pack(side="left")

        self.wer = tk.Label(
            self.wurzel, text="", fg=FARBEN["leise"], bg=FARBEN["grund"],
            font=eng, anchor="w", justify="left",
        )
        self.wer.pack(fill="x", padx=14)

        rahmen = tk.Frame(self.wurzel, bg=FARBEN["rand"], bd=0)
        rahmen.pack(fill="both", expand=True, padx=14, pady=12)

        self.text = tk.Text(
            rahmen, bg="#070912", fg=FARBEN["tinte"], font=eng,
            insertbackground=FARBEN["tinte"], relief="flat", padx=10, pady=8,
            wrap="none", state="disabled",
        )
        self.text.pack(fill="both", expand=True, padx=1, pady=1)
        self.text.tag_config("befehl", foreground=FARBEN["tinte"])
        self.text.tag_config("beginn", foreground=FARBEN["gut"])
        self.text.tag_config("ende", foreground=FARBEN["warn"])

        fuss = tk.Label(
            self.wurzel,
            text=f"Alles Mitgeschriebene steht auch in {LOG}",
            fg=FARBEN["leise"], bg=FARBEN["grund"], anchor="w",
        )
        fuss.pack(fill="x", padx=14, pady=(0, 10))

        self.warteschlange = queue.Queue()
        threading.Thread(target=self.mitlesen, daemon=True).start()
        self.nachsehen()
        self.abarbeiten()

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
            self.wer.config(text="\n".join(
                f"{konto} von {herkunft} — seit {seit}" for konto, herkunft, seit in offen
            ))
        self.wurzel.after(int(TAKT * 1000), self.nachsehen)

    # ── Mitschrift lesen ────────────────────────────────────────
    def mitlesen(self):
        """Der Datei folgen, auch wenn sie zwischendurch gedreht wird."""
        while True:
            try:
                with open(LOG, "r", errors="replace") as f:
                    f.seek(0, os.SEEK_END)
                    while True:
                        zeile = f.readline()
                        if zeile:
                            self.warteschlange.put(zeile.rstrip("\n"))
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
            zeile = self.warteschlange.get()
            marke = "befehl"
            if " öffnet " in zeile or "ÖFFNET" in zeile:
                marke = "beginn"
            elif " schließt " in zeile or "SCHLIESST" in zeile:
                marke = "ende"
            self.text.config(state="normal")
            self.text.insert("end", zeile + "\n", marke)
            # Nicht endlos wachsen lassen.
            if int(self.text.index("end-1c").split(".")[0]) > ZEILEN:
                self.text.delete("1.0", "2.0")
            self.text.see("end")
            self.text.config(state="disabled")
        self.wurzel.after(300, self.abarbeiten)


if __name__ == "__main__":
    Fenster().wurzel.mainloop()
