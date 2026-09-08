-- Cuenta bancaria por defecto para pagos por chat/WhatsApp (Panel Admin → Configuración)
ALTER TABLE "Company" ADD COLUMN "bancoDefaultId" TEXT;
