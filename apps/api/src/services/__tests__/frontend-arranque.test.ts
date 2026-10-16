import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * Los scripts del frontend son clásicos y sin build: un error en una sentencia
 * de arriba de todo **corta el archivo entero**, y como el arranque se registra
 * al final, la pantalla queda a medio armar sin que nada avise.
 *
 * Pasó de verdad: un `async` huérfano antes de un comentario hacía que el
 * navegador lanzara `ReferenceError` al evaluarlo, y `init.js` nunca registraba
 * su listener — la empresa no aparecía en el sidebar y los menús por rol no se
 * mostraban.
 *
 * `node --check` NO alcanza: `async` seguido de un comentario y una declaración
 * de función son dos sentencias válidas para el parser. Hay que EJECUTAR el
 * archivo —que es lo que hace el navegador— en un contexto donde los globales
 * del navegador existan y respondan a todo.
 */

const DIR = path.join(__dirname, '../../../../web/public/js');

/**
 * Un objeto que responde a cualquier cosa: `document.getElementById(...)` y
 * compañía se pueden llamar sin que exista un DOM de verdad.
 * `has` es el trap que consulta la resolución de nombres.
 */
const cualquierCosa: any = new Proxy(function () {}, {
  get: () => cualquierCosa,
  has: () => true,
  apply: () => cualquierCosa,
  construct: () => cualquierCosa,
  set: () => true,
});

/** Los globales del navegador que los scripts tocan al arrancar. */
const GLOBALES = [
  'document', 'window', 'localStorage', 'sessionStorage', 'location', 'navigator', 'history', 'screen',
  'fetch', 'Chart', 'alert', 'confirm', 'prompt', 'URL', 'FormData', 'FileReader', 'Blob', 'Image',
  'MutationObserver', 'IntersectionObserver', 'requestAnimationFrame', 'cancelAnimationFrame',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'btoa', 'atob', 'File', 'DataTransfer', 'Event', 'CustomEvent',
];

const archivos = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.js')) : [];

/**
 * Qué declara cada archivo. En la página los scripts comparten el ámbito global,
 * así que uno puede llamar al arrancar una función definida en otro (`inventario.js`
 * llama a `pintarEmpresaEnTitulo`); evaluándolos de a uno hay que darle esos
 * nombres —los de los DEMÁS— o el test fallaría por algo que en el navegador sí existe.
 */
const declarados = new Map<string, Set<string>>();
for (const archivo of archivos) {
  const src = fs.readFileSync(path.join(DIR, archivo), 'utf8');
  const nombres = new Set<string>();
  for (const m of src.matchAll(/^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) nombres.add(m[1]);
  for (const m of src.matchAll(/^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/gm)) nombres.add(m[1]);
  declarados.set(archivo, nombres);
}

describe('arranque de los scripts del frontend', () => {
  it('hay scripts que revisar (si no, este test no está mirando nada)', () => {
    expect(archivos.length).toBeGreaterThan(5);
  });

  for (const archivo of archivos) {
    it(`${archivo} ejecuta su arranque sin errores`, () => {
      const src = fs.readFileSync(path.join(DIR, archivo), 'utf8');

      const sandbox: any = { console };
      for (const g of GLOBALES) sandbox[g] = cualquierCosa;
      sandbox.globalThis = sandbox;
      sandbox.window = sandbox; // en el navegador `window` es el propio global
      // Lo que este archivo espera de los otros (helpers compartidos).
      for (const [otro, nombres] of declarados) {
        if (otro === archivo) continue;
        for (const n of nombres) if (!(n in sandbox)) sandbox[n] = cualquierCosa;
      }

      // Si el archivo lanza, el error sale acá con su nombre y su línea.
      expect(() => vm.runInNewContext(src, sandbox, { timeout: 5000, filename: archivo })).not.toThrow();
    });
  }
});
