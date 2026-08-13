-- Alias de cuentas del motor contable (antes hardcodeados en ALIAS_TO_CODE)
ALTER TABLE "Account" ADD COLUMN "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[];
