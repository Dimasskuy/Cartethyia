#!/bin/sh
# Cartethyia container entrypoint with bundled Redis.
#
# The console API is Redis-backed by design: without a Redis client the
# application boots the data plane only and never mounts /console/api/*.
# This wrapper starts a local ephemeral Redis (sessions/cache only, no
# persistence) and then hands off to the standard entrypoint.
set -e
REDIS_PORT=6379
tries=0
redis-server \
  --port "$REDIS_PORT" \
  --bind 127.0.0.1 \
  --daemonize yes \
  --logfile /tmp/redis.log \
  --dir /tmp \
  --save '' \
  --appendonly no \
  --maxmemory 64mb \
  --maxmemory-policy allkeys-lru
while [ "$tries" -lt 50 ]; do
  if redis-cli -p "$REDIS_PORT" ping > /dev/null 2>&1; then
    break
  fi
  tries=$((tries + 1))
  sleep 0.2
done
exec /app/entrypoint.sh "$@"
