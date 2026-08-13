-- Cifrado de campos en reposo: taxIdHash determinista para dedupe de RUC.
-- El unique de taxId se mueve a taxIdHash (el ciphertext con IV aleatorio no permite dedupe).
ALTER TABLE "Company" ADD COLUMN "taxIdHash" TEXT;

DROP INDEX "Company_taxId_key";

CREATE UNIQUE INDEX "Company_taxIdHash_key" ON "Company"("taxIdHash");
