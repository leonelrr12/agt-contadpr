-- Facturas DGI por correo (IMAP): la empresa asigna un buzón, el sistema lee las
-- facturas que mandan los proveedores (PDF adjunto, XML o link del CUTE) y las carga
-- como asiento BORRADOR + archivo en «Facturas recibidas». Diseño completo y decisiones
-- del dueño en FACTURAS-CORREO.md.
--
-- Dos tablas nuevas:
--  · `email_factura_config` — 1:1 con la empresa, se crea perezosamente con `upsert`.
--    `imapPassword` va CIFRADO (`ENCRYPTED_FIELDS` de `services/crypto-fields.ts`; hay
--    que agregarlo a esa lista o queda en claro). El cursor (`imapUidValidity` +
--    `imapLastUid`) es la segunda red de idempotencia además del Message-ID.
--  · `email_factura_mensaje` — ledger de correos vistos, `@@unique(companyId, messageId)`.
--    Va aparte de `expense_claim` porque un correo puede traer 0, 1 o N facturas, hay
--    que recordar los que NO eran facturas (para no re-escanear ni gastar LLM) y el
--    Message-ID único sobrevive a que cambie la UIDVALIDITY del buzón.
--
-- Dos columnas nuevas en `expense_claim`: `origen` (canal por el que entró la factura;
-- antes se deducía de si tenía trabajador y con el correo hacen falta los tres valores)
-- y `emailMensajeId` con FK ON DELETE SET NULL — borrar el historial de correos no puede
-- llevarse una factura archivada (misma doctrina que `workerId` en la 0033).
--
-- Migración ADITIVA: las columnas nuevas tienen default y las tablas nacen vacías.
-- SQL validado con `prisma migrate diff --from-url <prod> --to-schema-datamodel`, que
-- devuelve exactamente estas sentencias; lo único agregado a mano es el backfill del
-- final, marcado (Prisma no emite migraciones de datos).

-- AlterTable
ALTER TABLE "expense_claim" ADD COLUMN     "emailMensajeId" TEXT,
ADD COLUMN     "origen" TEXT NOT NULL DEFAULT 'MANUAL';

-- CreateTable
CREATE TABLE "email_factura_config" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "modo" TEXT NOT NULL DEFAULT 'IMAP',
    "imapHost" TEXT,
    "imapPort" INTEGER NOT NULL DEFAULT 993,
    "imapSecure" BOOLEAN NOT NULL DEFAULT true,
    "imapUser" TEXT,
    "imapPassword" TEXT,
    "imapFolder" TEXT NOT NULL DEFAULT 'INBOX',
    "imapUidValidity" INTEGER,
    "imapLastUid" INTEGER,
    "marcarLeido" BOOLEAN NOT NULL DEFAULT false,
    "carpetaMover" TEXT,
    "inboxAlias" TEXT,
    "cuentaPagoId" TEXT,
    "metodoPago" TEXT NOT NULL DEFAULT 'TRANSFERENCIA',
    "conceptoDefaultId" TEXT,
    "ultimaCorridaAt" TIMESTAMP(3),
    "ultimoEstado" TEXT,
    "ultimoDetalle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_factura_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_factura_mensaje" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "folder" TEXT,
    "uidValidity" INTEGER,
    "uid" INTEGER,
    "messageId" TEXT NOT NULL,
    "remitente" TEXT,
    "asunto" TEXT,
    "recibidoAt" TIMESTAMP(3),
    "adjuntos" TEXT NOT NULL DEFAULT '[]',
    "facturas" TEXT NOT NULL DEFAULT '[]',
    "estado" TEXT NOT NULL DEFAULT 'PROCESANDO',
    "detalle" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "email_factura_mensaje_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "email_factura_config_companyId_key" ON "email_factura_config"("companyId");

-- CreateIndex
CREATE UNIQUE INDEX "email_factura_config_inboxAlias_key" ON "email_factura_config"("inboxAlias");

-- CreateIndex
CREATE INDEX "email_factura_mensaje_companyId_estado_idx" ON "email_factura_mensaje"("companyId", "estado");

-- CreateIndex
CREATE INDEX "email_factura_mensaje_companyId_createdAt_idx" ON "email_factura_mensaje"("companyId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "email_factura_mensaje_companyId_messageId_key" ON "email_factura_mensaje"("companyId", "messageId");

-- CreateIndex
CREATE INDEX "expense_claim_emailMensajeId_idx" ON "expense_claim"("emailMensajeId");

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_emailMensajeId_fkey" FOREIGN KEY ("emailMensajeId") REFERENCES "email_factura_mensaje"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_factura_config" ADD CONSTRAINT "email_factura_config_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_factura_mensaje" ADD CONSTRAINT "email_factura_mensaje_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Backfill (A MANO: `prisma migrate diff` no emite migraciones de datos).
-- Hasta acá el único escritor de una factura recibida era el flujo de WhatsApp
-- (`whatsapp-service.ts`), y en producción las 9 filas existentes tienen trabajador:
-- todas vinieron por ahí. El default 'MANUAL' queda para las que se carguen a mano.
UPDATE "expense_claim" SET "origen" = 'WHATSAPP';
