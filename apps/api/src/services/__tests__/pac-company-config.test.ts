import { describe, it, expect } from 'vitest';
import {
  buildProviderConfig,
  getPacConfigView,
  probePacCredentials,
  savePacConfig,
  testPacConnection,
} from '../pac/company-config';
import { FACTURA_FACIL_ENDPOINTS } from '../pac/facturafacil';
import { PacError } from '../pac/types';

/**
 * Configuración del PAC por empresa. Lo crítico: los secretos NUNCA salen en la
 * vista, un campo vacío conserva lo guardado, y habilitar la emisión exige UUID,
 * API key y sucursal. El adaptador, además, se niega si las credenciales llegan
 * cifradas (el fantasma del cliente Prisma sin extensión).
 */

const COMPANY_UUID = '11111111-1111-4111-8111-111111111111';
const BRANCH_UUID = '22222222-2222-4222-8222-222222222222';

function fakePrisma(initial: any = null) {
  let row = initial;
  return {
    pacConfig: {
      findUnique: async ({ where }: any) => (row && row.companyId === where.companyId ? row : null),
      upsert: async ({ create, update }: any) => {
        row = row ? { ...row, ...update } : { id: 'pc1', ...create };
        return row;
      },
      update: async ({ data }: any) => {
        row = { ...row, ...data };
        return row;
      },
    },
    fila: () => row,
  } as any;
}

const rowBase = {
  companyId: 'c1',
  provider: 'FACTURA_FACIL',
  environment: 'PRUEBAS',
  companyUuid: COMPANY_UUID,
  pacApiKey: 'secret-key',
  basicUser: null,
  pacBasicPassword: null,
  branchUuid: BRANCH_UUID,
  branchCode: null,
  pos: '001',
  enabled: true,
  lastTestAt: null,
  lastTestOk: null,
  lastTestError: null,
};

describe('PacConfig: vista segura', () => {
  it('sin fila devuelve una ficha vacía y usable', async () => {
    const view = await getPacConfigView(fakePrisma(null), 'c1');
    expect(view.configured).toBe(false);
    expect(view.provider).toBe('FACTURA_FACIL');
    expect(view.environment).toBe('PRUEBAS');
    expect(view.apiKeySet).toBe(false);
  });

  it('nunca expone la API key ni la contraseña Basic', async () => {
    const prisma = fakePrisma(null);
    const view = await savePacConfig(prisma, 'c1', {
      companyUuid: COMPANY_UUID,
      pacApiKey: 'sk_live_super_secreta',
      basicUser: 'usuario',
      pacBasicPassword: 'clave-secreta',
      branchUuid: BRANCH_UUID,
      enabled: true,
    });

    expect(view.apiKeySet).toBe(true);
    expect(view.basicPasswordSet).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sk_live_super_secreta');
    expect(JSON.stringify(view)).not.toContain('clave-secreta');
  });
});

describe('PacConfig: guardado', () => {
  it('crea la ficha incompleta sin habilitar (los accesos llegan después)', async () => {
    const view = await savePacConfig(fakePrisma(null), 'c1', {});
    expect(view.configured).toBe(true);
    expect(view.enabled).toBe(false);
    expect(view.pos).toBe('001');
    expect(view.companyUuid).toBe('');
  });

  it('un campo secreto vacío conserva lo guardado', async () => {
    const prisma = fakePrisma({ ...rowBase });
    const view = await savePacConfig(prisma, 'c1', { pacApiKey: '', pos: '002' });
    expect(prisma.fila().pacApiKey).toBe('secret-key');
    expect(view.pos).toBe('002');
  });

  it('borra la API key solo con clearApiKey (y exige deshabilitar antes)', async () => {
    const prisma = fakePrisma({ ...rowBase });
    await expect(savePacConfig(prisma, 'c1', { clearApiKey: true })).rejects.toThrowError(
      /API key/,
    );

    const view = await savePacConfig(prisma, 'c1', { enabled: false, clearApiKey: true });
    expect(view.apiKeySet).toBe(false);
    expect(prisma.fila().pacApiKey).toBeNull();
  });

  it('habilitar sin UUID/API key/sucursal falla con la lista de lo que falta', async () => {
    await expect(savePacConfig(fakePrisma(null), 'c1', { enabled: true })).rejects.toThrowError(
      /UUID del emisor.*API key.*sucursal/,
    );
  });

  it('valida proveedor, ambiente, POS y código de sucursal', async () => {
    const prisma = fakePrisma(null);
    await expect(savePacConfig(prisma, 'c1', { provider: 'OTRO' })).rejects.toThrowError(
      /no soportado/,
    );
    await expect(savePacConfig(prisma, 'c1', { environment: 'STAGING' })).rejects.toThrowError(
      /PRUEBAS o PRODUCCION/,
    );
    await expect(savePacConfig(prisma, 'c1', { pos: '01' })).rejects.toThrowError(/3 dígitos/);
    await expect(savePacConfig(prisma, 'c1', { branchCode: '123' })).rejects.toThrowError(
      /4 caracteres/,
    );
  });

  it('valida el formato UUID del emisor y de la sucursal', async () => {
    const prisma = fakePrisma(null);
    await expect(savePacConfig(prisma, 'c1', { companyUuid: 'abc' })).rejects.toThrowError(
      /formato UUID/,
    );
    await expect(savePacConfig(prisma, 'c1', { branchUuid: 'abc' })).rejects.toThrowError(
      /formato UUID/,
    );
  });

  it('exige usuario y contraseña Basic juntos', async () => {
    await expect(savePacConfig(fakePrisma(null), 'c1', { basicUser: 'u' })).rejects.toThrowError(
      /juntos/,
    );
  });
});

describe('PacConfig: configuración del adaptador', () => {
  it('se niega a emitir con la emisión deshabilitada', () => {
    expect(() => buildProviderConfig({ ...rowBase, enabled: false })).toThrowError(
      /deshabilitada/,
    );
  });

  it('deriva la URL base del ambiente', () => {
    expect(buildProviderConfig(rowBase).baseUrl).toBe(FACTURA_FACIL_ENDPOINTS.PRUEBAS);
    expect(
      buildProviderConfig({ ...rowBase, environment: 'PRODUCCION' }).baseUrl,
    ).toBe(FACTURA_FACIL_ENDPOINTS.PRODUCCION);
  });

  it('detecta credenciales que llegaron cifradas al adaptador', () => {
    expect(() =>
      buildProviderConfig({ ...rowBase, pacApiKey: 'v1:aa:bb:cc' }),
    ).toThrowError(/cifradas/);
  });

  it('puede probar credenciales sin habilitar la emisión', () => {
    const cfg = buildProviderConfig({ ...rowBase, enabled: false }, { requireEnabled: false });
    expect(cfg.apiKey).toBe('secret-key');
  });
});

describe('PacConfig: prueba de conexión', () => {
  it('un 404 de la consulta prueba que las credenciales son válidas', async () => {
    const provider = {
      find: async () => {
        throw new PacError('no encontrado', 'NOT_FOUND', 404);
      },
    } as any;

    const result = await probePacCredentials(provider);
    expect(result.ok).toBe(true);
  });

  it('un 401/403 se reporta como fallo', async () => {
    const provider = {
      find: async () => {
        throw new PacError('credenciales inválidas', 'AUTH', 401);
      },
    } as any;

    const result = await probePacCredentials(provider);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
  });

  it('sin ficha guardada no hay nada que probar', async () => {
    await expect(testPacConnection(fakePrisma(null), 'c1')).rejects.toThrowError(
      /No hay configuración/,
    );
  });
});
