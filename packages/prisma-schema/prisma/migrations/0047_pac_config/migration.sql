-- Configuración de emisión electrónica (PAC / agente autorizado) por empresa.
--
-- Una fila por empresa. Los secretos (`pacApiKey`, `pacBasicPassword`) los cifra
-- la aplicación en reposo (AES-256-GCM, services/crypto-fields.ts): acá se
-- guardan como TEXT, igual que `imapPassword` y el `taxId` cifrado.
--
-- `companyUuid` y `pacApiKey` son NULLABLE a propósito: la ficha se puede crear
-- antes de que el proveedor entregue los accesos. `enabled` (emisión) exige
-- ambos, y esa regla vive en services/pac/company-config.ts.
--
-- Migración ADITIVA: no toca ninguna tabla existente. Se aplica con
-- `prisma migrate deploy` SOLO cuando el dueño autorice el destino.

-- CreateTable
CREATE TABLE "pac_config" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'FACTURA_FACIL',
    "environment" TEXT NOT NULL DEFAULT 'PRUEBAS',
    "companyUuid" TEXT,
    "pacApiKey" TEXT,
    "basicUser" TEXT,
    "pacBasicPassword" TEXT,
    "branchUuid" TEXT,
    "branchCode" TEXT,
    "pos" TEXT NOT NULL DEFAULT '001',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "lastTestAt" TIMESTAMP(3),
    "lastTestOk" BOOLEAN,
    "lastTestError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pac_config_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "pac_config_companyId_key" ON "pac_config"("companyId");

-- AddForeignKey
ALTER TABLE "pac_config" ADD CONSTRAINT "pac_config_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;
