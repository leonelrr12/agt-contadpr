-- Descuento por ausencia o tardanza, congelado en el renglón de la corrida.
--
-- No es una deducción al neto: es salario NO devengado, así que ya viene restado en
-- `sueldo` y con él bajó la base de cotización (SS, SE y el aporte del patrono). La
-- columna existe para poder mostrarlo —sin ella, un renglón con descuento y uno con
-- menos días se verían iguales— y para que el renglón explique su propio sueldo.
--
-- Aditiva: una columna con default. Sin backfill.

ALTER TABLE "payroll_item" ADD COLUMN "menosSueldo" DOUBLE PRECISION NOT NULL DEFAULT 0;
