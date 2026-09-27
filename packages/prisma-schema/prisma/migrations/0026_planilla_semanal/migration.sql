-- Planilla semanal: el día de pago configurable y la corrida consolidada.
--
-- `diaPagoSemanal` es el día en que se paga la semana (0 = domingo, como
-- `Date.getDay()`; default viernes). De él sale el calendario del pago semanal:
-- cuántos pagos tiene el mes —4 o 5— y cuál de ellos es el que se está corriendo.
-- Eso es lo que hace que el ISR del mes cierre exacto: los pagos intermedios llevan
-- la división redondeada y el último se lleva el resto. Con un número fijo de pagos
-- por mes el mes quedaría con céntimos de más o de menos.
--
-- `consolidado` marca las corridas que se contabilizan en UN asiento en vez de uno
-- por empleado. Es el caso de la semanal: 52 corridas al año por el asiento de cada
-- empleado convertirían la cola de revisión del contador en el cuello de botella del
-- módulo. Se guarda en la fila —y no se deriva de la periodicidad— porque describe
-- cómo se armó ESA corrida: cambiar la regla mañana no puede reinterpretar el pasado,
-- y la anulación y la revisión necesitan saber si el asiento es uno o son treinta.
--
-- Aditiva: una columna con default y una booleana con default. Sin backfill.

ALTER TABLE "payroll_settings" ADD COLUMN "diaPagoSemanal" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "payroll_run" ADD COLUMN "consolidado" BOOLEAN NOT NULL DEFAULT false;
