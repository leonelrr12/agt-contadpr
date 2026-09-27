-- La cuota de movimientos pasa a ser fraccionaria: la planilla semanal consume MEDIA.
--
-- Son 52 corridas al año contra 24 de la quincenal, así que cobrarle la cuota entera a
-- cada una le costaría al cliente semanal el doble por la misma nómina. Con el contador
-- entero, media cuota no existe: la única salida sería cobrar una cada dos corridas,
-- que es más difícil de explicar en la factura que un 0,5.
--
-- Aditiva y sin pérdida: los enteros ya contados se conservan tal cual (1 → 1.0).

-- Ojo con el nombre: el modelo se llama `Subscription` pero la tabla está mapeada a
-- `subscription` en minúscula (`@@map("subscription")`). Con el nombre del modelo,
-- Prisma falla con "relation does not exist".
ALTER TABLE "subscription" ALTER COLUMN "movementsUsed" TYPE DOUBLE PRECISION;
