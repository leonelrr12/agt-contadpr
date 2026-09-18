import { describe, it, expect } from 'vitest';
import { parseImportFile } from '../csv-parser';

/**
 * El tipo de cada fila decide el asiento (una VENTA acredita la cuenta de
 * ingreso y deja CxC; un GASTO debita la cuenta de gasto y sale del banco).
 * Se deduce del texto: manda el CONCEPTO del archivo, y la dirección del
 * dinero (verbo de pago/cobro) manda sobre las palabras clave.
 */
async function tiposDe(
  filas: string[][],
  headers = ['Fecha', 'Detalle', 'Monto'],
): Promise<Array<string | null>> {
  const csv = [headers.join(','), ...filas.map(f => f.map(c => `"${c}"`).join(','))].join('\n');
  const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'casos.csv');
  return parsed.rows.map(r => r.type);
}

describe('parseImportFile — tipo detectado del Detalle', () => {
  it('un verbo de pago al inicio gana sobre "servicios" (carga de honorarios)', async () => {
    expect(await tiposDe([['01/09/2026', 'Paga Servicios profesionales', '500.00']])).toEqual(['GASTO']);
  });

  it.each([
    ['Pago de servicios', 'GASTO'],
    ['Pago de alquiler', 'GASTO'],
    ['Compra de mercancía', 'COMPRA'],
    ['Pago proveedor Ferretería La Ventaja', 'PAGO_PROVEEDOR'],
    // Préstamo: la cuota SALE (baja el pasivo); el desembolso es el que entra
    ['Pago de préstamo', 'PAGO_PRESTAMO'],
    ['Cuota del préstamo bancario', 'PAGO_PRESTAMO'],
    ['Préstamo recibido Banco Nacional', 'PRESTAMO'],
    // Un banco que cobra comisión es un gasto, no un cobro nuestro
    ['Cobro de comisión bancaria', 'GASTO'],
    ['Comisión por transferencia', 'GASTO'],
    ['Ferretería La Ventaja', 'GASTO'],
    // Dinero que entra: cobro de una venta a crédito (baja CxC, no es venta nueva)
    ['Recibo pago de factura No. 9999', 'COBRO_CLIENTE'],
    ['Cobro de la factura 123', 'COBRO_CLIENTE'],
    ['Abono de cliente Juan', 'COBRO_CLIENTE'],
    // "recibo/recibí" solo cuenta si habla de dinero
    ['Recibí mercancía', 'COMPRA'],
    // Señales de venta explícitas: el verbo de pago no las invierte
    ['Venta de servicios profesionales', 'VENTA'],
    ['Venta de mercancía', 'VENTA'],
  ])('"%s" → %s', async (detalle, esperado) => {
    expect(await tiposDe([['01/09/2026', detalle, '500.00']])).toEqual([esperado]);
  });
});

describe('parseImportFile — el Concepto manda sobre el Detalle', () => {
  const headers = ['Fecha', 'Detalle', 'Concepto', 'Monto'];

  it('el Concepto "Honorarios" manda aunque el Detalle diga "Paga Servicios"', async () => {
    expect(await tiposDe([['01/09/2026', 'Paga Servicios profesionales', 'Honorarios', '500.00']], headers))
      .toEqual(['GASTO']);
  });

  it('sin Concepto decide el Detalle', async () => {
    expect(await tiposDe([['01/09/2026', 'Paga Servicios profesionales', '', '500.00']], headers))
      .toEqual(['GASTO']);
  });

  it('un Concepto de venta manda aunque el Detalle diga "Paga"', async () => {
    expect(await tiposDe([['01/09/2026', 'Paga Servicios profesionales', 'Venta de servicios', '500.00']], headers))
      .toEqual(['VENTA']);
  });
});
