/**
 * El catálogo de módulos que se pueden **contratar aparte** del plan
 * (`Subscription.addons`), con su precio.
 *
 * Es la única fuente: la validación del panel (`PATCH /api/admin/subscriptions/:id`)
 * sale de acá, y la pantalla de precios lo publica tal cual en `GET /api/addons`. Así
 * el precio que se ve es el mismo que se cobra, y agregar un módulo es agregar una
 * entrada.
 *
 * Un módulo se tiene por el **plan o por acá** (PLANES.md §4): el despacho que
 * necesita inventario para un solo cliente lo contrata suelto en vez de saltar de
 * plan. Precios fijados por el dueño el 16-10-2026 (Facturas PDF ya se vendía a
 * $9.99; Inventario y Planilla a $3.99 cada uno).
 */

export interface ModuloContratable {
  id: string;
  nombre: string;
  precio: number;
  descripcion: string;
  /** Lo que se lleva el cliente, en bullets. */
  incluye: string[];
}

export const MODULOS_CONTRATABLES: ModuloContratable[] = [
  {
    id: 'facturas-pdf',
    nombre: '🧾 Facturas PDF',
    precio: 9.99,
    descripcion: 'Emite facturas de venta profesionales con cumplimiento DGI.',
    incluye: [
      'Numeración correlativa por serie',
      'Logo y datos de tu empresa',
      'Resolución DGI en cada factura',
      'Items detallados con ITBMS desglosado',
      'PDF descargable e imprimible',
      'Asiento contable automático (BORRADOR)',
    ],
  },
  {
    id: 'inventario',
    nombre: '📦 Inventario',
    precio: 3.99,
    descripcion: 'Kardex, costo promedio y valoración de existencias, con compras y ventas que mueven el stock.',
    incluye: ['Entradas, salidas y ajustes', 'Kardex por producto', 'Costo promedio y valoración', 'Cuadre contra el mayor'],
  },
  {
    id: 'planilla',
    nombre: '🧮 Planilla',
    precio: 3.99,
    descripcion: 'Nómina panameña completa: SS, SE, ISR, décimo, vacaciones y aportes del patrono.',
    incluye: ['Empleados y salarios', 'Cálculo quincenal, mensual o semanal', 'Pago a la CSS y descarga de planillas', 'Asientos y pasivo del patrono'],
  },
];

/** Los ids que acepta `Subscription.addons`. Deriva del catálogo, no se escribe dos veces. */
export const KNOWN_ADDONS: string[] = MODULOS_CONTRATABLES.map((m) => m.id);
