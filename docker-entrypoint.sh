#!/bin/sh
# Cartethyia container entrypoint
# Handles bind mount permission fixes and binary execution

set -e

APP_UID=10001
APP_GID=10001

# A bind-mounted data directory arrives with the host's ownership, which is
# usually root. The runtime user then cannot create the telemetry payload
# directory, so every capture fails while the console still reports capture as
# enabled. Fix the ownership when we can, and say so when we cannot: running
# unprivileged is the default (the image sets USER), so this is normally a
# no-op and the host directory has to be prepared instead.
DATA_DIR="${CARTETHYIA_TELEMETRY_PAYLOAD_DIR:-/app/data}"
case "$DATA_DIR" in /*) ;; *) DATA_DIR="/app/data" ;; esac

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR" 2>/dev/null || true
  chown -R "$APP_UID:$APP_GID" "$DATA_DIR" 2>/dev/null || true
elif [ ! -w "$DATA_DIR" ]; then
  echo "cartethyia: $DATA_DIR is not writable by uid $(id -u); telemetry payload capture will fail." >&2
  echo "cartethyia: chown it to $APP_UID:$APP_GID on the host, or run the container as root to have it fixed." >&2
fi

# Execute the provided command (binary or shell command)
# Use exec to replace the entrypoint process, allowing signal propagation
exec "$@"
