#!/bin/bash
# Limpiar todos los datos contables y de clientes/proveedores de UNA empresa
# Borra además el detalle de prueba de los módulos: planilla (corridas, ítems,
# deducciones), inventario (solo el kardex) y reembolsos (reclamos y pagos).
# Mantiene: empresa, usuarios, cuentas, conceptos, planes, suscripciones,
#          los catálogos de personas e inventario —empleados, trabajadores y
#          productos— (el stock del producto SÍ se pone en 0: ver inventario),
#          las cuentas contables de la empresa (los planilla*Id viven en Company)
#          y los PARÁMETROS de planilla: tasas, tabla del ISR, factores, día de pago.
#
# Los parámetros NO son datos de prueba: son configuración del dueño. Borrarlos
# (como se hacía con la fila de payroll_settings) hacía que la próxima lectura la
# recreara con los valores legales del código y su tasa volviera a 0,1225 sola.
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
echo "   conciliaciones, plantillas recurrentes, clientes, proveedores, planilla,"
echo "   inventario y reembolsos (facturas recibidas y pagos)."
echo "   La empresa, usuarios, cuentas, conceptos, empleados, trabajadores, productos"
echo "   y parámetros de planilla se mantienen intactos."
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
#   payroll_item_deduction → payroll_run y payroll_deduction
#   payroll_item → payroll_run
#   payroll_item.journalEntryId → JournalEntry (no es FK, pero el orden hijos→padres sí importa)
#   expense_claim → reimbursement (el reclamo referencia al pago)
RUN_SQL=$(cat << ENDSQL
-- Planilla: el detalle de deducciones cuelga de la corrida y del catálogo de
-- deducciones (FK RESTRICT), así que va antes que los dos.
DELETE FROM payroll_item_deduction WHERE "companyId" = '${COMPANY_ID}';

-- Planilla: el ítem referencia la corrida, así que va primero.
-- NO se toca `employee`: el alta de la persona es catálogo, no un movimiento de
-- prueba. `payroll_settings` tampoco: son las tasas y la tabla del ISR que
-- configuró el dueño, y borrarlas las devolvía a los valores del código.
DELETE FROM payroll_item WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM payroll_run WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM payroll_deduction WHERE "companyId" = '${COMPANY_ID}';

-- Inventario: se borra el kardex y se CONSERVA el catálogo de productos. Los
-- saldos del producto (stockActual/stockValor/costoPromedio) son un caché del
-- último movimiento, así que sin kardex van a 0: si no, el producto mostraría un
-- stock que ya no existe y el cuadre del inventario lo reportaría.
DELETE FROM inventory_movement WHERE "companyId" = '${COMPANY_ID}';
UPDATE inventory_product SET "stockActual" = 0, "stockValor" = 0, "costoPromedio" = 0 WHERE "companyId" = '${COMPANY_ID}';

-- Reembolsos: se borran las facturas recibidas (reclamos) y los pagos. El
-- TRABAJADOR se conserva: es el alta del celular, no un movimiento — y con él
-- queda su vínculo en whatsapp_link, así que ese celular sigue operando como
-- trabajador. El reclamo va primero: referencia al pago.
DELETE FROM expense_claim WHERE "companyId" = '${COMPANY_ID}';
DELETE FROM reimbursement WHERE "companyId" = '${COMPANY_ID}';

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
-- El rastro, solo el de esta empresa: `AuditLog` no tiene companyId (cuelga de
-- `userId`), así que se acota por los usuarios de la empresa. Sin el WHERE se llevaba
-- también el de las demás — y con él, la constancia de lo que se hizo y cuándo.
DELETE FROM "AuditLog" WHERE "userId" IN (SELECT id FROM "User" WHERE "companyId" = '${COMPANY_ID}');
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
UNION ALL SELECT 'Facturas recibidas', COUNT(*)::text FROM expense_claim WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Reembolsos', COUNT(*)::text FROM reimbursement WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Movimientos de kardex', COUNT(*)::text FROM inventory_movement WHERE \"companyId\" = '$COMPANY_ID'
ORDER BY 1;
" 2>/dev/null

# Empleados, trabajadores y productos son catálogo: sobreviven a propósito (el
# stock del producto se pone en 0). Que se vea, por la misma razón que las tasas.
echo ""
echo "♻️  Catálogos conservados:"
docker exec agt-contador-db-1 psql -U contador -d agt_contador -c "
SELECT 'Empleados' as catalogo, COUNT(*)::text as filas FROM employee WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Trabajadores', COUNT(*)::text FROM worker_account WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Productos de inventario', COUNT(*)::text || ' (stock en 0)' FROM inventory_product WHERE \"companyId\" = '$COMPANY_ID'
ORDER BY 1;
" 2>/dev/null

# Las tasas sobreviven a la limpieza: que se vea, porque el script las borraba y el
# dueño se enteraba por un número que volvía solo a su valor legal.
echo ""
echo "⚙️  Parámetros de planilla conservados:"
docker exec agt-contador-db-1 psql -U contador -d agt_contador -c "
SELECT 'SS patrono — sueldo' as parametro, \"ssPatronal\"::text as valor FROM payroll_settings WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'SE patrono — sueldo', \"sePatronal\"::text FROM payroll_settings WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Riesgos profesionales', \"riesgosProfesionales\"::text FROM payroll_settings WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Provisión de prestaciones', \"provisionarPrestaciones\"::text FROM payroll_settings WHERE \"companyId\" = '$COMPANY_ID'
UNION ALL SELECT 'Cuentas del pasivo del patrono', COUNT(*)::text || ' configuradas' FROM \"Company\" WHERE id = '$COMPANY_ID' AND \"planillaSSPatronalId\" IS NOT NULL
ORDER BY 1;
" 2>/dev/null

echo ""
echo "Reinicia la API: pm2 restart agt-contador-api"
