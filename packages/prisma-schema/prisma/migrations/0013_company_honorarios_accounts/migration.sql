-- Honorarios Profesionales: cuentas del gasto (DEBE) y del banco (HABER),
-- configurables en Administración → Honorarios
ALTER TABLE "Company" ADD COLUMN "honorariosGastoId" TEXT;
ALTER TABLE "Company" ADD COLUMN "honorariosBancoId" TEXT;
