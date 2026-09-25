import { describe, it, expect } from 'vitest';
import { parseInventarioFile } from '../csv-parser';

/**
 * El parser de la carga inicial de inventario. Lo que fija: que reconozca las
 * columnas por su nombre, que NO adivine cuando el encabezado es ambiguo, y que una
 * fila mala se marque en vez de entrar mal cargada.
 */
const csv = (texto: string) => Buffer.from(texto, 'utf-8');

const parsear = (texto: string) => parseInventarioFile(csv(texto), 'productos.csv');

describe('carga de inventario — detección de columnas', () => {
  it('reconoce las cinco columnas por su nombre', async () => {
    const r = await parsear('SKU,Nombre,Existencia,Costo,Precio de Venta\nCEM-50,Cemento,10,4.5,7.99\n');
    expect(r.cuentas).toMatchObject({ sku: 'SKU', nombre: 'Nombre', cantidad: 'Existencia', costo: 'Costo', precio: 'Precio de Venta' });
    expect(r.rows[0]).toMatchObject({ sku: 'CEM-50', nombre: 'Cemento', cantidad: 10, costoUnitario: 4.5, precioVenta: 7.99 });
  });

  it('acepta encabezados en inglés y variantes', async () => {
    const r = await parsear('Code,Product,Qty,Cost,PVP\nA1,Arena,3,10,15\n');
    expect(r.rows[0]).toMatchObject({ sku: 'A1', nombre: 'Arena', cantidad: 3, costoUnitario: 10, precioVenta: 15 });
  });

  it('SKU y Precio de Venta son opcionales', async () => {
    const r = await parsear('Producto,Cantidad,Costo\nClavos,100,0.05\n');
    expect(r.rows[0]).toMatchObject({ sku: null, nombre: 'Clavos', cantidad: 100, costoUnitario: 0.05, precioVenta: null });
  });

  it('lee montos con símbolo y separador de miles', async () => {
    // "1,500" (coma de miles) se lee 1500; "2.50" conserva el punto decimal.
    // Ojo: "1.500" se interpreta como 1,5 — es el formato europeo que ya usa el
    // resto de la importación, y no se cambia acá.
    const r = await parsear('Nombre,Existencia,Costo\nCable,"1,500",$2.50\n');
    expect(r.rows[0]).toMatchObject({ cantidad: 1500, costoUnitario: 2.5 });
  });
});

describe('carga de inventario — encabezados que no se adivinan', () => {
  it('un "Precio" suelto se rechaza pidiendo que se nombre la columna', async () => {
    // Es ambiguo, y elegir mal deja el margen al revés: el costo y el precio de
    // venta quedarían invertidos sin que nadie lo note.
    await expect(parsear('Nombre,Existencia,Precio\nCemento,10,7.99\n')).rejects.toThrow(/ambigua/i);
  });

  it('un "Precio Costo" sí se reconoce como costo', async () => {
    const r = await parsear('Nombre,Existencia,Precio Costo\nCemento,10,4.5\n');
    expect(r.rows[0].costoUnitario).toBe(4.5);
  });

  it('sin columna de existencia el mensaje dice qué poner', async () => {
    await expect(parsear('Nombre,Costo\nCemento,4.5\n')).rejects.toThrow(/Existencia/i);
  });

  it('sin columna de producto el mensaje dice qué poner', async () => {
    await expect(parsear('Cantidad,Costo\n10,4.5\n')).rejects.toThrow(/Nombre|Producto/i);
  });
});

describe('carga de inventario — filas', () => {
  it('marca las filas con datos inválidos en vez de cargarlas', async () => {
    const r = await parsear('Nombre,Existencia,Costo\nBueno,10,5\nSin costo,10,abc\nSin cantidad,xyz,5\n,10,5\n');
    expect(r.rows.filter((f) => !f.errores.length)).toHaveLength(1);
    expect(r.rows.find((f) => f.nombre === 'Sin costo')!.errores.join(' ')).toMatch(/Costo inválido/);
    expect(r.rows.find((f) => f.nombre === 'Sin cantidad')!.errores.join(' ')).toMatch(/Existencia inválida/);
    expect(r.rows.find((f) => f.nombre === '')!.errores.join(' ')).toMatch(/nombre/i);
    expect(r.rows).toHaveLength(4);
  });

  it('una existencia de cero se rechaza: es un producto sin mercancía', async () => {
    const r = await parsear('Nombre,Existencia,Costo\nCemento,0,5\n');
    expect(r.rows[0].errores.join(' ')).toMatch(/Existencia inválida/);
  });

  it('el mismo producto dos veces acumula la existencia en lugar de perder una', async () => {
    const r = await parsear('SKU,Nombre,Existencia,Costo\nCEM,Cemento,10,5\nCEM,Cemento,5,5\n');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].cantidad).toBe(15);
    expect(r.duplicadas).toEqual(['Cemento']);
  });

  it('ignora las líneas en blanco', async () => {
    const r = await parsear('Nombre,Existencia,Costo\nCemento,10,5\n\n,\nArena,2,8\n');
    expect(r.rows).toHaveLength(2);
  });
});
