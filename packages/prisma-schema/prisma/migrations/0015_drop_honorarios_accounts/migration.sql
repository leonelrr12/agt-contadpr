-- El modo Honorarios se retiró (Anexo-DGI Fase E): los honorarios entran por la
-- carga general de Transacciones y su cuenta se marca con "Lleva Anexo" en el
-- catálogo. Estas columnas configuraban el modo retirado.
-- Va DESPUÉS de desplegar el código que ya no las lee (si no, la API vieja
-- fallaría al seleccionarlas).
ALTER TABLE "Company" DROP COLUMN IF EXISTS "honorariosGastoId";
ALTER TABLE "Company" DROP COLUMN IF EXISTS "honorariosBancoId";
