#!/usr/bin/env bash
# Serve the project root on http://127.0.0.1:8765 (idempotent) and print the URL
# to open in the VS Code integrated browser (Cmd+Shift+P -> "Simple Browser: Show").
# Usage: serve.sh <path/to/report.html>
set -euo pipefail
PORT=8765
ROOT="$(cd "$(dirname "$0")/../../../.." && pwd)"   # .claude/skills/<skill>/scripts -> project root
FILE="${1:?usage: serve.sh <report.html>}"
ABS="$(cd "$(dirname "$FILE")" && pwd)/$(basename "$FILE")"
REL="${ABS#"$ROOT"/}"
if [ "$REL" = "$ABS" ]; then
  echo "error: $FILE is outside the project root $ROOT" >&2; exit 1
fi
if ! curl -s -o /dev/null "http://127.0.0.1:$PORT/"; then
  (cd "$ROOT" && nohup python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &)
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break; sleep 0.3; done
fi
URL="http://127.0.0.1:$PORT/$REL"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$URL")"
[ "$CODE" = "200" ] || { echo "error: $URL returned HTTP $CODE (is another server using port $PORT?)" >&2; exit 1; }
echo "$URL"
