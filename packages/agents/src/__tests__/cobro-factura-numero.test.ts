import { describe, it, expect } from 'vitest';
import { OrchestratorAgent } from '../orchestrator-agent';
import { parseInput } from '../dialog-agent';

/**
 * Regresión del cobro por chat: la factura A-000003 de Hotel Panama existe,
 * pero el flujo buscaba SOLO por número exacto. El usuario escribe (o el LLM
 * devuelve) "000003", "a-000003" o "A000003" y el bot contestaba que no la
 * encontraba. Además "Hotel Panamá" (con tilde) no coincidía con el cliente
 * "Hotel Panama" de la factura.
 */

const CUENTAS = [
  { id: 'acc-caja', code: '1.1.01', aliases: ['caja'], name: 'Caja', type: 'ACTIVO', isActive: true },
  { id: 'acc-clientes', code: '1.1.03.01', aliases: ['clientes'], name: 'Clientes', type: 'ACTIVO', isActive: true },
  { id: 'acc-ret', code: '1.1.07', aliases: [], name: 'ITBMS Retenido por Terceros', type: 'ACTIVO', isActive: true },
  { id: 'acc-banco', code: '1.1.02.03', aliases: [], name: 'Banco de Panama', type: 'ACTIVO', isActive: true },
  { id: 'acc-banco-general', code: '1.1.02.01', aliases: ['banco-general'], name: 'Banco General', type: 'ACTIVO', isActive: true },
];

function factura(number: string, id = 'inv-1') {
  return {
    id,
    companyId: 'demo-company',
    number,
    total: 160.5,
    paidAmount: 0,
    itbms: 10.5,
    paymentMethod: 'CREDITO',
    date: new Date('2026-10-19T12:00:00'),
    client: {
      id: 'cli-1',
      name: 'Hotel Panama',
      taxId: '8-123-456',
      esAgenteRetenedor: false,
      porcentajeRetencionItbms: 0.5,
      vigenciaRetencionDesde: null,
      vigenciaRetencionHasta: null,
    },
  };
}

function makeOrchestrator(invoices: ReturnType<typeof factura>[], writeLog?: any) {
  const prisma: any = {
    account: {
      findMany: async (args: any = {}) => {
        const ids = args?.where?.id?.in;
        if (ids) return CUENTAS.filter((c) => ids.includes(c.id));
        const id = args?.where?.id;
        if (typeof id === 'string') return CUENTAS.filter((c) => c.id === id);
        return CUENTAS;
      },
      findFirst: async (args: any) => CUENTAS.find((c) => c.id === args?.where?.id) || null,
    },
    company: { findUnique: async () => ({ declaraITBMS: true, bancoDefaultId: 'acc-banco' }) },
    concept: { findMany: async () => [] },
    invoice: {
      findFirst: async (args: any) => {
        const where = args?.where || {};
        if (where.id) return invoices.find((i) => i.id === where.id) || null;
        const buscado = where.number?.equals;
        if (typeof buscado === 'string') {
          return invoices.find((i) => i.number.toLowerCase() === buscado.toLowerCase()) || null;
        }
        return null;
      },
      findMany: async () => invoices.map((i) => ({ id: i.id, number: i.number })),
      update: async (args: any) => ({ id: args?.where?.id, ...args?.data }),
    },
    $transaction: async (fn: any) => fn(prisma),
    journalEntry: {
      create: async (args: any) => {
        if (writeLog) writeLog.entry = args;
        return { id: 'je-1', ...args?.data };
      },
      findFirst: async () => null,
    },
    transaction: { create: async (args: any) => ({ id: 'tx-1', ...args?.data }) },
    invoicePayment: {
      create: async (args: any) => {
        if (writeLog) writeLog.payment = args;
        return { id: 'pay-1', ...args?.data };
      },
    },
    client: { update: async () => ({}) },
    retentionItbms: { create: async () => ({}) },
  };
  return new OrchestratorAgent({ prisma, companyId: 'demo-company', userId: 'demo-user' });
}

