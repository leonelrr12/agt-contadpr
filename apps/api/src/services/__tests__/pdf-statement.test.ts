import { describe, it, expect } from 'vitest';
import { filasDeTextoDeExtracto, validarCadenaDeSaldos } from '../pdf-statement';
import { parseImportFile, debitCreditDeFila } from '../csv-parser';

/**
 * Extracto de tarjeta en PDF (Banco General, VISA PYME ****1798, julio 2026).
 *
 * El texto es el que devuelve pdf-parse del estado real: una fila por línea,
 * fecha al inicio, categoría y monto con signo al final. Los cargos van en
 * negativo y los pagos en positivo; `debitCreditDeFila` los convierte al par
 * débito/crédito que compara el conciliador (cargo → crédito al pasivo).
 *
 * Los nombres y montos de esta prueba son inventados; el archivo real no se
 * versiona.
 */
const TEXTO_ESTADO = [
  '23-oct-2026 • 06:22 PM',
  'VISA PEQUEÑA Y MEDIANA EMPRESA B',
  '**** 1798 VISA PYME Límite total de la tarjeta: $4,830.00',
  'Estado de cuenta con fecha de corte el 30-sep-2026',
  'Deuda anterior Compras y cargos Pagos Deuda al corte Pago mínimo Fecha de pago',
  '$12.09 -$3,779.44 $3,399.67 $391.86 $25 28-ago-2026',
  'Cargos y Pagos',
  'Fecha Descripción Categoría Monto',
  '21-jul-2026 GRACIAS POR SU PAGO - BEL/ATM Pagos $3,399.67',
  '31-jul-2026 FINANCIAMIENTO Cargos -$12.23',
  '31-jul-2026 ITBMS CARGO POR SEGURO Cargos -$0.18',
  '31-jul-2026 SEGURO DE FRAUDE MENSUAL Cargos -$3.50',
  'Cargos: -$15.91\tPagos: $3,399.67',
  'Movimientos TITULAR DE PRUEBA ****',
  'Fecha Descripción Categoría Monto',
  '02-jul-2026 COMERCIO DE PRUEBA UNO Viajes -$97.00',
  '07-jul-2026 COMERCIO DE PRUEBA DOS Tiendas y almacenes -$192.35',
  '15-jul-2026 TRANSFERENCIA ACH 1,000.00 1,250.00',
  '16-jul-2026 NOTA DEBITO (25.00)',
  'Compras: -$3,763.53',
  'Plan de crédito Monto adeudado Tasa nominal Tasa efectiva Interés cobrado',
  'Compras $391.86 12.00% 12.68% $12.23',
  'Página 1 de 2',
].join('\n');

describe('filasDeTextoDeExtracto — texto del estado de tarjeta', () => {
  it('lee solo las líneas con fecha al inicio e importe al final', () => {
    const filas = filasDeTextoDeExtracto(TEXTO_ESTADO);

    expect(filas.map(f => f.fecha)).toEqual([
      '21-jul-2026', '31-jul-2026', '31-jul-2026', '31-jul-2026',
      '02-jul-2026', '07-jul-2026', '15-jul-2026', '16-jul-2026',
    ]);
    expect(filas[0]).toMatchObject({ descripcion: 'GRACIAS POR SU PAGO - BEL/ATM Pagos', monto: '$3,399.67' });
    expect(filas[1]).toMatchObject({ descripcion: 'FINANCIAMIENTO Cargos', monto: '-$12.23' });
  });

  it('descarta encabezados, totales, sellos de hora y pies de página', () => {
    const textos = filasDeTextoDeExtracto(TEXTO_ESTADO).map(f => f.descripcion);
    expect(textos.join(' | ')).not.toMatch(/Cargos:|Compras:|Página|Deuda anterior/);
    expect(filasDeTextoDeExtracto(TEXTO_ESTADO)).toHaveLength(8);
  });

  it('con varias columnas toma el débito como salida y el crédito como entrada', () => {
    const fila = filasDeTextoDeExtracto('15-jul-2026 TRANSFERENCIA ACH 1,000.00 1,250.00')[0];
    expect(fila.monto).toBe('1,000.00');
    expect(fila.saldo).toBe('1,250.00');

    // Débito Crédito Saldo: débito con monto = salida (negativo).
    const salida = filasDeTextoDeExtracto('17-jul-2026 COMPRA 1,000.00 0.00 250.00')[0];
    expect(salida.monto).toBe('-1,000.00');
    expect(salida.saldo).toBe('250.00');

    // Columna de débito vacía (`0.00`) y crédito con el movimiento = entrada.
    const entrada = filasDeTextoDeExtracto('16-jul-2026 DEPOSITO 0.00 500.00 1,750.00')[0];
    expect(entrada.monto).toBe('500.00');
    expect(entrada.saldo).toBe('1,750.00');
  });

  it('normaliza el negativo entre paréntesis', () => {
    expect(filasDeTextoDeExtracto('16-jul-2026 NOTA DEBITO (25.00)')[0].monto).toBe('-25.00');
  });
});

