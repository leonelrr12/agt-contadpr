#!/bin/bash
# Eliminar COMPLETAMENTE una empresa y TODOS sus datos asociados
# Útil para empresas de prueba que no continuaron después del periodo demo
# Borra: empresa, usuarios, cuentas, conceptos, asientos, transacciones,
#         clientes, proveedores, facturas, cuentas por pagar, conciliaciones,
#         plantillas recurrentes, obligaciones fiscales, logs, etc.
set -e

if [ -z "${1:-}" ]; then
  echo "Uso: $0 <companyId>"
  echo ""
  echo "Empresas disponibles:"
  docker exec agt-contador-db-1 psql -U contador -d agt_contador -c "
    SELECT c.id, c.name, c.\"taxId\", c.\"createdAt\",
           (SELECT COUNT(*) FROM \"User\" WHERE \"companyId\" = c.id) as usuarios,
           (SELECT COUNT(*) FROM \"Transaction\" WHERE \"companyId\" = c.id) as movimientos,
           s.status as plan
    FROM \"Company\" c
    LEFT JOIN subscription s ON s.\"companyId\" = c.id
    ORDER BY c.\"createdAt\" DESC;
  " 2>/dev/null
  exit 1
fi

COMPANY_ID="$1"

# Validar formato básico de ID (cuid = 25 chars, empieza con 'c')
if [[ ! "$COMPANY_ID" =~ ^c[a-zA-Z0-9]{8,}$ ]]; then
  echo "⚠️  El ID no parece tener formato válido (cuid)."
  echo "   Asegúrate de copiarlo exactamente de la lista de arriba."
  read -p "¿Usar este ID de todas formas? (s/N): " FORCE
  if [ "$FORCE" != "s" ] && [ "$FORCE" != "S" ]; then echo "Cancelado."; exit 0; fi
fi

# Obtener datos de la empresa para mostrar
COMPANY_INFO=$(docker exec agt-contador-db-1 psql -U contador -d agt_contador -t -c "
  SELECT c.name || ' (' || c.\"taxId\" || ') - Creada: ' || to_char(c.\"createdAt\", 'DD/MM/YYYY')
  FROM \"Company\" c WHERE c.id = '$COMPANY_ID';
" 2>/dev/null | tr -d ' ')

if [ -z "$COMPANY_INFO" ]; then
  echo "❌ Empresa no encontrada: $COMPANY_ID"
  exit 1
fi

echo "🗑️  Eliminación TOTAL de empresa"
echo "   Empresa: $COMPANY_INFO"
echo "   ID:      $COMPANY_ID"
echo ""
echo "   ⚠️  ESTO ES IRREVERSIBLE ⚠️"
echo "   Se borrarán TODOS los datos de esta empresa:"
echo "   • Empresa y configuración"
echo "   • Usuarios y sus registros de auditoría"
echo "   • Cuentas contables (catálogo)"
echo "   • Conceptos y reglas contables"
echo "   • Asientos y líneas de diario"
echo "   • Transacciones"
echo "   • Clientes y proveedores"
echo "   • Facturas (Invoice) y Cuentas por pagar (Bill)"
echo "   • Conciliaciones bancarias"
echo "   • Plantillas recurrentes"
echo "   • Obligaciones fiscales"
echo "   • API Keys"
echo "   • Logs de importación"
echo "   • Vinculaciones de WhatsApp"
echo "   • Suscripción y pagos"
echo ""
read -p "Para confirmar, escribe ELIMINAR en mayúsculas: " CONFIRM
if [ "$CONFIRM" != "ELIMINAR" ]; then echo "Cancelado."; exit 0; fi

echo ""
echo "⏳ Iniciando eliminación..."

RUN_SQL=$(cat << ENDSQL
BEGIN;

-- ============================================================
-- FASE 1: Romper FKs opcionales para evitar conflictos
-- ============================================================
UPDATE "Transaction" SET "journalEntryId" = NULL WHERE "companyId" = '${COMPANY_ID}';
UPDATE recurring_template SET "lastEntryId" = NULL WHERE "companyId" = '${COMPANY_ID}';
UPDATE bank_statement_row SET "matchedEntryId" = NULL
  WHERE "statementId" IN (SELECT id FROM bank_statement WHERE "companyId" = '${COMPANY_ID}');

-- ============================================================
-- FASE 2: Eliminar tablas hijo que dependen de otras tablas
-- ============================================================
DELETE FROM "JournalLine"
  WHERE "journalEntryId" IN (SELECT id FROM "JournalEntry" WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM bank_statement_row
  WHERE "statementId" IN (SELECT id FROM bank_statement WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM "AccountingRuleEntry"
  WHERE "ruleId" IN (SELECT id FROM "AccountingRule" WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM payment_record
  WHERE "subscriptionId" IN (SELECT id FROM subscription WHERE "companyId" = '${COMPANY_ID}');

-- ============================================================
-- FASE 3: Eliminar tablas principales con FKs a otras tablas
-- ============================================================
DELETE FROM "Transaction" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "JournalEntry" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM bank_statement WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "AccountingRule" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM recurring_template WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM invoice WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM bill WHERE "companyId" = '${COMPANY_ID}';

-- ============================================================
-- FASE 4: Eliminar tablas directas (solo dependen de Company)
-- ============================================================
DELETE FROM api_key WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM import_log WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM whatsapp_link WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM tax_obligation WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "OCRExample" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM client WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM supplier WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "Concept" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM "Account" WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM subscription WHERE "companyId" = '${COMPANY_ID}';

-- ============================================================
-- FASE 5: Auditoría y Usuarios
-- ============================================================
DELETE FROM "AuditLog"
  WHERE "userId" IN (SELECT id FROM "User" WHERE "companyId" = '${COMPANY_ID}');
DELETE FROM "User" WHERE "companyId" = '${COMPANY_ID}';

-- ============================================================
-- FASE 6: La empresa misma
-- ============================================================
DELETE FROM "Company" WHERE id = '${COMPANY_ID}';

COMMIT;
ENDSQL
)

echo "$RUN_SQL" | docker exec -i agt-contador-db-1 psql -U contador -d agt_contador -v ON_ERROR_STOP=1 2>&1

echo ""
echo "✅ Empresa eliminada completamente: $COMPANY_INFO"

echo ""
echo "📊 Verificación — la empresa ya no debe aparecer:"
docker exec agt-contador-db-1 psql -U contador -d agt_contador -c "
  SELECT '¿Existe?' as verificacion,
         CASE WHEN COUNT(*) > 0 THEN '❌ SÍ - algo salió mal' ELSE '✅ NO - eliminada correctamente' END as resultado
  FROM \"Company\" WHERE id = '$COMPANY_ID';
" 2>/dev/null

echo ""
echo "💡 La API debe reiniciarse para limpiar cualquier caché en memoria:"
echo "   pm2 restart agt-contador-api"
