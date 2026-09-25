-- Marca de anulación en el asiento, SIN sacarlo de los informes.
--
-- Un asiento anulado se contabilizó y después se corrigió: no se borra la historia.
-- El original sigue contando en su período y el asiento de reversión —fechado el día
-- de la corrección— lo netea desde ese mes en adelante. Antes el original pasaba a
-- ANULADO, que lo excluía de su período: el informe de enero mostraba que un gasto
-- registrado en enero nunca había existido.
--
-- Esta columna guarda el id del asiento de reversión para que la UI pueda mostrarlo
-- y navegar hasta él. Ningún reporte la mira.
--
-- Aditiva: columna NULLable. Nada la lee todavía, así que no cambia ningún informe.

ALTER TABLE "JournalEntry" ADD COLUMN "anuladoPorId" TEXT;
