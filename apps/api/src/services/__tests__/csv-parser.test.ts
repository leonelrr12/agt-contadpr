import { describe, it, expect } from 'vitest';
import { parseImportFile, parseCobrosFile, debitCreditDeFila } from '../csv-parser';

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

describe('parseImportFile — tipo detectado del Detalle', () => {  it('un verbo de pago al inicio gana sobre "servicios" (carga de honorarios)', async () => {
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

/**
 * Columna de banco/caja del archivo ("Banco/Cuenta"): el gasto/compras al
 * contado sale de esa cuenta. Un encabezado que no se reconoce deja todo al
 * banco por defecto en silencio, así que la detección se fija con tests.
 */
describe('parseImportFile — columna Banco/Cuenta', () => {
  async function mappingDe(header: string) {
    const csv = `Fecha,Detalle,Monto,${header},Estado\n01/10/2026,Compra papeleria,100.00,Banco General,Contado\n`;
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'x.csv');
    return parsed.detectedMapping;
  }

  it.each(['Cuenta', 'CUENTA', 'Banco', 'Banco/Cuenta', 'Cuenta Contable'])(
    'reconoce "%s" como columna de banco',
    async (h) => {
      const m = await mappingDe(h);
      expect(m.bankCol).toBe(h);
      expect(m.stateCol).toBe('Estado');
    },
  );

  it.each(['Cta. Banco', 'N° Cuenta', 'No. Cuenta'])(
    'no confunde "%s" (nº de cuenta o abreviatura) con la cuenta de banco',
    async (h) => {
      expect((await mappingDe(h)).bankCol).toBeNull();
    },
  );

  it('el valor de la celda llega crudo a la fila para resolverlo contra el catálogo', async () => {
    const csv = 'Fecha,Detalle,Monto,Cuenta,Estado\n01/10/2026,Compra papeleria,100.00,1.1.02.01 Banco General,Contado\n';
    const parsed = await parseImportFile(Buffer.from(csv, 'utf8'), 'x.csv');
    expect(parsed.rows[0].bankName).toBe('1.1.02.01 Banco General');
    expect(parsed.rows[0].state).toBe('Contado');
  });
});

/**
 * Extracto bancario del Banco General (11-10). Dos cosas lo dejaban inservible:
 * la fecha con el mes en letras ("01-ene-2026") no se reconocía y TODAS las
 * filas se caían al guardar, y el monto venía en una sola columna con signo
 * ("- $ 10,00" = sale de la cuenta) sin columnas de débito/crédito, así que el
 * conciliador no tenía contra qué comparar.
 */
describe('parseImportFile — extracto del banco: fecha en letras y monto con signo', () => {
  const EXTRACTO = [
    ',Fecha,Referencia,Descripción,Monto,Saldo total',
    ',01-ene-2026,1,YAPPY BG A KARLA ISABEL ROMERO GOMEZ," - $ 10,00","$ 55.039,36"',
    ',02-ene-2026,1,YAPPY BG A ANIBAL ENRIQUE BARRIA DE LA CRUZ," - $ 22,00","$ 54.997,36"',
    ',15-sep-2026,2,DEPOSITO CLIENTE ACME,"$ 1.500,00","$ 56.497,36"',
  ].join('\n');

  const parsear = () => parseImportFile(Buffer.from(EXTRACTO, 'utf8'), 'ENERO.csv');

  it('lee las fechas con el mes en letras', async () => {
    const { rows } = await parsear();
    expect(rows.map(r => r.date)).toEqual(['2026-01-01', '2026-01-02', '2026-09-15']);
  });

  it('el monto negativo es débito (sale del banco) y el positivo es crédito', async () => {
    const { rows } = await parsear();
    expect(rows.map(r => debitCreditDeFila(r))).toEqual([
      { debit: 10, credit: 0 },
      { debit: 22, credit: 0 },
      { debit: 0, credit: 1500 },
    ]);
  });

  it('lee el saldo y la descripción de cada fila', async () => {
    const { rows } = await parsear();
    expect(rows[0].balance).toBe(55039.36);
    expect(rows[0].description).toBe('YAPPY BG A KARLA ISABEL ROMERO GOMEZ');
    expect(rows[0].reference).toBe('1');
  });

  it('un mes que no existe no inventa fecha', async () => {
    const csv = 'Fecha,Descripción,Monto\n01-xxx-2026,Algo," - $ 5,00"\n';
    const { rows } = await parseImportFile(Buffer.from(csv, 'utf8'), 'x.csv');
    expect(rows[0].date).toBeNull();
  });

  it('con columnas de débito y crédito propias, el monto con signo no las pisa', async () => {
    const csv = 'Fecha,Descripción,Débito,Crédito\n01/03/2026,Retiro,25.00,\n';
    const { rows } = await parseImportFile(Buffer.from(csv, 'utf8'), 'x.csv');
    expect(debitCreditDeFila(rows[0])).toEqual({ debit: 25, credit: 0 });
  });
});

/**
 * Estado de tarjeta de crédito (Banco General, "Movimientos de tarjetas").
 * Tres cosas lo dejaban inservible: el preámbulo —título y número de tarjeta—
 * antes de la fila de columnas, los lados rotulados "Cargos (Db)"/"Pagos (Cr)"
 * (que no caían en ninguna columna, y "Pagos" se colaba como forma de pago) y
 * los montos en formato "$0,18".
 */
describe('parseImportFile — estado de tarjeta de crédito', () => {
  const FILAS = [
    '**** 1798\t**** 1798\t28/02/2026\t28/02/2026\tITBMS CARGO POR SEGURO\t10000000730228999949910\t$0,18\t',
    '**** 1798\t**** 1798\t28/02/2026\t28/02/2026\tSEGURO DE FRAUDE MENSUAL\t10000000730228999949910\t$3,50\t',
    '**** 1798\t**** 1798\t05/03/2026\t05/03/2026\tPAGO RECIBIDO\t10000000730228999949911\t\t$150,00',
  ];
  const TARJETA = [
    'Movimientos de tarjetas de crédito',
    '**** 1798  VISA PYME',
    '',
    'Cuenta\t"Tarjeta     "\tFecha transacción\tFecha proceso\tDescripción\tReferencia\tCargos (Db)\tPagos (Cr)',
    ...FILAS,
  ].join('\n');

  const parsear = () => parseImportFile(Buffer.from(TARJETA, 'utf8'), 'TARJETA.csv');

  it('salta el preámbulo y encuentra el encabezado', async () => {
    const { headers } = await parsear();
    expect(headers).toContain('Fecha transacción');
    expect(headers).toContain('Cargos (Db)');
  });

  it('lee los lados (Db)/(Cr) como débito y crédito, no como forma de pago', async () => {
    const { detectedMapping: m } = await parsear();
    expect(m.debitCol).toBe('Cargos (Db)');
    expect(m.creditCol).toBe('Pagos (Cr)');
    expect(m.paymentMethodCol).toBeNull();
  });

  it('lee fechas, descripción, referencia y montos en formato "$0,18"', async () => {
    const { rows } = await parsear();
    expect(rows).toHaveLength(3);
    expect(rows[0].date).toBe('2026-02-28');
    expect(rows[0].description).toBe('ITBMS CARGO POR SEGURO');
    expect(rows[0].reference).toBe('10000000730228999949910');
    expect(debitCreditDeFila(rows[0])).toEqual({ debit: 0.18, credit: 0 });
    expect(debitCreditDeFila(rows[2])).toEqual({ debit: 0, credit: 150 });
  });

  // Con la coma como separador, un monto "$3,50" solo es legible si viene
  // entrecomillado — así lo exporta el banco. Sin comillas el archivo es
  // ambiguo para cualquiera, no solo para nosotros.
  it.each([['"$3,50"', 3.5], ['3.50', 3.5]])(
    'el mismo estado separado por comas también entra (monto %s)',
    async (monto, esperado) => {
      const csv = [
        'Movimientos de tarjetas de crédito',
        '**** 1798  VISA PYME',
        'Cuenta,Tarjeta,Fecha transacción,Fecha proceso,Descripción,Referencia,Cargos (Db),Pagos (Cr)',
        `**** 1798,**** 1798,28/02/2026,28/02/2026,SEGURO DE FRAUDE MENSUAL,10000000730228999949910,${monto},`,
      ].join('\n');
      const { rows, detectedMapping: m } = await parseImportFile(Buffer.from(csv, 'utf8'), 'TARJETA.csv');
      expect(m.creditCol).toBe('Pagos (Cr)');
      expect(rows).toHaveLength(1);
      expect(debitCreditDeFila(rows[0])).toEqual({ debit: esperado, credit: 0 });
    },
  );

  it('una columna "Forma de Pago" sigue siendo el método de pago', async () => {
    const csv = 'Fecha,Detalle,Monto,Forma de Pago\n01/10/2026,Compra papeleria,100.00,Transferencia\n';
    const { detectedMapping: m, rows } = await parseImportFile(Buffer.from(csv, 'utf8'), 'x.csv');
    expect(m.paymentMethodCol).toBe('Forma de Pago');
    expect(rows[0].paymentMethod).toBe('Transferencia');
  });
});

describe('parseCobrosFile — columna del Nº de factura', () => {
  it('prefiere "Factura #" sobre "Referencia" cuando el archivo ACH trae las dos', async () => {
    const csv = [
      'Cliente,Fecha de Pago,Cuenta,Referencia,Factura #,TOTAL',
      'Hotel Panama,19/10/2026,Banco General,ACH-998877,A-000003,85.00',
    ].join('\n');
    const parsed = await parseCobrosFile(Buffer.from(csv, 'utf8'), 'pagos.csv');
    expect(parsed.rows[0].invoiceNumber).toBe('A-000003');
    expect(parsed.rows[0].accountName).toBe('Banco General');
  });

  it('si "Factura #" está vacía, usa la Referencia (no la descarta)', async () => {
    const csv = [
      'Cliente,Fecha de Pago,Cuenta,Referencia,Factura #,TOTAL',
      'Hotel Panama,19/10/2026,Banco General,ACH-998877,,85.00',
    ].join('\n');
    const parsed = await parseCobrosFile(Buffer.from(csv, 'utf8'), 'pagos.csv');
    expect(parsed.rows[0].invoiceNumber).toBe('ACH-998877');
  });
});