describe('filasDeTextoDeExtracto — texto del estado de ahorro', () => {
  /**
   * El estado de ahorro de Banco General trae `Monto Saldo` al final y las
   * descripciones largas partidas en dos líneas, con la línea de importes sola.
   * El número de cuenta (`04-73-00-002810-1`) parece una fecha y no lo es.
   */
  const TEXTO_AHORRO = [
    '23-oct-2026 06:20 PM',
    'CUENTA DE AHORROS',
    '04-73-00-002810-1',
    'Titular: EMPRESA DE PRUEBA, S.A.',
    'Saldo total: $1,303.00',
    'Disponible: $1,303.00',
    'Movimientos entre 01-jun-2026 y 30-sep-2026',
    'Fecha Saldo total\tMonto\tDescripción',
    '01-jun-2026 TRANSFERENCIA DE PRUEBA SERVICIOS GENERALES PRUEBA,',
    'S.A. por pago WS',
    '$1,000.00 $1,500.00',
    '03-jun-2026 PAGO PROVEEDOR UNO -$150.00 $1,350.00',
    'Pag. 1 de 2',
    '23-oct-2026 06:20 PM',
    '04-jun-2026 PAGO PROVEEDOR DOS -$50.00 $1,300.00',
    '05-jun-2026 INTERES CUENTA DE AHORROS $3.00 $1,303.00',
    'Pag. 2 de 2',
  ].join('\n');

  it('junta la descripción partida y lee monto + saldo', () => {
    const filas = filasDeTextoDeExtracto(TEXTO_AHORRO);

    expect(filas.map(f => f.fecha)).toEqual(['01-jun-2026', '03-jun-2026', '04-jun-2026', '05-jun-2026']);
    expect(filas[0]).toEqual({
      fecha: '01-jun-2026',
      descripcion: 'TRANSFERENCIA DE PRUEBA SERVICIOS GENERALES PRUEBA, S.A. por pago WS',
      monto: '$1,000.00',
      saldo: '$1,500.00',
    });
    expect(filas[1]).toMatchObject({ monto: '-$150.00', saldo: '$1,350.00' });
    expect(filas[3]).toMatchObject({ monto: '$3.00', saldo: '$1,303.00' });
  });

  it('la cadena de saldos cierra en todas las filas (orden ascendente)', () => {
    expect(validarCadenaDeSaldos(filasDeTextoDeExtracto(TEXTO_AHORRO)))
      .toEqual({ comprobados: 3, orden: 'asc', advertencia: null });
  });

  it('la cadena también cierra si el estado viene en orden DESCENDENTE', () => {
    // El extracto de la cuenta corriente de Banco General viene del más nuevo
    // al más viejo: la relación usa el monto de la fila ANTERIOR, no la actual.
    const filas = [
      { fecha: '10-jun-2026', monto: '-$50.00', saldo: '$1,300.00' },
      { fecha: '09-jun-2026', monto: '-$150.00', saldo: '$1,350.00' },
      { fecha: '08-jun-2026', monto: '$1,000.00', saldo: '$1,500.00' },
    ];
    expect(validarCadenaDeSaldos(filas)).toEqual({ comprobados: 2, orden: 'desc', advertencia: null });
  });

  it('el número de cuenta no se toma como fecha', () => {
    expect(filasDeTextoDeExtracto('04-73-00-002810-1')).toEqual([]);
    expect(filasDeTextoDeExtracto('23-oct-2026')).toEqual([]);
  });

  it('una fila que falta deja advertencia, NO un error que bloquee la carga', () => {
    const filas = [
      { fecha: '01-jun-2026', monto: '-$10.00', saldo: '$100.00' },
      // Falta la fila que dejaba el saldo en $95.00.
      { fecha: '02-jun-2026', monto: '-$5.00', saldo: '$90.00' },
      { fecha: '03-jun-2026', monto: '-$7.00', saldo: '$83.00' },
    ];
    const r = validarCadenaDeSaldos(filas);
    expect(r.comprobados).toBeLessThan(2);
    expect(r.advertencia).toMatch(/cadena de saldos no cierra/i);
  });

  it('un movimiento sin importes es un parseo incompleto, no una fila a saltear', () => {
    expect(() => filasDeTextoDeExtracto([
      '01-jun-2026 MOVIMIENTO SIN IMPORTES',
      '02-jun-2026 OTRO MOVIMIENTO -$1.00 $9.00',
    ].join('\n'))).toThrow(/No se pudo leer completo el movimiento del 01-jun-2026/i);
  });
});

