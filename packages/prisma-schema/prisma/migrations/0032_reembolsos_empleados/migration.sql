-- Reembolsos a trabajadores: identidad por celular y registro durable de las
-- facturas que el trabajador adelanta de su bolsillo.
--
-- Qué resuelve:
--  · Hasta acá TODO lo que entraba por WhatsApp se atribuía al admin de la
--    empresa (`resolveWhatsAppUserId`) y la URL del CUTE se descargaba y se
--    tiraba: no quedaba rastro de qué factura respaldaba cada gasto.
--  · `whatsapp_link.workerAccountId` es la ÚNICA marca que separa los dos modos
--    de un celular vinculado: con cuenta de trabajador, cada gasto que confirme
--    nace como factura por reembolsar; sin ella, sigue operando como la empresa.
--    Nullable a propósito — los vínculos que ya existen no cambian de conducta.
--
-- Contabilidad (decidida con el dueño): el gasto se registra al recibir la
-- factura contra el PASIVO `2.1.02.02 Reembolsos Empleados por Pagar`, no contra
-- el banco — el dinero todavía no salió:
--
--     al llegar la factura:  DR Gasto/Compra   CR 2.1.02.02
--     al pagar (N facturas): DR 2.1.02.02      CR Banco
--
-- Convenciones que sostienen el diseño:
--  · `dedupeKey` (RUC+número+fecha+total, o la URL si falta alguno) es unique
--    POR EMPRESA: la misma factura no entra dos veces, la mande quien la mande.
--    Es nullable — sin datos para identificar la factura no se puede deduplicar,
--    y Postgres deja convivir varios NULL en un índice unique.
--  · `journalEntryId` es @unique: un asiento salda UNA factura, y lo garantiza
--    la base, no el código.
--  · El estado del reembolso (PENDIENTE/PAGADO) vive acá y el contable
--    (BORRADOR/CONFIRMADO/RECHAZADO) en el asiento: dos ejes distintos que el
--    panel muestra juntos. No se sincronizan a mano.
--  · `dgiXml` guarda el XML oficial que la DGI embebe en el visor del CUTE
--    (~10-25 KB, comprimido por TOAST): es el documento legal, y el listado de
--    facturas queda autocontenido sin depender del visor de la DGI.
--
-- `reimbursement` se crea acá aunque el pago se implemente después: es una
-- tabla vacía y evita una segunda migración a producción.

-- AlterTable
ALTER TABLE "whatsapp_link" ADD COLUMN     "workerAccountId" TEXT;

-- CreateTable
CREATE TABLE "worker_account" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "phoneNumber" TEXT NOT NULL,
    "nombre" TEXT NOT NULL,
    "employeeId" TEXT,
    "supplierId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "worker_account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "expense_claim" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "dgiUrl" TEXT,
    "dgiXml" TEXT,
    "proveedor" TEXT,
    "rucEmisor" TEXT,
    "numeroFactura" TEXT,
    "fecha" TIMESTAMP(3) NOT NULL,
    "total" DOUBLE PRECISION NOT NULL,
    "itbms" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "dedupeKey" TEXT,
    "journalEntryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDIENTE',
    "reimbursementId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "expense_claim_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reimbursement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "workerId" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "journalEntryId" TEXT,
    "paidById" TEXT,
    "paidAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "worker_account_companyId_isActive_idx" ON "worker_account"("companyId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "worker_account_companyId_phoneNumber_key" ON "worker_account"("companyId", "phoneNumber");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claim_journalEntryId_key" ON "expense_claim"("journalEntryId");

-- CreateIndex
CREATE INDEX "expense_claim_companyId_status_idx" ON "expense_claim"("companyId", "status");

-- CreateIndex
CREATE INDEX "expense_claim_companyId_workerId_status_idx" ON "expense_claim"("companyId", "workerId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "expense_claim_companyId_dedupeKey_key" ON "expense_claim"("companyId", "dedupeKey");

-- CreateIndex
CREATE INDEX "reimbursement_companyId_workerId_idx" ON "reimbursement"("companyId", "workerId");

-- CreateIndex
CREATE INDEX "whatsapp_link_workerAccountId_idx" ON "whatsapp_link"("workerAccountId");

-- AddForeignKey
ALTER TABLE "whatsapp_link" ADD CONSTRAINT "whatsapp_link_workerAccountId_fkey" FOREIGN KEY ("workerAccountId") REFERENCES "worker_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_account" ADD CONSTRAINT "worker_account_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_account" ADD CONSTRAINT "worker_account_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "worker_account" ADD CONSTRAINT "worker_account_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "worker_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_journalEntryId_fkey" FOREIGN KEY ("journalEntryId") REFERENCES "JournalEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_reimbursementId_fkey" FOREIGN KEY ("reimbursementId") REFERENCES "reimbursement"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "worker_account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_paidById_fkey" FOREIGN KEY ("paidById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
