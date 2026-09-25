-- El gasto del patrono se reparte en TRES cuentas, no en una.
--
-- El contador tiene en su catálogo 6.01.02.01 Riesgos Profesionales, 6.01.02.02
-- SE Patrono y 6.01.02.03 SS Patrono, y quiere analizarlos por separado. Hasta acá
-- todo el aporte patronal caía en una sola cuenta (y, sin configurar, en la de
-- Sueldos, que mezclaba el costo del patrono con el sueldo del empleado).
--
-- Tasas que se agregan a los parámetros, con los valores que dio el contador:
--  · `riesgosProfesionales` 1,00% — la diferencia entre el 13,25% del patrono y el
--    12,25% de Seguro Social. Depende de la clase de riesgo: es editable.
--  · `ssPatronalDecimo` 10,75% — el patrono cotiza sobre el décimo a una tasa MENOR
--    que sobre el sueldo. El lado del empleado ya estaba (7,25%, verificado contra
--    los asientos cargados).
--
-- Aditiva: columnas NULLables o con default. Sin backfill.

ALTER TABLE "Company" ADD COLUMN     "planillaSSPatronalGastoId" TEXT,
ADD COLUMN     "planillaSEPatronalGastoId" TEXT,
ADD COLUMN     "planillaRiesgosProfesionalesId" TEXT;

ALTER TABLE "payroll_settings" ADD COLUMN     "riesgosProfesionales" DOUBLE PRECISION NOT NULL DEFAULT 0.01,
ADD COLUMN     "ssPatronalDecimo" DOUBLE PRECISION NOT NULL DEFAULT 0.1075;

ALTER TABLE "payroll_item" ADD COLUMN     "riesgosPatronal" DOUBLE PRECISION NOT NULL DEFAULT 0;
