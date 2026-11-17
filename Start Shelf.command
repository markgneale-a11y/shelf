#!/bin/bash
# Double-click to start Shelf: serves this folder on 127.0.0.1:8765 and opens it in your browser.
cd "$(dirname "$0")"
if ! lsof -iTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
  python3 -m http.server 8765 --bind 127.0.0.1 >/dev/null 2>&1 &
  sleep 1
fi
open "http://127.0.0.1:8765/"
echo "Shelf is running at http://127.0.0.1:8765/  (close this window to stop it)"
wait