describe('parseImportFile — PDF de extracto', () => {
  it('mapea el PDF al mismo débito/crédito que un CSV del banco', async () => {
    const { default: PDFDocument } = await import('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const listo = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
    doc.fontSize(8);
    for (const linea of [TEXTO_ESTADO]) doc.text(linea);
    doc.end();

    const parsed = await parseImportFile(await listo, 'ESTADO.pdf');

    expect(parsed.rows).toHaveLength(8);
    const pago = parsed.rows[0];
    const compra = parsed.rows[1];
    expect(pago.date).toBe('2026-07-21');
    expect(debitCreditDeFila(pago)).toEqual({ debit: 0, credit: 3399.67 });
    expect(debitCreditDeFila(compra)).toEqual({ debit: 12.23, credit: 0 });
    // El saldo de las líneas de dos importes queda disponible pero no se
    // confunde con el movimiento.
    const transferencia = parsed.rows.find(r => r.description?.startsWith('TRANSFERENCIA'));
    expect(transferencia?.amount).toBe(1000);
    expect(transferencia?.balance).toBe(1250);
  }, 20000);

  it('un PDF con la cadena de saldos rota se carga igual y devuelve la advertencia', async () => {
    const { default: PDFDocument } = await import('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const listo = new Promise<Buffer>(resolve => doc.on('end', () => resolve(Buffer.concat(chunks))));
    doc.fontSize(8).text([
      '23-oct-2026 06:20 PM',
      'CUENTA DE AHORROS',
      '01-jun-2026 PAGO UNO -$10.00 $100.00',
      '02-jun-2026 PAGO DOS -$5.00 $90.00',
      '03-jun-2026 PAGO TRES -$7.00 $83.00',
    ].join('\n'));
    doc.end();

    const parsed = await parseImportFile(await listo, 'ROTO.pdf');

    expect(parsed.rows).toHaveLength(3);
    expect(parsed.warnings).toHaveLength(1);
    expect(parsed.warnings?.[0]).toMatch(/cadena de saldos no cierra/i);
  }, 20000);
});
