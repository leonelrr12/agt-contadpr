-- La cuenta que paga (diseño en PLANES.md §2): la suscripción se MUDA de la
-- empresa a la cuenta.
--
-- Hasta acá el plan y la cuota colgaban de la empresa, así que un despacho con diez
-- clientes tenía diez planes (o clientes sin plan). Ahora toda empresa cuelga de una
-- `cuenta` —el cliente que paga— y la suscripción cuelga de esa cuenta: un cliente
-- individual es una cuenta con UNA empresa, un despacho es una cuenta con N.
--
-- Migración ADITIVA + backfill: por cada empresa existente nace una cuenta con su
-- nombre, la empresa se le asigna y **su suscripción se mueve con ella**, así que
-- nada cambia de comportamiento hasta que alguien sume una segunda empresa a la
-- cuenta (ahí comparten plan y cuota, que es el punto).
--
-- El id de la cuenta se DERIVA del de la empresa (`cta_` + id) en vez de usar
-- `gen_random_uuid()`: el backfill necesita saber a qué cuenta mover cada
-- suscripción, y con ids generados habría que mapearlos por nombre —que no es
-- único— o con una tabla temporal.

-- CreateTable
CREATE TABLE "cuenta" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cuenta_pkey" PRIMARY KEY ("id")
);

-- AlterTable (primero nullable: el NOT NULL va después del backfill)
ALTER TABLE "Company" ADD COLUMN "cuentaId" TEXT;
ALTER TABLE "subscription" ADD COLUMN "cuentaId" TEXT;

-- El rate limit por plan deja de resolverse por NOMBRE (`middleware/plan-rate-limit.ts`)
-- y pasa a ser un campo del plan. Los valores son los mismos que tenía la tabla por
-- nombre, así que el comportamiento no cambia.
ALTER TABLE "plan" ADD COLUMN "reqPorSegundo" INTEGER NOT NULL DEFAULT 5;
UPDATE "plan" SET "reqPorSegundo" = 10 WHERE "name" = 'Emprendedor';
UPDATE "plan" SET "reqPorSegundo" = 25 WHERE "name" = 'Pyme';
UPDATE "plan" SET "reqPorSegundo" = 50 WHERE "name" = 'Despacho';
-- 'Demo' y cualquier plan nuevo se quedan en el default 5, que es el piso del middleware.

-- Backfill (A MANO: `prisma migrate diff` no emite migraciones de datos).
INSERT INTO "cuenta" ("id", "name", "createdAt", "updatedAt")
SELECT 'cta_' || c."id", c."name", now(), now()
FROM "Company" c;

UPDATE "Company" SET "cuentaId" = 'cta_' || "id";
UPDATE "subscription" SET "cuentaId" = 'cta_' || "companyId";

-- AlterTable
ALTER TABLE "Company" ALTER COLUMN "cuentaId" SET NOT NULL;
ALTER TABLE "subscription" ALTER COLUMN "cuentaId" SET NOT NULL;

-- La suscripción ya no cuelga de la empresa.
ALTER TABLE "subscription" DROP CONSTRAINT "subscription_companyId_fkey";
DROP INDEX "subscription_companyId_idx";
ALTER TABLE "subscription" DROP COLUMN "companyId";

-- CreateIndex
CREATE INDEX "Company_cuentaId_idx" ON "Company"("cuentaId");
CREATE INDEX "subscription_cuentaId_idx" ON "subscription"("cuentaId");

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_cuentaId_fkey" FOREIGN KEY ("cuentaId") REFERENCES "cuenta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription" ADD CONSTRAINT "subscription_cuentaId_fkey" FOREIGN KEY ("cuentaId") REFERENCES "cuenta"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
