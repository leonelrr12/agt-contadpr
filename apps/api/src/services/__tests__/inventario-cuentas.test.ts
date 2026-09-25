import { describe, it, expect } from 'vitest';
import { resolverCuentas } from '../inventario';

/**
 * La resolución de cuentas del kardex tiene una cadena de respaldo (producto →
 * empresa → alias clásico → código del catálogo) y, cuando no encuentra nada, un
 * mensaje que dice QUÉ HACER. Estos casos fijan el orden y el mensaje, porque de
 * eso depende que configurar una empresa nueva no sea adivinanza.
 *
 * Se le pasa un agente de mentira: `resolverCuentas` recibe el agente ya construido,
 * así que no hace falta Prisma.
 */
const agente = (mapa: Record<string, string>) => ({
  resolveAlias: (clave: string): string => {
    if (mapa[clave]) return mapa[clave];
    throw new Error(`Cuenta contable no encontrada: "${clave}"`);
  },
}) as any;

const EMPRESA = { inventarioCuentaId: null, inventarioCostoId: null };
const CATALOGO_BASE = { 'inventario-mercancia': 'acc-inv', '5.01.01': 'acc-costo' };

describe('resolverCuentas — cadena de respaldo', () => {
  it('usa las cuentas del producto cuando las tiene', () => {
    const a = agente({ 'acc-inv-propio': 'acc-inv-propio', 'acc-costo-propio': 'acc-costo-propio' });
    const r = resolverCuentas(a, EMPRESA, {
      cuentaInventarioId: 'acc-inv-propio',
      cuentaCostoId: 'acc-costo-propio',
    });
    expect(r).toEqual({ inventarioId: 'acc-inv-propio', costoId: 'acc-costo-propio' });
  });

  it('cae a las de la empresa cuando el producto no define las suyas', () => {
    const a = agente({ 'cuenta-empresa': 'cuenta-empresa', 'cuenta-costo-empresa': 'cuenta-costo-empresa' });
    const r = resolverCuentas(a, { inventarioCuentaId: 'cuenta-empresa', inventarioCostoId: 'cuenta-costo-empresa' });
    expect(r).toEqual({ inventarioId: 'cuenta-empresa', costoId: 'cuenta-costo-empresa' });
  });

  it('sin configuración cae al alias clásico del catálogo', () => {
    const r = resolverCuentas(agente(CATALOGO_BASE), EMPRESA);
    expect(r).toEqual({ inventarioId: 'acc-inv', costoId: 'acc-costo' });
  });

  it('ignora una cuenta configurada que ya no existe y sigue bajando', () => {
    // El producto apunta a una cuenta borrada: no revienta, usa la de la empresa.
    const r = resolverCuentas(agente({ 'cuenta-empresa': 'cuenta-empresa', '5.01.01': 'acc-costo' }), {
      inventarioCuentaId: 'cuenta-empresa',
      inventarioCostoId: null,
    }, { cuentaInventarioId: 'cuenta-borrada' });
    expect(r.inventarioId).toBe('cuenta-empresa');
  });
});

describe('resolverCuentas — cuando falta configurar', () => {
  it('sin cuenta de inventario el mensaje dice cómo arreglarlo', () => {
    expect(() => resolverCuentas(agente({}), EMPRESA)).toThrow(/inventario-mercancia/);
  });

  it('sin cuenta de costo el mensaje nombra el alias que hay que asignar', () => {
    expect(() => resolverCuentas(agente({ 'inventario-mercancia': 'acc-inv' }), EMPRESA)).toThrow(/costo-ventas/);
  });

  it('el error sale como 400, no como 500', () => {
    try {
      resolverCuentas(agente({}), EMPRESA);
      throw new Error('debería haber lanzado');
    } catch (e: any) {
      expect(e.status).toBe(400);
    }
  });
});
