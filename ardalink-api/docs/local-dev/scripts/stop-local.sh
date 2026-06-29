#!/usr/bin/env bash
# Stops the local stack started by start-local.sh. Idempotent.
# Aggressively kills by PID file AND by name pattern, so stale
# processes from prior crashed runs are cleaned up too.
set -o pipefail
RUN_DIR=/tmp/ardalink-local

echo "Stopping ardalink-local stack..."

# 1. PIDs we wrote on the way up
for name in api engine web; do
  if [ -f "$RUN_DIR/$name.pid" ]; then
    pid=$(cat "$RUN_DIR/$name.pid")
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null && echo "  stopped $name (pid $pid)"
    fi
    rm -f "$RUN_DIR/$name.pid"
  fi
done

# 2. By pattern — catches any stragglers (watch restarts, etc.)
for pat in "tsx watch" "ardalink_engine.main" "/tmp/ardalink-local/web-server.py"; do
  matches=$(pgrep -f "$pat" 2>/dev/null || true)
  if [ -n "$matches" ]; then
    for pid in $matches; do
      kill -9 "$pid" 2>/dev/null && echo "  killed straggler $pat (pid $pid)"
    done
  fi
done

# 3. Docker containers
for c in ardalink-local-postgres ardalink-local-redis; do
  if docker ps -a --format '{{.Names}}' 2>/dev/null | grep -q "^${c}$"; then
    docker stop "$c" >/dev/null 2>&1 && echo "  stopped docker $c"
    docker rm "$c"   >/dev/null 2>&1
  fi
done

# 4. Wait for ports to clear (max 10s)
for port in 3000 5001 8080 15432; do
  for i in $(seq 1 20); do
    if ! ss -tln 2>/dev/null | grep -q ":$port "; then break; fi
    sleep 0.5
  done
done

echo "Done."