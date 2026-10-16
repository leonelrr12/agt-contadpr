import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * La fila de «Cuentas» del panel SaaS, con los topes que **rigen de verdad**.
 *
 * Pasó el 16-10-2026: Odesa tenía cortesía de 5 usuarios sobre un plan de 3, la app la
 * respetaba (`services/suscripcion.ts`) y el panel mostraba «5 / 3» en rojo — el dueño
 * decidía sobre un número que no era el que el cliente estaba usando. Regla: **la
 * cortesía de la suscripción manda sobre el plan**, en el panel igual que en la API.
 *
 * Se renderiza de verdad la fila (el script inline de `admin.html` en un sandbox) en
 * vez de mirar el código: es la única forma de atrapar un template que arma el número
 * con la variable equivocada.
 */

const PAGINA = path.join(__dirname, '../../../../web/public/admin.html');

const cualquierCosa: any = new Proxy(function () {}, {
  get: (_t, prop) => {
    if (prop === Symbol.toPrimitive) return () => '';
    if (prop === 'toString' || prop === 'valueOf') return () => '';
    if (prop === Symbol.iterator) return function* () {};
    return cualquierCosa;
  },
  has: () => true,
  apply: () => cualquierCosa,
  construct: () => cualquierCosa,
  set: () => true,
});

const respuestaFalsa = () => ({ ok: true, status: 200, json: async () => cualquierCosa, text: async () => '' });

/** El script inline del panel, listo para pedirle que pinte una fila. */
function armarPanel(): any {
  const html = fs.readFileSync(PAGINA, 'utf8');
  const script = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]).join('\n');

  const sandbox: any = {
    console,
    getUser: () => ({ id: 'u-1', name: 'Dueño', email: 'd@x.com', role: 'superadmin' }),
    getToken: () => 'token-de-prueba',
    api: async () => respuestaFalsa(),
    authFetch: async () => respuestaFalsa(),
    fetch: async () => respuestaFalsa(),
    showAlert: async () => {},
    JSON, Object, Array, String, Number, Math, Date, Promise, Error, Set, Map, RegExp,
    parseInt, parseFloat, isNaN, encodeURI, decodeURI, encodeURIComponent,
  };
  for (const g of ['document', 'window', 'localStorage', 'location', 'URLSearchParams', 'URL', 'setTimeout', 'clearTimeout']) {
    sandbox[g] = cualquierCosa;
  }
  sandbox.globalThis = sandbox;
  sandbox.window = sandbox;
  vm.runInNewContext(script, sandbox, { timeout: 5000, filename: 'admin.html' });
  return sandbox;
}

/** El texto visible de la fila (sin etiquetas ni espacios de más). */
const texto = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

/** Una cuenta con una empresa, `usuarios` propios y la suscripción que se le pase. */
function cuenta(usuarios: number, suscripcion: any) {
  return {
    id: 'cta-1',
    name: 'Servicios Generales Odesa S.A',
    historial: 0,
    empresas: [{ id: 'c-1', name: 'Odesa', taxId: '8-123', usuarios }],
    suscripcion,
  };
}

const SUSCRIPCION = (extra: any = {}) => ({
  id: 's-1',
  status: 'GRANTED',
  movementsUsed: 1407,
  movementsLimit: 1500,
  addons: [],
  periodEnd: new Date(Date.now() + 30 * 86400000).toISOString(),
  plan: { name: 'Individual Premium', price: 19.99, maxEmpresas: 1, maxUsuariosPorEmpresa: 3, modulos: ['inventario', 'planilla'] },
  ...extra,
});

