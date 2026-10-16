import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cargarFacturaDesdeCorreo } from '../email-factura-pipeline';
import type { FacturaDetectada } from '../email-factura-extract';

/**
 * El pipeline es el ÚNICO lugar del módulo que crea contabilidad, y lo hace sin
 * nadie del otro lado: cuando algo falta no se pregunta, se anota y no se carga.
 * Estos tests fijan, en orden, todo lo que tiene que decidir ANTES de gastar
 * LLM (duplicada, otro cliente, sin cuenta, sin cuota) y las dos redes que
 * protegen la contabilidad: no confirmar nada si el motor necesita preguntar, y
 * borrar el asiento si la factura ya estaba archivada por otro canal.
 */

const estado = vi.hoisted(() => ({
  instancias: [] as any[],
  proceso: null as any,
  confirmaciones: 0,
  confirmado: null as any,
}));

vi.mock('@agt-contador/agents', () => ({
  OrchestratorAgent: class {
    constructor(cfg: any) {
      estado.instancias.push(cfg);
    }
    async process() {
      return estado.proceso;
    }
    async confirm() {
      estado.confirmaciones++;
      return estado.confirmado;
    }
  },
}));

// La clasificación por palabras del catálogo no es lo que se prueba acá (y
// consultaría la BD): sin concepto pre-clasificado el motor decide.
vi.mock('../pre-clasificador', () => ({ quickClassify: async () => null }));

const CONFIRMADO_OK = {
  plan: {},
  needsConfirmation: true,
  result: { dialog: { type: 'GASTO' }, entry: { debit: [], credit: [] } },
};

function prismaFalso(opts: any = {}) {
  const llamadas = { claims: [] as any[], cuota: 0, borrados: [] as string[] };
  // `duplicados` se consume en orden: cada llamada al dedupe devuelve el siguiente.
  const duplicados: any[] = [...(opts.duplicados || [])];
  const prisma: any = {
    company: { findUnique: async () => ('company' in opts ? opts.company : { name: 'Empresa Demo', taxId: '1555-1234-5678' }) },
    account: {
      findFirst: async () =>
        'banco' in opts ? opts.banco : { id: 'acc-banco', code: '1.1.02.01', name: 'Banco General', isActive: true, isBlocked: false },
    },
    subscription: {
      findFirst: async () => ('sub' in opts ? opts.sub : { id: 'sub-1', movementsUsed: 10, movementsLimit: 100 }),
      update: async () => {
        llamadas.cuota++;
        return {};
      },
    },
    concept: { findFirst: async () => opts.concepto ?? null },
    // El `createdById` del asiento: el pipeline resuelve un usuario real de la empresa.
    user: { findFirst: async () => ({ id: 'u-1' }) },
    expenseClaim: {
      findFirst: async () => (duplicados.length ? duplicados.shift() : null),
      create: async ({ data }: any) => {
        llamadas.claims.push(data);
        return { id: 'claim-1', ...data };
      },
    },
    transaction: { deleteMany: async () => (llamadas.borrados.push('transaction'), { count: 1 }) },
    journalLine: { deleteMany: async () => (llamadas.borrados.push('journalLine'), { count: 2 }) },
    journalEntry: { delete: async () => (llamadas.borrados.push('journalEntry'), {}) },
    $transaction: async (ops: any[]) => Promise.all(ops),
  };
  return { prisma, llamadas };
}

const FACTURA = (over: any = {}): FacturaDetectada => ({
  via: 'XML',
  origen: 'factura.xml',
  factura: {
    proveedor: 'RIBA SMITH S A',
    ruc: '342-240-75526',
    numeroFactura: '0000373708',
    fecha: '2026-09-27',
    total: 12.49,
    itbms: 0,
    ...(over.factura || {}),
  },
  texto: 'Factura RIBA SMITH',
  items: ['GUINEO', 'NARANJA DE JUGO'],
  clienteRuc: '1555-1234-5678',
  clienteNombre: 'Empresa Demo',
  ...over,
});

const CFG = { companyId: 'c1', cuentaPagoId: 'acc-banco', metodoPago: 'TRANSFERENCIA', conceptoDefaultId: null };
const CORREO = { mensajeId: 'fila-1' };

beforeEach(() => {
  estado.instancias = [];
  estado.proceso = CONFIRMADO_OK;
  estado.confirmaciones = 0;
  estado.confirmado = { journalEntry: { id: 'je-1' } };
});

describe('cargarFacturaDesdeCorreo — el camino feliz', () => {
  it('crea el asiento BORRADOR, archiva la factura y consume la cuota', async () => {
    const { prisma, llamadas } = prismaFalso();

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('CARGADA');
    expect(r.journalEntryId).toBe('je-1');
    expect(r.claimId).toBe('claim-1');
    expect(llamadas.cuota).toBe(1);
    expect(llamadas.claims[0]).toMatchObject({ companyId: 'c1', workerId: null, origen: 'CORREO', emailMensajeId: 'fila-1' });
    expect(llamadas.borrados).toEqual([]);
  });

  it('el asiento sale con la cuenta configurada y el método impuesto', async () => {
    const { prisma } = prismaFalso();

    await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(estado.instancias).toHaveLength(1);
    expect(estado.instancias[0].cuentaPagoForzada).toEqual({ id: 'acc-banco', name: 'Banco General' });
    expect(estado.instancias[0].paymentMethodForzado).toBe('TRANSFERENCIA');
  });
});

