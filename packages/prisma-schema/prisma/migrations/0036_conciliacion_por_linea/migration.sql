-- Conciliación bancaria fina: una fila del extracto sostenida por VARIAS líneas
-- del libro.
--
-- Qué resuelve: el ACH de Inmobiliaria Don Antonio del 20-feb por $17.353,68 son
-- cuatro facturas cobradas de una sola vez ($912,54 + $6.618,06 + $527,85 +
-- $9.295,23). El matcher automático empareja UNA línea contra UNA fila y por
-- monto exacto, así que ese depósito no tenía contra qué conciliarse y las
-- cuatro partidas del libro quedaban "sin conciliar (libros)" para siempre.
--
-- Por qué por LÍNEA y no por asiento: la línea es la unidad que no se puede
-- repetir (un asiento puede tener dos líneas de banco y sostener dos filas), y
-- es la que lleva el monto que cuadra contra la fila.
--
-- Convenciones:
--  · `matchedEntryId` en bank_statement_row sigue siendo el asiento "de
--    cabecera" (el primero del vínculo) para la UI y los listados; esta tabla es
--    la verdad de qué está conciliado.
--  · `amount` permite aplicar un monto PARCIAL de la línea (depósito neto de
--    comisión o retención); lo normal es el total de la línea.
--  · `isManual` marca el vínculo hecho a mano: el matcher automático no lo
--    reasigna ni "Volver a conciliar" lo suelta.
--  · El unique (rowId, lineId) impide que la misma línea sustente dos veces la
--    misma fila; el solapamiento entre filas distintas lo valida la API.

-- CreateTable
CREATE TABLE "bank_row_match" (
    "id" TEXT NOT NULL,
    "rowId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "lineId" TEXT NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "isManual" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "bank_row_match_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "bank_row_match_rowId_lineId_key" ON "bank_row_match"("rowId", "lineId");

-- CreateIndex
CREATE INDEX "bank_row_match_rowId_idx" ON "bank_row_match"("rowId");

-- CreateIndex
CREATE INDEX "bank_row_match_entryId_idx" ON "bank_row_match"("entryId");

-- CreateIndex
CREATE INDEX "bank_row_match_lineId_idx" ON "bank_row_match"("lineId");

-- AddForeignKey
ALTER TABLE "bank_row_match" ADD CONSTRAINT "bank_row_match_rowId_fkey" FOREIGN KEY ("rowId") REFERENCES "bank_statement_row"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_row_match" ADD CONSTRAINT "bank_row_match_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "JournalEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bank_row_match" ADD CONSTRAINT "bank_row_match_lineId_fkey" FOREIGN KEY ("lineId") REFERENCES "JournalLine"("id") ON DELETE CASCADE ON UPDATE CASCADE;
