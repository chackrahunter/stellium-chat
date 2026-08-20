# Nimmt den Strom auseinander: Bild in eine Datei, Meldungen auf den Schirm.
import sys, struct
aus = open(sys.argv[1], "wb")
ein = sys.stdin.buffer
bilder = 0
while True:
    kopf = ein.read(5)
    if len(kopf) < 5: break
    art = kopf[0]; laenge = struct.unpack("<I", kopf[1:5])[0]
    nutz = b""
    while len(nutz) < laenge:
        st = ein.read(laenge - len(nutz))
        if not st: break
        nutz += st
    if art == 1:
        aus.write(nutz); bilder += 1
    elif art == 3:
        print("  [pi]", nutz.decode("utf-8", "replace"), file=sys.stderr, flush=True)
aus.close()
print(f"  {bilder} Bilder geschrieben", file=sys.stderr)
