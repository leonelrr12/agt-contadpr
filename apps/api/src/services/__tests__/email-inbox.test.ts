import { describe, it, expect } from 'vitest';
import { clasificarErrorImap, faltanCredenciales } from '../email-inbox';

/**
 * El servidor de correo contesta en su idioma («Invalid credentials», «NO
 * [AUTHENTICATIONFAILED]»); la tarjeta y el estado de la corrida tienen que
 * decirle al contador si el problema son las credenciales o la conexión, porque
 * la solución es distinta: revisar la app password, o esperar y reintentar.
 */

describe('faltanCredenciales', () => {
  const completo = { imapHost: 'imap.gmail.com', imapUser: 'a@b.com', imapPassword: 'secreta' };

  it('con servidor, usuario y contraseña se puede intentar', () => {
    expect(faltanCredenciales(completo)).toBe(false);
  });

  it('sin ninguno de los tres no se intenta', () => {
    expect(faltanCredenciales({})).toBe(true);
    expect(faltanCredenciales({ ...completo, imapPassword: null })).toBe(true);
    expect(faltanCredenciales({ ...completo, imapHost: '' })).toBe(true);
  });
});

describe('clasificarErrorImap', () => {
  it('el rechazo de credenciales de imapflow es ERROR_CREDENCIALES', () => {
    const err = Object.assign(new Error('Authentication failed'), {
      authenticationFailed: true,
      responseText: 'Invalid credentials (Failure)',
    });
    const r = clasificarErrorImap(err);
    expect(r.codigo).toBe('ERROR_CREDENCIALES');
    expect(r.detalle).toContain('Invalid credentials');
  });

  it('el código del servidor también alcanza, aunque el mensaje no lo diga', () => {
    const err = { serverResponseCode: 'AUTHENTICATIONFAILED', responseText: 'NO' };
    expect(clasificarErrorImap(err).codigo).toBe('ERROR_CREDENCIALES');
  });

  it('un servidor caído es ERROR_CONEXION, no credenciales', () => {
    const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:993'), { code: 'ECONNREFUSED' });
    expect(clasificarErrorImap(err).codigo).toBe('ERROR_CONEXION');
  });

  it('un timeout también es ERROR_CONEXION', () => {
    expect(clasificarErrorImap({ code: 'ETIMEOUT', message: 'Connection timeout' }).codigo).toBe('ERROR_CONEXION');
  });

  it('sin mensaje no revienta', () => {
    expect(clasificarErrorImap({}).codigo).toBe('ERROR_CONEXION');
  });
});
