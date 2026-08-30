-- Facturas PDF add-on: configuración de facturación + logo + items + addons

-- Empresa: datos de facturación y contador correlativo
ALTER TABLE "Company" ADD COLUMN "logo" BYTEA;
ALTER TABLE "Company" ADD COLUMN "facturaSerie" TEXT;
ALTER TABLE "Company" ADD COLUMN "facturaResolucion" TEXT;
ALTER TABLE "Company" ADD COLUMN "facturaResolucionFecha" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "facturaCorrelativo" INTEGER NOT NULL DEFAULT 0;

-- Suscripción: add-ons contratados (ej. ["facturas-pdf"])
ALTER TABLE "subscription" ADD COLUMN "addons" TEXT[] NOT NULL DEFAULT '{}';

-- Factura: método de pago + items detallados
ALTER TABLE "invoice" ADD COLUMN "paymentMethod" TEXT;

CREATE TABLE "InvoiceItem" (
  "id" TEXT NOT NULL,
  "invoiceId" TEXT NOT NULL,
  "descripcion" TEXT NOT NULL,
  "cantidad" INTEGER NOT NULL DEFAULT 1,
  "precio" DOUBLE PRECISION NOT NULL,
  "itbms" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "InvoiceItem_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "InvoiceItem_invoiceId_idx" ON "InvoiceItem"("invoiceId");
ALTER TABLE "InvoiceItem" ADD CONSTRAINT "InvoiceItem_invoiceId_fkey"
  FOREIGN KEY ("invoiceId") REFERENCES "invoice"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Guardia anti-duplicado de numeración (permite NULLs múltiples para facturas sin número)
CREATE UNIQUE INDEX "Invoice_companyId_number_key" ON "invoice"("companyId", "number");
