import { describe, it, expect, beforeEach } from 'vitest';
import { ClassificationAgent } from '../classification-agent';
import { basePrismaStub } from './stubs';

function makePrismaStub() {
  const concepts = [
    { name: 'Combustible', accountId: 'acct-combustible', confidence: 0.95, account: { name: 'Gastos de Combustible' } },
    { name: 'Electricidad', accountId: 'acct-electricidad', confidence: 0.9, account: { name: 'Gastos de Electricidad' } },
    { name: 'Internet', accountId: 'acct-internet', confidence: 0.9, account: { name: 'Gastos de Internet' } },
  ];
  const accounts = [
    { id: 'acct-combustible', name: 'Gastos de Combustible', code: '6.01.02', type: 'GASTO', isActive: true },
    { id: 'acct-electricidad', name: 'Gastos de Electricidad', code: '6.01.03', type: 'GASTO', isActive: true },
    { id: 'acct-internet', name: 'Gastos de Internet', code: '6.01.04', type: 'GASTO', isActive: true },
    { id: 'acct-gastos-varios', name: 'Gastos Varios', code: '6.06.01', type: 'GASTO', isActive: true },
    { id: 'acct-ventas', name: 'Ventas', code: '4.01.01', type: 'INGRESO', isActive: true },
    { id: 'acct-clientes', name: 'Clientes', code: '1.1.03.01', type: 'ACTIVO', isActive: true },
    { id: 'acct-otros-ingresos', name: 'Otros Ingresos', code: '4.02', type: 'INGRESO', isActive: true },
  ];

  return {
    ...basePrismaStub(),
    concept: {
      findMany: async () => concepts,
    },
    account: {
      findMany: async () => accounts,
    },
  };
}

/** Empresa con la colisión que rompía la carga de honorarios: el concepto
 *  "Servicios" vive en una cuenta de INGRESO (4.01.02). */
function makePrismaColisionIngreso() {
  const concepts = [
    { name: 'Servicios', accountId: 'acct-servicios', confidence: 0.9, account: { type: 'INGRESO' } },
    { name: 'Servicio', accountId: 'acct-servicios', confidence: 0.9, account: { type: 'INGRESO' } },
    { name: 'Honorarios', accountId: 'acct-honorarios', confidence: 0.9, account: { type: 'GASTO' } },
    { name: 'Alquiler', accountId: 'acct-alquiler', confidence: 0.9, account: { type: 'GASTO' } },
  ];
  const accounts = [
    { id: 'acct-servicios', name: 'Ventas de Servicios', code: '4.01.02', type: 'INGRESO', isActive: true },
    { id: 'acct-honorarios', name: 'Honorarios Profesionales', code: '6.02.01', type: 'GASTO', isActive: true },
    { id: 'acct-alquiler', name: 'Alquiler', code: '6.01.08', type: 'GASTO', isActive: true },
    { id: 'acct-gastos-varios', name: 'Gastos Varios', code: '6.08.01', type: 'GASTO', isActive: true },
    { id: 'acct-ventas', name: 'Ventas', code: '4.01.01', type: 'INGRESO', isActive: true },
    { id: 'acct-clientes', name: 'Clientes', code: '1.1.03.01', type: 'ACTIVO', isActive: true },
  ];
  return {
    ...basePrismaStub(),
    concept: { findMany: async () => concepts },
    account: { findMany: async () => accounts },
  };
}

describe('ClassificationAgent', () => {
  let agent: ClassificationAgent;

  beforeEach(() => {
    agent = new ClassificationAgent({ prisma: makePrismaStub(), companyId: 'demo-company' });
  });

  it('finds exact match by concept name', async () => {
    const result = await agent.classify('Combustible');
    expect(result.concept).toBe('Combustible');
    expect(result.accountId).toBe('acct-combustible');
    expect(result.confidence).toBe(0.95);
  });

  it('finds exact match case-insensitive', async () => {
    const result = await agent.classify('combustible');
    expect(result.concept).toBe('Combustible');
    expect(result.accountId).toBe('acct-combustible');
  });

  it('finds partial match by prefix', async () => {
    const result = await agent.classify('Combustible Diesel');
    expect(result.concept).toBe('Combustible');
    expect(result.accountId).toBe('acct-combustible');
    expect(result.confidence).toBeGreaterThanOrEqual(0.85);
  });

  it('falls back to generic account based on transaction type', async () => {
    const result = await agent.classify('Consultoría de desarrollo web', 'COBRO_CLIENTE');
    expect(result.concept).toBe('Consultoría de desarrollo web');
    expect(result.accountId).toBe('acct-clientes');
    expect(result.confidence).toBe(0.5);
  });

  it('falls back to Gastos Varios for unknown GASTO', async () => {
    const result = await agent.classify('Hosting y dominio', 'GASTO');
    expect(result.accountId).toBe('acct-gastos-varios');
    expect(result.confidence).toBe(0.5);
  });

  it('returns confidence 0 when no match and no generic fallback', async () => {
    const emptyAgent = new ClassificationAgent({
      prisma: {
        concept: { findMany: async () => [] },
        account: { findMany: async () => [] },
      },
      companyId: 'demo-company',
    });
    const result = await emptyAgent.classify('Unknown Concept', 'GASTO');
    expect(result.confidence).toBe(0);
    expect(result.accountId).toBe('');
  });
});

