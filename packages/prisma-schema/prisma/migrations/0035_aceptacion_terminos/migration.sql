-- Evidencia de la aceptación de los Términos y Condiciones por usuario:
-- versión aceptada (la vigente vive en apps/api/src/lib/terms.ts) y fecha.
-- Aditiva y sin default: las cuentas que ya existían quedan en NULL (no tienen
-- constancia registrada) y el alta nueva las llena al crear el usuario.
--
-- SQL validado con `prisma migrate diff --from-url <prod> --to-schema-datamodel`
-- (devuelve exactamente estas dos columnas: la base está sin otro desvío).
ALTER TABLE "User" ADD COLUMN     "termsAcceptedAt" TIMESTAMP(3),
ADD COLUMN     "termsVersion" TEXT;