describe('cargarFacturaDesdeCorreo — lo que NO llega al motor', () => {
  it('una factura ya archivada es DUPLICADA y no gasta LLM', async () => {
    const { prisma, llamadas } = prismaFalso({ duplicados: [{ id: 'claim-viejo', workerId: null, status: 'PENDIENTE', createdAt: new Date() }] });

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('DUPLICADA');
    expect(estado.instancias).toHaveLength(0); // ni se construyó el orquestador
    expect(llamadas.cuota).toBe(0);
  });

  it('una factura de otro cliente es OTRO_CLIENTE y no se carga', async () => {
    const { prisma } = prismaFalso();

    // El caso real: la factura está a nombre de una persona (RUC 794485) y la
    // empresa es otra. Cargarla sería meter el gasto de alguien más en el libro.
    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA({ clienteRuc: '794485', clienteNombre: 'Leonel Rodriguez' }), CORREO);

    expect(r.estado).toBe('OTRO_CLIENTE');
    expect(r.detalle).toContain('Leonel Rodriguez');
    expect(estado.instancias).toHaveLength(0);
  });

  it('sin cuenta de contrapartida no se carga nada', async () => {
    const { prisma } = prismaFalso({ banco: null });

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('SIN_CUENTA');
    expect(estado.instancias).toHaveLength(0);
  });

  it('sin cuota en el plan no se carga, pero tampoco se pierde (el barrido la conserva)', async () => {
    const { prisma, llamadas } = prismaFalso({ sub: { id: 'sub-1', movementsUsed: 100, movementsLimit: 100 } });

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('CUOTA');
    expect(llamadas.claims).toHaveLength(0);
    expect(estado.instancias).toHaveLength(0);
  });
});

describe('cargarFacturaDesdeCorreo — el receptor', () => {
  it('sin RUC en la factura se sigue: no hay con qué comparar', async () => {
    const { prisma } = prismaFalso();
    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA({ clienteRuc: null, clienteNombre: null }), CORREO);
    expect(r.estado).toBe('CARGADA');
  });

  it('si la empresa no tiene RUC cargado tampoco se descarta', async () => {
    const { prisma } = prismaFalso({ company: { name: 'Empresa Demo', taxId: null } });
    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA({ clienteRuc: '794485' }), CORREO);
    expect(r.estado).toBe('CARGADA');
  });

  it('el mismo RUC con o sin guiones es la misma empresa', async () => {
    const { prisma } = prismaFalso({ company: { name: 'Empresa Demo', taxId: '155512345678' } });
    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA({ clienteRuc: '1555-1234-5678' }), CORREO);
    expect(r.estado).toBe('CARGADA');
  });

  it('un RUC de pocos dígitos no matchea la cola del RUC de la empresa', async () => {
    const { prisma } = prismaFalso({ company: { name: 'Empresa Demo', taxId: '1555-1234-5678' } });
    // «78» está al final de 155512345678: sin el mínimo de dígitos, entraría.
    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA({ clienteRuc: '78', clienteNombre: 'Otro' }), CORREO);
    expect(r.estado).toBe('OTRO_CLIENTE');
  });
});

describe('cargarFacturaDesdeCorreo — cuando el motor necesita preguntar', () => {
  it('sin poder clasificar el concepto NO se confirma nada', async () => {
    const { prisma, llamadas } = prismaFalso();
    estado.proceso = { plan: {}, needsConfirmation: false, prompt: 'No reconozco el concepto "Varios". ¿Podrías clasificarlo?' };

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('SIN_CONCEPTO');
    expect(r.detalle).toContain('No reconozco el concepto');
    expect(estado.confirmaciones).toBe(0); // nunca se confirma a ciegas
    expect(llamadas.claims).toHaveLength(0);
  });

  it('un prompt que no es del concepto queda como SIN_DATOS', async () => {
    const { prisma } = prismaFalso();
    estado.proceso = { plan: {}, needsConfirmation: false, prompt: '¿Cuál es el monto de la compra?' };

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('SIN_DATOS');
  });
});

describe('cargarFacturaDesdeCorreo — carrera con otro canal', () => {
  it('si la factura ya estaba archivada, el asiento recién creado se borra', async () => {
    const { prisma, llamadas } = prismaFalso({
      // El primer dedupe no la ve; el segundo (después de confirmar) sí: otro
      // canal la archivó en el medio.
      duplicados: [null, { id: 'claim-otro', workerId: null, status: 'PENDIENTE', createdAt: new Date(), worker: null }],
    });

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('DUPLICADA');
    expect(r.journalEntryId).toBeNull();
    // El asiento fantasma no queda: transacciones → líneas → asiento.
    expect(llamadas.borrados).toEqual(['transaction', 'journalLine', 'journalEntry']);
    expect(llamadas.cuota).toBe(0); // y no consume cuota por algo que no cargó
  });
});

describe('cargarFacturaDesdeCorreo — nunca lanza', () => {
  it('un error inesperado se devuelve como estado, no como excepción', async () => {
    const { prisma } = prismaFalso();
    prisma.company.findUnique = async () => {
      throw new Error('la BD se cayó');
    };

    const r = await cargarFacturaDesdeCorreo(prisma, CFG, FACTURA(), CORREO);

    expect(r.estado).toBe('ERROR');
    expect(r.detalle).toContain('la BD se cayó');
  });
});
