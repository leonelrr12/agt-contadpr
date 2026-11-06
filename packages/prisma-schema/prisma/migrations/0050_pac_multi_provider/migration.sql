-- Multi-proveedor PAC por empresa (Factura Fácil + The Factory HKA), 06-11-2026.
--
-- `pac_config` ya tiene una fila por empresa y un `provider`. Para que la misma
-- ficha sirva a proveedores con esquemas de autenticación distintos se agregan
-- campos neutrales:
--   apiUser/apiPassword: login de integración que devuelve un JWT (HKA).
--   baseUrl: URL propia del proveedor. HKA la entrega por ambiente/empresa;
--            producción no se adivina, se configura acá.
--
-- `apiPassword` se cifra en reposo (AES-256-GCM, services/crypto-fields.ts),
-- igual que `pacApiKey` y `pacBasicPassword`: la columna es TEXT.
--
-- Migración ADITIVA: no toca datos existentes. Aplicar con `prisma migrate
-- deploy` SOLO cuando el dueño autorice el destino.

ALTER TABLE "pac_config" ADD COLUMN "apiUser" TEXT;
ALTER TABLE "pac_config" ADD COLUMN "apiPassword" TEXT;
ALTER TABLE "pac_config" ADD COLUMN "baseUrl" TEXT;
