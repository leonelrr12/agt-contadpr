import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ESTADOS_QUE_AVISAN, mereceAviso, componerAviso, avisarProblemas } from '../email-facturas-avisos';
import { ESTADOS_REPROCESABLES } from '../email-inbox';

/**
 * El aviso por correo existe para que una factura que no se cargó no se
 * descubra por casualidad. Dos cosas importan: que avise solo cuando hay algo
 * que una persona puede arreglar (un boletín no es un problema), y que no se
 * convierta en spam cuando el mismo problema se repite en cada pasada.
 */

const enviados = vi.hoisted(() => ({ correos: [] as any[] }));

vi.mock('../mailer', () => ({
  APP_URL: 'https://contador507.com',
  sendEmail: async (to: string, subject: string, text: string, html: string) => {
    enviados.correos.push({ to, subject, text, html });
    return true;
  },
}));

const problema = (estado: string, over: any = {}) => ({ estado, proveedor: 'RIBA SMITH S A', numeroFactura: '0000378805', ...over });

const prismaFalso = (usuarios: any[] = [{ email: 'dueno@empresa.com' }]) => ({
  company: { findUnique: async () => ({ name: 'Empresa Demo' }) },
  user: { findMany: async () => usuarios },
});

beforeEach(() => {
  enviados.correos = [];
  delete process.env.EMAIL_FACTURAS_AVISOS;
});
afterEach(() => {
  delete process.env.EMAIL_FACTURAS_AVISOS;
});

describe('la lista de estados', () => {
  it('es la misma que «Reprocesar» puede reintentar (si se separan, esto lo dice)', () => {
    expect([...ESTADOS_QUE_AVISAN].sort()).toEqual([...ESTADOS_REPROCESABLES].sort());
  });

  it('lo normal NO avisa: un boletín, un correo sin factura, una repetida', () => {
    expect(mereceAviso({ problemas: [problema('SIN_ADJUNTOS'), problema('SIN_FACTURA'), problema('DUPLICADA'), problema('CARGADA')] })).toBe(false);
  });

  it('lo que una persona puede arreglar SÍ avisa', () => {
    for (const estado of ESTADOS_QUE_AVISAN) {
      expect(mereceAviso({ problemas: [problema(estado)] })).toBe(true);
    }
  });

  it('una corrida que no se pudo hacer avisa aunque no haya facturas', () => {
    expect(mereceAviso({ problemas: [], fallo: { codigo: 'ERROR_CREDENCIALES', detalle: 'Invalid credentials' } })).toBe(true);
  });
});

describe('componerAviso', () => {
  it('nombra la empresa, el proveedor, el número y el estado', () => {
    const { subject, text } = componerAviso('Empresa Demo', { problemas: [problema('OTRO_CLIENTE', { detalle: 'La factura está a nombre de otra persona' })] });
    expect(subject).toContain('Empresa Demo');
    expect(subject).toContain('1 factura');
    expect(text).toContain('RIBA SMITH S A Nº 0000378805');
    expect(text).toContain('OTRO_CLIENTE');
    expect(text).toContain('La factura está a nombre de otra persona');
    expect(text).toContain('Administración → Configuración'); // qué hacer
  });

  it('un buzón caído se avisa distinto y dice qué pasa mientras tanto', () => {
    const { subject, text } = componerAviso('Empresa Demo', {
      problemas: [],
      fallo: { codigo: 'ERROR_CREDENCIALES', detalle: 'El servidor rechazó el usuario o la contraseña.' },
    });
    expect(subject).toContain('no se pudo leer');
    expect(text).toContain('ERROR_CREDENCIALES');
    expect(text).toContain('no se está cargando ninguna factura nueva');
  });

  it('no avisa por lo que no es un problema, aunque venga en la lista', () => {
    const { subject, text } = componerAviso('Empresa Demo', { problemas: [problema('SIN_ADJUNTOS'), problema('DUPLICADA')] });
    expect(subject).toContain('0 facturas');
    expect(text).not.toContain('SIN_ADJUNTOS');
  });

  it('escapa lo que venga del correo (el asunto lo escribe un tercero)', () => {
    const { html } = componerAviso('Empresa Demo', { problemas: [problema('ERROR', { proveedor: '<img src=x onerror=alert(1)>' })] });
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img');
  });
});

describe('avisarProblemas', () => {
  it('manda a los admin activos de la empresa', async () => {
    const r = await avisarProblemas(prismaFalso([{ email: 'a@x.com' }, { email: 'b@x.com' }]), 'c1', { problemas: [problema('SIN_CUENTA')] });
    expect(r).toBe(true);
    expect(enviados.correos.map((c) => c.to)).toEqual(['a@x.com', 'b@x.com']);
  });

  it('no manda nada si no hay nada que avisar', async () => {
    const r = await avisarProblemas(prismaFalso(), 'c1', { problemas: [problema('SIN_ADJUNTOS')] });
    expect(r).toBe(false);
    expect(enviados.correos).toEqual([]);
  });

  it('no repite el mismo aviso el mismo día (el buzón caído avisa una vez, no cada media hora)', async () => {
    const apagado = { problemas: [], fallo: { codigo: 'ERROR_CREDENCIALES', detalle: 'x' } };
    await avisarProblemas(prismaFalso(), 'c1', apagado);
    await avisarProblemas(prismaFalso(), 'c1', apagado);

    expect(enviados.correos).toHaveLength(1);
  });

  it('un problema DISTINTO el mismo día sí se avisa', async () => {
    await avisarProblemas(prismaFalso(), 'c2', { problemas: [problema('SIN_CUENTA')] });
    await avisarProblemas(prismaFalso(), 'c2', { problemas: [problema('OTRO_CLIENTE')] });

    expect(enviados.correos).toHaveLength(2);
  });

  it('se puede apagar con EMAIL_FACTURAS_AVISOS=false', async () => {
    process.env.EMAIL_FACTURAS_AVISOS = 'false';
    const r = await avisarProblemas(prismaFalso(), 'c3', { problemas: [problema('SIN_CUENTA')] });
    expect(r).toBe(false);
    expect(enviados.correos).toEqual([]);
  });

  it('sin admin con correo, no rompe: avisa en el log y sigue', async () => {
    const r = await avisarProblemas(prismaFalso([]), 'c4', { problemas: [problema('SIN_CUENTA')] });
    expect(r).toBe(false);
  });

  it('nunca lanza, aunque la BD falle', async () => {
    const prisma = { company: { findUnique: async () => { throw new Error('sin BD'); } } };
    await expect(avisarProblemas(prisma, 'c5', { problemas: [problema('SIN_CUENTA')] })).resolves.toBe(false);
  });
});
