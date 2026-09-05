-- Retención ITBMS sufrida (50% del ITBMS por cliente agente) + dedupe de RUC

-- 1) Dedupe de contrapartes por RUC sin filtrar el valor cifrado (HMAC determinista)
ALTER TABLE "client" ADD COLUMN "taxIdHash" TEXT;
ALTER TABLE "supplier" ADD COLUMN "taxIdHash" TEXT;

CREATE UNIQUE INDEX "client_companyId_taxIdHash_key" ON "client"("companyId", "taxIdHash");
CREATE UNIQUE INDEX "supplier_companyId_taxIdHash_key" ON "supplier"("companyId", "taxIdHash");

-- 2) Perfil de agente de retención en el cliente (vigencia evaluada contra la fecha de la factura)
ALTER TABLE "client" ADD COLUMN "esAgenteRetenedor" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "client" ADD COLUMN "porcentajeRetencionItbms" DOUBLE PRECISION NOT NULL DEFAULT 0.5;
ALTER TABLE "client" ADD COLUMN "vigenciaRetencionDesde" TIMESTAMP(3);
ALTER TABLE "client" ADD COLUMN "vigenciaRetencionHasta" TIMESTAMP(3);

-- 3) Retención ITBMS en el pago: amount = efectivo recibido; retentionAmount = crédito fiscal
ALTER TABLE "invoice_payment" ADD COLUMN "retentionAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- 4) Registro de retenciones sufridas (crédito fiscal; certificado del agente como soporte)
CREATE TABLE "retencion_itbms" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "invoicePaymentId" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "baseGravada" DOUBLE PRECISION NOT NULL,
    "itbmsFacturado" DOUBLE PRECISION NOT NULL,
    "porcentaje" DOUBLE PRECISION NOT NULL,
    "montoRetencion" DOUBLE PRECISION NOT NULL,
    "numeroCertificado" TEXT,
    "fechaCertificado" TIMESTAMP(3),
    "estado" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "journalEntryId" TEXT,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "retencion_itbms_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "retencion_itbms_companyId_idx" ON "retencion_itbms"("companyId");
CREATE INDEX "retencion_itbms_clientId_idx" ON "retencion_itbms"("clientId");
CREATE INDEX "retencion_itbms_invoiceId_idx" ON "retencion_itbms"("invoiceId");
CREATE INDEX "retencion_itbms_estado_idx" ON "retencion_itbms"("estado");

ALTER TABLE "retencion_itbms" ADD CONSTRAINT "retencion_itbms_clientId_fkey"
    FOREIGN KEY ("clientId") REFERENCES "client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "retencion_itbms" ADD CONSTRAINT "retencion_itbms_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
