import { describe, it, expect } from 'vitest';
import { parseRosterFile, normalizarTipoPago } from '../payroll-roster';

/**
 * El alta masiva de empleados. Lo que se fija acá son las dos reglas que el archivo
 * tiene que respetar para que nadie cargue un sueldo equivocado:
 *
 *  · **El SUELDO del archivo es el salario base MENSUAL** y se guarda tal cual. No se
 *    multiplica ni se divide por nada: el archivo dice el sueldo del contrato.
 *  · **El TIPO DE PAGO sale de la columna de la fila**; una celda vacía es quincenal,
 *    y si el archivo no trae la columna manda el selector de la pantalla.
 *
 * El tipo de pago NO toca el sueldo —solo dice cómo se parte ese mensual al pagarlo—,
 * así que una fila semanal de 1.000 y una mensual de 1.000 valen lo mismo al año.
 */

const csv = (lineas: string[]) => Buffer.from(lineas.join('\n'), 'utf-8');

describe('normalizarTipoPago', () => {
  it('reconoce las formas en que aparece escrita la columna', () => {
    expect(normalizarTipoPago('SEMANAL')).toBe('SEMANAL');
    expect(normalizarTipoPago('semanal')).toBe('SEMANAL');
    expect(normalizarTipoPago(' Semana ')).toBe('SEMANAL');
    expect(normalizarTipoPago('S')).toBe('SEMANAL');
    expect(normalizarTipoPago('quincenal')).toBe('QUINCENAL');
    expect(normalizarTipoPago('QUINCENA')).toBe('QUINCENAL');
    expect(normalizarTipoPago('Q')).toBe('QUINCENAL');
    expect(normalizarTipoPago('Mensual')).toBe('MENSUAL');
    expect(normalizarTipoPago('MENSUALES')).toBe('MENSUAL');
    expect(normalizarTipoPago('M')).toBe('MENSUAL');
  });

  it('no adivina: lo que no reconoce devuelve null, y el vacío también', () => {
    expect(normalizarTipoPago('catorcenal')).toBeNull();
    expect(normalizarTipoPago('')).toBeNull();
    expect(normalizarTipoPago(undefined)).toBeNull();
    expect(normalizarTipoPago('QQ')).toBeNull();
  });
});

describe('alta masiva: el sueldo es el mensual y el tipo de pago va por fila', () => {
  const ARCHIVO_MIXTO = csv([
    'NOMBRE,CEDULA,CARGO,NSS,TIPO DE PAGO,SUELDO',
    'Ana Semanal,8-111-111,Vendedora,123456,SEMANAL,1000',
    'Beto Quincenal,8-222-222,Chofer,234567,QUINCENAL,900',
    'Carla Mensual,8-333-333,Gerente,345678,MENSUAL,1500',
    'Dora Sin Dato,8-444-444,Auxiliar,456789,,600',
  ]);

  it('guarda el sueldo del archivo tal cual: ya es el mensual', async () => {
    const r = await parseRosterFile(ARCHIVO_MIXTO, 'planilla.csv', 'QUINCENAL');
    const porNombre = new Map(r.rows.map((f) => [f.nombre, f]));

    // El tipo de pago NO multiplica ni divide: los tres valen lo que dice el archivo.
    expect(porNombre.get('Ana Semanal')!.sueldoBase).toBe(1000);
    expect(porNombre.get('Beto Quincenal')!.sueldoBase).toBe(900);
    expect(porNombre.get('Carla Mensual')!.sueldoBase).toBe(1500);
  });

  it('el tipo de pago se lee de la columna de CADA fila', async () => {
    const r = await parseRosterFile(ARCHIVO_MIXTO, 'planilla.csv', 'QUINCENAL');
    const porNombre = new Map(r.rows.map((f) => [f.nombre, f]));

    expect(porNombre.get('Ana Semanal')!.tipoPago).toBe('SEMANAL');
    expect(porNombre.get('Ana Semanal')!.tipoPagoFuente).toBe('ARCHIVO');
    expect(porNombre.get('Beto Quincenal')!.tipoPago).toBe('QUINCENAL');
    expect(porNombre.get('Carla Mensual')!.tipoPago).toBe('MENSUAL');
  });

  it('una celda VACÍA es quincenal, y se ve que vino del defecto', async () => {
    const r = await parseRosterFile(ARCHIVO_MIXTO, 'planilla.csv', 'SEMANAL');
    const dora = r.rows.find((f) => f.nombre === 'Dora Sin Dato')!;

    expect(dora.tipoPago).toBe('QUINCENAL');
    expect(dora.tipoPagoFuente).toBe('DEFECTO');
    expect(dora.sueldoBase).toBe(600); // el sueldo no depende del tipo de pago
  });

  it('la celda manda sobre el selector de la pantalla', async () => {
    const r = await parseRosterFile(ARCHIVO_MIXTO, 'planilla.csv', 'MENSUAL');
    expect(r.rows.find((f) => f.nombre === 'Ana Semanal')!.tipoPago).toBe('SEMANAL');
    expect(r.rows.find((f) => f.nombre === 'Beto Quincenal')!.tipoPago).toBe('QUINCENAL');
  });

  it('un tipo de pago que no se reconoce REPORTA la fila en vez de adivinar', async () => {
    const archivo = csv(['NOMBRE,CEDULA,TIPO DE PAGO,SUELDO', 'Elena Rara,8-555-555,catorcenal,700']);
    const r = await parseRosterFile(archivo, 'planilla.csv', 'QUINCENAL');
    expect(r.rows[0].parseError).toMatch(/no reconocido/i);
    expect(r.rows[0].sueldoBase).toBe(0);
  });

  it('sin la columna, el tipo de pago lo pone el selector (el sueldo no cambia)', async () => {
    const archivo = csv(['NOMBRE,CEDULA,SUELDO', 'Fito Viejo,8-666-666,450']);

    const quincenal = await parseRosterFile(archivo, 'planilla.csv', 'QUINCENAL');
    expect(quincenal.rows[0].tipoPago).toBe('QUINCENAL');
    expect(quincenal.rows[0].sueldoBase).toBe(450);

    const semanal = await parseRosterFile(archivo, 'planilla.csv', 'SEMANAL');
    expect(semanal.rows[0].tipoPago).toBe('SEMANAL');
    expect(semanal.rows[0].sueldoBase).toBe(450); // el mismo archivo, el mismo sueldo
  });

  it('CARGO y NSS se leen y viajan en la fila (la pantalla los muestra)', async () => {
    const r = await parseRosterFile(ARCHIVO_MIXTO, 'planilla.csv', 'QUINCENAL');
    const ana = r.rows.find((f) => f.nombre === 'Ana Semanal')!;
    expect(ana.cargo).toBe('Vendedora');
    expect(ana.nss).toBe('123456');
    expect(r.detectedColumns.tipoPago).toBe('TIPO DE PAGO');
    expect(r.detectedColumns.cargo).toBe('CARGO');
    expect(r.detectedColumns.nss).toBe('NSS');
  });
});
