-- Declaración mensual de ITBMS (Formulario 430) como DATO.
--
-- Qué resuelve: hasta acá el 430 era un informe de solo lectura (`borrador-430.ts`) y
-- `TaxObligation` era solo calendario — sin renglones, sin número de formulario y sin
-- asiento (Tuning.md §4.1, brecha 1). La compensación del R52 vivía en
-- `POST /retenciones-itbms/compensar`: escribe el asiento BORRADOR y pasa las
-- retenciones a APLICADA **sin vínculo consultable** (solo el JSON de `metadata`) y
-- **sin vuelta atrás** (APLICADA es terminal y anular el asiento no devolvía las
-- retenciones): brechas 2 y 3. Esta tabla guarda la declaración presentada, los
-- asientos que creó (FK real) y las retenciones que aplicó, para poder revertirla.
--
-- Convenciones que sostienen el diseño:
--  · `period` en "YYYY-MM": la misma del `TaxObligation.period` con el que se cruza
--    (presentar marca la obligación del período como COMPLETED).
--  · Una sola declaración VIVA por empresa+período: índice único PARCIAL con
--    `WHERE "estado" <> 'ANULADA'`, el idioma de `payroll_run` (0023) y del guardia de
--    re-cierre (0006). Una anulada es historia y no bloquea volver a declarar el
--    período. **Prisma no expresa el `WHERE`, así que el guardia vive acá** y el
--    schema solo declara los índices de consulta. Es deliberado.
--  · `asientoCompensacionId` / `asientoPagoId`: FK REALES con `@unique` y
--    `ON DELETE SET NULL` (patrón `ExpenseClaim`, migración 0032). Un asiento
--    pertenece a una sola declaración y lo garantiza la base, no el código.
--  · `retencion_itbms.declaracionId`: el vínculo que faltaba para devolver a RECIBIDA
--    las retenciones de una declaración anulada.
--  · `numeroFormulario` único por empresa y nullable: los borradores (NULL) conviven,
--    y tras anular hay que presentar con un número NUEVO.
--  · `borradorJson`: la foto de lo que el contador vio al crear (el borrador sigue
--    moviéndose con el libro); la declaración no se recalcula nunca.
--
-- SQL validado con `prisma migrate diff --from-url <prod> --to-schema-datamodel`, que
-- devuelve exactamente estas sentencias (la base estaba sin drift). Lo único agregado
-- a mano es el índice parcial del final, marcado.

-- AlterTable
ALTER TABLE "retencion_itbms" ADD COLUMN     "declaracionId" TEXT;

-- CreateTable
CREATE TABLE "declaracion_itbms" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "mes" INTEGER NOT NULL,
    "estado" TEXT NOT NULL DEFAULT 'BORRADOR',
    "baseVentas" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "debitoFiscal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "baseCompras" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "creditoFiscal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "retencionAplicada" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "saldoAnterior" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "saldoAPagar" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "saldoAFavor" BOOLEAN NOT NULL DEFAULT false,
    "numeroFormulario" TEXT,
    "fechaPresentacion" TIMESTAMP(3),
    "presentadaAt" TIMESTAMP(3),
    "presentadaPorId" TEXT,
    "montoPagado" DOUBLE PRECISION,
    "fechaPago" TIMESTAMP(3),
    "anuladaAt" TIMESTAMP(3),
    "anuladaPorId" TEXT,
    "motivoAnulacion" TEXT,
    "asientoCompensacionId" TEXT,
    "asientoPagoId" TEXT,
    "obligacionMarcada" BOOLEAN NOT NULL DEFAULT false,
    "borradorJson" TEXT,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "declaracion_itbms_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "declaracion_itbms_asientoCompensacionId_key" ON "declaracion_itbms"("asientoCompensacionId");

-- CreateIndex
CREATE UNIQUE INDEX "declaracion_itbms_asientoPagoId_key" ON "declaracion_itbms"("asientoPagoId");

-- CreateIndex
CREATE INDEX "declaracion_itbms_companyId_estado_idx" ON "declaracion_itbms"("companyId", "estado");

-- CreateIndex
CREATE INDEX "declaracion_itbms_companyId_period_idx" ON "declaracion_itbms"("companyId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "declaracion_itbms_companyId_numeroFormulario_key" ON "declaracion_itbms"("companyId", "numeroFormulario");

-- CreateIndex
CREATE INDEX "retencion_itbms_declaracionId_idx" ON "retencion_itbms"("declaracionId");

-- CreateIndex
-- A MANO (no lo emite `prisma migrate diff`): una sola declaración VIVA por
-- empresa+período. Las ANULADAS quedan fuera del índice — son historia y no bloquean
-- volver a declarar, que es el punto de «se anula y se rehace».
CREATE UNIQUE INDEX "declaracion_itbms_companyId_period_vigente_key"
  ON "declaracion_itbms" ("companyId", "period")
  WHERE "estado" <> 'ANULADA';

-- AddForeignKey
ALTER TABLE "retencion_itbms" ADD CONSTRAINT "retencion_itbms_declaracionId_fkey" FOREIGN KEY ("declaracionId") REFERENCES "declaracion_itbms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "declaracion_itbms" ADD CONSTRAINT "declaracion_itbms_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "declaracion_itbms" ADD CONSTRAINT "declaracion_itbms_asientoCompensacionId_fkey" FOREIGN KEY ("asientoCompensacionId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "declaracion_itbms" ADD CONSTRAINT "declaracion_itbms_asientoPagoId_fkey" FOREIGN KEY ("asientoPagoId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "declaracion_itbms" ADD CONSTRAINT "declaracion_itbms_presentadaPorId_fkey" FOREIGN KEY ("presentadaPorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "declaracion_itbms" ADD CONSTRAINT "declaracion_itbms_anuladaPorId_fkey" FOREIGN KEY ("anuladaPorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
