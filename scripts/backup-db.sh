#!/bin/bash
# Backup automático de la base de datos agt_contador
# Uso: ./scripts/backup-db.sh
# Genera: backups/agt_contador_YYYYMMDD_HHMMSS.sql.gz
set -euo pipefail

BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
RETENTION_DAYS=30
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agt_contador_$TIMESTAMP.sql.gz"

# Cargar variables de entorno
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  source "$(dirname "$0")/../.env"
  set +a
fi

mkdir -p "$BACKUP_DIR"

echo "[$(date)] Iniciando backup de agt_contador..."

# Backup desde el contenedor Docker
docker exec agt-contador-db-1 pg_dump \
  -U contador \
  -d agt_contador \
  --no-owner \
  --no-acl \
  | gzip > "$BACKUP_FILE"

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[$(date)] ✅ Backup creado: $BACKUP_FILE ($SIZE)"

# Eliminar backups antiguos (>30 días)
DELETED=$(find "$BACKUP_DIR" -name "agt_contador_*.sql.gz" -mtime +$RETENTION_DAYS -delete -print | wc -l)
if [ "$DELETED" -gt 0 ]; then
  echo "[$(date)] 🗑️  $DELETED backups antiguos eliminados"
fi

echo "[$(date)] Backups actuales: $(ls "$BACKUP_DIR"/agt_contador_*.sql.gz 2>/dev/null | wc -l)"
