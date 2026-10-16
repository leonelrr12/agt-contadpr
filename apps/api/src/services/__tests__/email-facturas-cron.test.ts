import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tocaCorrer, correrBarridoDiario } from '../email-facturas-cron';

/**
 * El cron tiene dos trabajos y los dos importan: decidir CUÁNDO (una vez al día,
 * con catch-up si el VPS estaba caído) y que una empresa con las credenciales
 * mal no deje sin leer a las demás. Lo segundo es lo que se rompe en silencio:
 * un `throw` sin atrapar en la empresa 1 y las 20 siguientes no se barren nunca.
 */

const barridos = vi.hoisted(() => ({
  llamadas: [] as string[],
  falla: new Set<string>(),
  central: 0,
  resultadoCentral: { ok: true, revisados: 0, facturas: 0, estados: {}, ignorados: 0 } as any,
}));

vi.mock('../email-inbox', () => ({
  barrerFacturasPorCorreo: async (_prisma: any, companyId: string) => {
    barridos.llamadas.push(companyId);
    if (barridos.falla.has(companyId)) throw new Error('el barrido explotó');
    return { ok: true, revisados: 0, facturas: 0, estados: {} };
  },
  barrerBuzonCentral: async () => {
    barridos.central++;
    return barridos.resultadoCentral;
  },
}));

const prismaFalso = (configs: any[], empresasCentral = 0) => ({
  emailFacturaConfig: { findMany: async () => configs, count: async () => empresasCentral },
});

const HOY = (hora: number, minuto = 0) => new Date(2026, 9, 16, hora, minuto, 0);
const config = (companyId: string, ultimaCorridaAt: Date | null = null, extra: any = {}) => ({
  companyId,
  ultimaCorridaAt,
  isActive: true,
  imapHost: 'imap.test',
  imapUser: 'u',
  ...extra,
});

beforeEach(() => {
  barridos.llamadas = [];
  barridos.falla = new Set();
  barridos.central = 0;
  barridos.resultadoCentral = { ok: true, revisados: 0, facturas: 0, estados: {}, ignorados: 0 };
  delete process.env.EMAIL_CENTRAL_IMAP_USER;
  delete process.env.EMAIL_CENTRAL_IMAP_PASS;
});

describe('tocaCorrer', () => {
  it('antes de la hora objetivo no se barre', () => {
    expect(tocaCorrer(HOY(2, 59), null)).toBe(false);
  });

  it('pasada la hora, si no hubo corrida hoy, se barre (catch-up si el VPS estaba caído)', () => {
    expect(tocaCorrer(HOY(3, 0), null)).toBe(true);
    expect(tocaCorrer(HOY(9, 30), new Date(2026, 9, 15, 3, 5))).toBe(true); // la última fue ayer
  });

  it('si ya se barrió hoy, no se repite', () => {
    expect(tocaCorrer(HOY(9, 30), new Date(2026, 9, 16, 3, 5))).toBe(false);
    // Y una corrida MANUAL al mediodía también cuenta: el dueño ya miró el buzón hoy.
    expect(tocaCorrer(HOY(23, 59), new Date(2026, 9, 16, 12, 0))).toBe(false);
  });

  it('una corrida de ayer a la misma hora no cuenta como de hoy', () => {
    expect(tocaCorrer(HOY(3, 0), new Date(2026, 9, 15, 3, 0))).toBe(true);
  });

  it('la hora objetivo es configurable', () => {
    expect(tocaCorrer(HOY(5, 0), null, 6)).toBe(false);
    expect(tocaCorrer(HOY(6, 0), null, 6)).toBe(true);
  });
});

describe('correrBarridoDiario', () => {
  it('barre solo las que les toca', async () => {
    const prisma = prismaFalso([
      config('c1'), // nunca corrió
      config('c2', new Date(2026, 9, 16, 3, 5)), // ya corrió hoy
    ]);

    const r = await correrBarridoDiario(prisma, HOY(9));

    expect(barridos.llamadas).toEqual(['c1']);
    expect(r).toMatchObject({ empresas: 2, corridas: 1, fallidas: 0 });
  });

  it('una empresa que falla no deja sin barrer a las demás', async () => {
    barridos.falla = new Set(['c2']);
    const prisma = prismaFalso([config('c1'), config('c2'), config('c3')]);

    const r = await correrBarridoDiario(prisma, HOY(9));

    expect(barridos.llamadas.sort()).toEqual(['c1', 'c2', 'c3']); // se intentaron todas
    expect(r).toMatchObject({ empresas: 3, corridas: 2, fallidas: 1 });
  });

  it('un error inesperado del barrido no corta la pasada', async () => {
    barridos.falla = new Set(['c1']);
    const prisma = prismaFalso([config('c1'), config('c2')]);

    const r = await correrBarridoDiario(prisma, HOY(9));

    expect(r.corridas).toBe(1);
    expect(r.fallidas).toBe(1);
  });

  it('si la BD no responde, la pasada termina sin lanzar', async () => {
    const prisma = {
      emailFacturaConfig: {
        findMany: async () => {
          throw new Error('sin conexión');
        },
      },
    };

    const r = await correrBarridoDiario(prisma, HOY(9));

    expect(r).toEqual({ empresas: 0, corridas: 0, fallidas: 0 });
  });

  it('de madrugada, antes de la hora, no barre nada', async () => {
    const prisma = prismaFalso([config('c1')]);
    const r = await correrBarridoDiario(prisma, HOY(2));
    expect(barridos.llamadas).toEqual([]);
    expect(r.corridas).toBe(0);
  });
});

describe('correrBarridoDiario — el buzón central', () => {
  it('sin ninguna empresa en modo CENTRAL no se toca ese buzón', async () => {
    const prisma = prismaFalso([config('c1')], 0);

    const r = await correrBarridoDiario(prisma, HOY(9));

    expect(barridos.central).toBe(0); // ni se conecta
    expect(r.central).toBeUndefined();
  });

  it('con una empresa usándolo, se barre una vez', async () => {
    barridos.resultadoCentral = { ok: true, revisados: 3, facturas: 1, estados: {}, ignorados: 2 };
    const prisma = prismaFalso([], 1);

    const r = await correrBarridoDiario(prisma, HOY(9));

    expect(barridos.central).toBe(1);
    expect(r.central).toMatchObject({ revisados: 3, ignorados: 2 });
  });

  it('sin las credenciales del buzón central, avisa y no gasta el día', async () => {
    // Sin EMAIL_CENTRAL_IMAP_* el poller no puede entrar: la pasada se reintenta
    // en el próximo tick en vez de esperar 24 horas. (El marcador de la corrida
    // central vive en el proceso, así que este test usa el día siguiente.)
    const MANANA = (hora: number) => new Date(2026, 9, 17, hora, 0, 0);
    barridos.resultadoCentral = { ok: false, revisados: 0, facturas: 0, estados: {}, ignorados: 0, codigo: 'SIN_CREDENCIALES' };
    const prisma = prismaFalso([], 1);

    const primera = await correrBarridoDiario(prisma, MANANA(9));
    const segunda = await correrBarridoDiario(prisma, MANANA(10));

    expect(primera.central?.codigo).toBe('SIN_CREDENCIALES');
    expect(barridos.central).toBe(2); // se volvió a intentar
    expect(segunda.central?.codigo).toBe('SIN_CREDENCIALES');
  });
});
