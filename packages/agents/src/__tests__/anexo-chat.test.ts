import { describe, it, expect } from 'vitest';
import { OrchestratorAgent } from '../orchestrator-agent';

/**
 * Regresión: el chat no validaba el flag "Lleva Anexo" de la cuenta. El
 * import sí lo hacía, así que "Compré combustible por $56 banco" creaba el
 * asiento en Gastos de Combustible (6.01.15, requiresAnexo) sin pedir
 * RUC/Cédula ni Nombre.
 */

const CUENTAS = [
  { id: 'acc-caja', code: '1.1.01', aliases: ['caja'], name: 'Caja', type: 'ACTIVO', isActive: true, requiresAnexo: false },
  { id: 'acc-banco', code: '1.1.02.03', aliases: [], name: 'Banco de Panama', type: 'ACTIVO', isActive: true, requiresAnexo: false },
  { id: 'acc-clientes', code: '1.1.03.01', aliases: ['clientes'], name: 'Cuentas por Cobrar Clientes', type: 'ACTIVO', isActive: true, requiresAnexo: false },
  { id: 'acc-proveedores', code: '2.1.01', aliases: ['proveedores'], name: 'Proveedores', type: 'PASIVO', isActive: true, requiresAnexo: false },
  { id: 'acc-combustible', code: '6.01.15', aliases: [], name: 'Gastos de Combustible', type: 'GASTO', isActive: true, requiresAnexo: true },
];

function makeOrchestrator() {
  const prisma: any = {
    account: {
      findMany: async (args: any = {}) => {
        let out = CUENTAS;
        const code = args?.where?.code;
        if (code?.startsWith) out = out.filter((c) => c.code.startsWith(code.startsWith));
        const ids = args?.where?.id?.in;
        if (ids) out = out.filter((c) => ids.includes(c.id));
        const id = args?.where?.id;
        if (typeof id === 'string') out = out.filter((c) => c.id === id);
        return out;
      },
      findFirst: async (args: any) => {
        const w = args?.where || {};
        return CUENTAS.find((c) => (w.id ? c.id === w.id : true)) || null;
      },
    },
    company: { findUnique: async () => ({ declaraITBMS: true, bancoDefaultId: 'acc-banco' }) },
    concept: {
      findMany: async () => [{
        name: 'Combustible',
        accountId: 'acc-combustible',
        confidence: 0.95,
        account: { id: 'acc-combustible', code: '6.01.15', name: 'Gastos de Combustible', type: 'GASTO' },
      }],
    },
    client: { findMany: async () => [], findFirst: async () => null },
    supplier: { findMany: async () => [], findFirst: async () => null },
  };
  return new OrchestratorAgent({ prisma, companyId: 'demo-company', userId: 'demo-user' });
}

describe('Anexo DGI en el chat', () => {
  it('no genera el asiento si la cuenta requiere Anexo y faltan RUC/Nombre', async () => {
    const r = await makeOrchestrator().process('Compré combustible por $56 banco');
    expect(r.needsConfirmation).toBe(false);
    expect(r.prompt).toContain('Anexo DGI');
    expect(r.prompt).toContain('RUC/Cédula');
    expect(r.prompt).toContain('Nombre');
    expect(r.result).toBeUndefined();
    // El chat usa esto para dejar la instrucción original en la caja.
    expect(r.prefill).toBe('Compré combustible por $56 banco');
  });

  it('continúa con el asiento cuando el follow-up trae RUC y Nombre', async () => {
    const agent = makeOrchestrator();
    const previo = await agent.process('Compré combustible por $56 banco');
    const r = await agent.process(
      'RUC 8-123-456, Proveedor Distribuidora XYZ',
      { messages: [], extractedData: previo.plan.dialog },
    );
    expect(r.needsConfirmation).toBe(true);
    expect(r.prompt).toContain('Combustible');
    expect(r.prompt).toContain('Crédito: Banco de Panama');
    const entry = (r.result as any).entry;
    expect(entry.debit[0].accountId).toBe('acc-combustible');
    expect(entry.credit[0].accountId).toBe('acc-banco');
    expect((r.result as any).dialog.ruc).toBe('8-123-456');
    expect((r.result as any).dialog.provider).toBe('Distribuidora XYZ');
    expect((r.result as any).entry.description).toContain('Compré combustible');
  });

  it('a crédito también exige Nº de factura', async () => {
    const agent = makeOrchestrator();
    const previo = await agent.process('Compré combustible por $56 a crédito');
    expect(previo.needsConfirmation).toBe(false);
    expect(previo.prompt).toContain('Nº de factura');

    const r = await agent.process(
      'RUC 8-123-456, Proveedor Distribuidora XYZ, Factura A-000123',
      { messages: [], extractedData: previo.plan.dialog },
    );
    expect(r.needsConfirmation).toBe(true);
    expect((r.result as any).dialog.invoiceNumber).toBe('A-000123');
    expect((r.result as any).entry.credit[0].accountId).toBe('acc-proveedores');
  });

  it('un registro NUEVO no hereda RUC/Nombre/factura del Anexo anterior', async () => {
    const agent = makeOrchestrator();
    const previo = await agent.process('Compré combustible por $56 banco');
    // Contexto con los datos de Anexo ya cargados de otra compra.
    const contexto = { ...previo.plan.dialog, ruc: '8-999-999', provider: 'Proveedor Viejo', invoiceNumber: 'A-999' };

    const r = await agent.process('Compré combustible por $60 banco', {
      messages: [],
      extractedData: contexto,
    });

    expect(r.needsConfirmation).toBe(false);
    expect(r.prompt).toContain('Anexo DGI');
    expect((r.plan.dialog as any).ruc).toBeNull();
    expect((r.plan.dialog as any).provider).toBeNull();
    expect((r.plan.dialog as any).invoiceNumber).toBeNull();
    expect(r.prefill).toBe('Compré combustible por $60 banco');
  });
});
