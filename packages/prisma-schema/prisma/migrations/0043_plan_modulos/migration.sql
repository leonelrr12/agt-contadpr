-- Módulos incluidos por plan (PLANES.md §4 y §7 fase 3).
--
-- Inventario y Planilla se prendían por ROL y `facturas-pdf` por add-on: el plan no
-- decía nada. Ahora el plan lleva sus módulos y se validan en dos lados —el menú y
-- las rutas de cada módulo—, porque esconder solo el menú deja la funcionalidad
-- accesible por API.
--
-- Un módulo se habilita por el PLAN o por un ADD-ON contratado
-- (`Subscription.addons`), así que los add-ons que ya existen siguen valiendo.
--
-- Valores: los de la tabla comercial acordada (PLANES.md §6) para los planes que
-- existen hoy —Emprendedor es «básico» (sin módulos), Pyme y Despacho llevan
-- inventario y planilla, y Despacho (el tope) lleva todo—. **Demo lleva inventario y
-- planilla aunque §6 lo llame «básico»**: las dos empresas que hoy están en Demo usan
-- la planilla (6 empleados cada una), y un cambio de planes no puede recortarle el
-- trabajo a un cliente vivo. Los planes nuevos de la fase 4 traen los suyos.

ALTER TABLE "plan" ADD COLUMN "modulos" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "plan" SET "modulos" = ARRAY['inventario', 'planilla'] WHERE "name" = 'Demo';
UPDATE "plan" SET "modulos" = ARRAY['inventario', 'planilla'] WHERE "name" = 'Pyme';
UPDATE "plan" SET "modulos" = ARRAY['inventario', 'planilla', 'facturas-pdf'] WHERE "name" = 'Despacho';
-- 'Emprendedor' queda en el default ('{}'): es el plan básico, sin módulos.
