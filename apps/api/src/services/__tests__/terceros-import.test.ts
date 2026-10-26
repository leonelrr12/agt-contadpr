import { describe, it, expect } from 'vitest';
import {
  parseTercerosFile,
  planificarTerceros,
  aplicarPlanTerceros,
  resumir,
  construirPlantillaTerceros,
  type FilaTercero,
} from '../terceros-import';

const HEADER = 'TIPO,RUC,DV,NOMBRE,RAZON SOCIAL,TIPO INDENTIFICACION,TELEFONO,EMAIL,DIRECCION,UBICACION,NOTAS,PLAZO DE PAGO';

function csv(...rows: string[]) {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

describe('parseTercerosFile', () => {
  it('mapea RAZON SOCIAL a name y NOMBRE a tradeName', async () => {
    const rows = await parseTercerosFile(csv(
      'Proveedor,46004-187-302083,96,+Movil Panama,CABLES & WIRILESS,RUC,,,,,,30',
      'Proveedor,8-786-1842,89,ALEJANDRO RODRIGUEZ ACEVEDO,,CEDULA,,,,,,',
      'Cliente,8-733-2267,88,Ferreteria El Tornillo,FERRETERÍA EL TORNILLO S.A.,RUC,+507 6000-0000,compras@tornillo.com,Calle 1,8-8-8,Cliente,30',
    ), 'terceros.csv');

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({
      fila: 2,
      tipo: 'Proveedor',
      name: 'CABLES & WIRILESS',
      tradeName: '+Movil Panama',
      taxId: '46004-187-302083',
      dv: '96',
      paymentTerms: '30',
    });
    expect(rows[1]).toMatchObject({
      tipo: 'Proveedor',
      name: 'ALEJANDRO RODRIGUEZ ACEVEDO',
      tradeName: null,
      taxId: '8-786-1842',
      dv: '89',
      taxIdType: 'CEDULA',
    });
    expect(rows[2]).toMatchObject({
      tipo: 'Cliente',
      name: 'FERRETERÍA EL TORNILLO S.A.',
      tradeName: null,
      location: '8-8-8',
      email: 'compras@tornillo.com',
    });
  });

  it('reconoce el typo TIPO INDENTIFICACION y separa el DV pegado al RUC', async () => {
    const rows = await parseTercerosFile(csv(
      'Cliente,8-733-2267-88,,Cliente X,,RUC,,,,,,',
    ), 'terceros.csv');
    expect(rows[0].taxId).toBe('8-733-2267');
    expect(rows[0].dv).toBe('88');
  });

  it('marca error si el DV del RUC y la columna DV no coinciden', async () => {
    const rows = await parseTercerosFile(csv(
      'Cliente,8-733-2267-88,99,Cliente X,,RUC,,,,,,',
    ), 'terceros.csv');
    expect(rows[0].error).toContain('no coincide');
  });

  it('marca error si la ubicación no es PP-DD-CC', async () => {
    const rows = await parseTercerosFile(csv(
      'Cliente,8-733-2267,88,Cliente X,,RUC,,,,MAL,',
    ), 'terceros.csv');
    expect(rows[0].error).toContain('Ubicación inválida');
  });

  it('la plantilla XLSX se lee con el mismo parser', async () => {
    const buffer = await construirPlantillaTerceros();
    const rows = await parseTercerosFile(buffer, 'plantilla-terceros.xlsx');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => !r.error)).toBe(true);
    expect(rows[0]).toMatchObject({ name: 'CABLES & WIRELESS', tradeName: '+Movil Panama', dv: '96' });
  });

  it('acepta el formato exacto del dueño, sin UBICACION ni PLAZO', async () => {
    const header = 'TIPO,RUC,DV,NOMBRE,RAZON SOCIAL,TIPO INDENTIFICACION,TELEFONO,EMAIL,DIRECCION,NOTAS';
    const rows = await parseTercerosFile(Buffer.from([
      header,
      'Proveedor,46004-187-302083,96,+Movil Panama,CABLES & WIRILESS,RUC,,,,',
      'Proveedor,8-786-1842,89,ALEJANDRO RODRIGUEZ ACEVEDO,,CEDULA,,,,',
    ].join('\n'), 'utf8'), 'terceros.csv');

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => !r.error)).toBe(true);
    expect(rows[0]).toMatchObject({ name: 'CABLES & WIRILESS', tradeName: '+Movil Panama', dv: '96' });
    expect(rows[1]).toMatchObject({ name: 'ALEJANDRO RODRIGUEZ ACEVEDO', tradeName: null, dv: '89' });
  });
});

