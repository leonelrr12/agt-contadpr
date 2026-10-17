-- Ficha de la empresa (17-10-2026).
--
-- Hasta ahora el alta solo pedía nombre y RUC, y después no había dónde guardar
-- el resto de la ficha del contribuyente. Estos campos son DATOS, no reglas:
-- nada de lo que ya calcula el sistema los lee, salvo `dv`, que se imprime al
-- lado del RUC y permite comparar RUCs sin mezclar el dígito verificador.
--
-- `sello` sigue el patrón del logo: Bytes en la BD (el contenedor no persiste
-- archivos) y se redimensiona con sharp al subirlo.

ALTER TABLE "Company" ADD COLUMN "dv" TEXT;
ALTER TABLE "Company" ADD COLUMN "tipoEntidad" TEXT;
ALTER TABLE "Company" ADD COLUMN "actividadEconomica" TEXT;
ALTER TABLE "Company" ADD COLUMN "noPatronal" TEXT;
ALTER TABLE "Company" ADD COLUMN "observaciones" TEXT;
ALTER TABLE "Company" ADD COLUMN "fechaApertura" TIMESTAMP(3);
ALTER TABLE "Company" ADD COLUMN "sello" BYTEA;
