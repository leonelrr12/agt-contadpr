import { describe, it, expect } from 'vitest';
import { processWhatsAppMessage } from '../whatsapp-service';

/**
 * El celular de un TRABAJADOR solo sirve para cargar gastos que le van a
 * reembolsar: la ayuda tiene que ofrecerle las dos formas útiles (URL/PDF o el
 * gasto escrito), no "batch" ni "saldo" de la empresa.
 */
const link = (workerAccountId: string | null) => ({
  phoneNumber: '50761234567',
  verifiedAt: new Date(),
  isActive: true,
  companyId: 'c1',
  workerAccountId,
});

const prismaCon = (workerAccountId: string | null) => ({
  whatsAppLink: { findFirst: async () => link(workerAccountId) },
});

describe('ayuda de WhatsApp', () => {
  it('HOLA de un trabajador muestra URL/PDF o el gasto escrito', async () => {
    const r = await processWhatsAppMessage(prismaCon('w1') as any, '50761234567', 'chat-hola-trabajador', 'HOLA');
    expect(r).toContain('URL de la DGI o PDF');
    expect(r).toContain('Compré almuerzo por 3.50');
    expect(r).toContain('/viaticos');
    expect(r).not.toContain('batch');
    expect(r).not.toContain('saldo');
  });

  it('HOLA de la empresa mantiene la ayuda general', async () => {
    const r = await processWhatsAppMessage(prismaCon(null) as any, '50761234567', 'chat-hola-empresa', 'HOLA');
    expect(r).toContain('batch');
    expect(r).toContain('saldo');
  });
});
