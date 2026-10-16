-- La tabla de precios nueva (PLANES.md §6, acordada por el dueño el 16-10-2026).
--
-- Los planes viejos (Emprendedor, Pyme, Despacho) se **desactivan**, no se borran:
-- `isActive = false` los saca de la pantalla de precios y del selector del panel,
-- pero la fila sigue viva para las suscripciones que los referencian (hoy ninguna).
--
-- Se separan por PERFIL, que es la decisión comercial: el negocio que necesita uno
-- (individual) y el contador que lleva varios clientes (despacho). El escalón de
-- 11-25 existe para que pasar de 10 a 11 clientes no cueste 3,75× más, y el Básico
-- a $9.99 es la puerta de entrada del empresario chico.
--
-- `monthlyLimit = 999999` en Despacho 50+ es «ilimitado» (la cuota es una red
-- anti-abuso, no una métrica de venta: §2). La UI lo muestra como «ilimitados».
--
-- **Demo queda como está** (1 empresa, 2 usuarios, inventario y planilla): las dos
-- cuentas vivas lo usan y llevan 5 y 3 usuarios propios, así que bajarlo a «básico»
-- les recortaría el trabajo. Moverlas a un plan pago es una decisión del dueño y se
-- hace desde el panel, no en una migración.

INSERT INTO "plan" ("id", "name", "description", "monthlyLimit", "reqPorSegundo", "maxEmpresas", "maxUsuariosPorEmpresa", "modulos", "price", "features", "isActive", "sortOrder", "createdAt") VALUES
  ('plan-individual-basico', 'Individual Básico',
   'Para el negocio chico que lleva su propia contabilidad',
   500, 5, 1, 3, ARRAY[]::TEXT[], 9.99,
   '["Procesamiento por IA","Escáner OCR de facturas","Todos los reportes","Exportación a Excel y PDF","Soporte por WhatsApp"]',
   true, 1, now()),

  ('plan-individual-premium', 'Individual Premium',
   'Para el negocio que además controla su mercancía y su planilla',
   1000, 10, 1, 3, ARRAY['inventario','planilla'], 19.99,
   '["Todo lo del plan Básico","Inventario y Planilla incluidos","Procesamiento por IA avanzado","Soporte prioritario por WhatsApp"]',
   true, 2, now()),

  ('plan-despacho-3', 'Despacho 3',
   'Para el contador que lleva hasta 3 clientes',
   1000, 10, 3, 3, ARRAY[]::TEXT[], 19.99,
   '["Cambio de empresa sin cerrar sesión","Tablero de pendientes por cliente","Comparativo entre empresas","Alta de clientes con tu propio catálogo","Múltiples API Keys","Soporte por WhatsApp"]',
   true, 3, now()),

  ('plan-despacho-10', 'Despacho 10',
   'Para el despacho que lleva hasta 10 clientes',
   2000, 25, 10, 4, ARRAY['inventario','planilla'], 39.99,
   '["Todo lo del Despacho 3","Inventario y Planilla incluidos","Procesamiento por IA avanzado","Múltiples API Keys","Soporte prioritario por WhatsApp"]',
   true, 4, now()),

  ('plan-despacho-25', 'Despacho 25',
   'Para el despacho que lleva hasta 25 clientes',
   4000, 25, 25, 5, ARRAY['inventario','planilla'], 79.99,
   '["Todo lo del Despacho 10","Procesamiento por IA avanzado","Múltiples API Keys","Soporte prioritario por WhatsApp"]',
   true, 5, now()),

  ('plan-despacho-50', 'Despacho 50+',
   'Para el despacho grande: todo incluido y movimientos ilimitados',
   999999, 50, 50, 5, ARRAY['inventario','planilla','facturas-pdf'], 149.99,
   '["Todo lo del Despacho 25","Facturas PDF incluido","Procesamiento por IA avanzado","Múltiples API Keys","Soporte dedicado"]',
   true, 6, now())
ON CONFLICT ("name") DO NOTHING;

-- Los planes viejos salen de la vitrina (sus suscripciones siguen funcionando).
UPDATE "plan" SET "isActive" = false WHERE "name" IN ('Emprendedor', 'Pyme', 'Despacho');
