import { describe, it, expect, vi, beforeEach } from 'vitest';
import { aliasDeDireccion, empresaPorAlias, barrerBuzonCentral } from '../email-inbox';

/**
 * El buzón central es UNO para todas las empresas, y es además la cuenta de
 * correo de quien lo administra. Dos cosas no pueden fallar: que un correo caiga
 * en la empresa del alias correcto, y que **el cuerpo de un correo sin alias
 * registrado no se baje** — abrirlo para ver si era una factura sería leer el
 * correo personal de otro.
 */

vi.mock('../email-factura-pipeline', () => ({
  cargarFacturaDesdeCorreo: async () => ({ estado: 'CARGADA', detalle: null, journalEntryId: 'je-1', claimId: 'claim-1' }),
}));

describe('aliasDeDireccion', () => {
  it('saca el tag de la dirección', () => {
    expect(aliasDeDireccion('hrodced+facturas@gmail.com')).toBe('facturas');
    expect(aliasDeDireccion('hrodced+odesa-2026@googlemail.com')).toBe('odesa-2026');
  });

  it('normaliza a minúsculas (Gmail no distingue)', () => {
    expect(aliasDeDireccion('Hrodced+Facturas@Gmail.com')).toBe('facturas');
  });

  it('sin tag no hay alias', () => {
    expect(aliasDeDireccion('hrodced@gmail.com')).toBeNull();
    expect(aliasDeDireccion('')).toBeNull();
    expect(aliasDeDireccion(null)).toBeNull();
  });
});

describe('empresaPorAlias', () => {
  const prisma = (config: any) => ({
    emailFacturaConfig: {
      findFirst: async ({ where }: any) => (where.inboxAlias.in.includes(config?.inboxAlias) ? config : null),
    },
  });

  it('encuentra la empresa por el alias del destinatario', async () => {
    const cfg = { companyId: 'c1', inboxAlias: 'facturas' };
    expect(await empresaPorAlias(prisma(cfg), ['hrodced+facturas@gmail.com'])).toEqual(cfg);
  });

  it('un alias desconocido no es de nadie', async () => {
    expect(await empresaPorAlias(prisma({ companyId: 'c1', inboxAlias: 'facturas' }), ['hrodced+otra@gmail.com'])).toBeNull();
  });

  it('un correo sin tag tampoco', async () => {
    expect(await empresaPorAlias(prisma({ companyId: 'c1', inboxAlias: 'facturas' }), ['hrodced@gmail.com'])).toBeNull();
  });
});

// ── El poller ────────────────────────────────────────────────────────────────

class ImapCentralFalso {
  mailbox = { uidValidity: 555 };
  mensajes: any[] = [];
  fuentesPedidas: number[] = [];

  async connect() {}
  async logout() {}
  async getMailboxLock() {
    return { release: () => {} };
  }
  async *fetch() {
    for (const m of this.mensajes) yield m;
  }
  async fetchOne(uid: string) {
    this.fuentesPedidas.push(Number(uid));
    return this.mensajes.find((m) => m.uid === Number(uid)) || null;
  }
}

const XML_FACTURA = `<factura><cabecera><dRuc>1555-12345-67</dRuc><dNombEm>FERRETERIA EL TORNILLO S A</dNombEm>
<dNroDF>0000999001</dNroDF><dFechaEm>2026-10-15T10:30:00-05:00</dFechaEm><dNombRec>Empresa Demo</dNombRec></cabecera>
<gTot><dTotNeto>53.50</dTotNeto><dVTot>53.50</dVTot></gTot></factura>`;

/** Un correo MIME de verdad, con el XML de la factura adjunto. */
const emlConFactura = (messageId: string, para: string): Buffer =>
  Buffer.from(
    [
      `From: proveedor@x.com`,
      `To: ${para}`,
      `Subject: Factura electronica`,
      `Message-ID: <${messageId}>`,
      'Date: Thu, 16 Oct 2026 09:00:00 -0500',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="B"',
      '',
      '--B',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Adjunto la factura.',
      '--B',
      'Content-Type: text/xml; name="factura.xml"',
      'Content-Disposition: attachment; filename="factura.xml"',
      '',
      XML_FACTURA,
      '--B--',
      '',
    ].join('\r\n'),
  );

const mensaje = (uid: number, direccion: string, messageId: string) => ({
  uid,
  size: 1000,
  source: emlConFactura(messageId, direccion),
  envelope: { messageId: `<${messageId}>`, subject: `Correo ${uid}`, to: [{ address: direccion }], from: [{ address: 'proveedor@x.com' }], date: new Date('2026-10-16T09:00:00-05:00') },
});

