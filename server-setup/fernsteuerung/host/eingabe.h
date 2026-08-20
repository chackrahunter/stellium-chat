/*
 * Eingaben in den Pi hineinreichen: Zeiger, Tastatur, Zwischenablage.
 *
 * Alle drei laufen über Protokolle, die labwc anbietet (nachgesehen, nicht
 * vermutet — `zwlr_virtual_pointer_manager_v1` v2, `zwp_virtual_keyboard_-
 * manager_v1` v1, `zwlr_data_control_manager_v1` v2).
 *
 * Warum nicht `ydotool`: das braucht ein /dev/uinput und damit root, und es
 * hängt sich als *Gerät* in den Kernel statt als Client an den Compositor.
 * Der Weg über Wayland braucht keine Sonderrechte und geht genau an die
 * Sitzung, die wir auch abgreifen.
 *
 * Die Zwischenablage über `data_control` ist der eigentliche Grund, dieses
 * Protokoll zu nehmen: es liest und schreibt die Auswahl, **ohne dass ein
 * Fenster den Fokus haben muss**. Genau das braucht man, wenn auf dem Mac
 * kopiert und auf dem Pi eingefügt wird.
 */
#ifndef EINGABE_H
#define EINGABE_H

#include <stdbool.h>
#include <stdint.h>
#include <wayland-client.h>

struct Eingabe;

/* Wird gerufen, wenn sich die Zwischenablage AUF DEM PI geändert hat. */
typedef void (*AblageRuf)(const char *text, size_t laenge, void *nutzer);

struct Eingabe *eingabe_anlegen(struct wl_display *anzeige,
                                struct wl_registry *reg);
/* Nach dem Binden der Globals aufrufen — richtet Zeiger, Tastatur und
   Ablage ein. Gibt false zurück, wenn etwas Wesentliches fehlt. */
bool eingabe_starten(struct Eingabe *e, AblageRuf ruf, void *nutzer);

/* Der Registrierungs-Hörer reicht passende Globals hierher weiter. */
void eingabe_global(struct Eingabe *e, struct wl_registry *r, uint32_t name,
                    const char *iface, uint32_t version);

/* x und y in 0..65535, unabhängig von der Auflösung des Schirms. */
void eingabe_zeiger(struct Eingabe *e, uint32_t x, uint32_t y);
void eingabe_taste(struct Eingabe *e, uint32_t knopf, bool gedrueckt);
void eingabe_rollen(struct Eingabe *e, uint32_t achse, double wert);
void eingabe_tastatur(struct Eingabe *e, uint32_t code, bool gedrueckt);
void eingabe_umschalter(struct Eingabe *e, uint32_t gedrueckt, uint32_t verriegelt,
                        uint32_t gesperrt, uint32_t gruppe);
void eingabe_ablage_setzen(struct Eingabe *e, const char *text, size_t laenge);

void eingabe_freigeben(struct Eingabe *e);

#endif