const existenteCliente = {
  id: 'c1', name: 'CLIENTE A', taxId: '8-733-2267', dv: null,
  tradeName: null, contactName: null, taxIdType: null,
  phone: null, email: null, address: null, location: null, notes: null,
};
const existenteProveedor = {
  id: 's1', name: 'PROVEEDOR B', taxId: '342-240-75526', dv: '50',
  tradeName: null, contactName: null, taxIdType: null,
  phone: null, email: null, address: null, location: null, notes: null, paymentTerms: '30',
};

const fila = (p: Partial<FilaTercero>): FilaTercero => ({ fila: 2, tipo: 'Cliente', name: 'X', ...p });

describe('planificarTerceros', () => {
  const existentes = { client: [existenteCliente], supplier: [existenteProveedor] };

  it('crea un tercero nuevo', () => {
    const r = planificarTerceros([fila({ tipo: 'Proveedor', name: 'NUEVO PROV', taxId: '8-100-200' })], existentes, 'completar');
    expect(r.resumen.nuevo).toBe(1);
    expect(r.filas[0]).toMatchObject({ estado: 'nuevo', tipo: 'Proveedor' });
    expect(r.filas[0].data).toMatchObject({ name: 'NUEVO PROV', fiscalSource: 'IMPORT' });
  });

  it('en modo completar solo llena campos vacíos y no pisa', () => {
    const r = planificarTerceros([
      fila({ name: 'OTRO NOMBRE', taxId: '8-733-2267', dv: '88', phone: '+507 6000-0000' }),
    ], existentes, 'completar');
    expect(r.resumen.actualiza).toBe(1);
    expect(r.filas[0].data).toMatchObject({ dv: '88', phone: '+507 6000-0000' });
    expect(r.filas[0].data?.name).toBeUndefined();
  });

  it('en modo actualizar sobrescribe los valores no vacíos', () => {
    const r = planificarTerceros([
      fila({ name: 'CLIENTE A', taxId: '8-733-2267', phone: '+507 6000-0000' }),
    ], existentes, 'actualizar');
    expect(r.filas[0].estado).toBe('actualiza');
    expect(r.filas[0].data).toMatchObject({ phone: '+507 6000-0000' });
  });

  it('conflicta si el nombre ya pertenece a otro RUC', () => {
    const r = planificarTerceros([
      fila({ name: 'CLIENTE A', taxId: '8-999-999' }),
    ], existentes, 'completar');
    expect(r.filas[0].estado).toBe('conflicto');
  });

  it('marca repetida una fila idéntica y conflicto si difiere', () => {
    const base = fila({ name: 'NUEVO', taxId: '8-100-200', phone: '1' });
    const r = planificarTerceros([base, { ...base, fila: 3 }], existentes, 'completar');
    expect(r.filas[1].estado).toBe('repetida');

    const r2 = planificarTerceros([base, { ...base, fila: 3, phone: '2' }], existentes, 'completar');
    expect(r2.filas[0].estado).toBe('conflicto');
    expect(r2.filas[1].estado).toBe('conflicto');
  });

  it('no mezcla Cliente y Proveedor del mismo RUC (son tablas distintas)', () => {
    const r = planificarTerceros([
      fila({ tipo: 'Cliente', name: 'CLIENTE A', taxId: '8-733-2267' }),
      fila({ tipo: 'Proveedor', name: 'CLIENTE A', taxId: '8-733-2267' }),
    ], { client: [existenteCliente], supplier: [] }, 'completar');
    expect(r.filas[0].estado).toBe('sin_cambios');
    expect(r.filas[1].estado).toBe('nuevo');
  });

  it('encuentra un proveedor histórico por nombre comercial y le completa el RUC', () => {
    const proveedor = {
      id: 's2', name: '+Movil Panama', taxId: null, dv: null, tradeName: null,
      contactName: null, taxIdType: null, phone: null, email: null, address: null,
      location: null, notes: null, paymentTerms: '30',
    };
    const r = planificarTerceros([
      fila({
        tipo: 'Proveedor', name: 'CABLES & WIRILESS', tradeName: '+Movil Panama',
        taxId: '46004-187-302083', dv: '96',
      }),
    ], { client: [], supplier: [proveedor] }, 'completar');
    expect(r.filas[0].estado).toBe('actualiza');
    expect(r.filas[0].data).toMatchObject({
      name: 'CABLES & WIRILESS',
      tradeName: '+Movil Panama',
      taxId: '46004-187-302083',
      dv: '96',
    });
  });

  it('avisa posible duplicado por nombre parcial en vez de crear otro', () => {
    const persona = {
      id: 'c2', name: 'Alejandro Acevedo', taxId: null, dv: null, tradeName: null,
      contactName: null, taxIdType: null, phone: null, email: null, address: null,
      location: null, notes: null,
    };
    const r = planificarTerceros([
      fila({ name: 'Alejandro Rodriguez Acevedo', taxId: '8-786-1842', dv: '89', taxIdType: 'CEDULA' }),
    ], { client: [persona], supplier: [] }, 'completar');
    expect(r.filas[0].estado).toBe('conflicto');
    expect(r.filas[0].detalle).toContain('Posible duplicado');
  });
});

