import { describe, it, expect } from 'vitest';
import { quickClassify } from '../services/pre-clasificador';

/**
 * Pre-clasificador de las facturas que se suben desde la web (imagen por OCR o
 * PDF). El caso que lo motivó es el mismo del flujo de WhatsApp: un proveedor
 * que apunta a un rubro que la empresa no tiene no puede quedarse con la
 * propuesta — la farmacia sin Medicamentos cae a Gastos Varios aunque el ítem
 * (JABÓN) sí tenga cuenta.
 */

const prisma = (concepts: any[], keywordHit: string | null = null) => ({
  concept: {
    findMany: async () => concepts,
    findFirst: async () => (keywordHit ? { name: keywordHit } : null),
  },
});

// Como Empresa Demo: tiene limpieza y combustible, no medicinas.
const demo = [
  { name: 'Suministros de Limpieza', accountId: 'a1', confidence: 0.9, keywords: '[]' },
  { name: 'Combustible', accountId: 'a2', confidence: 0.9, keywords: '[]' },
];

describe('quickClassify: propuestas validadas contra el catálogo de la empresa', () => {
  it('la farmacia sin Medicamentos no se queda con la propuesta: gana el ítem', async () => {
    const texto = 'FARMACIA EL PUEBLO — JABÓN DE BAÑO 3.50';
    expect(await quickClassify(texto, prisma(demo) as any, 'demo')).toBe('Suministros de Limpieza');
  });

  it('el proveedor con rubro en el catálogo se sigue proponiendo', async () => {
    expect(await quickClassify('TERPEL ESTACIÓN', prisma(demo) as any, 'demo')).toBe('Combustible');
  });

  it('una palabra clave aprendida de la empresa gana al mapa', async () => {
    expect(await quickClassify('AGRO LOS SANTOS', prisma(demo, 'Materia prima') as any, 'demo')).toBe('Materia prima');
  });

  it('sin catálogo (llamada vieja) se conserva el primer candidato del mapa', async () => {
    expect(await quickClassify('FARMACIA EL PUEBLO')).toBe('Medicamentos');
  });

  it('una lectura de catálogo que falla no tumba la propuesta', async () => {
    const roto = {
      concept: {
        findMany: async () => { throw new Error('conexión caída'); },
        findFirst: async () => { throw new Error('conexión caída'); },
      },
    };
    expect(await quickClassify('TERPEL ESTACIÓN', roto as any, 'demo')).toBe('Combustible');
  });

  it('texto vacío o solo metadata no propone nada', async () => {
    expect(await quickClassify('   ', prisma(demo) as any, 'demo')).toBeNull();
    expect(await quickClassify('FACTURA RUC DV TOTAL ITBMS', prisma(demo) as any, 'demo')).toBeNull();
  });
});
