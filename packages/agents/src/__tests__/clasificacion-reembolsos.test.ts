import { describe, it, expect } from 'vitest';
import { ClassificationAgent, KEYWORD_MAP, keywordsDe, conceptoPorKeywords } from '../classification-agent';
import { basePrismaStub } from './stubs';

/**
 * Clasificación de las compras que un trabajador adelanta (módulo Reembolsos).
 *
 * Dos cosas que se rompieron o podían romperse en silencio y estos casos fijan:
 *
 *  · El pre-clasificador propone `KEYWORD_MAP[palabra][0]` y el agente lo resuelve
 *    por nombre. Con `tornillo` el primer candidato era 'Mantenimiento y
 *    Reparaciones', y como el paso de substring corre ANTES de probar el segundo
 *    candidato, el nombre propuesto contenía 'Mantenimiento' y ganaba esa cuenta
 *    — nunca se llegaba a Repuestos. Por eso el orden del mapa es la corrección.
 *  · Las palabras que la empresa configura en el concepto (`Concept.keywords`) son
 *    lo único que el contador puede ajustar sin código, así que van primero.
 */

const catalogo = (concepts: any[]) => ({
  ...basePrismaStub(),
  concept: { findMany: async () => concepts },
  account: {
    findMany: async () => [
      { id: 'acct-repuestos', name: 'Compras', code: '5.01.02', type: 'COSTO', isActive: true },
      { id: 'acct-materia', name: 'Compras', code: '5.01.02', type: 'COSTO', isActive: true },
      { id: 'acct-mantenimiento', name: 'Mantenimiento y Reparaciones', code: '6.01.09', type: 'GASTO', isActive: true },
      { id: 'acct-agua-emb', name: 'Atencion al Empleado', code: '6.01.01.07', type: 'GASTO', isActive: true },
      { id: 'acct-agua-servicio', name: 'Agua', code: '6.01.04', type: 'GASTO', isActive: true },
      { id: 'acct-varios', name: 'Gastos Varios', code: '6.08.01', type: 'GASTO', isActive: true },
    ],
  },
});

const agente = (concepts: any[]) =>
  new ClassificationAgent({ prisma: catalogo(concepts) as any, companyId: 'odesa' });

describe('repuestos: el nombre propuesto no puede ser secuestrado por Mantenimiento', () => {
  const concepts = [
    { name: 'Mantenimiento', accountId: 'acct-mantenimiento', confidence: 0.9, keywords: '[]' },
    { name: 'Repuestos y Accesorios', accountId: 'acct-repuestos', confidence: 0.9, keywords: '[]' },
  ];

  it.each(['tornillo', 'repuesto', 'repuestos', 'herramienta', 'pintura'])(
    'la palabra "%s" termina en Repuestos y Accesorios',
    async (palabra) => {
      const propuesto = KEYWORD_MAP[palabra][0]; // lo que propone el pre-clasificador
      const r = await agente(concepts).classify(propuesto, 'GASTO');
      expect(r.concept).toBe('Repuestos y Accesorios');
      expect(r.accountId).toBe('acct-repuestos');
    },
  );

  it('una ferretería (el proveedor) es materia prima', () => {
    expect(KEYWORD_MAP['ferretería'][0]).toBe('Materia prima');
    expect(KEYWORD_MAP['ferreteria'][0]).toBe('Materia prima');
  });

  it('el agua suelta es la embotellada; el acueducto va por el proveedor', () => {
    expect(KEYWORD_MAP['agua'][0]).toBe('Agua Embotellada');
    expect(KEYWORD_MAP['idaan'][0]).toBe('IDAAN');
    expect(KEYWORD_MAP['acueducto'][0]).toBe('Acueducto');
  });
});

describe('palabras configuradas por la empresa (Concept.keywords)', () => {
  const concepts = [
    {
      name: 'Materia prima', accountId: 'acct-materia', confidence: 0.9,
      keywords: JSON.stringify(['ferretería', 'materiales', 'insumos']),
    },
    { name: 'Mantenimiento', accountId: 'acct-mantenimiento', confidence: 0.9, keywords: '[]' },
  ];

  it('ganan a las heurísticas: el contador las configura y no toca código', async () => {
    const r = await agente(concepts).classify('Ferretería Central', 'GASTO');
    expect(r.concept).toBe('Materia prima');
  });

  it('no ensucian otras clasificaciones', async () => {
    const r = await agente(concepts).classify('Mantenimiento', 'GASTO');
    expect(r.concept).toBe('Mantenimiento');
  });

  it('keywords corruptas se ignoran en vez de tumbar la clasificación', () => {
    expect(keywordsDe({ keywords: '{roto' })).toEqual([]);
    expect(keywordsDe({ keywords: null })).toEqual([]);
    expect(keywordsDe({ keywords: '["Tornillo","FERRETERIA"]' })).toEqual(['tornillo', 'ferreteria']);
    expect(conceptoPorKeywords([{ name: 'X', keywords: '{roto' }], ['tornillo'])).toBeNull();
  });
});
