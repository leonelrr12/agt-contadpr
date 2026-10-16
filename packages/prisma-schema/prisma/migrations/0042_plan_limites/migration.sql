-- Límites reales por plan (PLANES.md §3 y §7 fase 2): empresas por cuenta y
-- usuarios por empresa.
--
-- Hasta acá «3 usuarios» y «Usuarios ilimitados» eran **texto de adorno** en
-- `Plan.features`: se mostraban en la pantalla de precios y no se validaban en
-- ningún lado. Estos dos campos son los que se validan de verdad.
--
-- Los valores son los de la tabla comercial acordada (PLANES.md §6) para los planes
-- que existen hoy. Los planes nuevos de la fase 4 traen los suyos; mientras tanto,
-- el default (1 empresa / 3 usuarios) es el piso —nunca «ilimitado»—, así que un plan
-- creado a mano sin tocar estos campos nace acotado y se sube a propósito.
--
-- OJO con el cupo de usuarios: cuenta los usuarios PROPIOS de la empresa (los que
-- tienen ahí su empresa casa), no las membresías. El personal del despacho no
-- consume cupo de ningún cliente.

ALTER TABLE "plan" ADD COLUMN "maxEmpresas" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "plan" ADD COLUMN "maxUsuariosPorEmpresa" INTEGER NOT NULL DEFAULT 3;

UPDATE "plan" SET "maxEmpresas" = 1,  "maxUsuariosPorEmpresa" = 2  WHERE "name" = 'Demo';
UPDATE "plan" SET "maxEmpresas" = 1,  "maxUsuariosPorEmpresa" = 3  WHERE "name" = 'Emprendedor';
UPDATE "plan" SET "maxEmpresas" = 1,  "maxUsuariosPorEmpresa" = 10 WHERE "name" = 'Pyme';
UPDATE "plan" SET "maxEmpresas" = 50, "maxUsuariosPorEmpresa" = 5  WHERE "name" = 'Despacho';
