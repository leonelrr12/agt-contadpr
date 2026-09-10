-- Planilla (nómina): cuentas contables por columna del archivo maestro,
-- configurables en Administración → Configuración → Planilla
ALTER TABLE "Company" ADD COLUMN "planillaSueldoId" TEXT;
ALTER TABLE "Company" ADD COLUMN "planillaHorasExtrasId" TEXT;
ALTER TABLE "Company" ADD COLUMN "planillaDecimoId" TEXT;
ALTER TABLE "Company" ADD COLUMN "planillaSSId" TEXT;
ALTER TABLE "Company" ADD COLUMN "planillaSEId" TEXT;
ALTER TABLE "Company" ADD COLUMN "planillaISRId" TEXT;
ALTER TABLE "Company" ADD COLUMN "planillaBancoId" TEXT;
