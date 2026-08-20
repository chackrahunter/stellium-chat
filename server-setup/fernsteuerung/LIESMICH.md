# Stellium Fernsteuerung

Ersatz für TeamViewer auf dem Pi: Bild in Echtzeit zum Mac, Eingaben zurück,
Zwischenablage in beide Richtungen, Anmeldung über ID und Passwort.

**Stand: 20.08.2026 — vollständig, vom Mac aus durchs Internet erprobt.**

    Verbindung steht nach          480 ms
    Pi hat sich ausgewiesen        ✓
    Sitzung offen nach            1208 ms
    erstes Bild nach              2119 ms
    131 Bilder · 14,7 je Sekunde · 1919 kbit/s · verworfen 0

`verworfen 0` ist die wichtigste Zahl: die Leitung Deutschland–Alaska ist
nicht der Engpass. Die 14,7 Bilder/s sind genau das, was der Abgriff auf dem
Pi hergibt.

## Warum überhaupt selbst gebaut

Auf demselben Pi, im selben Ruhezustand gemessen:

| | Speicher | CPU im Leerlauf |
|---|---|---|
| TeamViewer (`teamviewerd` + `TeamViewer_Desktop`) | **815 MB** | rechnet durchgehend |
| `stellium-fern` | **33,8 MB** | **2,5 %** |

## Was gemessen wurde, bevor etwas entstand

Der **Pi 5 hat keinen Hardware-Kodierer für H.264**. Nachgesehen, nicht
vermutet: unter `/dev/video*` liegen `rpi-hevc-dec` (ein *De*kodierer) und
16× `pispbe` (Kamera-Pipeline). Die Zeile `h264_v4l2m2m` in ffmpeg ist eine
leere Hülle ohne Gerät. Also x264 in Software — reicht: 1080p mit 34 Bildern/s
bei 1,2 von 4 Kernen.

Die drei Stufen je Bild in 1920×1080:

    rücklesen   32 ms   (Minimum. Wächst genau mit der Fläche — bei 960×540
                         sind es 8 ms. Das sind ~260 MB/s aus dem Grafik-
                         speicher: eine Eigenschaft des Geräts, nicht des
                         Programms. labwc rendert über /dev/dri/card1.)
    Farbe        8 ms
    kodieren    20 ms

Nacheinander 60 ms. Auf zwei Fäden max(32, 28) = 32 ms.

### Was nichts gebracht hat — und warum es hier steht

**Mehrere Abgriffe gleichzeitig anfordern.** Naheliegend, denn ein Abgriff
besteht aus zwei ganz verschiedenen Wartezeiten (auf den nächsten Zeichen-
vorgang, dann auf das Rücklesen). Gemessen: 13,0 → 13,0 Bilder/s. Der
Compositor arbeitet die Anforderungen ohnehin nacheinander ab und reiht sie
nur ein. Steht als `--auftraege` noch drin, Vorgabe 1.

Gemessene Stellschrauben bei 1280×720:

| Aufträge | Kodier-Fäden | Bilder/s |
|---|---|---|
| 1 | 1 | 12,6 |
| 1 | 2 | 14,8 |
| **1** | **3** | **20,3** ← Vorgabe |
| 2 | 2 | 18,5 |
| 2 | 3 | 17,9 |

### Die wichtigste Messung

Mit angehaltenem Dashboard fällt der Abgriff auf **1,0 Bilder/s**. Das ist
kein Fehler, sondern der Beweis, dass `copy_with_damage` tut, was es soll:
**ein ruhiger Schirm kostet nichts.** Die Bildrate wird nicht vom Programm
begrenzt, sondern davon, wie oft sich der Schirm überhaupt ändert — derzeit
durch die Dashboard-Animation mit ~24 Bildern/s.

**Daraus folgt eine offene Aufgabe:** Während einer Fernsitzung ist diese
Animation reine Last. Sie zu drosseln gehört in `konsole-gui/konsole.py`
(dort liegen noch nicht committete Änderungen vom Gestaltungs-Agenten).

## Was drinsteckt

    host/fern-host.c      Abgriff (zwlr_screencopy v3) + x264, zwei Fäden
    host/eingabe.c/.h     Zeiger, Tastatur, Zwischenablage
    host/protokolle/      die vier Wayland-Protokolle als XML
    host/Makefile         wayland-scanner erzeugt den Rest beim Bauen
    dienst/anmeldung.mjs  ID, Passwort, Handschlag, Verschlüsselung

labwc 0.9.8 bietet alles Nötige an (mit einem eigenen Programm abgefragt,
nicht geraten): `zwlr_screencopy_manager_v1` v3, `zwlr_virtual_pointer_-
manager_v1` v2, `zwp_virtual_keyboard_manager_v1` v1, `zwlr_data_control_-
manager_v1` v2.

### Zwei Fallen, die Zeit gekostet haben

1. **`linux_dmabuf` darf im Hörer nicht `NULL` sein.** libwayland bricht das
   Programm ab, sobald ein Ereignis kommt, dessen Eintrag fehlt — und labwc
   schickt es bei *jedem* Bild. Fehlermeldung: `listener function for opcode 5
   of zwlr_screencopy_frame_v1 is NULL`.

