import { describe, it, expect, afterEach } from 'vitest';
import {
  separarRucDv,
  normalizarRucBase,
  formatearRuc,
  normalizarNombreTercero,
  hashRucBase,
  esIdentificacionEmpresa,
  separarIdentificacion,
} from '../ruc';

describe('separarRucDv', () => {
  it('separa el DV cuando viene pegado como último grupo de 1-2 dígitos', () => {
    expect(separarRucDv('342-240-75526-50')).toEqual({ base: '342-240-75526', dv: '50' });
    expect(separarRucDv('8-733-2267-88')).toEqual({ base: '8-733-2267', dv: '88' });
    expect(separarRucDv('8-733-2267-5')).toEqual({ base: '8-733-2267', dv: '5' });
  });

  it('no parte el cuerpo del RUC ni una cédula corta', () => {
    expect(separarRucDv('342-240-75526')).toEqual({ base: '342-240-75526', dv: null });
    expect(separarRucDv('155592408-2-2015')).toEqual({ base: '155592408-2-2015', dv: null });
    expect(separarRucDv('1234-56')).toEqual({ base: '1234-56', dv: null });
    expect(separarRucDv('794485')).toEqual({ base: '794485', dv: null });
  });

  it('el Número Tributario (NT) de gobierno se conserva entero y sin DV', () => {
    expect(separarRucDv('NT-123-456-7')).toEqual({ base: 'NT-123-456-7', dv: null });
    expect(separarRucDv('NT 123456')).toEqual({ base: 'NT 123456', dv: null });
    expect(separarRucDv('NT123456')).toEqual({ base: 'NT123456', dv: null });
    expect(normalizarRucBase('NT-123-456-7')).toBe('NT1234567');
  });

  it('tolera vacíos y espacios', () => {
    expect(separarRucDv('')).toEqual({ base: '', dv: null });
    expect(separarRucDv(null)).toEqual({ base: '', dv: null });
    expect(separarRucDv('  342-240-75526-50  ')).toEqual({ base: '342-240-75526', dv: '50' });
  });
});

describe('normalizarRucBase / formatearRuc', () => {
  it('compara el mismo RUC con y sin DV', () => {
    expect(normalizarRucBase('342-240-75526-50')).toBe('34224075526');
    expect(normalizarRucBase('342-240-75526')).toBe('34224075526');
    expect(normalizarRucBase('342 240 75526')).toBe('34224075526');
  });

  it('vuelve a armar el RUC con su DV', () => {
    expect(formatearRuc('342-240-75526', '50')).toBe('342-240-75526-50');
    expect(formatearRuc('342-240-75526', null)).toBe('342-240-75526');
    expect(formatearRuc('', '50')).toBe('');
  });
});

describe('esIdentificacionEmpresa (regla B)', () => {
  it('reconoce RUC completos, bases largas y números de gobierno', () => {
    expect(esIdentificacionEmpresa({ taxId: '8-733-2267-88' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxId: '541-81-118009', dv: '06' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxId: '541-81-118009' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxId: '155592408-2-2015' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxId: '342-240-75526' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxId: 'PE-8-913-05' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxId: 'NT-123-456' })).toBe(true);
  });

  it('no confunde cédulas con empresas', () => {
    expect(esIdentificacionEmpresa({ taxId: '4-756-445' })).toBe(false);
    expect(esIdentificacionEmpresa({ taxId: '8-940-27' })).toBe(false);
    expect(esIdentificacionEmpresa({ taxId: '8-1234-567' })).toBe(false);
    expect(esIdentificacionEmpresa({ taxId: '' })).toBe(false);
  });

  it('el tipo explícito manda sobre la forma', () => {
    expect(esIdentificacionEmpresa({ taxIdType: 'CEDULA', taxId: '8-940-27', dv: '27' })).toBe(false);
    expect(esIdentificacionEmpresa({ taxIdType: 'PASAPORTE', taxId: 'AB123456' })).toBe(false);
    expect(esIdentificacionEmpresa({ taxIdType: 'RUC', taxId: '4-756-445' })).toBe(true);
    expect(esIdentificacionEmpresa({ taxIdType: 'NT', taxId: '123' })).toBe(true);
  });
});

describe('separarIdentificacion (respeta el tipo)', () => {
  it('una cédula se guarda entera, aunque termine en 1-2 dígitos', () => {
    expect(separarIdentificacion('8-819-33', 'CEDULA')).toEqual({ base: '8-819-33', dv: null });
    expect(separarIdentificacion('8-940-27', 'CEDULA')).toEqual({ base: '8-940-27', dv: null });
    expect(separarIdentificacion('AB123456', 'PASAPORTE')).toEqual({ base: 'AB123456', dv: null });
  });

  it('un RUC completo de 4 grupos se parte aunque el tipo diga CEDULA', () => {
    expect(separarIdentificacion('8-819-43-33', 'CEDULA')).toEqual({ base: '8-819-43', dv: '33' });
  });

  it('un RUC sí separa base y DV', () => {
    expect(separarIdentificacion('8-819-33', 'RUC')).toEqual({ base: '8-819', dv: '33' });
    expect(separarIdentificacion('8-733-2267-88', 'RUC')).toEqual({ base: '8-733-2267', dv: '88' });
  });

  it('sin tipo usa la forma: cédula entera, RUC partido', () => {
    expect(separarIdentificacion('8-819-33')).toEqual({ base: '8-819-33', dv: null });
    expect(separarIdentificacion('8-733-2267-88')).toEqual({ base: '8-733-2267', dv: '88' });
    expect(separarIdentificacion('541-81-118009')).toEqual({ base: '541-81-118009', dv: null });
  });
});

describe('normalizarNombreTercero', () => {
  it('ignora tildes, mayúsculas, puntuación y sufijos legales', () => {
    expect(normalizarNombreTercero('FERRETERÍA EL TORNILLO, S.A.')).toBe('ferreteria el tornillo');
    expect(normalizarNombreTercero('Ferreteria El Tornillo SA')).toBe('ferreteria el tornillo');
    expect(normalizarNombreTercero('Panamá Corp.')).toBe('panama');
  });
});

describe('hashRucBase', () => {
  const original = process.env.FIELD_ENC_KEY;
  afterEach(() => {
    if (original === undefined) delete process.env.FIELD_ENC_KEY;
    else process.env.FIELD_ENC_KEY = original;
  });

  it('el RUC con y sin DV produce el MISMO hash', () => {
    process.env.FIELD_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(hashRucBase('342-240-75526-50')).toBe(hashRucBase('342-240-75526'));
    expect(hashRucBase('342-240-75526-50')).toHaveLength(64);
  });

  it('RUC distintos producen hashes distintos', () => {
    process.env.FIELD_ENC_KEY = Buffer.alloc(32, 7).toString('base64');
    expect(hashRucBase('342-240-75526')).not.toBe(hashRucBase('342-240-75527'));
  });

  it('sin FIELD_ENC_KEY no hay hash (dedupe por RUC deshabilitado)', () => {
    delete process.env.FIELD_ENC_KEY;
    expect(hashRucBase('342-240-75526')).toBe('');
  });
});
