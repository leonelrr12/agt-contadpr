import { describe, it, expect } from 'vitest';
import { ClassificationAgent, KEYWORD_MAP, keywordsDe, conceptoPorKeywords, conceptoDelMapa } from '../classification-agent';
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

/**
 * El pre-clasificador propone `KEYWORD_MAP[palabra][0]`, pero solo si ese
 * candidato RESUELVE contra el catálogo de la empresa. El caso real: una factura
 * de FARMACIA EL PUEBLO con el ítem JABÓN en una empresa sin Medicamentos —
 * antes se proponía 'Medicamentos', el clasificador no lo resolvía y el gasto
 * caía a Gastos Varios aunque el jabón sí tuviera cuenta.
 */
describe('el proveedor apunta a un rubro que la empresa no tiene: deciden los ítems', () => {
  // Catálogo con el ítem (limpieza), sin el rubro del proveedor (medicinas) —
  // como Empresa Demo, donde el caso se reprodujo.
  const conLimpieza = [
    { name: 'Suministros de Limpieza', accountId: 'acct-limpieza', confidence: 0.9, keywords: '[]' },
  ];

  it('el proveedor no propone nada si su rubro no está en el catálogo', () => {
    expect(conceptoDelMapa('farmacia', conLimpieza)).toBeNull();
  });

  it('sin catálogo (teléfono sin vincular) se conserva el primer candidato', () => {
    expect(conceptoDelMapa('farmacia')).toBe('Medicamentos');
  });

  it('con el rubro en el catálogo sí lo propone', () => {
    const conMedicamentos = [
      ...conLimpieza,
      { name: 'Medicamentos', accountId: 'acct-med', confidence: 0.9, keywords: '[]' },
    ];
    expect(conceptoDelMapa('farmacia', conMedicamentos)).toBe('Medicamentos');
  });

  it('el ítem decide: JABÓN termina en Suministros de Limpieza', async () => {
    const propuesto = conceptoDelMapa('jabón', conLimpieza) ?? conceptoDelMapa('jabon', conLimpieza);
    expect(propuesto).toBe('Suministros de Limpieza');
    const r = await agente(conLimpieza).classify(propuesto!, 'GASTO');
    expect(r.concept).toBe('Suministros de Limpieza');
    expect(r.accountId).toBe('acct-limpieza');
  });

  it('el gate es "nombra al concepto", no "existe igual": Salarios nombra a Salario', () => {
    const c = [{ name: 'Salario', accountId: 'acct-salario', confidence: 0.9, keywords: '[]' }];
    expect(conceptoDelMapa('salario', c)).toBe('Salarios');
  });

  it('una coincidencia floja (palabra suelta o prefijo) no alcanza', () => {
    // 'Suministros de Oficina' comparte la palabra 'oficina' con 'Útiles de
    // oficina', pero no lo nombra: una compra de limpieza no puede ir a Papelería.
    const c = [{ name: 'Útiles de oficina', accountId: 'acct-oficina', confidence: 0.9, keywords: '[]' }];
    expect(conceptoDelMapa('jabón', c)).toBeNull();
    // 'Comisiones Bancarias' llegaba a 'Comisión' solo por el prefijo 'comi'.
    const c2 = [{ name: 'Comisión', accountId: 'acct-com', confidence: 0.9, keywords: '[]' }];
    expect(conceptoDelMapa('comisión', c2)).toBe('Comisión'); // por el candidato 'Comisión' del mapa
    expect(conceptoDelMapa('transferencia', c2)).toBeNull();
  });

  it('una cuenta que contradice la dirección del movimiento no se propone', () => {
    const c = [
      { name: 'Transporte', accountId: 'acct-ingreso', confidence: 0.9, keywords: '[]', account: { type: 'INGRESO' } },
    ];
    expect(conceptoDelMapa('transporte', c, 'GASTO')).toBeNull();
    expect(conceptoDelMapa('transporte', c, 'VENTA')).toBe('Transporte');
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