describe('cobro de factura por chat — Nº con serie y nombre con tilde', () => {  it('encuentra A-000003 cuando el usuario escribe 000003 (sin prefijo)', async () => {
    const r = await makeOrchestrator([factura('A-000003')])
      .process('Cobré la factura 000003 a Hotel Panamá por $85 en ACH');
    expect(r.needsConfirmation).toBe(true);
    expect(r.prompt).toContain('A-000003');
    expect(r.prompt).toContain('$85.00');
    expect((r.result as any)?.dialog?.facturaId).toBe('inv-1');
  });

  it('un cobro por ACH debita el banco (default de la empresa), no Caja', async () => {
    const r = await makeOrchestrator([factura('A-000003')])
      .process('Cobré la factura 000003 a Hotel Panamá por $85 en ACH');
    expect(r.prompt).toContain('Débito: Banco de Panama');
    expect(r.prompt).not.toContain('Débito: Caja');
  });

  it('si el usuario nombra el banco, usa ESE banco', async () => {
    const r = await makeOrchestrator([factura('A-000003')])
      .process('Cobré la factura 000003 a Hotel Panamá por $85 en ACH Banco General');
    expect(r.prompt).toContain('Débito: Banco General');
  });

  it('encuentra A-000003 cuando el número viene completo y en minúsculas', async () => {
    const r = await makeOrchestrator([factura('A-000003')])
      .process('Cobré la factura a-000003 a Hotel Panamá por $85 en ACH');
    expect(r.needsConfirmation).toBe(true);
    expect((r.result as any)?.dialog?.facturaId).toBe('inv-1');
  });

  it('si dos facturas comparten los dígitos, pide el número completo en vez de elegir una', async () => {
    const r = await makeOrchestrator([factura('A-000003', 'inv-a'), factura('B-000003', 'inv-b')])
      .process('Cobré la factura 000003 a Hotel Panamá por $85 en ACH');
    expect(r.needsConfirmation).toBe(false);
    expect(r.prompt).toContain('coinciden');
    expect(r.prompt).toContain('A-000003');
    expect(r.prompt).toContain('B-000003');
  });

  it('parseInput captura el Nº con prefijo de letra y el formato FE-AAAA-NNNN', () => {
    expect(parseInput('Recibí pago de Hotel Panamá por $85 factura A-000003').invoiceNumber).toBe('A-000003');
    expect(parseInput('Cobré la factura FE-2026-0001 por $85').invoiceNumber).toBe('FE-2026-0001');
    expect(parseInput('Cobré la factura 993 por $85').invoiceNumber).toBe('993');
  });

  it('al confirmar, el asiento debita el MISMO banco que mostró el preview (no Caja)', async () => {
    const log: any = {};
    const agent = makeOrchestrator([factura('A-000003')], log);
    const preview = await agent.process('Cobré la factura 000003 a Hotel Panamá por $85 en ACH');

    await agent.confirm(preview.result);

    const lines = log.entry.data.lines.create;
    expect(lines[0]).toEqual({ accountId: 'acc-banco', debit: 85, credit: 0 });
    expect(log.payment.data.accountId).toBe('acc-banco');
  });

  it('una confirmación pendiente sin cuentaCobroId también resuelve el banco', async () => {
    const log: any = {};
    const agent = makeOrchestrator([factura('A-000003')], log);
    const preview = await agent.process('Cobré la factura 000003 a Hotel Panamá por $85 en ACH');
    const legacy = { ...(preview.result as any).dialog };
    delete legacy.cuentaCobroId;
    delete legacy.cuentaCobroNombre;

    await agent.confirm({ dialog: legacy, entry: (preview.result as any).entry });

    expect(log.entry.data.lines.create[0].accountId).toBe('acc-banco');
  });
});

describe('cobro por chat — cambio de factura después de un error', () => {
  const invoices = [factura('A-000003', 'inv-3'), factura('A-000004', 'inv-4')];

  it('no arrastra la factura anterior: "Abono factura A-000004" usa A-000004', async () => {
    const agent = makeOrchestrator(invoices);
    // A-000003 tiene saldo 160.50: un abono de 200 da el error de saldo.
    const error = await agent.process('Cobré la factura A-000003 a Hotel Panamá por $200 en ACH');
    expect(error.needsConfirmation).toBe(false);
    expect(error.prompt).toContain('excede el saldo');
    expect((error.plan.dialog as any).invoiceNumber).toBe('A-000003');

    const r = await agent.process('Abono factura A-000004 por 85', {
      messages: [],
      extractedData: error.plan.dialog,
    });

    expect(r.needsConfirmation).toBe(true);
    expect(r.prompt).toContain('A-000004');
    expect((r.result as any).dialog.invoiceNumber).toBe('A-000004');
    expect((r.result as any).dialog.amount).toBe(85);
  });

  it('el mismo abono a la misma factura actualiza el monto, no lo hereda', async () => {
    const agent = makeOrchestrator(invoices);
    const error = await agent.process('Cobré la factura A-000003 a Hotel Panamá por $200 en ACH');

    const r = await agent.process('Abono factura A-000003 por 30', {
      messages: [],
      extractedData: error.plan.dialog,
    });

    expect(r.needsConfirmation).toBe(true);
    expect((r.result as any).dialog.invoiceNumber).toBe('A-000003');
    expect((r.result as any).dialog.amount).toBe(30);
  });
});
