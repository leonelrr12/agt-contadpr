-- El pasivo del patrono se reparte en TRES cuentas, no en una.
--
-- El catálogo del contador partió el pasivo de la CSS: 2.1.08.01 SS por Pagar
-- Empleado, 2.1.08.02 SS por Pagar Patrono, 2.1.08.04 SE por Pagar Patrono y
-- 2.1.08.06 Riesgos Profesionales. Hasta acá los riesgos profesionales se
-- acreditaban a la MISMA cuenta que el Seguro Social del patrono (y, sin
-- configurar, a la del obrero), así que la subcuenta de riesgos no existía.
--
-- Aditiva: una columna NULLable. Sin backfill.
--
-- Ojo con el pago: `registrarPagoCSS` debita CADA cuenta con su monto. Con el
-- pasivo partido y el pago debitando una sola, las subcuentas se acreditarían
-- para siempre y nunca netearían a cero.

ALTER TABLE "Company" ADD COLUMN "planillaRiesgosPatronalId" TEXT;
