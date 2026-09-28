-- El Seguro Social del patrono es 13,25%, y los riesgos profesionales van APARTE.
--
-- El contador lo aclaró el 28-09: la tabla de tasas presentaba el 13,25% del patrono
-- como un total del que se restaba el 12,25% de Seguro Social para sacar el 1,00% de
-- riesgos. Con eso, `ssPatronal` quedaba en 12,25% y el punto de riesgos se sumaba
-- encima: el total salía igual, pero el Seguro Social del patrono devengaba un punto
-- menos y los riesgos un punto más de lo que les toca — cada uno en su cuenta y en su
-- renglón de la liquidación de la CSS.
--
-- Cambia solo el DEFAULT de la columna: las empresas que ya tienen su fila en
-- `payroll_settings` conservan lo que hayan configurado. Sin backfill.

ALTER TABLE "payroll_settings" ALTER COLUMN "ssPatronal" SET DEFAULT 0.1325;