// classifyAll (clasificación en lote del import) debe dar EXACTAMENTE lo mismo
// que classify(): el preview y la ejecución comparten motor (Anexo-DGI Fase D).
describe('ClassificationAgent.classifyAll (lote)', () => {
  it('produce el mismo resultado que classify() fila a fila', async () => {
    const agent = new ClassificationAgent({ prisma: makePrismaStub(), companyId: 'demo-company' });
    const casos: Array<{ concept: string; type?: string }> = [
      { concept: 'Combustible', type: 'GASTO' },
      { concept: 'Factura de electricidad ENSA julio', type: 'GASTO' },
      { concept: 'gasolina terpel', type: 'GASTO' },
      { concept: 'concepto que no existe', type: 'GASTO' },
      { concept: 'algo raro', type: 'INGRESO' },
      { concept: 'zzz', type: 'VENTA' },
    ];

    const prefetched = await agent.loadConcepts();
    const lote = await agent.classifyAll(casos, prefetched);
    const individual = [];
    for (const c of casos) individual.push(await agent.classify(c.concept, c.type));

    expect(lote).toEqual(individual);
  });

  it('carga los conceptos por su cuenta si no se los pasan', async () => {
    const agent = new ClassificationAgent({ prisma: makePrismaStub(), companyId: 'demo-company' });
    const [r] = await agent.classifyAll([{ concept: 'Combustible', type: 'GASTO' }]);
    expect(r.accountId).toBe('acct-combustible');
  });
});

// Un gasto/compra no puede caer en una cuenta de INGRESO (ni una venta en una
// de GASTO): el asiento quedaría debitando una cuenta de ventas.
describe('ClassificationAgent (dirección del movimiento)', () => {
  let agent: ClassificationAgent;

  beforeEach(() => {
    agent = new ClassificationAgent({ prisma: makePrismaColisionIngreso(), companyId: 'demo-company' });
  });

  it('un GASTO no cae en el concepto "Servicios" de una cuenta de ingreso', async () => {
    const r = await agent.classify('Paga Servicios profesionales', 'GASTO');
    expect(r.accountId).not.toBe('acct-servicios');
    expect(r.accountId).toBe('acct-gastos-varios'); // cuenta genérica del tipo
  });

  it('una VENTA sí usa el concepto de ingreso', async () => {
    const r = await agent.classify('Venta de servicios profesionales', 'VENTA');
    expect(r.accountId).toBe('acct-servicios');
  });

  it('una VENTA no cae en la cuenta de gasto homónima', async () => {
    const r = await agent.classify('Alquiler local comercial', 'VENTA');
    expect(r.accountId).toBe('acct-ventas'); // genérica de VENTA, no 6.01.08 Alquiler
  });

  it('sin tipo no filtra por dirección (comportamiento histórico)', async () => {
    const r = await agent.classify('Servicios profesionales');
    expect(r.accountId).toBe('acct-servicios');
    // el mismo texto que la VENTA de arriba, sin tipo: cae en la cuenta de gasto
    const sinTipo = await agent.classify('Alquiler local comercial');
    expect(sinTipo.accountId).toBe('acct-alquiler');
  });

  it('un gasto con concepto propio sigue clasificando a su cuenta', async () => {
    const r = await agent.classify('Honorarios', 'GASTO');
    expect(r.accountId).toBe('acct-honorarios');
  });

  it('classifyAll filtra igual que classify', async () => {
    const prefetched = await agent.loadConcepts();
    const [lote] = await agent.classifyAll([{ concept: 'Paga Servicios profesionales', type: 'GASTO' }], prefetched);
    const individual = await agent.classify('Paga Servicios profesionales', 'GASTO');
    expect(lote).toEqual(individual);
  });
});

// La cuenta genérica se busca por nombre y, si la empresa la nombra distinto,
// por el alias del motor contable: un cobro no puede quedar sin cuenta.
describe('ClassificationAgent (cuenta genérica por alias)', () => {
  function makePrismaSinNombreClientes() {
    const accounts = [
      { id: 'acct-cxc', name: 'Cuenta por Cobrar Clientes', code: '1.1.03.01', type: 'ACTIVO', isActive: true, aliases: ['clientes'] },
      { id: 'acct-gastos-varios', name: 'Gastos Varios', code: '6.06.01', type: 'GASTO', isActive: true, aliases: ['gasto'] },
    ];
    return {
      ...basePrismaStub(),
      concept: { findMany: async () => [] },
      account: { findMany: async () => accounts },
    };
  }

  it('un COBRO_CLIENTE cae en la cuenta con alias "clientes"', async () => {
    const agent = new ClassificationAgent({ prisma: makePrismaSinNombreClientes(), companyId: 'otra-empresa' });
    const r = await agent.classify('Recibo pago de factura 9999', 'COBRO_CLIENTE');
    expect(r.accountId).toBe('acct-cxc');
    expect(r.confidence).toBe(0.5);
  });

  it('sigue prefiriendo el nombre exacto cuando existe', async () => {
    const agent = new ClassificationAgent({ prisma: makePrismaStub(), companyId: 'demo-company' });
    const r = await agent.classify('Hosting y dominio', 'GASTO');
    expect(r.accountId).toBe('acct-gastos-varios');
  });
});
