import { describe, it, expect } from 'vitest';
import { billSaldo, filtroFacturaCredito, invoiceSaldo } from '../saldos';

describe('saldos de documentos', () => {
  it('una factura de contado no es CxC aunque el status siga PENDIENTE', () => {
    expect(invoiceSaldo({ total: 300, paidAmount: 0, status: 'PENDIENTE', paymentMethod: 'EFECTIVO' })).toBe(0);
  });

  it('una factura a crédito resta los abonos parciales', () => {
    expect(invoiceSaldo({ total: 1000, paidAmount: 200, status: 'PENDIENTE', paymentMethod: 'CREDITO' })).toBe(800);
  });

  it('pagada/rechazada siempre saldo 0', () => {
    expect(invoiceSaldo({ total: 1000, paidAmount: 200, status: 'PAGADA', paymentMethod: 'CREDITO' })).toBe(0);
    expect(invoiceSaldo({ total: 1000, paidAmount: 0, status: 'RECHAZADA', paymentMethod: 'CREDITO' })).toBe(0);
  });

  it('un Bill no tiene abonos parciales: total o pagada', () => {
    expect(billSaldo({ total: 400, status: 'PENDIENTE' })).toBe(400);
    expect(billSaldo({ total: 400, status: 'PAGADA' })).toBe(0);
    expect(billSaldo({ total: 400, status: 'RECHAZADA' })).toBe(0);
  });

  it('el filtro de CxC conserva las de crédito y excluye EFECTIVO', () => {
    expect(filtroFacturaCredito()).toEqual({
      OR: [{ paymentMethod: null }, { paymentMethod: { not: 'EFECTIVO' } }],
    });
  });
});
