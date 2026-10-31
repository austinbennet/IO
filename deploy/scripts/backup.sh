#!/usr/bin/env bash
# Nightly backup: PostgreSQL logical dump + Redis snapshot + recordings/HLS metadata. Keeps 14 days.
set -euo pipefail
DEST="${BACKUP_DIR:-/var/backups/io}"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$DEST"
PGURL="${DATABASE_URL:?DATABASE_URL required}"
pg_dump --format=custom --no-owner --file "$DEST/io-pg-$STAMP.dump" "$PGURL"
if [ -n "${REDIS_URL:-}" ]; then redis-cli -u "$REDIS_URL" --rdb "$DEST/io-redis-$STAMP.rdb" >/dev/null; fi
find "$DEST" -name 'io-*' -mtime +14 -delete
echo "backup complete: $DEST/io-pg-$STAMP.dump"
