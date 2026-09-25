-- Inventario: catálogo de productos de REVENTA y kardex de movimientos con costo
-- promedio ponderado (ver INVENTARIO.md y el comentario de los modelos).
--
-- Convenciones que sostienen el diseño:
--  · `saldoValor` es la suma FIRMADA de los `costoTotal` que fueron al asiento, NO
--    cantidad × promedio. Por eso el kardex y el mayor cuadran al centavo por
--    construcción; el costo promedio se deriva y se puede redondear al mostrarlo.
--  · `cantidad` SIEMPRE positiva: el signo lo da `tipo` (ENTRADA/SALIDA/AJUSTE_*).
--  · `fecha` a MEDIODÍA local (lib/dates.ts), como el resto del repo.
--
-- Aditiva: solo crea tablas y añade columnas NULLables, sin tocar datos existentes.

CREATE TABLE "inventory_product" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sku" TEXT,
    "nombre" TEXT NOT NULL,
    "descripcion" TEXT,
    "unidad" TEXT NOT NULL DEFAULT 'UND',
    "stockMinimo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stockActual" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "costoPromedio" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "cuentaInventarioId" TEXT,
    "cuentaCostoId" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_product_pkey" PRIMARY KEY ("id")
);

-- Dedupe del catálogo, mismo criterio que client/supplier (nombre normalizado)
CREATE UNIQUE INDEX "inventory_product_companyId_nombre_key"
    ON "inventory_product"("companyId", "nombre");

-- El SKU es opcional: en Postgres los NULL conviven en un índice único, así que
-- varios productos sin código no chocan entre sí.
CREATE UNIQUE INDEX "inventory_product_companyId_sku_key"
    ON "inventory_product"("companyId", "sku");

CREATE INDEX "inventory_product_companyId_isActive_idx"
    ON "inventory_product"("companyId", "isActive");

CREATE TABLE "inventory_movement" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "fecha" TIMESTAMP(3) NOT NULL,
    "tipo" TEXT NOT NULL,
    "origen" TEXT NOT NULL,
    "cantidad" DOUBLE PRECISION NOT NULL,
    "costoUnitario" DOUBLE PRECISION NOT NULL,
    "costoTotal" DOUBLE PRECISION NOT NULL,
    "saldoCantidad" DOUBLE PRECISION NOT NULL,
    "saldoValor" DOUBLE PRECISION NOT NULL,
    "saldoCostoPromedio" DOUBLE PRECISION NOT NULL,
    "journalEntryId" TEXT,
    "invoiceId" TEXT,
    "supplierId" TEXT,
    "referencia" TEXT,
    "notas" TEXT,
    "dedupeKey" TEXT,
    "estado" TEXT NOT NULL DEFAULT 'ACTIVO',
    "revierteAId" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movement_pkey" PRIMARY KEY ("id")
);

-- Idempotencia: re-subir el mismo documento o un doble clic no duplica stock.
-- Los movimientos de formulario no traen clave (NULL) y no chocan entre sí.
CREATE UNIQUE INDEX "inventory_movement_companyId_dedupeKey_key"
    ON "inventory_movement"("companyId", "dedupeKey");

-- El kardex de un producto, en orden de REGISTRO (no de fecha de documento): una
-- factura retroactiva no puede reescribir los promedios posteriores.
CREATE INDEX "inventory_movement_companyId_productId_createdAt_idx"
    ON "inventory_movement"("companyId", "productId", "createdAt");

-- Valoración y reportes por fecha de DOCUMENTO
CREATE INDEX "inventory_movement_companyId_productId_fecha_idx"
    ON "inventory_movement"("companyId", "productId", "fecha");
CREATE INDEX "inventory_movement_companyId_fecha_idx"
    ON "inventory_movement"("companyId", "fecha");

-- Del asiento al movimiento (visor de origen del auxiliar + cuadre contra el mayor)
CREATE INDEX "inventory_movement_journalEntryId_idx" ON "inventory_movement"("journalEntryId");
CREATE INDEX "inventory_movement_invoiceId_idx" ON "inventory_movement"("invoiceId");
CREATE INDEX "inventory_movement_supplierId_idx" ON "inventory_movement"("supplierId");

ALTER TABLE "inventory_product" ADD CONSTRAINT "inventory_product_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_companyId_fkey"
    FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- RESTRICT: un producto con movimientos no se borra; el módulo lo desactiva.
ALTER TABLE "inventory_movement" ADD CONSTRAINT "inventory_movement_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "inventory_product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Cuentas por defecto del módulo (patrón Company.planilla*Id, migración 0012)
ALTER TABLE "Company" ADD COLUMN "inventarioCuentaId" TEXT;
ALTER TABLE "Company" ADD COLUMN "inventarioCostoId" TEXT;

-- El renglón de una factura puede venir de un producto del kardex. Opcional: las
-- facturas de servicios y las históricas quedan con NULL y sin línea de costo.
ALTER TABLE "invoice_item" ADD COLUMN "productId" TEXT;
CREATE INDEX "invoice_item_productId_idx" ON "invoice_item"("productId");
-- SET NULL: si algún día se borra un producto, la factura conserva su renglón.
ALTER TABLE "invoice_item" ADD CONSTRAINT "invoice_item_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "inventory_product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
