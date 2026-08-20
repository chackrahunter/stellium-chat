#define _GNU_SOURCE
#include "eingabe.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

#include <xkbcommon/xkbcommon.h>

#include "wlr-virtual-pointer-unstable-v1-client-protocol.h"
#include "virtual-keyboard-unstable-v1-client-protocol.h"
#include "wlr-data-control-unstable-v1-client-protocol.h"

#define TEXT_ART   "text/plain;charset=utf-8"
#define ABLAGE_MAX (1024 * 1024)      /* 1 MB reicht für Text; alles darüber
                                         ist mit Sicherheit kein Kopieren */

struct Eingabe {
  struct wl_display *anzeige;
  struct wl_seat    *sitz;

  struct zwlr_virtual_pointer_manager_v1 *zeiger_verw;
  struct zwlr_virtual_pointer_v1         *zeiger;
  struct zwp_virtual_keyboard_manager_v1 *tast_verw;
  struct zwp_virtual_keyboard_v1         *tastatur;
  struct zwlr_data_control_manager_v1    *ablage_verw;
  struct zwlr_data_control_device_v1     *ablage;
  struct zwlr_data_control_source_v1     *quelle;

  char   *unser_text;          /* was WIR zuletzt gesetzt haben */
  size_t  unser_laenge;

  AblageRuf ruf;
  void     *nutzer;

  /* Der zuletzt angebotene Text-Behälter, bis `selection` ihn bestätigt. */
  struct zwlr_data_control_offer_v1 *angebot;
  bool angebot_kann_text;
};

static uint32_t zeitstempel(void) {
  struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t);
  return (uint32_t)(t.tv_sec * 1000 + t.tv_nsec / 1000000);
}

/* ── Zeiger ──────────────────────────────────────────────────── */

void eingabe_zeiger(struct Eingabe *e, uint32_t x, uint32_t y) {
  if (!e->zeiger) return;
  /* Absolut statt relativ: relative Bewegung würde sich mit jeder verlorenen
     Nachricht aufsummieren und der Zeiger liefe langsam aus dem Bild. */
  zwlr_virtual_pointer_v1_motion_absolute(e->zeiger, zeitstempel(), x, y, 65535, 65535);
  zwlr_virtual_pointer_v1_frame(e->zeiger);
}

void eingabe_taste(struct Eingabe *e, uint32_t knopf, bool gedrueckt) {
  if (!e->zeiger) return;
  zwlr_virtual_pointer_v1_button(e->zeiger, zeitstempel(), knopf,
      gedrueckt ? WL_POINTER_BUTTON_STATE_PRESSED : WL_POINTER_BUTTON_STATE_RELEASED);
  zwlr_virtual_pointer_v1_frame(e->zeiger);
}

void eingabe_rollen(struct Eingabe *e, uint32_t achse, double wert) {
  if (!e->zeiger) return;
  zwlr_virtual_pointer_v1_axis(e->zeiger, zeitstempel(), achse, wl_fixed_from_double(wert));
  zwlr_virtual_pointer_v1_frame(e->zeiger);
}

/* ── Tastatur ────────────────────────────────────────────────── */

void eingabe_tastatur(struct Eingabe *e, uint32_t code, bool gedrueckt) {
  if (!e->tastatur) return;
  /* Der Code ist ein evdev-Code (KEY_A = 30), genau wie ihn wl_keyboard
     benutzt. Die xkb-Zuordnung liegt beim Compositor und rechnet selbst +8. */
  zwp_virtual_keyboard_v1_key(e->tastatur, zeitstempel(), code, gedrueckt ? 1 : 0);
}

void eingabe_umschalter(struct Eingabe *e, uint32_t gedrueckt, uint32_t verriegelt,
                        uint32_t gesperrt, uint32_t gruppe) {
  if (!e->tastatur) return;
  zwp_virtual_keyboard_v1_modifiers(e->tastatur, gedrueckt, verriegelt, gesperrt, gruppe);
}

