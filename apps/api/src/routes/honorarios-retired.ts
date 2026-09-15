import { Router } from 'express';

/**
 * El modo Honorarios se retiró (Anexo-DGI Fase E): los honorarios entran por la
 * carga general de Transacciones — el concepto "Honorarios" clasifica a la cuenta
 * 6.02.01, que el usuario marca con "Lleva Anexo" para exigir RUC/Cédula y Nombre.
 *
 * Este stub devuelve 410 con la guía para los navegadores que aún tengan en caché
 * el JS viejo (js/honorarios.js) y sigan llamando al endpoint retirado.
 */
export const honorariosRetiredRouter = Router();

honorariosRetiredRouter.use((_req, res) => {
  res.status(410).json({
    error: 'El modo Honorarios ya no existe. Carga los honorarios en Importar → Transacciones: el concepto "Honorarios" los lleva a la cuenta 6.02.01 (márcala con "Lleva Anexo" en Administración → Cuentas para exigir RUC/Cédula y Nombre).',
    code: 'HONORARIOS_RETIRED',
  });
});
