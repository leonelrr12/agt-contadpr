-- Reparación: la tabla creada en 0007 como "InvoiceItem" debe llamarse
-- "invoice_item" (el modelo Prisma usa @@map("invoice_item")).
ALTER TABLE "InvoiceItem" RENAME TO "invoice_item";
ALTER INDEX "InvoiceItem_invoiceId_idx" RENAME TO "invoice_item_invoiceId_idx";
ALTER TABLE "invoice_item" RENAME CONSTRAINT "InvoiceItem_invoiceId_fkey" TO "invoice_item_invoiceId_fkey";
