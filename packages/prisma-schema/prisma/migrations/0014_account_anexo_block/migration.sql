-- Flags por cuenta (Administración → Catálogo de cuentas):
--   requiresAnexo: la cuenta lleva Anexo DGI (exige RUC/Cédula y Nombre en las cargas)
--   isBlocked:     la cuenta no admite asientos nuevos
-- Ambos nacen apagados: el usuario marca sus cuentas.
ALTER TABLE "Account" ADD COLUMN "requiresAnexo" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Account" ADD COLUMN "isBlocked" BOOLEAN NOT NULL DEFAULT false;
