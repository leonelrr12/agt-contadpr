#!/bin/bash
# Limpiar todos los datos contables y de clientes/proveedores de UNA empresa
# Mantiene: empresa, usuarios, cuentas, conceptos, planes, suscripciones
set -e

if [ -z "${1:-}" ]; then
  echo "Uso: $0 <companyId>"
  echo ""
  echo "Empresas disponibles:"
  docker exec agt-contador-db-1 psql -U contador -d agt_contador -c "SELECT id, name FROM \"Company\";" 2>/dev/null
  exit 1
fi

COMPANY_ID="$1"

# Verificar que la empresa existe
EXISTS=$(docker exec agt-contador-db-1 psql -U contador -d agt_contador -t -c "SELECT name FROM \"Company\" WHERE id = '$COMPANY_ID';" 2>/dev/null | tr -d ' ')
if [ -z "$EXISTS" ]; then
  echo "❌ Empresa no encontrada: $COMPANY_ID"
  exit 1
fi

echo "🧹 Limpiando datos de: $EXISTS ($COMPANY_ID)"
echo "   Esto borrará TODOS los asientos, transacciones, clientes y proveedores de esta empresa."
echo "   La empresa, usuarios, cuentas y conceptos se mantienen intactos."
echo ""
read -p "¿Continuar? (escribe 'SI' en mayúsculas): " CONFIRM
if [ "$CONFIRM" != "SI" ]; then echo "Cancelado."; exit 0; fi

# Ejecutar SQL con manejo de errores
RUN_SQL=$(cat << ENDSQL
DELETE FROM bill WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM invoice WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM payment_record WHERE "subscriptionId" IN (SELECT id FROM subscription WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM "Transaction" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "JournalLine" WHERE "journalEntryId" IN (SELECT id FROM "JournalEntry" WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM "JournalEntry" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "AuditLog";
DELETE FROM client WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM supplier WHERE "companyId" = '${COMPANY_ID}';
UPDATE subscription SET "movementsUsed" = 0 WHERE "companyId" = '${COMPANY_ID}' AND status IN ('DEMO', 'ACTIVE', 'GRANTED');
ENDSQL
)

echo "$RUN_SQL" | docker exec -i agt-contador-db-1 psql -U contador -d agt_contador -v ON_ERROR_STOP=1 2>&1

echo ""
echo "✅ Limpieza completada para $EXISTS"

echo ""
echo "📊 Datos restantes:"
docker exec agt-contador-db-1 psql -U contador -d agt_contador -c "
SELECT 'Transacciones' as dato, COUNT(*)::text as valor FROM \"Transaction\" WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Asientos', COUNT(*)::text FROM \"JournalEntry\" WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Clientes', COUNT(*)::text FROM client WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Proveedores', COUNT(*)::text FROM supplier WHERE \"companyId\" = '$COMPANY_ID'
ORDER BY 1;
" 2>/dev/null

echo ""
echo "Reinicia la API: pm2 restart agt-contador-api"
