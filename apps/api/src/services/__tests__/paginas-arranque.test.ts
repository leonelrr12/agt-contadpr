import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * El arranque de las páginas sueltas (`admin.html`, `planes.html`, …), que tienen su
 * JavaScript **inline** y por eso quedaban fuera del test de los `js/`: un error en la
 * primera línea de la página no lo ve nadie hasta que el dueño abre la pantalla.
 *
 * Pasó de verdad (16-10-2026, panel SaaS): el estado del panel se declaraba con `let`
 * DEBAJO del bloque de init, y `loadCuentas()` —llamada desde ahí— leía una de esas
 * variables **antes de su primer `await`**, o sea en zona muerta temporal. El
 * `ReferenceError` no rompe la página entera: como la función es `async`, queda como
 * promesa rechazada sin `catch` y la tabla se queda en «Cargando…» para siempre. Un
 * `try/catch` alrededor de la evaluación no lo ve —por eso este test escucha las
 * promesas rechazadas—, y `node --check` tampoco, porque la sintaxis es correcta.
 *
 * Se evalúa con `getUser()` devolviendo un superadmin y un `fetch` que responde, que es
 * la única forma de que la página entre por la rama que arma las tablas.
 */

const PAGINAS = path.join(__dirname, '../../../../web/public');

/**
 * Responde a cualquier cosa y se puede llamar/construir: el DOM de mentira. Las
 * conversiones a texto devuelven '' en vez del propio proxy: si no, cualquier
 * `${...}` o `String(...)` sobre un nodo revienta con «Cannot convert object to
 * primitive value» y el test fallaría por su culpa, no por la de la página.
 */
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

const GLOBALES = [
  'document', 'window', 'localStorage', 'sessionStorage', 'location', 'navigator', 'history',
  'alert', 'confirm', 'prompt', 'URL', 'URLSearchParams', 'FormData', 'FileReader', 'Blob',
  'MutationObserver', 'requestAnimationFrame', 'setTimeout', 'clearTimeout', 'setInterval',
  'clearInterval', 'btoa', 'atob', 'Event', 'CustomEvent', 'encodeURIComponent', 'Headers',
];

/**
 * Una respuesta HTTP de mentira. El JSON devuelve el proxy y no `{}`: la página hace
 * `d.algo.toFixed(2)` y compañía, y con un objeto vacío el test fallaría por el dato
 * que le inventamos nosotros en vez de por el código de la página.
 */
const respuestaFalsa = () => ({
  ok: true,
  status: 200,
  json: async () => cualquierCosa,
  text: async () => '',
  headers: { get: () => 'application/json' },
});

const archivos = fs.existsSync(PAGINAS)
  ? fs.readdirSync(PAGINAS).filter((f) => f.endsWith('.html'))
  : [];

/** Los `<script>` sin `src` de una página (el JS propio, no las librerías). */
function scriptsInline(html: string): string[] {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1])
    .filter((s) => s.trim().length > 0);
}

/**
 * Lo que declaran los scripts compartidos (`js/shared.js`, `js/terminos.js`, …): las
 * páginas los cargan con `<script src>` y su código inline los llama al arrancar
 * (`verificarTerminos()`), así que sin estos nombres el test fallaría por algo que en
 * el navegador sí existe. Mismo criterio que el test de los `js/`.
 */
const DIR_JS = path.join(PAGINAS, 'js');
const nombresCompartidos = new Set<string>();
if (fs.existsSync(DIR_JS)) {
  for (const archivo of fs.readdirSync(DIR_JS).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(DIR_JS, archivo), 'utf8');
    // Con indentación incluida: `terminos.js` declara `verificarTerminos` dentro de su
    // IIFE y la publica en `window` — que es como las páginas la llaman al arrancar.
    for (const m of src.matchAll(/^\s*(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) nombresCompartidos.add(m[1]);
    for (const m of src.matchAll(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) nombresCompartidos.add(m[1]);
    for (const m of src.matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)) nombresCompartidos.add(m[1]);
  }
}

describe('arranque de las páginas sueltas', () => {
  it('hay páginas con script propio que revisar', () => {
    const conScript = archivos.filter((f) => scriptsInline(fs.readFileSync(path.join(PAGINAS, f), 'utf8')).length);
    expect(conScript.length).toBeGreaterThan(3);
  });

  for (const archivo of archivos) {
    const trozos = scriptsInline(fs.readFileSync(path.join(PAGINAS, archivo), 'utf8'));
    if (!trozos.length) continue;

    it(`${archivo} arranca sin errores ni promesas rechazadas`, async () => {
      const rechazos: any[] = [];
      const alRechazar = (e: any) => rechazos.push(e);
      process.on('unhandledRejection', alRechazar);
      // `unhandledRejection` se emite en el tick siguiente al rechazo.
      const esperarRechazos = () => new Promise((r) => setTimeout(r, 30));

      const sandbox: any = {
        console,
        // La página entra por la rama de superadmin y pide datos de verdad.
        getUser: () => ({ id: 'u-1', name: 'Dueño', email: 'd@x.com', role: 'superadmin' }),
        getToken: () => 'token-de-prueba',
        authFetch: async () => respuestaFalsa(),
        api: async () => respuestaFalsa(),
        fetch: async () => respuestaFalsa(),
        showAlert: async () => {},
        escapeHtml: (s: any) => String(s ?? ''),
        JSON, Object, Array, String, Number, Math, Date, Promise, Error, Set, Map, RegExp,
        parseInt, parseFloat, isNaN, encodeURI, decodeURI, document: cualquierCosa,
      };
      for (const g of GLOBALES) if (!(g in sandbox)) sandbox[g] = cualquierCosa;
      for (const n of nombresCompartidos) if (!(n in sandbox)) sandbox[n] = cualquierCosa;
      sandbox.globalThis = sandbox;
      sandbox.window = sandbox; // en el navegador `window` es el propio global

      try {
        for (const trozo of trozos) {
          expect(() => vm.runInNewContext(trozo, sandbox, { timeout: 5000, filename: archivo })).not.toThrow();
          await esperarRechazos();
        }
        expect(rechazos.map((e) => e?.message || String(e))).toEqual([]);
      } finally {
        process.off('unhandledRejection', alRechazar);
      }
    });
  }
});
