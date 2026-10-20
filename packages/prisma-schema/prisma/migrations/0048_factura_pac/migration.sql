-- Emisión electrónica (PAC) sobre las facturas de venta, 20-10-2026.
--
-- La factura y su asiento se crean como siempre (transacción local). Después del
-- commit se llama al PAC; estos campos guardan el resultado y permiten reintentar
-- con el MISMO controlId. La emisión NUNCA revierte la factura ni el asiento.
--
-- `itbmsRate` se agrega porque el PAC pide el CÓDIGO de la tasa (07/10/15/exento)
-- y hasta ahora el monto por línea no decía cuál era.
--
-- `pacXml` puede ser grande: se omite de las listas y se sirve por su endpoint.
-- `dv`/`location` del cliente son los datos del receptor que exige la DGI para
-- contribuyentes (el RUC solo no alcanza).
--
-- Migración ADITIVA: las facturas existentes quedan NO_CONFIGURADO y su tasa 7%.
-- Aplicar con `prisma migrate deploy` SOLO cuando el dueño autorice el destino.

ALTER TABLE "invoice" ADD COLUMN "itbmsRate" DOUBLE PRECISION NOT NULL DEFAULT 0.07;
ALTER TABLE "invoice" ADD COLUMN "pacStatus" TEXT NOT NULL DEFAULT 'NO_CONFIGURADO';
ALTER TABLE "invoice" ADD COLUMN "pacProvider" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacEnvironment" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacControlId" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "invoice" ADD COLUMN "cufe" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacDocumentUuid" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacDocumentNumber" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacAuthorizationNumber" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacPdfUrl" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacQrData" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacXml" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacMessages" TEXT;
ALTER TABLE "invoice" ADD COLUMN "pacAuthorizedAt" TIMESTAMP(3);
ALTER TABLE "invoice" ADD COLUMN "pacLastError" TEXT;

CREATE INDEX "invoice_companyId_pacStatus_idx" ON "invoice"("companyId", "pacStatus");

ALTER TABLE "client" ADD COLUMN "dv" TEXT;
ALTER TABLE "client" ADD COLUMN "location" TEXT;
