# stellium-fern-host
#
# Die Protokoll-Dateien (.xml) beschreiben, wie man mit dem Compositor redet.
# `wayland-scanner` macht daraus C — deshalb stehen die erzeugten Dateien nicht
# im Verzeichnisbaum, sondern entstehen beim Bauen.

SCANNER  := wayland-scanner
XML      := protokolle
ERZEUGT  := erzeugt

PROTOKOLLE := \
  wlr-screencopy-unstable-v1 \
  wlr-virtual-pointer-unstable-v1 \
  wlr-data-control-unstable-v1 \
  virtual-keyboard-unstable-v1

KOEPFE  := $(PROTOKOLLE:%=$(ERZEUGT)/%-client-protocol.h)
QUELLEN := $(PROTOKOLLE:%=$(ERZEUGT)/%-protocol.c)

PAKETE := wayland-client x264 libswscale libavutil xkbcommon
CFLAGS  += -O2 -Wall -Wextra -I$(ERZEUGT) $(shell pkg-config --cflags $(PAKETE))
LDLIBS  += $(shell pkg-config --libs $(PAKETE)) -lm -lpthread

.PHONY: alle sauber
alle: fern-host

$(ERZEUGT):
	@mkdir -p $@

$(ERZEUGT)/%-client-protocol.h: $(XML)/%.xml | $(ERZEUGT)
	$(SCANNER) client-header $< $@

$(ERZEUGT)/%-protocol.c: $(XML)/%.xml | $(ERZEUGT)
	$(SCANNER) private-code $< $@

fern-host: fern-host.c eingabe.c eingabe.h $(KOEPFE) $(QUELLEN)
	$(CC) $(CFLAGS) -o $@ fern-host.c eingabe.c $(QUELLEN) $(LDLIBS)

sauber:
	rm -rf $(ERZEUGT) fern-host
