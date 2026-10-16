import { describe, it, expect, vi, beforeEach } from 'vitest';
import { conceptoDelMapa } from '@agt-contador/agents';

/**
 * La factura por PDF/URL se clasifica con TODOS sus ítems, no con los tres
 * primeros. El ítem que resuelve el rubro puede estar en cualquier posición: la
 * factura de fonda del 11-10 (Hojaldre, Hojaldre, Buñuelo, **Bistec Picado**)
 * caía a Gastos Varios porque `items.slice(0, 3)` dejaba fuera el bistec y el
 * proveedor —una panadería— no nombra ningún rubro del mapa.
 *
 * El catálogo es el de una empresa cualquiera con Alimentación (6.01.01.07).
 */

// El texto que devuelve pdf-parse lo fija cada test (la caja es hoisted porque
// el factory de vi.mock corre antes que el cuerpo del archivo).
const caja = vi.hoisted(() => ({ texto: '' }));

vi.mock('../wa-session-store', () => {
  const sessions = new Map<string, any>();
  const mk = () => ({
    chatId: '', phoneNumber: '', dialogContext: null, pendingResult: null,
    entityMatches: null, originalInput: null, pendingFactura: null, state: 'idle', lastActivity: 0,
  });
  const s = (chatId: string) => sessions.get(chatId);
  return {
    createSession: (chatId: string, phoneNumber: string) => sessions.set(chatId, { ...mk(), chatId, phoneNumber }),
    getSession: (chatId: string) => s(chatId),
    touchSession: () => {},
    setDialogContext: (chatId: string, ctx: any) => { const x = s(chatId); if (x) x.dialogContext = ctx; },
    setPendingResult: (chatId: string, r: any) => { const x = s(chatId); if (x) { x.pendingResult = r; x.state = 'confirming'; } },
    setEntityMatches: () => {},
    setAwaitingPayment: (chatId: string) => { const x = s(chatId); if (x) x.state = 'awaiting_payment'; },
    setAwaitingCategory: (chatId: string) => { const x = s(chatId); if (x) x.state = 'awaiting_category'; },
    setOriginalInput: (chatId: string, t: string) => { const x = s(chatId); if (x) x.originalInput = t; },
    getOriginalInput: (chatId: string) => s(chatId)?.originalInput ?? null,
    setPendingFactura: (chatId: string, f: any) => { const x = s(chatId); if (x) x.pendingFactura = f; },
    getPendingFactura: (chatId: string) => s(chatId)?.pendingFactura ?? null,
    resetSession: (chatId: string) => { const x = s(chatId); if (x) { x.dialogContext = null; x.pendingResult = null; x.state = 'idle'; } },
  };
});

vi.mock('../pdf-extractor', async (importOriginal) => ({
  // Solo se sustituye el parseo del PDF (necesitaría un PDF de verdad): la
  // extracción de items es pura y se usa la real, que es lo que se está probando.
  extractInvoiceItems: (await importOriginal<typeof import('../pdf-extractor')>()).extractInvoiceItems,
  extractFromPDF: async () => ({
    text: caja.texto,
    provider: 'PANADERIA LA ESPIGA',
    ruc: '8-888-8888',
    invoiceNumber: 'FE-2026-00099',
    date: '2026-10-11',
    subtotal: 5.86,
    itbms: 0.41,
    total: 6.27,
    confidence: 0.9,
    source: 'pdf-parse',
  }),
}));

import { processWhatsAppPDF } from '../whatsapp-service';
import { createSession, getSession } from '../wa-session-store';

const CHAT = 'test-items';
const PHONE = '50760000001';

/** Factura DGI con las filas dadas dentro de la sección "Valor Item". */
const factura = (items: string[]) => [
  'FACTURA ELECTRONICA',
  'PANADERIA LA ESPIGA',
  'Valor Item',
  'No. Descripcion Cantidad Precio',
  ...items.map((d, i) => `${i + 1} ${d} 1.000000 1.000000 0.00 1.0000 0.00 1.00000`),
  'Desglose ITBMS',
].join('\n');

const prisma = () => ({
  whatsAppLink: {
    findFirst: async () => ({
      id: 'l1', phoneNumber: PHONE, companyId: 'demo', workerAccountId: null,
      verifiedAt: new Date(), isActive: true,
    }),
  },
  user: { findFirst: async () => ({ id: 'u1', companyId: 'demo', role: 'admin', isActive: true }) },
  concept: {
    findMany: async () => [
      { name: 'Alimentación', accountId: 'acct-alim', confidence: 0.9, keywords: '[]' },
      { name: 'Gastos Varios', accountId: 'acct-varios', confidence: 0.9, keywords: '[]' },
    ],
    findFirst: async () => null,
  },
  account: { findMany: async () => [] },
  expenseClaim: { findFirst: async () => null },
});

const catalogo = [
  { name: 'Alimentación', accountId: 'acct-alim', confidence: 0.9, keywords: '[]' },
  { name: 'Gastos Varios', accountId: 'acct-varios', confidence: 0.9, keywords: '[]' },
];

describe('factura con el ítem que resuelve al final de la lista', () => {
  beforeEach(() => {
    delete process.env.DEEPSEEK_API_KEY; // sin LLM: camino determinista (regex)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    createSession(CHAT, PHONE);
  });

  it('un ítem del medio decide: ni el corte a tres ni la coma pegada lo dejan fuera', async () => {
    // Los ítems se unen con ", " y el mapa no ve la coma pegada ("empanadas,"):
    // el que resuelve va CUARTO (fuera del viejo `slice(0, 3)`) y con la lista
    // terminando en una palabra que el mapa tampoco conoce — si el último ítem
    // fuera del mapa, matchearía él y el test dejaría de probar esto.
    const desconocidos = ['Suspiro', 'Bizcocho', 'Cuajada', 'Yiyi'];
    for (const palabra of desconocidos) {
      expect(conceptoDelMapa(palabra.toLowerCase(), catalogo)).toBeNull();
    }

    caja.texto = factura([...desconocidos.slice(0, 3), 'Empanadas', desconocidos[3]]);
    const reply = await processWhatsAppPDF(prisma() as any, PHONE, CHAT, 'http://wa.local/factura.pdf');

    const ctx: any = getSession(CHAT)!.dialogContext;
    expect(ctx.concept).toBe('Alimentación');
    expect(reply).not.toMatch(/Tipo de compra/i);
  });

  it('la factura reportada (Hojaldre, Hojaldre, Buñuelo, Bistec Picado) sale en Alimentación', async () => {
    caja.texto = factura(['Hojaldre', 'Hojaldre', 'Buñuelo', 'Bistec Picado']);
    const reply = await processWhatsAppPDF(prisma() as any, PHONE, CHAT, 'http://wa.local/factura.pdf');

    const ctx: any = getSession(CHAT)!.dialogContext;
    expect(ctx.concept).toBe('Alimentación');
    expect(reply).not.toMatch(/Gastos Varios/);
  });
});
