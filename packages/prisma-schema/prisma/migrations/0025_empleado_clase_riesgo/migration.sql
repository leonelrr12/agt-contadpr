-- Clase de riesgo profesional por empleado.
--
-- Hasta acá la tarifa de riesgos profesionales era una sola para toda la empresa,
-- pero una misma empresa puede tener una oficina y un almacén con clases distintas.
-- El empleado sin clase sigue usando la tasa general de la empresa.
--
-- `riesgosPorClase` va en JSON con la convención de `tablaISR`: `"{}"` significa
-- "usar la tabla del código", que trae solo la clase I (1,00%). Las demás se cargan
-- desde Parámetros, y una clase sin tasa RECHAZA la fila de ese empleado en vez de
-- asumir cero.
--
-- Aditiva: una columna NULLable y una con default. Sin backfill.

ALTER TABLE "employee" ADD COLUMN "claseRiesgo" TEXT;

ALTER TABLE "payroll_settings" ADD COLUMN "riesgosPorClase" TEXT NOT NULL DEFAULT '{}';
