import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import vm from 'vm';

/**
 * La tarjeta de emisión electrónica (PAC) de Administración → Empresa.
 *
 * Lo que no puede fallar: los secretos se muestran como «guardada» y nunca se
 * reenvían vacíos (vacío = conservar), el ambiente de producción se confirma
 * antes de guardar, y el HTML escapa lo que viene del backend.
 */

const ARCHIVO = path.join(__dirname, '../../../../web/public/js/empresa.js');

const ENTIDADES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function sandboxEmpresa() {
  const sb: any = {
    console,
    API_URL: '/api',
    JSON, Object, Array, String, Number, Math, Date, Promise, Error, RegExp,
    setTimeout: (fn: any) => fn(),
    clearTimeout: () => {},
    escapeHtml: (s: any) => String(s ?? '').replace(/[&<>"']/g, (c) => ENTIDADES[c] ?? c),
    showAlert: async () => {},
    showConfirm: async () => true,
    authFetch: async () => ({ ok: true, json: async () => ({}) }),
    document: { getElementById: () => null },
    localStorage: { getItem: () => null, setItem: () => {} },
  };
  sb.window = sb;
  sb.globalThis = sb;
  vm.runInNewContext(fs.readFileSync(ARCHIVO, 'utf8'), sb, { timeout: 5000, filename: 'empresa.js' });
  return sb;
}

const PAC = {
  configured: true,
  provider: 'FACTURA_FACIL',
  environment: 'PRUEBAS',
  companyUuid: '11111111-1111-4111-8111-111111111111',
  pos: '002',
  branchUuid: '22222222-2222-4222-8222-222222222222',
  branchCode: '',
  basicUser: 'usuario-api',
  // La vista del backend NUNCA trae los secretos, solo los booleanos.
  enabled: true,
  apiKeySet: true,
  basicPasswordSet: false,
  lastTestAt: '2026-10-20T18:00:00.000Z',
  lastTestOk: true,
  lastTestError: null,
};

/** Documento falso con los campos que lee savePacConfigUI. */
function montarCampos(sb: any, overrides: Record<string, any> = {}) {
  const valores: Record<string, any> = {
    'emp-pac-provider': 'FACTURA_FACIL',
    'emp-pac-env': 'PRUEBAS',
    'emp-pac-base-url': '',
    'emp-pac-company-uuid': ' 11111111-1111-4111-8111-111111111111 ',
    'emp-pac-api-key': '',
    'emp-pac-basic-user': '',
    'emp-pac-basic-password': '',
    'emp-pac-api-user': '',
    'emp-pac-api-password': '',
    'emp-pac-branch-uuid': '',
    'emp-pac-branch-code': '0001',
    'emp-pac-pos': '001',
    ...overrides,
  };
  const elementos: Record<string, any> = {};
  for (const [id, valor] of Object.entries(valores)) {
    elementos[id] = id === 'emp-pac-enabled' ? { checked: valor } : { value: valor };
  }
  elementos['emp-pac-enabled'] = { checked: overrides['emp-pac-enabled'] ?? true };
  elementos['emp-pac-saved-msg'] = { style: {} };
  sb.document = { getElementById: (id: string) => elementos[id] || null };
  return elementos;
}

describe('tarjeta PAC en la ficha de la empresa', () => {
  it('muestra «guardada» para los secretos y el estado de la última prueba', () => {
    const sb = sandboxEmpresa();
    const html = sb.renderEmpresaPacCard(PAC, false);

    expect(html).toContain('•••••••• (guardada)');
    expect(html).toContain('✅ Última prueba OK');
    expect(html).toContain('value="11111111-1111-4111-8111-111111111111"');
    expect(html).toContain('value="002"');
    expect(html).toContain('checked');
  });

  it('escapa lo que viene del backend', () => {
    const sb = sandboxEmpresa();
    const html = sb.renderEmpresaPacCard(
      { ...PAC, companyUuid: '"><script>alert(1)</script>' },
      false,
    );

    expect(html).not.toContain('<script>');
    expect(html).toContain('&quot;&gt;&lt;script&gt;');
  });

  it('avisa si la configuración no se pudo cargar', () => {
    const sb = sandboxEmpresa();
    const html = sb.renderEmpresaPacCard(null, true);
    expect(html).toContain('No se pudo cargar la configuración del PAC');
  });

  it('no reenvía secretos vacíos: vacío significa conservar', async () => {
    const sb = sandboxEmpresa();
    montarCampos(sb);
    let enviado: any = null;
    sb.authFetch = async (_url: string, opts: any) => {
      enviado = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ...PAC, apiKeySet: true }) };
    };

    await sb.savePacConfigUI();

    expect(enviado).not.toHaveProperty('pacApiKey');
    expect(enviado).not.toHaveProperty('pacBasicPassword');
    expect(enviado.branchCode).toBe('0001');
    expect(enviado.enabled).toBe(true);
    expect(enviado.companyUuid).toBe('11111111-1111-4111-8111-111111111111');
  });

  it('envía los secretos solo cuando el usuario escribe uno nuevo', async () => {
    const sb = sandboxEmpresa();
    montarCampos(sb, { 'emp-pac-api-key': ' sk_nueva ', 'emp-pac-basic-password': 'clave' });
    let enviado: any = null;
    sb.authFetch = async (_url: string, opts: any) => {
      enviado = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ...PAC, basicPasswordSet: true }) };
    };

    await sb.savePacConfigUI();

    expect(enviado.pacApiKey).toBe('sk_nueva');
    expect(enviado.pacBasicPassword).toBe('clave');
  });

  it('pide confirmación al pasar a PRODUCCIÓN y no guarda si se cancela', async () => {
    const sb = sandboxEmpresa();
    sb.empresaPacActual = PAC; // venía de PRUEBAS
    montarCampos(sb, { 'emp-pac-env': 'PRODUCCION' });
    let confirmado = 0;
    let llamado = 0;
    sb.showConfirm = async () => {
      confirmado++;
      return false;
    };
    sb.authFetch = async () => {
      llamado++;
      return { ok: true, json: async () => PAC };
    };

    await sb.savePacConfigUI();

    expect(confirmado).toBe(1);
    expect(llamado).toBe(0);
  });
});