2. **Puffer-Auswahl.** Der erste Entwurf nahm den ersten Puffer, an dem der
   Kodierer nicht arbeitet — oft einen, in dem noch ein ungelesenes Bild lag,
   während daneben ein leerer stand. 21–32 grundlos verworfene Bilder je zwei
   Sekunden, rund die halbe Ausbeute.

## Nachgewiesen

- Bild: gültiges H.264, 1920×1080, yuv420p (mit `ffprobe` geprüft)
- Zeiger: bewegt sich (Schirmbilder vorher/nachher unterschiedlich)
- Zwischenablage Mac → Pi: `wl-paste` liefert exakt den gesendeten Text
- Zwischenablage Pi → Mac: `wl-copy` auf dem Pi kommt als Rahmen an
- Tastatur: wird vom Compositor angenommen, ohne Warnung. **Dass Tasten in
  einem Programm ankommen, ist noch nicht gezeigt** — dafür braucht es ein
  Fenster mit Fokus und jemanden, der zusieht.

## Wie man es benutzt

Auf dem Pi läuft `stellium-fern.service` dauerhaft. Sie kostet nichts, solange
niemand zusieht: der Abgreifer wird **erst beim Verbinden gestartet** und beim
Trennen wieder beendet.

    sudo stellium-fern-passwort          zeigt die ID
    sudo stellium-fern-passwort --neu    würfelt ein neues Passwort
    sudo stellium-fern-passwort --setzen <wort>

**ID und Passwort bleiben dauerhaft.** Sie liegen auf der Platte und ändern
sich nur, wenn man sie ausdrücklich neu setzt — anders als bei TeamViewer, das
je Sitzung würfelt. Das ist Absicht: Don hat keinen Zugang zum Bildschirm des
Pi und könnte ein gewürfeltes Passwort gar nicht ablesen.

In der Mac-App: der Bildschirm in der linken Leiste. Adresse und Passwort
eintragen, verbinden. „Steuerung an" gibt Tastatur und Maus weiter; ohne sie
sieht man nur zu. Die Zwischenablage läuft in beide Richtungen mit.

Im Dashboard des Pi steht unten in der Fernzugriffs-Karte eine Zeile
`Bildschirm · verbunden seit HH:MM` — **nur dass**, nie was.

## Wie es hinausgeht

Port **7788**, freigegeben über NAT-PMP und in `stellium-zugang` aufgenommen,
also stündlich erneuert. In der Firewall des Pi eigens erlaubt (`ufw allow
7788/tcp`) — ohne das ging nichts durch, obwohl der Router weiterleitete und
der Dienst lauschte.

Kein TLS davor, und das ist kein Versäumnis: Handschlag und Strom sind
Ende-zu-Ende verschlüsselt (ECDH P-256 + scrypt, AES-256-GCM). Eine zweite
Schicht darüber brächte nichts als Verzögerung — und Verzögerung ist bei
Fernsteuerung das Einzige, was wirklich weh tut.

## Noch offen

1. Dashboard-Animation während einer Sitzung drosseln. Sie ist der Grund, warum
   der Schirm sich überhaupt 24-mal je Sekunde ändert — während man fernsteuert
   ist das reine Last.
2. `teamviewerd` läuft weiter. Es ist der Rückweg auf eine Maschine in Alaska,
   an die niemand hinfahren kann. Es fliegt raus, wenn Don das hier eine Weile
   im Alltag benutzt hat — nicht vorher.
3. Die Mac-Ansicht ist gebaut und typgeprüft, aber noch nicht von Hand bedient
   worden. Bewiesen sind: Handschlag, Bildstrom, Eingabe, Zwischenablage
   (jeweils über die echte Leitung) und die Dekodierung im Browser —
   **108 von 108 Bildern, 0 Fehler, 128 Bilder/s Dekodierleistung**.

## Bauen

    ssh stellium
    cd ~/fern-bau/host && make

Braucht: `build-essential pkg-config libwayland-dev wayland-protocols
libx264-dev libswscale-dev libavutil-dev libxkbcommon-dev wl-clipboard`
(alle bereits installiert).

## Von Hand ausprobieren

    export XDG_RUNTIME_DIR=/run/user/1000 WAYLAND_DISPLAY=wayland-0
    ./fern-host --bilder 30 --ausgabe 1280x720 | python3 entrahmen.py /tmp/x.h264

Befehle gehen zeilenweise auf stdin:

    z <x> <y>            Zeiger, 0..65535 (absolut, damit sich nichts aufsummiert)
    t <knopf> <0|1>      Maustaste (272 = links)
    r <achse> <wert>     Rollen
    k <code> <0|1>       Taste (evdev-Code, KEY_A = 30)
    m <d> <l> <s> <g>    Umschalter
    a <base64>           Zwischenablage setzen

Heraus kommen Rahmen: `[Art:1][Länge:4 LE][Inhalt]`, Art 1 = H.264,
2 = Zwischenablage, 3 = Meldung.
