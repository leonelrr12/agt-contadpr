-- Precio de venta de referencia por producto, SIN ITBMS (igual que InvoiceItem.precio:
-- el impuesto se calcula encima al facturar).
--
-- Sirve para prellenar el precio en el formulario de facturas —hoy queda en blanco
-- porque el sistema solo conocía el costo— y para ver el margen por producto. El
-- precio que manda siempre es el del renglón de la factura, así que si queda viejo
-- no rompe ninguna contabilidad.
--
-- Aditiva: columna NULLable sobre una tabla sin datos.

ALTER TABLE "inventory_product" ADD COLUMN "precioVenta" DOUBLE PRECISION;
