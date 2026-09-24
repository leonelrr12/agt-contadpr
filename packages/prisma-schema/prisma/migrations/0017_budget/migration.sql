-- Presupuestos: monto mensual por cuenta hoja, con rollup por cuenta padre.
-- amount va SIEMPRE POSITIVO y en la dirección natural de la cuenta (ver schema.prisma).
-- El anual no se guarda: es la suma de los 12 meses.
CREATE TABLE "budget" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "budget_pkey" PRIMARY KEY ("id")
);

-- Clave del upsert del guardado en lote (mismo orden que @@unique)
CREATE UNIQUE INDEX "budget_companyId_accountId_year_month_key"
    ON "budget"("companyId", "accountId", "year", "month");

-- Listado por año (la consulta de la pantalla)
CREATE INDEX "budget_companyId_year_idx" ON "budget"("companyId", "year");
CREATE INDEX "budget_accountId_idx" ON "budget"("accountId");

ALTER TABLE "budget" ADD CONSTRAINT "budget_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "budget" ADD CONSTRAINT "budget_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
