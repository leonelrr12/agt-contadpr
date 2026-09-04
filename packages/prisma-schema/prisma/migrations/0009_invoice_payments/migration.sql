-- Abonos/parciales a facturas de clientes (CxC)
ALTER TABLE "invoice" ADD COLUMN "paidAmount" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- Tabla de abonos por factura
CREATE TABLE "invoice_payment" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "accountId" TEXT,
    "accountName" TEXT,
    "journalEntryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_payment_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "invoice_payment_invoiceId_idx" ON "invoice_payment"("invoiceId");
CREATE INDEX "invoice_payment_companyId_idx" ON "invoice_payment"("companyId");

ALTER TABLE "invoice_payment" ADD CONSTRAINT "invoice_payment_invoiceId_fkey"
    FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
