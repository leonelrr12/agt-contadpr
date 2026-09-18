#!/bin/bash
# Restaurar base de datos desde backup
# Uso: ./scripts/restore-db.sh <archivo-backup>
#
# El formato se detecta por el CONTENIDO (magic bytes), no por la extensión:
#   .dump    → pg_dump -Fc (formato custom)  → pg_restore
#   .sql.gz  → SQL plano comprimido          → gunzip | psql
#   .sql     → SQL plano                     → psql
#
# Los dumps diarios viven en /root/backups/contador507/ y son .dump.
# El paquete DR trae database.sql.gz (SQL plano) — ambos entran por acá.
set -euo pipefail

BACKUP_DIR="/root/backups/contador507"
CONTAINER="agt-contador-db-1"
DBUSER="contador"
DB="agt_contador"

if [ -z "${1:-}" ]; then
  echo "Uso: $0 <archivo-backup>"
  echo ""
  echo "Backups disponibles en $BACKUP_DIR:"
  # Ojo: `ls A*.dump B*.sql.gz` con un solo glob que matchea imprime los
  # archivos Y devuelve error (por el glob vacío), así que el `|| echo
  # "(ninguno)"` saldría igual y confundiría. Recorremos glob por glob.
  FOUND=0
  for pat in "$BACKUP_DIR"/*.dump "$BACKUP_DIR"/*.sql.gz; do
    [ -e "$pat" ] || continue
    ls -lh "$pat"
    FOUND=1
  done
  [ "$FOUND" -eq 1 ] || echo "  (ninguno)"
  exit 1
fi

BACKUP_FILE="$1"

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Archivo no encontrado: $BACKUP_FILE"
  exit 1
fi

# ── Detectar formato por magic bytes ──
# Detectamos por contenido para que un archivo renombrado no nos engañe.
# Comparamos en hex porque meter bytes binarios crudos en $( ) hace que
# bash avise "ignored null byte" en cada corrida.
#   custom (pg_dump -Fc) → "PGDMP" → 5047444d50
#   gzip                 → 1f 8b
MAGIC=$(head -c 5 "$BACKUP_FILE" | od -An -tx1 | tr -d ' \n')
case "$MAGIC" in
  5047444d50*) FORMAT="custom" ;;
  1f8b*)       FORMAT="gzip" ;;
  *)           FORMAT="plain" ;;
esac

echo "⚠️  Esto SOBRESCRIBIRÁ la base de datos $DB actual."
echo "   Archivo: $BACKUP_FILE"
echo "   Tamaño: $(du -h "$BACKUP_FILE" | cut -f1)"
echo "   Formato detectado: $FORMAT"
echo ""
read -p "¿Continuar? (escribe 'SI' en mayúsculas): " CONFIRM

if [ "$CONFIRM" != "SI" ]; then
  echo "Cancelado."
  exit 0
fi

echo "[$(date)] Restaurando base de datos..."

# ── Red de seguridad ──
# La restauración en formato custom usa --clean, que DROPEA los objetos
# antes de recrearlos. Si el backup está corrupto o incompleto te quedas
# sin la base actual, así que guardamos el estado previo primero.
SAFETY=""
if docker exec "$CONTAINER" psql -U "$DBUSER" -d postgres -lqt 2>/dev/null | cut -d \| -f1 | grep -qw "$DB"; then
  mkdir -p "$BACKUP_DIR"
  SAFETY="$BACKUP_DIR/pre-restore_${DB}_$(date +%Y-%m-%d_%H-%M-%S).dump"
  if docker exec "$CONTAINER" pg_dump -U "$DBUSER" -Fc "$DB" > "$SAFETY" 2>/dev/null; then
    echo "  💾 Red de seguridad: $SAFETY ($(du -h "$SAFETY" | cut -f1))"
  else
    rm -f "$SAFETY"; SAFETY=""
    echo "  ⚠️  No se pudo respaldar el estado actual — continuando sin red de seguridad."
  fi
else
  echo "  ℹ️  La base $DB no existe todavía (instalación nueva) — sin red de seguridad."
fi

# Desconectar usuarios activos
docker exec "$CONTAINER" psql -U "$DBUSER" -d postgres -c "
  SELECT pg_terminate_backend(pg_stat_activity.pid)
  FROM pg_stat_activity
  WHERE pg_stat_activity.datname = '$DB'
    AND pid <> pg_backend_pid();
" 2>/dev/null || true

# ── Restaurar según formato ──
# set +e: necesitamos inspeccionar el código de salida a mano.
set +e
case "$FORMAT" in
  custom)
    # --clean --if-exists: dropea los objetos presentes en el dump antes de
    # recrearlos (sin esto, chocan con los existentes).
    # --no-owner --no-acl: ignora dueños/permisos originales del dump.
    docker exec -i "$CONTAINER" pg_restore \
      -U "$DBUSER" -d "$DB" \
      --clean --if-exists --no-owner --no-acl \
      < "$BACKUP_FILE"
    RC=$?
    ;;
  gzip)
    gunzip -c "$BACKUP_FILE" | docker exec -i "$CONTAINER" psql -U "$DBUSER" -d "$DB"
    RC=$?
    ;;
  *)
    docker exec -i "$CONTAINER" psql -U "$DBUSER" -d "$DB" < "$BACKUP_FILE"
    RC=$?
    ;;
esac
set -e

# pg_restore: 0 = OK · 1 = avisos · >=2 = error
if [ "$RC" -eq 0 ]; then
  echo "[$(date)] ✅ Base de datos restaurada exitosamente."
elif [ "$RC" -eq 1 ]; then
  echo "[$(date)] ⚠️  Restauración con avisos (código 1) — típicamente objetos"
  echo "   que ya existían o roles que no están en este servidor. La base quedó"
  echo "   restaurada igual: revisa la salida de arriba por si acaso."
else
  echo "[$(date)] ❌ Restauración FALLÓ (código $RC) — la base puede haber quedado a medias."
  if [ -n "$SAFETY" ]; then
    echo "   Para volver atrás: $0 $SAFETY"
  fi
  exit "$RC"
fi

echo "Reinicia la API: pm2 restart agt-contador-api"
