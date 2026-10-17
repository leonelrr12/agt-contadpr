/**
 * La ayuda dentro de la app (`public/js/ayuda.js`): un «?» por pantalla con los pasos.
 *
 * Es texto pegado a la pantalla, así que lo que puede romperse en silencio es el
 * ENGANCHE: un id mal escrito en `AYUDA_POR_PANEL` no da error — simplemente esa
 * pantalla se queda sin botón y nadie se entera hasta que un cliente pregunta. Lo
 * mismo con un tema que se renombra en el diccionario y queda huérfano en el mapa.
 *
 * Se verifica contra el `index.html` de verdad: si un panel cambia de id, este test
 * lo dice.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

const PUBLIC = path.join(__dirname, '../../../../web/public');
const SRC = fs.readFileSync(path.join(PUBLIC, 'js/ayuda.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');

/** Un DOM mínimo, lo justo para que el script corra y podamos mirar qué insertó. */
class Panel {
  _html = '';
  style: any = {};
  constructor(public id: string, public _posicion = 'static') {}
  querySelector() { return null; } // todavía sin botón puesto
  insertAdjacentHTML(donde: string, html: string) { if (donde === 'afterbegin') this._html = html; }
}

/** El elemento que devuelve `createElement`: guarda el HTML para poder mirarlo. */
class Elemento {
  style: any = {};
  _h = '';
  addEventListener() {}
  appendChild() {}
  set innerHTML(v: string) { this._h = v; }
  get innerHTML() { return this._h; }
}

function correr() {
  const paneles = new Map<string, Panel>();
  const ctx: any = {
    console, Object, Array, String,
    document: {
      head: { appendChild() {} },
      getElementById: (id: string) => paneles.get(id) || null,
      createElement: () => new Elemento(),
      querySelector: () => null,
      querySelectorAll: () => [],
      body: { appendChild(el: any) { ctx.__dialogo = el; } },
    },
    window: {},
  };
  ctx.window.getComputedStyle = (el: any) => ({ position: el._posicion });
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx, { filename: 'ayuda.js' });
  return { ctx, paneles };
}

/** Los ids que existen hoy en el SPA. */
const IDS_DEL_SPA = new Set([...INDEX.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));

describe('la ayuda de la app', () => {
  it('⭐ todos los paneles del mapa existen en index.html (un id mal escrito no da error, deja la pantalla sin «?»)', () => {
    const { ctx } = correr();
    const mapa: Record<string, string> = vm.runInContext('AYUDA_POR_PANEL', ctx);
    const faltantes = Object.keys(mapa).filter((id) => !IDS_DEL_SPA.has(id));

    expect(faltantes).toEqual([]);
    expect(Object.keys(mapa).length).toBeGreaterThanOrEqual(8);
  });

  it('cada panel apunta a un tema que existe en el diccionario', () => {
    const { ctx } = correr();
    const mapa: Record<string, string> = vm.runInContext('AYUDA_POR_PANEL', ctx);
    const temas: Record<string, any> = vm.runInContext('AYUDA', ctx);

    for (const [panel, tema] of Object.entries(mapa)) {
      expect(temas[tema], `${panel} apunta a "${tema}", que no está en AYUDA`).toBeTruthy();
    }
  });

  it('cada tema tiene lo mínimo para servir: emoji, título, para qué, pasos y el «ojo»', () => {
    const { ctx } = correr();
    const temas: Record<string, any> = vm.runInContext('AYUDA', ctx);

    expect(Object.keys(temas).length).toBeGreaterThanOrEqual(10);
    for (const [clave, t] of Object.entries<any>(temas)) {
      expect(t.emoji, clave).toBeTruthy();
      expect(t.titulo, clave).toBeTruthy();
      expect(t.para, clave).toBeTruthy();
      expect(Array.isArray(t.pasos) && t.pasos.length >= 3, `${clave} necesita al menos 3 pasos`).toBe(true);
      // El «ojo» es lo que evita el error típico: sin él, un tema es un folleto.
      expect(t.ojo, clave).toBeTruthy();
    }
  });

  it('el botón cae en cada panel mapeado, y solo en esos', () => {
    const { ctx, paneles } = correr();
    const mapa: Record<string, string> = vm.runInContext('AYUDA_POR_PANEL', ctx);

    for (const id of Object.keys(mapa)) paneles.set(id, new Panel(id));
    paneles.set('panel-whatsapp-content', new Panel('panel-whatsapp-content')); // no mapeado

    vm.runInContext('pintarAyudas()', ctx);

    for (const [id, tema] of Object.entries(mapa)) {
      const p = paneles.get(id)!;
      expect(p._html, `${id} sin botón`).toContain(`abrirAyuda('${tema}')`);
    }
    expect(paneles.get('panel-whatsapp-content')!._html).toBe(''); // no está en el mapa
  });

  it('no rompe el posicionamiento de un panel que ya es relative', () => {
    const { ctx, paneles } = correr();
    const relativo = new Panel('panel-import-content', 'relative');
    paneles.set('panel-import-content', relativo);

    vm.runInContext('pintarAyudas()', ctx);

    expect(relativo.style.position).toBeUndefined(); // no se pisa
    expect(relativo._html).toContain('ayuda-flotante');
  });

  it('el diálogo arma el tema con sus pasos y el índice con todos', () => {
    const { ctx } = correr();

    vm.runInContext("abrirAyuda('conciliacion')", ctx);
    const uno: string = (ctx as any).__dialogo.innerHTML;
    expect(uno).toContain('Conciliación bancaria');
    expect(uno).toContain('<ol>');
    expect(uno).toContain('ayuda-ojo');

    vm.runInContext('abrirAyuda()', ctx);
    const indice: string = (ctx as any).__dialogo.innerHTML;
    const temas: Record<string, any> = vm.runInContext('AYUDA', ctx);
    expect((indice.match(/abrirAyuda\('/g) || []).length).toBe(Object.keys(temas).length);
  });
});