describe('la fila de Cuentas del panel', () => {
  it('⭐ con cortesía de usuarios muestra la cortesía, no el tope del plan', () => {
    const panel = armarPanel();
    const html = panel.filaCuenta(cuenta(4, SUSCRIPCION({ maxUsuariosPorEmpresa: 5 })));
    const t = texto(html);

    expect(t).toContain('4 / 5');
    expect(t).not.toContain('4 / 3');
    // Y no se marca en rojo: está dentro de lo que el dueño le otorgó.
    expect(html).not.toContain('⚠️');
  });

  it('en el tope exacto avisa igual: el próximo usuario ya no entra', () => {
    const panel = armarPanel();
    const html = panel.filaCuenta(cuenta(5, SUSCRIPCION({ maxUsuariosPorEmpresa: 5 })));

    expect(texto(html)).toContain('5 / 5');
    expect(html).toContain('⚠️'); // está justo en el tope, no pasado, pero avisa
  });

  it('sin cortesía manda el plan (y ahí sí avisa que se pasó)', () => {
    const panel = armarPanel();
    const html = panel.filaCuenta(cuenta(5, SUSCRIPCION()));
    const t = texto(html);

    expect(t).toContain('5 / 3');
    expect(html).toContain('⚠️'); // el nombre de la empresa que se pasó
    expect(html).toContain('var(--red)'); // y el tope, en rojo
  });

  it('la cortesía de empresas también gana sobre el plan', () => {
    const panel = armarPanel();
    const fila = cuenta(3, SUSCRIPCION({ maxEmpresas: 3 }));
    fila.empresas = [
      { id: 'c-1', name: 'Odesa', taxId: '8-123', usuarios: 2 },
      { id: 'c-2', name: 'Cliente Dos', taxId: '1-1', usuarios: 1 },
      { id: 'c-3', name: 'Cliente Tres', taxId: '2-2', usuarios: 1 },
    ];

    const html = panel.filaCuenta(fila);
    const t = texto(html);

    expect(t).toContain('3 / 3'); // 3 empresas contra el tope de 1 del plan
    expect(t).not.toContain('3 / 1');
    expect(html).not.toContain('⚠️');
  });

  it('con una sola empresa no repite el nombre: la cuenta se llama como ella', () => {
    // La cuenta de un cliente individual lleva el nombre de su empresa (backfill de la
    // 0041), así que la segunda línea mostraba lo mismo dos veces. Se veía en negrita
    // y en gris: «Servicios Generales Odesa S.A» y abajo «Servicios Generales Odesa S.A».
    const panel = armarPanel();
    const fila = cuenta(2, SUSCRIPCION());
    fila.empresas = [{ id: 'c-1', name: fila.name, taxId: '8-123', usuarios: 2 }];

    const t = texto(panel.filaCuenta(fila));

    expect(t.match(/Odesa/g)?.length).toBe(1); // una sola vez, no dos
    expect(t).toContain('8-123'); // abajo va el RUC, que sí aporta
  });

  it('si la empresa se llama distinto que la cuenta, se muestra igual', () => {
    const panel = armarPanel();
    const fila = cuenta(2, SUSCRIPCION());
    fila.name = 'Cuenta de Leo';
    fila.empresas = [{ id: 'c-1', name: 'Servicios Generales Odesa S.A', taxId: '8-123', usuarios: 2 }];

    const t = texto(panel.filaCuenta(fila));

    expect(t).toContain('Cuenta de Leo');
    expect(t).toContain('Servicios Generales Odesa S.A'); // el nombre de la empresa es información nueva
  });

  it('con varias empresas sí lista los clientes del despacho', () => {
    const panel = armarPanel();
    const fila = cuenta(3, SUSCRIPCION({ maxEmpresas: 5 }));
    fila.name = 'Despacho Istmeño';
    fila.empresas = [
      { id: 'c-1', name: 'Cliente Uno', taxId: '1-1', usuarios: 2 },
      { id: 'c-2', name: 'Cliente Dos', taxId: '2-2', usuarios: 1 },
    ];

    const t = texto(panel.filaCuenta(fila));
    expect(t).toContain('Cliente Uno · Cliente Dos');
  });

  it('una cuenta sin suscripción vigente se puede leer y ofrece asignarle un plan', () => {
    const panel = armarPanel();
    const t = texto(panel.filaCuenta({ ...cuenta(1, null), historial: 2 }));

    expect(t).toContain('Sin suscripción vigente');
    expect(t).toContain('2 vencidas');
    expect(t).toContain('Asignar plan');
  });
});
