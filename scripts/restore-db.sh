#!/bin/bash
# Restaurar base de datos desde backup
# Uso: ./scripts/restore-db.sh backups/agt_contador_20260715_030000.sql.gz
set -euo pipefail

if [ -z "${1:-}" ]; then
  echo "Uso: $0 <archivo-backup.sql.gz>"
  echo ""
  echo "Backups disponibles:"
  ls -lh "$(dirname "$0")/../backups/"*.sql.gz 2>/dev/null || echo "  (ninguno)"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Archivo no encontrado: $BACKUP_FILE"
  exit 1
fi

echo "⚠️  Esto SOBRESCRIBIRÁ la base de datos agt_contador actual."
echo "   Archivo: $BACKUP_FILE"
echo "   Tamaño: $(du -h "$BACKUP_FILE" | cut -f1)"
echo ""
read -p "¿Continuar? (escribe 'SI' en mayúsculas): " CONFIRM

if [ "$CONFIRM" != "SI" ]; then
  echo "Cancelado."
  exit 0
fi

echo "[$(date)] Restaurando base de datos..."

# Primero desconectar usuarios activos
docker exec agt-contador-db-1 psql -U contador -d postgres -c "
  SELECT pg_terminate_backend(pg_stat_activity.pid)
  FROM pg_stat_activity
  WHERE pg_stat_activity.datname = 'agt_contador'
    AND pid <> pg_backend_pid();
" 2>/dev/null || true

# Restaurar
gunzip -c "$BACKUP_FILE" | docker exec -i agt-contador-db-1 psql -U contador -d agt_contador

echo "[$(date)] ✅ Base de datos restaurada exitosamente."
echo "Reinicia la API: pm2 restart agt-contador-api"
