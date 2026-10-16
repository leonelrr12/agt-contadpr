-- Facturas por correo: RUC/cédulas EXTRA que se aceptan como receptor.
--
-- El filtro de receptor descarta la factura que no está a nombre de la empresa
-- (para no cargar la del cliente de al lado), pero el caso normal del dueño es
-- comprar a su nombre personal: la factura viene a su cédula y hoy caería en
-- OTRO_CLIENTE. Este campo agrega excepciones explícitas —el `Company.taxId`
-- sigue aceptándose siempre— y se guarda como JSON en String (la convención del
-- repo, igual que `Transaction.metadata` y `adjuntos`).
--
-- Migración ADITIVA: la columna nace con default "[]" (ninguna excepción), o sea
-- que el comportamiento de las empresas que ya tenían el buzón no cambia.

-- AlterTable
ALTER TABLE "email_factura_config" ADD COLUMN     "receptorRucs" TEXT NOT NULL DEFAULT '[]';
