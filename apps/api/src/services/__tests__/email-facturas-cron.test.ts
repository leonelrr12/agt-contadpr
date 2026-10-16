import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tocaCorrer, correrBarridoDiario } from '../email-facturas-cron';

/**
 * El cron tiene dos trabajos y los dos importan: decidir CUÁNDO (una vez al día,
 * con catch-up si el VPS estaba caído) y que una empresa con las credenciales
 * mal no deje sin leer a las demás. Lo segundo es lo que se rompe en silencio:
 * un `throw` sin atrapar en la empresa 1 y las 20 siguientes no se barren nunca.
 */

const barridos = vi.hoisted(() => ({ llamadas: [] as string[], falla: new Set<string>() }));

vi.mock('../email-inbox', () => ({
  barrerFacturasPorCorreo: async (_prisma: any, companyId: string) => {
    barridos.llamadas.push(companyId);
    if (barridos.falla.has(companyId)) throw new Error('el barrido explotó');
    return { ok: true, revisados: 0, facturas: 0, estados: {} };
  },
}));

const prismaFalso = (configs: any[]) => ({
  emailFacturaConfig: { findMany: async () => configs },
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
