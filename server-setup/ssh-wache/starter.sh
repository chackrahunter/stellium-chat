#!/bin/bash
# Hält das Fenster am Leben. Stürzt es ab, kommt es nach drei Sekunden wieder —
# ein Wächter, den man wegklicken kann, wacht über nichts.
while true; do
  /usr/bin/python3 /usr/local/lib/stellium/ssh-wache.py
  sleep 3
done
