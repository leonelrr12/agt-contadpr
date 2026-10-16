-- Multi-empresa: membresías usuario ↔ empresa.
--
-- Hasta acá un usuario pertenecía a UNA sola empresa (`User.companyId`) y cambiar
-- de empresa era cerrar sesión y entrar con otro usuario. Un despacho necesita lo
-- contrario: una cuenta que trabaje varias empresas, con el ROL POR EMPRESA (el
-- mismo contador es `contador` en los libros del cliente y `admin` en los propios).
--
-- `User.companyId` queda como la empresa por defecto; la autorización pasa a salir
-- de esta tabla. `User.email` sigue siendo único global: la misma persona en dos
-- empresas es UNA cuenta con dos membresías, nunca dos usuarios.
--
-- Migración ADITIVA + backfill: cada usuario existente recibe su membresía con la
-- empresa y el rol que ya tenía, así que nada cambia de comportamiento hasta que
-- alguien sume una segunda empresa.

-- CreateTable
CREATE TABLE "user_company" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'contador',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "user_company_pkey" PRIMARY KEY ("id")
);
-- CreateIndex
CREATE INDEX "user_company_companyId_idx" ON "user_company"("companyId");
-- CreateIndex
CREATE UNIQUE INDEX "user_company_userId_companyId_key" ON "user_company"("userId", "companyId");
-- AddForeignKey
ALTER TABLE "user_company" ADD CONSTRAINT "user_company_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- AddForeignKey
ALTER TABLE "user_company" ADD CONSTRAINT "user_company_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill (A MANO: `prisma migrate diff` no emite migraciones de datos).
-- El id se arma con `gen_random_uuid()` porque el cuid lo genera Prisma, no la BD.
INSERT INTO "user_company" ("id", "userId", "companyId", "role", "createdAt")
SELECT 'uc_' || replace(gen_random_uuid()::text, '-', ''), u."id", u."companyId", u."role", now()
FROM "User" u
ON CONFLICT ("userId", "companyId") DO NOTHING;
