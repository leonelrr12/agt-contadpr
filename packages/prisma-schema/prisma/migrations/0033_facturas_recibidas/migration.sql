-- `expense_claim` pasa a ser el registro de TODAS las facturas recibidas, no
-- solo de las que un trabajador adelantó.
--
-- Qué resuelve: hasta acá, la URL del CUTE y el XML de la DGI se guardaban solo
-- cuando la factura venía del celular de un trabajador. Las facturas que sube la
-- propia empresa por WhatsApp seguían descartándose, así que "consultar
-- cualquier factura a futuro" era cierto a medias.
--
-- `workerId` nullable es la única marca que separa los dos papeles:
--   · con trabajador → es además un REEMBOLSO (su saldo lo responde /viaticos);
--   · sin trabajador → es una factura de la empresa, y solo se archiva.
--
-- La FK pasa a ON DELETE SET NULL: borrar una cuenta de trabajador no puede
-- llevarse por delante el archivo de las facturas que esa persona mandó.

-- DropForeignKey
ALTER TABLE "expense_claim" DROP CONSTRAINT "expense_claim_workerId_fkey";

-- AlterTable
ALTER TABLE "expense_claim" ALTER COLUMN "workerId" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "expense_claim" ADD CONSTRAINT "expense_claim_workerId_fkey" FOREIGN KEY ("workerId") REFERENCES "worker_account"("id") ON DELETE SET NULL ON UPDATE CASCADE;
