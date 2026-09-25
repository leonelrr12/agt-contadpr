-- La corrida no se recalcula: se anula y se rehace. Para que eso sea posible, el
-- período tiene que quedar libre al anular — y el único que había (0022) lo seguía
-- ocupando, porque una fila ANULADA sigue existiendo.
--
-- Se cambia por un índice único PARCIAL, el mismo idioma del guardia de re-cierre
-- de año (0006): el período lo ocupa una sola corrida VIVA; las anuladas son
-- historia y no bloquean nada.
--
-- Prisma no puede expresar el `WHERE` en el schema, así que el guardia vive acá y
-- el schema solo declara el índice de consulta. Es deliberado.

DROP INDEX "payroll_run_companyId_tipo_periodo_key";

CREATE UNIQUE INDEX "payroll_run_companyId_tipo_periodo_vigente_key"
  ON "payroll_run" ("companyId", "tipo", "periodo")
  WHERE "status" <> 'ANULADA';
