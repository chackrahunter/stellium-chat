#!/usr/bin/env python3
"""
Prüft, dass die Wache nie einen Widerspruch anzeigt.

Der Anlass: Don sah gleichzeitig „Nobody is connected right now." (SSH) und
„Screen · connected since 11:18" (Bildschirm) — zwei unabhängige Anzeigen, die
wie eine einzige falsche Auskunft aussahen, weil (a) der SSH-Text nirgends
sagte, dass er nur von SSH spricht, und (b) die Bildschirm-Zeile keinen Namen
zeigte, obwohl die Gegenstelle einen mitschickt.

Geprüft wird beides, direkt an der echten Anzeige-Logik aus `wache.py` und
`konsole.py` — nicht an einer Abschrift davon. Tk selbst wird dafür durch
einen Blindgänger ersetzt (siehe `_tk_blindgaenger`): keine der hier
geprüften Funktionen öffnet ein Fenster, also braucht es auch keins — das
läuft dann überall, mit oder ohne python3-tk, mit oder ohne Bildschirm.

    python3 server-setup/ssh-wache/pruefen.py
"""
import calendar
import importlib.util
import os
import sys
import time
import types

HIER = os.path.dirname(os.path.abspath(__file__))

ROT, GRUEN, GRAU, AUS = "\x1b[31m", "\x1b[32m", "\x1b[90m", "\x1b[0m"
fehler = 0


def pruefe(was, bedingung, zusatz=""):
    global fehler
    ok = bool(bedingung)
    if not ok:
        fehler += 1
    zeichen = f"{GRUEN}✓{AUS}" if ok else f"{ROT}✗{AUS}"
    zusatzteil = f"  {GRAU}{zusatz}{AUS}" if zusatz else ""
    print(f"  {zeichen} {was}{zusatzteil}")


def _tk_blindgaenger():
    """Ein `tkinter`, das sich anlegen, aber nie anzeigen lässt.

    `wache.py` und `konsole.py` bauen beim reinen Import noch kein einziges
    Fenster — Widgets entstehen erst, wenn jemand tatsächlich `Mitschrift(...)`
    oder `Konsole()` aufruft. Diese Prüfung tut das nie; sie ruft nur die
    reinen Funktionen und Methoden auf, die Text berechnen. Der Blindgänger
    muss also nichts können außer sich als Basisklasse eintragen zu lassen.
    """
    modul = types.ModuleType("tkinter")

    class Ding:
        def __init__(self, *a, **k):
            pass

        def __getattr__(self, _name):
            def ruf(*a, **k):
                return None
            return ruf

    for name in ("Frame", "Canvas", "Text", "Label", "Tk", "Toplevel",
                 "OptionMenu", "Menu", "Button", "Entry", "Scrollbar",
                 "PhotoImage"):
        setattr(modul, name, Ding)

    class StringVar(Ding):
        def __init__(self, value=""):
            self._wert = value

        def get(self):
            return self._wert

        def set(self, wert):
            self._wert = wert

        def trace_add(self, *a, **k):
            pass

    modul.StringVar = StringVar
    modul.TclError = type("TclError", (Exception,), {})

    schrift = types.ModuleType("tkinter.font")
    schrift.Font = Ding
    modul.font = schrift

    sys.modules["tkinter"] = modul
    sys.modules["tkinter.font"] = schrift


def _laden(pfad, name):
    angabe = importlib.util.spec_from_file_location(name, pfad)
    modul = importlib.util.module_from_spec(angabe)
    angabe.loader.exec_module(modul)
    return modul


_tk_blindgaenger()
wache = _laden(os.path.join(HIER, "wache.py"), "wache_unter_pruefung")
konsole = _laden(
    os.path.join(HIER, os.pardir, "konsole-gui", "konsole.py"),
    "konsole_unter_pruefung",
)


# ── Hilfen für die Bildschirm-Karte ──────────────────────────────
class _FakeMarke:
    """Steht für das `tk.Label`, das `schirm_zeigen` sonst beschriftet."""

    def __init__(self):
        self.text = None
        self.fg = None

    def config(self, text=None, fg=None):
        if text is not None:
            self.text = text
        if fg is not None:
            self.fg = fg


class _FakeKonsole:
    """Genau die Felder, die `Konsole.schirm_zeigen` anfasst — nicht mehr."""

    def __init__(self):
        self.schirm_stand = _FakeMarke()
        self._schirm_text = None


def schirm_text(d):
    fk = _FakeKonsole()
    konsole.Konsole.schirm_zeigen(fk, d)
    return fk.schirm_stand.text


print("\nSSH-Seite (wache.py) — wer ist da, und sagt sie das ehrlich?\n")

