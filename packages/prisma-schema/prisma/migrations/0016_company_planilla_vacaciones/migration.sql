-- Planilla (nómina): cuenta de la columna VACACIONES del archivo maestro.
-- Se debita (suma al bruto), como Sueldo y Horas Extras.
-- Configurable en Administración → Configuración (tarjeta Cuentas de Planilla).
ALTER TABLE "Company" ADD COLUMN "planillaVacacionesId" TEXT;
