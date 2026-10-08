-- Alinea la base con `schema.prisma`: borra las 7 diferencias que venían
-- arrastrándose desde las migraciones 0010 (retención), 0017 (presupuestos) y
-- 0018 (inventario), más un índice de planilla que nunca se creó.
--
-- Por qué existían: esas tablas se crearon cuando Prisma nombraba los constraints
-- en PascalCase (`InvoiceItem_pkey`) y ponía `DEFAULT CURRENT_TIMESTAMP` en las
-- columnas `@updatedAt`. El schema de hoy no declara ninguna de las dos cosas, así
-- que la base quedó "adelantada" respecto del schema en detalles cosméticos.
--
-- Por qué se arregla: mientras haya diferencias conocidas, `migrate diff` no sirve
-- como alarma — hay que leer las 7 para descubrir si además apareció una nueva.
-- Con esto el diff vuelve a dar vacío y cualquier línea que salga es drift de verdad.
--
-- Lo único con efecto real es el índice de `payroll_run`: el schema lo declara
-- desde la migración 0023 y ninguna migración lo creó (se quedó en un `db push` de
-- desarrollo). Los `DROP DEFAULT` y los renombres no cambian ningún dato: Prisma
-- escribe `updatedAt` desde el cliente en cada update, así que el default de la
-- base nunca se usó.

-- AlterTable
ALTER TABLE "budget" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inventory_movement" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "inventory_product" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- AlterTable
ALTER TABLE "invoice_item" RENAME CONSTRAINT "InvoiceItem_pkey" TO "invoice_item_pkey";

-- AlterTable
ALTER TABLE "retencion_itbms" ALTER COLUMN "updatedAt" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "payroll_run_companyId_tipo_periodo_idx" ON "payroll_run"("companyId", "tipo", "periodo");

-- RenameIndex
ALTER INDEX "Invoice_companyId_number_key" RENAME TO "invoice_companyId_number_key";