describe('aplicarPlanTerceros', () => {
  it('crea y actualiza usando el modelo correcto', async () => {
    const creados: any[] = [];
    const actualizados: any[] = [];
    const prisma = {
      client: {
        create: async ({ data }: any) => { creados.push({ model: 'client', data }); return { id: 'c-new' }; },
        update: async ({ where, data }: any) => { actualizados.push({ model: 'client', where, data }); return {}; },
      },
      supplier: {
        create: async ({ data }: any) => { creados.push({ model: 'supplier', data }); return { id: 's-new' }; },
        update: async ({ where, data }: any) => { actualizados.push({ model: 'supplier', where, data }); return {}; },
      },
    };
    const plan = planificarTerceros([
      fila({ tipo: 'Cliente', name: 'CLIENTE A', taxId: '8-733-2267', phone: '+507 1' }),
      fila({ tipo: 'Proveedor', name: 'PROVEEDOR NUEVO', taxId: '8-100-200' }),
    ], { client: [existenteCliente], supplier: [] }, 'completar');

    const r = await aplicarPlanTerceros(prisma, 'co-1', plan.filas);
    expect(r.aplicadas).toBe(2);
    expect(actualizados[0]).toMatchObject({ model: 'client', where: { id: 'c1' } });
    expect(creados[0]).toMatchObject({ model: 'supplier', data: { companyId: 'co-1', name: 'PROVEEDOR NUEVO' } });
  });
});

describe('resumir', () => {
  it('cuenta todos los estados', () => {
    const r = resumir([
      { fila: 2, tipo: 'Cliente', name: 'A', taxId: null, dv: null, estado: 'nuevo', detalle: '', cambios: [] },
      { fila: 3, tipo: 'Cliente', name: 'A', taxId: null, dv: null, estado: 'actualiza', detalle: '', cambios: [] },
      { fila: 4, tipo: 'Cliente', name: 'A', taxId: null, dv: null, estado: 'error', detalle: '', cambios: [] },
    ]);
    expect(r).toMatchObject({ total: 3, nuevo: 1, actualiza: 1, error: 1, conflicto: 0 });
  });
});
