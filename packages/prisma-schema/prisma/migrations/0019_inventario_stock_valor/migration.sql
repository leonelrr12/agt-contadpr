-- El producto guarda su VALOR vigente, no solo la cantidad y el promedio.
--
-- El motor de costo necesita el valor para calcular un barrido o una regularización,
-- y derivarlo de `stockActual × costoPromedio` lo dejaría a merced del redondeo de
-- punto flotante: `stockValor` es la cifra que tiene que cuadrar con el mayor al
-- centavo y no puede depender de un ida y vuelta.
--
-- Aditiva: columna nueva con default, sobre una tabla que todavía no tiene datos.

ALTER TABLE "inventory_product" ADD COLUMN "stockValor" DOUBLE PRECISION NOT NULL DEFAULT 0;
