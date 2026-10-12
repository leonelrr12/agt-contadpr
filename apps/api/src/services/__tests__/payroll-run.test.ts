import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { descripcionConsolidada, corridaXlsx } from '../payroll-run';

/**
 * La descripción del asiento de una corrida CONSOLIDADA (la semanal, que va en un solo
 * asiento). Es lo único que ve el contador en la cola de revisión antes de abrirla, así
 * que lo que dice importa: con un solo empleado tiene que decir SU nombre —"1 empleado"
 * obligaba a abrir la corrida para saber a quién se le estaba aprobando el asiento—, y
 * con varios el conteo, porque treinta nombres no se leen.
 */
describe('descripcionConsolidada', () => {
  const uno = [{ nombre: 'ALBRYND CASTILLO' }];
  const varios = [{ nombre: 'ALBRYND CASTILLO' }, { nombre: 'OTRO EMPLEADO' }];

  it('con UN empleado usa su nombre', () => {
    expect(descripcionConsolidada('SUELDO', uno, '2026-09-S1')).toBe('Planilla de ALBRYND CASTILLO — 2026-09-S1');
  });

  it('con varios cuenta los empleados', () => {
    expect(descripcionConsolidada('SUELDO', varios, '2026-09-S1')).toBe('Planilla de 2 empleados — 2026-09-S1');
  });

  it('nombra la prestación cuando no es sueldo', () => {
    expect(descripcionConsolidada('DECIMO', uno, '2026')).toBe('Décimo III de ALBRYND CASTILLO — 2026');
    expect(descripcionConsolidada('VACACIONES', varios, '2026-06')).toBe('Vacaciones de 2 empleados — 2026-06');
  });

  it('una corrida sin ítems no rompe la descripción', () => {
    expect(descripcionConsolidada('SUELDO', [], '2026-09-S1')).toBe('Planilla de 0 empleados — 2026-09-S1');
  });
});

/**
 * El listado de cálculos en Excel (`GET /corridas/:id/export.xlsx`). Lo que se prueba
 * acá es lo que el contador hace CON el archivo —sumar, cruzar, ver por qué no se
 * descontó una cuota— no la aritmética del motor, que tiene sus propias pruebas.
 */
describe('corridaXlsx', () => {
  const item = (over: any = {}) => ({
    employee: { nombre: 'ALBRYND CASTILLO', cedula: '8-888-8888' },
    diasTrabajados: 15,
    sueldo: 610.4, horasExtras: 0, otrosIngresos: 0, menosSueldo: 0, bruto: 610.4,
    ss: 59.51, se: 7.63, isr: 28.1, otrasDeducciones: 50, neto: 465.16,
    ssPatronal: 80.88, sePatronal: 9.16, riesgosPatronal: 6.1,
    deducciones: [],
    ...over,
  });

  const corrida = (over: any = {}) => ({
    tipo: 'SUELDO',
    periodo: '2026-09-Q1',
    items: [item(), item({ sueldo: 400, bruto: 400, otrasDeducciones: 0, deducciones: [] })],
    ...over,
  });

  /** La hoja, como matriz de valores crudos (fila 1 = encabezado, la última = totales). */
  async function leer(run: any) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await corridaXlsx(run));
    const ws = wb.worksheets[0];
    const filas: any[][] = [];
    ws.eachRow((row) => filas.push((row.values as any[]).slice(1)));
    return { ws, filas };
  }

  it('lleva el detalle completo del cálculo, con el neto y los tres aportes del patrono', async () => {
    const { filas } = await leer(corrida());
    expect(filas[0]).toEqual([
      'Empleado', 'Cédula', 'Días', 'Sueldo', 'Horas extras', 'Otros ingresos',
      'Menos sueldo', 'Bruto', 'SS', 'SE', 'ISR', 'Otras deducciones',
      'Detalle de deducciones', 'Neto', 'SS patronal', 'SE patronal', 'Riesgos profesionales',
    ]);
    expect(filas[1].slice(0, 4)).toEqual(['ALBRYND CASTILLO', '8-888-8888', 15, 610.4]);
  });

  it('los montos van como NÚMEROS, no como el texto del CSV: Excel tiene que poder sumarlos', async () => {
    const { ws, filas } = await leer(corrida());
    const neto = filas[1][13];
    expect(typeof neto).toBe('number');
    expect(neto).toBe(465.16);
    // Y con formato de moneda, que es lo que los muestra con dos decimales.
    expect(ws.getColumn(14).numFmt).toBe('#,##0.00');
  });

  it('la columna de deducciones dice a quién y por qué no se descontó', async () => {
    const run = corrida({
      items: [
        item({
          deducciones: [
            { acreedor: 'Banco General', monto: 50 },
            { acreedor: 'Mueblería Sula', monto: 0, motivoOmitida: 'la saltaste en esta corrida' },
          ],
        }),
      ],
    });
    const { filas } = await leer(run);
    expect(filas[1][12]).toBe('Banco General 50.00 · Mueblería Sula (la saltaste en esta corrida)');
  });

  it('cierra con el total de lo impreso, no con los totales guardados de la corrida', async () => {
    // Los totales congelados de la corrida se dejan MAL a propósito: si el pie los
    // leyera de ahí en vez de sumar las filas, el archivo se contradiría solo.
    const { filas } = await leer(corrida({ totalNeto: 99999, totales: { neto: 99999 } }));
    const total = filas[filas.length - 1];
    expect(total[0]).toBe('Total');
    expect(total[3]).toBe(1010.4);          // sueldo
    expect(total[13]).toBe(930.32);         // neto (465,16 × 2)
    expect(total[16]).toBe(12.2);           // riesgos (6,10 × 2)
    expect(total[2]).toBe('');              // los días no se suman
  });

  it('un pago de décimo se lee solo: el motor ya guarda el sueldo en cero y el monto en el bruto', async () => {
    const run = corrida({
      tipo: 'DECIMO',
      periodo: '2026',
      items: [item({ sueldo: 0, horasExtras: 0, bruto: 1220.8, ss: 88.51, se: 0, isr: 0, neto: 1132.29 })],
    });
    const { filas } = await leer(run);
    expect(filas[1][3]).toBe(0);
    expect(filas[1][7]).toBe(1220.8);
    expect(filas[1][13]).toBe(1132.29);
  });

  it('una corrida sin empleados sale con encabezado y total en cero, no vacía', async () => {
    const { filas } = await leer(corrida({ items: [] }));
    expect(filas).toHaveLength(2);          // encabezado + total
    expect(filas[1][0]).toBe('Total');
    expect(filas[1][13]).toBe(0);
  });
});
