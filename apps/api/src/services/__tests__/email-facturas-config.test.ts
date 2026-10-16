import { describe, it, expect } from 'vitest';
import {
  CAMPOS_EMAIL_FACTURA,
  configPublica,
  cuentaBancoDeEmpresa,
  cuentaEsDeBanco,
  getOrCreateEmailConfig,
  parseReceptorRucs,
} from '../email-facturas-config';

/**
 * Dos cosas de la configuración del buzón no pueden fallar en silencio: que la
 * contraseña IMAP nunca salga hacia el navegador, y que la cuenta de
 * contrapartida sea una cuenta de BANCO de la empresa (nunca Caja —en producción
 * está vacía—, nunca la de otra empresa, nunca una bloqueada).
 */

const prismaFalso = (cuentas: any[]) => ({
  account: {
    findMany: async () => cuentas,
    findFirst: async ({ where }: any) =>
      cuentas.find((c) => c.id === where.id && c.companyId === where.companyId) || null,
  },
});

const config = (over: any = {}) => ({
  companyId: 'c1',
  isActive: true,
  modo: 'IMAP',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  imapSecure: true,
  imapUser: 'facturas@empresa.com',
  imapPassword: 'v1:aa:bb:cc',
  imapFolder: 'INBOX',
  marcarLeido: false,
  carpetaMover: null,
  inboxAlias: 'odesa',
  cuentaPagoId: 'acc-banco',
  metodoPago: 'TRANSFERENCIA',
  conceptoDefaultId: 'con-1',
  ultimaCorridaAt: new Date('2026-10-15T09:00:00'),
  ultimoEstado: 'OK',
  ultimoDetalle: null,
  ...over,
});

describe('configPublica', () => {
  it('NUNCA devuelve la contraseña, solo si hay una guardada', () => {
    const pub = configPublica(config());
    expect(pub).not.toHaveProperty('imapPassword');
    expect(JSON.stringify(pub)).not.toContain('v1:aa:bb:cc');
    expect(pub.tienePassword).toBe(true);
  });

  it('sin contraseña guardada lo dice, para que la tarjeta pida una', () => {
    expect(configPublica(config({ imapPassword: null })).tienePassword).toBe(false);
  });

  it('devuelve todos los campos de la tarjeta y el estado de la última corrida', () => {
    const pub = configPublica(config());
    for (const { field } of CAMPOS_EMAIL_FACTURA) expect(pub).toHaveProperty(field);
    expect(pub.ultimoEstado).toBe('OK');
    expect(pub.inboxAlias).toBe('odesa');
    expect(pub.metodoPago).toBe('TRANSFERENCIA');
  });

  it('una fila recién creada no rompe la tarjeta', () => {
    const pub = configPublica({ companyId: 'c1', imapPassword: null });
    expect(pub.isActive).toBeNull();
    expect(pub.tienePassword).toBe(false);
  });
});

describe('cuentaEsDeBanco', () => {
  it('acepta las cuentas de banco', () => {
    expect(cuentaEsDeBanco('1.1.02.01')).toBe(true);
    expect(cuentaEsDeBanco(' 1.1.02.07 ')).toBe(true);
  });

  it('rechaza la Caja: en producción está vacía y acreditarla mentiría el asiento', () => {
    expect(cuentaEsDeBanco('1.1.01')).toBe(false);
    expect(cuentaEsDeBanco('1.1.01.02')).toBe(false);
  });

  it('rechaza tarjetas y cualquier otra cuenta', () => {
    expect(cuentaEsDeBanco('2.1.03.01')).toBe(false);
    expect(cuentaEsDeBanco('5.1.01')).toBe(false);
    expect(cuentaEsDeBanco(null)).toBe(false);
    expect(cuentaEsDeBanco('')).toBe(false);
  });
});

describe('cuentaBancoDeEmpresa', () => {
  const banco = { id: 'b1', code: '1.1.02.01', name: 'Banco General', companyId: 'c1', isActive: true, isBlocked: false };

  it('devuelve la cuenta cuando es de banco, de la empresa y está usable', async () => {
    const r = await cuentaBancoDeEmpresa(prismaFalso([banco]), 'c1', 'b1');
    expect(r).toEqual({ id: 'b1', code: '1.1.02.01', name: 'Banco General' });
  });

  it('una cuenta de OTRA empresa no resuelve', async () => {
    expect(await cuentaBancoDeEmpresa(prismaFalso([banco]), 'c2', 'b1')).toBeNull();
  });

  it('bloqueada o inactiva tampoco: el asiento no podría usarla', async () => {
    expect(await cuentaBancoDeEmpresa(prismaFalso([{ ...banco, isBlocked: true }]), 'c1', 'b1')).toBeNull();
    expect(await cuentaBancoDeEmpresa(prismaFalso([{ ...banco, isActive: false }]), 'c1', 'b1')).toBeNull();
  });

  it('una cuenta que no es de banco se rechaza aunque sea de la empresa', async () => {
    const caja = { ...banco, id: 'b2', code: '1.1.01' };
    expect(await cuentaBancoDeEmpresa(prismaFalso([caja]), 'c1', 'b2')).toBeNull();
  });

  it('sin id no hay cuenta (la empresa todavía no eligió)', async () => {
    expect(await cuentaBancoDeEmpresa(prismaFalso([banco]), 'c1', null)).toBeNull();
    expect(await cuentaBancoDeEmpresa(prismaFalso([banco]), 'c1', undefined)).toBeNull();
  });
});

describe('getOrCreateEmailConfig', () => {
  it('crea la fila perezosamente sin pisar la que ya existe', async () => {
    let llamada: any = null;
    const prisma = {
      emailFacturaConfig: {
        upsert: async (args: any) => {
          llamada = args;
          return { companyId: 'c1' };
        },
      },
    };
    await getOrCreateEmailConfig(prisma, 'c1');
    expect(llamada.where).toEqual({ companyId: 'c1' });
    expect(llamada.update).toEqual({}); // abrir la pantalla no cambia nada
    expect(llamada.create).toEqual({ companyId: 'c1' });
  });
});

describe('parseReceptorRucs', () => {
  it('acepta la lista del navegador (texto separado por comas)', () => {
    expect(parseReceptorRucs('8-123-4567, 1555-1234-5678; 794485')).toEqual(['81234567', '155512345678', '794485']);
  });

  it('acepta el JSON que se guarda en la base', () => {
    expect(parseReceptorRucs('["794485","8-123-4567"]')).toEqual(['794485', '81234567']);
  });

  it('saca repetidos, basura y lo que es demasiado corto para ser un RUC', () => {
    expect(parseReceptorRucs('794485, 794485, 12, abc, ') ).toEqual(['794485']);
  });

  it('sin nada devuelve la lista vacía (comportamiento de siempre)', () => {
    expect(parseReceptorRucs(null)).toEqual([]);
    expect(parseReceptorRucs('')).toEqual([]);
    expect(parseReceptorRucs('[]')).toEqual([]);
  });

  it('configPublica lo devuelve como lista, no como el JSON guardado', () => {
    expect(configPublica(config({ receptorRucs: '["794485"]' })).receptorRucs).toEqual(['794485']);
  });
});