static bool tastatur_richten(struct Eingabe *e) {
  struct xkb_context *ktx = xkb_context_new(XKB_CONTEXT_NO_FLAGS);
  if (!ktx) return false;
  /* Eine feste us-Belegung. Der Mac schickt uns evdev-Codes, keine Zeichen —
     welche Belegung der Pi sonst benutzt, spielt damit keine Rolle, und eine
     feste Zuordnung ist auf beiden Seiten vorhersagbar. */
  struct xkb_rule_names namen = { .rules = "evdev", .model = "pc105",
                                  .layout = "us", .variant = NULL, .options = NULL };
  struct xkb_keymap *belegung =
    xkb_keymap_new_from_names(ktx, &namen, XKB_KEYMAP_COMPILE_NO_FLAGS);
  if (!belegung) { xkb_context_unref(ktx); return false; }

  char *text = xkb_keymap_get_as_string(belegung, XKB_KEYMAP_FORMAT_TEXT_V1);
  size_t groesse = strlen(text) + 1;
  int fd = memfd_create("stellium-belegung", MFD_CLOEXEC);
  bool ok = false;
  if (fd >= 0 && ftruncate(fd, (off_t)groesse) == 0) {
    void *z = mmap(NULL, groesse, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
    if (z != MAP_FAILED) {
      memcpy(z, text, groesse);
      munmap(z, groesse);
      zwp_virtual_keyboard_v1_keymap(e->tastatur, WL_KEYBOARD_KEYMAP_FORMAT_XKB_V1,
                                     fd, (uint32_t)groesse);
      ok = true;
    }
  }
  if (fd >= 0) close(fd);
  free(text);
  xkb_keymap_unref(belegung);
  xkb_context_unref(ktx);
  return ok;
}

/* ── Zwischenablage: vom Pi lesen ────────────────────────────── */

static void ang_mime(void *d, struct zwlr_data_control_offer_v1 *o, const char *art) {
  (void)o;
  struct Eingabe *e = d;
  if (!strcmp(art, TEXT_ART) || !strcmp(art, "text/plain") || !strcmp(art, "UTF8_STRING"))
    e->angebot_kann_text = true;
}
static const struct zwlr_data_control_offer_v1_listener angebot_hoerer = { ang_mime };

static void dev_angebot(void *d, struct zwlr_data_control_device_v1 *dev,
                        struct zwlr_data_control_offer_v1 *o) {
  (void)dev;
  struct Eingabe *e = d;
  e->angebot = o;
  e->angebot_kann_text = false;
  zwlr_data_control_offer_v1_add_listener(o, &angebot_hoerer, e);
}

static void dev_auswahl(void *d, struct zwlr_data_control_device_v1 *dev,
                        struct zwlr_data_control_offer_v1 *o) {
  (void)dev;
  struct Eingabe *e = d;
  if (!o) return;
  if (!e->angebot_kann_text) { zwlr_data_control_offer_v1_destroy(o); e->angebot = NULL; return; }

  int roehre[2];
  if (pipe2(roehre, O_CLOEXEC) < 0) { zwlr_data_control_offer_v1_destroy(o); return; }
  zwlr_data_control_offer_v1_receive(o, TEXT_ART, roehre[1]);
  close(roehre[1]);
  /* Erst hinausschicken, sonst wartet die Gegenseite auf eine Bitte, die noch
     im Ausgangspuffer liegt — und wir warten auf ihre Antwort. */
  wl_display_flush(e->anzeige);

  char *puffer = malloc(ABLAGE_MAX);
  size_t gelesen = 0;
  if (puffer) {
    fcntl(roehre[0], F_SETFL, O_NONBLOCK);
    for (;;) {
      struct pollfd pf = { .fd = roehre[0], .events = POLLIN };
      /* Begrenzt warten: hängt die Gegenseite, darf das nicht den Bildstrom
         mit anhalten. */
      if (poll(&pf, 1, 300) <= 0) break;
      ssize_t n = read(roehre[0], puffer + gelesen, ABLAGE_MAX - gelesen);
      if (n == 0) break;
      if (n < 0) { if (errno == EAGAIN || errno == EINTR) continue; break; }
      gelesen += (size_t)n;
      if (gelesen >= ABLAGE_MAX) break;
    }
  }
  close(roehre[0]);
  zwlr_data_control_offer_v1_destroy(o);
  e->angebot = NULL;

  if (puffer && gelesen) {
    /* Was wir selbst gerade gesetzt haben, nicht zurückmelden — sonst
       schaukeln sich Mac und Pi gegenseitig hoch. */
    bool eigenes = e->unser_text && e->unser_laenge == gelesen &&
                   !memcmp(e->unser_text, puffer, gelesen);
    if (!eigenes && e->ruf) e->ruf(puffer, gelesen, e->nutzer);
  }
  free(puffer);
}

static void dev_fertig(void *d, struct zwlr_data_control_device_v1 *dev) { (void)d; (void)dev; }
static void dev_primaer(void *d, struct zwlr_data_control_device_v1 *dev,
                        struct zwlr_data_control_offer_v1 *o) {
  (void)d; (void)dev;
  /* Die mittlere Maustaste kopiert unter Linux eine zweite, eigene Auswahl.
     Die spiegeln wir bewusst nicht — sie ändert sich bei jedem Markieren mit
     der Maus, und das wollte niemand auf dem Mac haben. */
  if (o) zwlr_data_control_offer_v1_destroy(o);
}

static const struct zwlr_data_control_device_v1_listener geraet_hoerer = {
  .data_offer = dev_angebot, .selection = dev_auswahl,
  .finished = dev_fertig, .primary_selection = dev_primaer,
};

/* ── Zwischenablage: auf den Pi schreiben ────────────────────── */

static void quelle_senden(void *d, struct zwlr_data_control_source_v1 *q,
                          const char *art, int32_t fd) {
  (void)q; (void)art;
  struct Eingabe *e = d;
  if (e->unser_text) {
    const char *p = e->unser_text; size_t rest = e->unser_laenge;
    while (rest) {
      ssize_t n = write(fd, p, rest);
      if (n <= 0) break;
      p += n; rest -= (size_t)n;
    }
  }
  close(fd);
}
static void quelle_weg(void *d, struct zwlr_data_control_source_v1 *q) {
  struct Eingabe *e = d;
  if (e->quelle == q) e->quelle = NULL;
  zwlr_data_control_source_v1_destroy(q);
}
static const struct zwlr_data_control_source_v1_listener quelle_hoerer = {
  .send = quelle_senden, .cancelled = quelle_weg,
};

void eingabe_ablage_setzen(struct Eingabe *e, const char *text, size_t laenge) {
  if (!e->ablage_verw || !e->ablage) return;
  free(e->unser_text);
  e->unser_text = malloc(laenge ? laenge : 1);
  if (!e->unser_text) { e->unser_laenge = 0; return; }
  memcpy(e->unser_text, text, laenge);
  e->unser_laenge = laenge;

  if (e->quelle) { zwlr_data_control_source_v1_destroy(e->quelle); e->quelle = NULL; }
  e->quelle = zwlr_data_control_manager_v1_create_data_source(e->ablage_verw);
  zwlr_data_control_source_v1_add_listener(e->quelle, &quelle_hoerer, e);
  zwlr_data_control_source_v1_offer(e->quelle, TEXT_ART);
  zwlr_data_control_source_v1_offer(e->quelle, "text/plain");
  zwlr_data_control_source_v1_offer(e->quelle, "UTF8_STRING");
  zwlr_data_control_device_v1_set_selection(e->ablage, e->quelle);
  wl_display_flush(e->anzeige);
}

/* ── Einrichten ──────────────────────────────────────────────── */

struct Eingabe *eingabe_anlegen(struct wl_display *anzeige, struct wl_registry *reg) {
  (void)reg;
  struct Eingabe *e = calloc(1, sizeof *e);
  if (e) e->anzeige = anzeige;
  return e;
}

void eingabe_global(struct Eingabe *e, struct wl_registry *r, uint32_t name,
                    const char *iface, uint32_t version) {
  if (!strcmp(iface, wl_seat_interface.name) && !e->sitz)
    e->sitz = wl_registry_bind(r, name, &wl_seat_interface, version < 7 ? version : 7);
  else if (!strcmp(iface, zwlr_virtual_pointer_manager_v1_interface.name))
    e->zeiger_verw = wl_registry_bind(r, name,
        &zwlr_virtual_pointer_manager_v1_interface, version < 2 ? version : 2);
  else if (!strcmp(iface, zwp_virtual_keyboard_manager_v1_interface.name))
    e->tast_verw = wl_registry_bind(r, name, &zwp_virtual_keyboard_manager_v1_interface, 1);
  else if (!strcmp(iface, zwlr_data_control_manager_v1_interface.name))
    e->ablage_verw = wl_registry_bind(r, name,
        &zwlr_data_control_manager_v1_interface, version < 2 ? version : 2);
}

bool eingabe_starten(struct Eingabe *e, AblageRuf ruf, void *nutzer) {
  e->ruf = ruf; e->nutzer = nutzer;
  if (!e->sitz) return false;

  if (e->zeiger_verw)
    e->zeiger = zwlr_virtual_pointer_manager_v1_create_virtual_pointer(e->zeiger_verw, e->sitz);
  if (e->tast_verw) {
    e->tastatur = zwp_virtual_keyboard_manager_v1_create_virtual_keyboard(e->tast_verw, e->sitz);
    if (e->tastatur && !tastatur_richten(e)) {
      zwp_virtual_keyboard_v1_destroy(e->tastatur); e->tastatur = NULL;
    }
  }
  if (e->ablage_verw) {
    e->ablage = zwlr_data_control_manager_v1_get_data_device(e->ablage_verw, e->sitz);
    if (e->ablage) zwlr_data_control_device_v1_add_listener(e->ablage, &geraet_hoerer, e);
  }
  return e->zeiger && e->tastatur;
}

void eingabe_freigeben(struct Eingabe *e) {
  if (!e) return;
  if (e->quelle)   zwlr_data_control_source_v1_destroy(e->quelle);
  if (e->ablage)   zwlr_data_control_device_v1_destroy(e->ablage);
  if (e->tastatur) zwp_virtual_keyboard_v1_destroy(e->tastatur);
  if (e->zeiger)   zwlr_virtual_pointer_v1_destroy(e->zeiger);
  free(e->unser_text);
  free(e);
}
