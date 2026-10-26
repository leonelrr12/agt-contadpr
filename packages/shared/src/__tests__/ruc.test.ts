import { describe, it, expect, afterEach } from 'vitest';
import {
  separarRucDv,
  normalizarRucBase,
  formatearRuc,
  normalizarNombreTercero,
  hashRucBase,
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
