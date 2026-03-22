#!/bin/bash
# Database backup for NamiBarden
# Usage: ./scripts/backup-db.sh
# Recommended: add to crontab — 0 3 * * * /root/projects/NamiBarden/scripts/backup-db.sh

BACKUP_DIR="/root/backups/namibarden"
CONTAINER="namibarden-db"
DB_NAME="namibarden"
DB_USER="namibarden"
KEEP_DAYS=14

mkdir -p "$BACKUP_DIR"

TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/${DB_NAME}_${TIMESTAMP}.sql.gz"

docker exec "$CONTAINER" pg_dump -U "$DB_USER" "$DB_NAME" | gzip > "$BACKUP_FILE"

if [ $? -eq 0 ] && [ -s "$BACKUP_FILE" ]; then
  echo "Backup OK: $BACKUP_FILE ($(du -h "$BACKUP_FILE" | cut -f1))"
  # Prune old backups
  find "$BACKUP_DIR" -name "*.sql.gz" -mtime +$KEEP_DAYS -delete
else
  echo "BACKUP FAILED" >&2
  rm -f "$BACKUP_FILE"
  exit 1
fi
