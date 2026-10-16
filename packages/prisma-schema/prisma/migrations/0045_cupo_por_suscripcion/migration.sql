-- Cortesías de cupo por SUSCRIPCIÓN (16-10-2026).
--
-- El plan pone el tope de empresas y de usuarios por empresa, y eso está bien: es lo
-- que se vende. Pero hay clientes que no encajan en ningún plan —Odesa, por ejemplo,
-- tiene 5 usuarios propios en UNA empresa, y los planes individuales llegan a 3— y la
-- salida no puede ser inventar un plan nuevo ni dejarlo sin poder dar de alta gente.
--
-- `movementsLimit` ya funcionaba así (la suscripción puede diferir del plan), y estos
-- dos campos son lo mismo: `null` = usar el del plan (lo normal), un número = el cupo
-- de esta cuenta, `0` = sin tope. Se asignan desde el panel, en «Extender / Otorgar»,
-- y quedan registrados con la nota del admin.
--
-- No tocan los MÓDULOS: un módulo se tiene por el plan o contratado como add-on, y esa
-- es una decisión de producto, no una cortesía.

ALTER TABLE "subscription" ADD COLUMN "maxEmpresas" INTEGER;
ALTER TABLE "subscription" ADD COLUMN "maxUsuariosPorEmpresa" INTEGER;
