#!/bin/sh
# Cartethyia container entrypoint with bundled PostgreSQL.
#
# Koyeb's free managed Postgres only includes 5h of compute per month. The
# gateway's background sweeps (account-health every 30s, oauth/quota refresh
# every 60s) keep the database awake around the clock, so the quota is
# exhausted within days and every query is then rejected — the whole gateway
# (console login, /v1/* proxy) goes down with "db: disconnected".
#
# This wrapper starts a local PostgreSQL inside the container when no external
# database is configured, so the gateway is self-contained and quota-free.
# Data lives on the container's ephemeral disk (/app/data/postgres): it
# survives restarts but NOT redeploys — take a console backup before
# redeploying and restore it after.
#
# An explicitly configured external database (DATABASE_URL,
# DATABASE_PRIVATE_URL, DATABASE_PUBLIC_URL, or PGHOST) always wins: local
# Postgres is skipped in that case.
set -e

APP_UID=10001
APP_GID=10001
PG_BIN=/usr/lib/postgresql/15/bin
PGDATA="${PGDATA_DIR:-/app/data/postgres}"
PGPORT_LOCAL=5432

external_db_configured() {
  [ -n "$DATABASE_URL" ] || [ -n "$DATABASE_PRIVATE_URL" ] || \
  [ -n "$DATABASE_PUBLIC_URL" ] || [ -n "$PGHOST" ]
}

if external_db_configured; then
  echo "cartethyia: external database configured, skipping local Postgres." >&2
else
  echo "cartethyia: no external database configured, starting local Postgres." >&2
  mkdir -p "$PGDATA" /var/run/postgresql
  chown -R "$APP_UID:$APP_GID" "$PGDATA" /var/run/postgresql 2>/dev/null || true

  if [ ! -f "$PGDATA/PG_VERSION" ]; then
    echo "cartethyia: initializing local Postgres data directory at $PGDATA..." >&2
    setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
      "$PG_BIN/initdb" -D "$PGDATA" -U cartethyia --auth=trust \
      --no-locale --encoding=UTF8 > /tmp/postgres-init.log 2>&1
    # Low-memory tuning for the 512MB container: the app itself uses ~60MB
    # RSS and Redis is capped at 64MB, so Postgres gets a small slice.
    cat >> "$PGDATA/postgresql.conf" <<'EOF'
listen_addresses = 'localhost'
port = 5432
shared_buffers = 32MB
effective_cache_size = 128MB
work_mem = 2MB
maintenance_work_mem = 16MB
max_connections = 25
max_wal_size = 256MB
min_wal_size = 32MB
log_min_messages = warning
EOF
    # Trust local connections only. Postgres binds 127.0.0.1 inside the
    # container network namespace, so this is not exposed off-container.
    printf 'host all all 127.0.0.1/32 trust\nhost all all ::1/128 trust\n' >> "$PGDATA/pg_hba.conf"
    echo "cartethyia: local Postgres initialized." >&2
  fi

  setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
    "$PG_BIN/pg_ctl" -D "$PGDATA" -l /tmp/postgres.log -w -t 60 start > /dev/null 2>&1 || {
    echo "cartethyia: local Postgres failed to start; last log lines:" >&2
    tail -20 /tmp/postgres.log >&2 || true
    exit 1
  }

  tries=0
  while [ "$tries" -lt 50 ]; do
    if setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
      "$PG_BIN/pg_isready" -h localhost -p "$PGPORT_LOCAL" > /dev/null 2>&1; then
      break
    fi
    tries=$((tries + 1))
    sleep 0.2
  done
  if [ "$tries" -ge 50 ]; then
    echo "cartethyia: local Postgres did not become ready in time." >&2
    tail -20 /tmp/postgres.log >&2 || true
    exit 1
  fi

  if ! setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
    "$PG_BIN/psql" -h localhost -p "$PGPORT_LOCAL" -U cartethyia -d postgres \
    -tc "SELECT 1 FROM pg_database WHERE datname = 'cartethyia'" 2>/dev/null | grep -q 1; then
    echo "cartethyia: creating database 'cartethyia'..." >&2
    setpriv --reuid="$APP_UID" --regid="$APP_GID" --init-groups \
      "$PG_BIN/psql" -h localhost -p "$PGPORT_LOCAL" -U cartethyia -d postgres \
      -c "CREATE DATABASE cartethyia" > /dev/null
  fi

  # The app resolves these libpq variables when DATABASE_URL is absent
  # (see requireDatabaseUrl / databaseUrlFromLibpqEnv in persistence).
  export PGHOST=localhost
  export PGPORT="$PGPORT_LOCAL"
  export PGUSER=cartethyia
  export PGDATABASE=cartethyia
  # No PGPASSWORD: trust auth on container-localhost only.
  echo "cartethyia: local Postgres ready (cartethyia@localhost:5432/cartethyia)." >&2
fi

exec /app/entrypoint-with-redis.sh "$@"
