-- Cierre de año fiscal: período y marcador de asiento de cierre
ALTER TABLE "JournalEntry" ADD COLUMN "period" TEXT;
ALTER TABLE "JournalEntry" ADD COLUMN "isClosing" BOOLEAN NOT NULL DEFAULT false;

-- Guardia anti-duplicado: un solo asiento de cierre ACTIVO por empresa y año.
-- Un asiento ANULADO no bloquea el re-cierre del año.
CREATE UNIQUE INDEX "JournalEntry_companyId_period_closing_active_key"
  ON "JournalEntry" ("companyId", "period")
  WHERE "isClosing" = true AND "status" <> 'ANULADO';