describe('tarjeta PAC: proveedor HKA', () => {
  const PAC_HKA = {
    ...PAC,
    provider: 'HKA',
    companyUuid: '',
    apiUser: 'usuario-hka',
    apiPasswordSet: true,
    branchUuid: '',
    branchCode: '0000',
    baseUrl: 'https://demointegracion.thefactoryhka.com.pa/api',
  };

  it('arma el selector con el catálogo que manda la API', () => {
    const sb = sandboxEmpresa();
    const html = sb.renderEmpresaPacCard(
      {
        ...PAC,
        provider: 'OTRO',
        providers: [
          { id: 'FACTURA_FACIL', label: 'Factura Fácil' },
          { id: 'OTRO', label: 'Otro PAC' },
        ],
      },
      false,
    );

    expect(html).toContain('value="OTRO" selected');
    expect(html).toContain('Otro PAC');
  });

  it('muestra HKA seleccionado y los campos de integración', () => {
    const sb = sandboxEmpresa();
    const html = sb.renderEmpresaPacCard(PAC_HKA, false);

    expect(html).toContain('value="HKA" selected');
    expect(html).toContain('value="usuario-hka"');
    expect(html).toContain('•••••••• (guardada)');
    expect(html).toContain('value="https://demointegracion.thefactoryhka.com.pa/api"');
    expect(html).toContain('emp-pac-hka-fields');
  });

  it('guarda los campos de HKA y no reenvía la clave vacía', async () => {
    const sb = sandboxEmpresa();
    montarCampos(sb, {
      'emp-pac-provider': 'HKA',
      'emp-pac-api-user': ' usuario-hka ',
      'emp-pac-base-url': 'https://demo.test/api',
      'emp-pac-branch-code': '0000',
    });
    let enviado: any = null;
    sb.authFetch = async (_url: string, opts: any) => {
      enviado = JSON.parse(opts.body);
      return { ok: true, json: async () => PAC_HKA };
    };

    await sb.savePacConfigUI();

    expect(enviado.provider).toBe('HKA');
    expect(enviado.apiUser).toBe('usuario-hka');
    expect(enviado.baseUrl).toBe('https://demo.test/api');
    expect(enviado.branchCode).toBe('0000');
    expect(enviado).not.toHaveProperty('apiPassword');
    expect(enviado).not.toHaveProperty('companyUuid');
    expect(enviado).not.toHaveProperty('pacApiKey');
  });

  it('limpia la clave HKA si se borra el usuario', async () => {
    const sb = sandboxEmpresa();
    // `empresaPacActual` es un `let` del script: hay que asignarlo dentro del
    // contexto del vm, no como propiedad del sandbox.
    vm.runInContext(`empresaPacActual = ${JSON.stringify(PAC_HKA)};`, sb);
    montarCampos(sb, { 'emp-pac-provider': 'HKA', 'emp-pac-api-user': '' });
    let enviado: any = null;
    sb.authFetch = async (_url: string, opts: any) => {
      enviado = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ ...PAC_HKA, apiPasswordSet: false }) };
    };

    await sb.savePacConfigUI();

    expect(enviado.clearApiPassword).toBe(true);
  });
});
