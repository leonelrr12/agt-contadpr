import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Guardia de la barrida de diálogos nativos: la app usa js/dialogos.js
 * (showAlert / showConfirm / showPrompt) para que avisos y confirmaciones se
 * vean igual en todas las pantallas. Un alert()/confirm()/prompt() suelto
 * vuelve a romper esa consistencia y bloquea la pestaña del navegador.
 */

const PUBLIC = path.join(__dirname, '../../../../web/public');
const JS_DIR = path.join(PUBLIC, 'js');

function archivos(): string[] {
  const html = fs.readdirSync(PUBLIC).filter((f) => f.endsWith('.html')).map((f) => path.join(PUBLIC, f));
  const js = fs.existsSync(JS_DIR)
    ? fs.readdirSync(JS_DIR).filter((f) => f.endsWith('.js')).map((f) => path.join(JS_DIR, f))
    : [];
  return [...html, ...js];
}

/** Líneas con una llamada nativa, sin contar comentarios (de línea ni de bloque). */
function nativas(contenido: string): string[] {
  const resultado: string[] = [];
  let enBloque = false;
  contenido.split('\n').forEach((linea, i) => {
    let limpia = '';
    let j = 0;
    while (j < linea.length) {
      if (enBloque) {
        const fin = linea.indexOf('*/', j);
        if (fin === -1) { j = linea.length; } else { enBloque = false; j = fin + 2; }
        continue;
      }
      const iniBloque = linea.indexOf('/*', j);
      const iniLinea = linea.indexOf('//', j);
      if (iniLinea !== -1 && (iniBloque === -1 || iniLinea < iniBloque)) break;
      if (iniBloque === -1) { limpia += linea.slice(j); break; }
      limpia += linea.slice(j, iniBloque);
      enBloque = true;
      j = iniBloque + 2;
    }
    if (/(^|[^.\w$])(alert|confirm|prompt)\s*\(/.test(limpia)) {
      resultado.push(`${i + 1}: ${linea.trim()}`);
    }
  });
  return resultado;
}

describe('diálogos nativos', () => {
  it('no quedan alert/confirm/prompt en el frontend', () => {
    const pendientes = archivos().flatMap((archivo) =>
      nativas(fs.readFileSync(archivo, 'utf8')).map((linea) => `${path.basename(archivo)} → ${linea}`),
    );
    expect(pendientes).toEqual([]);
  });
});