for sprache in ("de", "en"):
    wache.SPRACHE = sprache
    print(f"  — Sprache: {sprache} —")

    titel, wer = wache.kopf_text([])
    pruefe("niemand verbunden: nennt SSH ausdrücklich",
           "ssh" in titel.lower() or "ssh" in wer.lower(), f"{titel!r} / {wer!r}")
    alte_mehrdeutige_saetze = {
        "de": "Gerade ist niemand verbunden.",
        "en": "Nobody is connected right now.",
    }
    pruefe("niemand verbunden: nicht mehr der alte mehrdeutige Satz",
           wer != alte_mehrdeutige_saetze[sprache], repr(wer))

    eine = [("aryan", "10.0.0.5", "10:00")]
    titel1, wer1 = wache.kopf_text(eine)
    pruefe("eine SSH-Sitzung: Titel nennt SSH", "ssh" in titel1.lower(), repr(titel1))
    pruefe("eine SSH-Sitzung: der Name steht in der Zeile", "aryan" in wer1)
    pruefe("eine SSH-Sitzung: NIE der „niemand verbunden“-Text "
           "(das ist genau der gemeldete Widerspruch)",
           wer1 != wache.T("niemand") and titel1 != wache.T("protokoll"))

    zwei = [("aryan", "10.0.0.5", "10:00"), ("dana", "10.0.0.9", "10:05")]
    titel2, wer2 = wache.kopf_text(zwei)
    pruefe("zwei SSH-Sitzungen: Titel nennt SSH und die Anzahl",
           "ssh" in titel2.lower() and "2" in titel2, repr(titel2))
    pruefe("zwei SSH-Sitzungen: auch hier NIE der „niemand verbunden“-Text",
           wer2 != wache.T("niemand"))

print("\nBildschirm-Seite (konsole.py) — wird der Kontoname gezeigt?\n")

for sprache in ("de", "en"):
    konsole.SPRACHE = sprache
    wache.SPRACHE = sprache
    print(f"  — Sprache: {sprache} —")

    jetzt_iso = time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())

    # Verbunden, mit Namen von der Gegenstelle.
    d_benannt = {"fern": {"da": True, "verbunden": True, "seit": jetzt_iso,
                          "konto": "Aryan"}}
    text_benannt = schirm_text(d_benannt)
    pruefe("verbunden mit Konto: zeigt den Namen", "Aryan" in text_benannt,
           repr(text_benannt))
    pruefe("verbunden mit Konto: als „Bildschirm“/„Screen“ erkennbar, nicht als SSH",
           ("bildschirm" in text_benannt.lower() or "screen" in text_benannt.lower())
           and "ssh" not in text_benannt.lower())

    # Verbunden, aber ohne Namen (ältere Gegenstelle oder keiner angegeben).
    for ohne_namen in (None, "", "   "):
        d_unbenannt = {"fern": {"da": True, "verbunden": True, "seit": jetzt_iso,
                                "konto": ohne_namen}}
        text_unbenannt = schirm_text(d_unbenannt)
        erwartet = konsole.T("schirm_unbekannt")
        pruefe(f"verbunden ohne Konto ({ohne_namen!r}): ehrliches "
               f"„{erwartet}“ statt leerer Zeile",
               erwartet in text_unbenannt and "None" not in text_unbenannt,
               repr(text_unbenannt))

    # Niemand am Bildschirm — muss sich vom SSH-Text unterscheiden können,
    # auch wenn beide zufällig nebeneinander stehen.
    d_frei = {"fern": {"da": True, "verbunden": False, "seit": None, "konto": None}}
    text_frei = schirm_text(d_frei)
    ssh_frei = wache.T("niemand")
    pruefe("Bildschirm frei: eigener Text, kein Zusammenfall mit dem SSH-Text",
           text_frei != ssh_frei, f"Bildschirm={text_frei!r}  SSH={ssh_frei!r}")

    # Fernsteuerung läuft gar nicht (kein zustand.json) — auch das ist eine
    # ehrliche Auskunft, kein leerer Platz.
    d_aus = {"fern": {"da": False, "verbunden": False, "seit": None, "konto": None}}
    text_aus = schirm_text(d_aus)
    pruefe("Fernsteuerungsdienst läuft nicht: eigener, klarer Text",
           text_aus not in (text_benannt, text_frei), repr(text_aus))

print()
if fehler:
    print(f"{ROT}{fehler} Prüfung(en) fehlgeschlagen.{AUS}\n")
    sys.exit(1)
print(f"{GRUEN}Alle Prüfungen bestanden.{AUS}\n")
sys.exit(0)
