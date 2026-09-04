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
echo "   Esto borrará TODOS los asientos, transacciones, facturas y cobros,"
echo "   conciliaciones, plantillas recurrentes, clientes y proveedores de esta empresa."
echo "   La empresa, usuarios, cuentas y conceptos se mantienen intactos."
echo ""
read -p "¿Continuar? (escribe 'SI' en mayúsculas): " CONFIRM
if [ "$CONFIRM" != "SI" ]; then echo "Cancelado."; exit 0; fi

# Ejecutar SQL con manejo de errores.
# ORDEN IMPORTANTE (hijos antes que padres, por FK):
#   invoice_item/invoice_payment → invoice → client
#   bill → supplier
#   bank_statement_row → bank_statement y → JournalEntry
#   recurring_template.lastEntryId → JournalEntry
#   JournalLine/Transaction/bank_statement_row → JournalEntry
#   payment_record → subscription
RUN_SQL=$(cat << ENDSQL
DELETE FROM invoice_item WHERE "invoiceId" IN (SELECT id FROM invoice WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM invoice_payment WHERE "invoiceId" IN (SELECT id FROM invoice WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM invoice WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM bill WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM bank_statement_row WHERE "statementId" IN (SELECT id FROM bank_statement WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM bank_statement WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM recurring_template WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "Transaction" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "JournalLine" WHERE "journalEntryId" IN (SELECT id FROM "JournalEntry" WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM "JournalEntry" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM payment_record WHERE "subscriptionId" IN (SELECT id FROM subscription WHERE "companyId" = '${COMPANY_ID}');
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
