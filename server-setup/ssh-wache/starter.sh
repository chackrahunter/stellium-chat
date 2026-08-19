#!/bin/bash
# Startet das Fenster zum Nachlesen des Fernzugriffs.
#
# Früher lief hier eine Schleife, die das Fenster nach einem Absturz sofort
# wieder hochbrachte — als Wächter, den man nicht wegklicken können sollte.
# Das Wachen macht jetzt die Konsole im Hintergrund; dieses Fenster ruft man
# auf, liest nach und macht es wieder zu. Käme es nach dem Schließen von
# selbst zurück, wäre das lästig statt hilfreich.
exec /usr/bin/python3 /usr/local/lib/stellium/ssh-wache.py "$@"
