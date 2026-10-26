-- Perfil fiscal de clientes y proveedores (Fase 1 de la BD de terceros), 26-10-2026.
--
-- Client ya tenía phone/email/address/dv/location; se agregan los datos que
-- faltaban para la ficha comercial. Supplier estaba solo con nombre/RUC y
-- teléfono/email: se le agregan DV, dirección y ubicación, más los mismos
-- campos de perfil.
--
-- `fiscalSource`/`fiscalUpdatedAt` registran de dónde salió el perfil
-- (MANUAL, XML, PDF, OCR, IMPORT, CHAT) para no pisar un dato manual con uno
-- extraído por LLM. `taxIdType` distingue RUC/CÉDULA/PASAPORTE.
--
-- Migración ADITIVA: no toca datos existentes. Aplicar con `prisma migrate
-- deploy` SOLO cuando el dueño autorice el destino; después hay que correr
-- `prisma generate` y el backfill de RUC/DV (scripts/backfill-terceros.ts).

ALTER TABLE "client" ADD COLUMN "tradeName" TEXT;
ALTER TABLE "client" ADD COLUMN "contactName" TEXT;
ALTER TABLE "client" ADD COLUMN "taxIdType" TEXT;
ALTER TABLE "client" ADD COLUMN "fiscalSource" TEXT;
ALTER TABLE "client" ADD COLUMN "fiscalUpdatedAt" TIMESTAMP(3);

ALTER TABLE "supplier" ADD COLUMN "dv" TEXT;
ALTER TABLE "supplier" ADD COLUMN "address" TEXT;
ALTER TABLE "supplier" ADD COLUMN "location" TEXT;
ALTER TABLE "supplier" ADD COLUMN "tradeName" TEXT;
ALTER TABLE "supplier" ADD COLUMN "contactName" TEXT;
ALTER TABLE "supplier" ADD COLUMN "taxIdType" TEXT;
ALTER TABLE "supplier" ADD COLUMN "fiscalSource" TEXT;
ALTER TABLE "supplier" ADD COLUMN "fiscalUpdatedAt" TIMESTAMP(3);
