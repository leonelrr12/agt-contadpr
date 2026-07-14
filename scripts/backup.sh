#!/bin/bash
# Backup de la base de datos PostgreSQL
# Uso: ./scripts/backup.sh
# Genera un archivo .sql.gz en ./backups/

set -e

BACKUP_DIR="$(cd "$(dirname "$0")/.." && pwd)/backups"
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
BACKUP_FILE="$BACKUP_DIR/agt_contador_$TIMESTAMP.sql.gz"

# Cargar variables de entorno si existe .env
if [ -f "$(dirname "$0")/../.env" ]; then
  set -a
  source "$(dirname "$0")/../.env"
  set +a
fi

# Conexión desde DATABASE_URL o valores por defecto
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_USER="${DB_USER:-contador}"
DB_PASSWORD="${DB_PASSWORD:-contador123}"
DB_NAME="${DB_NAME:-agt_contador}"

mkdir -p "$BACKUP_DIR"

echo "📦 Creando backup de $DB_NAME..."
PGPASSWORD="$DB_PASSWORD" pg_dump \
  -h "$DB_HOST" \
  -p "$DB_PORT" \
  -U "$DB_USER" \
  -d "$DB_NAME" \
  --no-owner \
  --no-acl \
  | gzip > "$BACKUP_FILE"

echo "✅ Backup guardado: $BACKUP_FILE"
echo "   Tamaño: $(du -h "$BACKUP_FILE" | cut -f1)"

# Mantener solo los últimos 7 backups
ls -t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +8 | xargs -r rm
echo "   (se conservan los últimos 7 backups)"

# Restaurar:
# gunzip -c backups/agt_contador_TIMESTAMP.sql.gz | PGPASSWORD=xxx psql -h localhost -U contador -d agt_contador