function prismaFalso(configs: any[]) {
  const filas: any[] = [];
  return {
    _filas: filas,
    emailFacturaConfig: {
      findFirst: async ({ where }: any) => configs.find((c) => where.inboxAlias.in.includes(c.inboxAlias) && c.isActive) || null,
      upsert: async ({ where }: any) => configs.find((c) => c.companyId === where.companyId) || { companyId: where.companyId, isActive: true },
    },
    emailFacturaMensaje: {
      create: async ({ data }: any) => {
        if (filas.some((f) => f.messageId === data.messageId)) throw Object.assign(new Error('P2002'), { code: 'P2002' });
        const fila = { id: `fila-${filas.length + 1}`, ...data };
        filas.push(fila);
        return fila;
      },
      update: async ({ where, data }: any) => {
        const f = filas.find((x) => x.id === where.id);
        Object.assign(f, data);
        return f;
      },
      delete: async ({ where }: any) => {
        const i = filas.findIndex((x) => x.id === where.id);
        if (i >= 0) filas.splice(i, 1);
        return {};
      },
    },
  };
}

const CONFIG_CENTRAL = { companyId: 'c1', inboxAlias: 'facturas', isActive: true, modo: 'CENTRAL', cuentaPagoId: 'acc-banco' };

beforeEach(() => {
  process.env.EMAIL_CENTRAL_IMAP_USER = 'buzon@gmail.com';
  process.env.EMAIL_CENTRAL_IMAP_PASS = 'clave';
});

describe('barrerBuzonCentral', () => {
  it('sin credenciales del buzón central no intenta nada', async () => {
    delete process.env.EMAIL_CENTRAL_IMAP_USER;
    const r = await barrerBuzonCentral(prismaFalso([CONFIG_CENTRAL]), { cliente: new ImapCentralFalso() });
    expect(r.ok).toBe(false);
    expect(r.codigo).toBe('SIN_CREDENCIALES');
  });

  it('enruta el correo a la empresa del alias y lo anota en SU ledger', async () => {
    const prisma = prismaFalso([CONFIG_CENTRAL]);
    const imap = new ImapCentralFalso();
    imap.mensajes = [mensaje(10, 'buzon+facturas@gmail.com', 'm10@x')];

    const r = await barrerBuzonCentral(prisma, { cliente: imap });

    expect(r.revisados).toBe(1);
    expect(r.estados).toEqual({ CARGADA: 1 });
    const fila = prisma._filas[0];
    expect(fila.companyId).toBe('c1');
    expect(fila.origen).toBe('CENTRAL');
    expect(fila.estado).toBe('CARGADA');
    expect(imap.fuentesPedidas).toEqual([10]); // solo ese cuerpo se bajó
  });

  it('un correo sin alias registrado se ignora SIN bajar su cuerpo', async () => {
    const prisma = prismaFalso([CONFIG_CENTRAL]);
    const imap = new ImapCentralFalso();
    imap.mensajes = [
      mensaje(20, 'buzon@gmail.com', 'personal@x'),          // correo normal del buzón
      mensaje(21, 'buzon+desconocido@gmail.com', 'otro@x'),  // alias que no es de nadie
      mensaje(22, 'buzon+facturas@gmail.com', 'factura@x'),  // el único que importa
    ];

    const r = await barrerBuzonCentral(prisma, { cliente: imap });

    expect(r.ignorados).toBe(2);
    expect(r.revisados).toBe(1);
    expect(imap.fuentesPedidas).toEqual([22]); // los cuerpos 20 y 21 nunca se pidieron
    expect(prisma._filas).toHaveLength(1);
  });

  it('el mismo correo dos veces no se procesa dos veces (Message-ID)', async () => {
    const prisma = prismaFalso([CONFIG_CENTRAL]);
    const imap = new ImapCentralFalso();
    imap.mensajes = [mensaje(30, 'buzon+facturas@gmail.com', 'm30@x')];
    await barrerBuzonCentral(prisma, { cliente: imap });

    // Otra pasada: el marcador en memoria es por proceso y el ledger es la red.
    const r2 = await barrerBuzonCentral(prisma, { cliente: imap });

    expect(prisma._filas).toHaveLength(1);
    expect(imap.fuentesPedidas).toEqual([30]); // el cuerpo se bajó una sola vez
    expect(r2.revisados + r2.ignorados).toBeGreaterThanOrEqual(0);
  });

  it('una empresa con el buzón apagado no recibe correos', async () => {
    const prisma = prismaFalso([{ ...CONFIG_CENTRAL, isActive: false }]);
    const imap = new ImapCentralFalso();
    imap.mensajes = [mensaje(40, 'buzon+facturas@gmail.com', 'm40@x')];

    const r = await barrerBuzonCentral(prisma, { cliente: imap });

    expect(r.ignorados).toBe(1);
    expect(imap.fuentesPedidas).toEqual([]);
  });
});
