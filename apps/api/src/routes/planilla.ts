import { Router } from 'express';
import multer from 'multer';
import { requireRole } from '../middleware/auth';
import { requireQuota, incrementUsage } from '../middleware/quota';
import { validate } from '../middleware/validate';
import { localDateKey } from '../services/tabular-utils';
import {
  previsualizarCorrida,
  ejecutarCorrida,
  anularCorrida,
  revisarCorrida,
  listarCorridas,
  obtenerCorrida,
  corridaACSV,
  finDePeriodo,
  type OpcionesCorrida,
} from '../services/payroll-run';
import { loadCompanyAccounts, filterPayoutAccounts } from '../services/account-resolver';
import { parseLocalDate } from '../lib/dates';
import { parseRosterFile, type TipoPago } from '../services/payroll-roster';
import {
  listarEmpleados,
  obtenerEmpleado,
  crearEmpleado,
  actualizarEmpleado,
} from '../services/payroll-empleados';
import {
  PLANILLA_FIELDS,
  getOrCreateSettings,
  parseTablaISR,
  parseRiesgosPorClase,
  resolverCuentasPlanilla,
} from '../services/payroll-parametros';
import { CLASES_RIESGO, DIAS_SEMANA } from '../services/payroll-calc';
import { resumenCSS, registrarPagoCSS, valorarCSS } from '../services/payroll-css';
import { cuadrePlanilla } from '../services/payroll-cuadre';
import {
  createEmpleadoSchema,
  updateEmpleadoSchema,
  updatePayrollSettingsSchema,
  tipoPagoSchema,
  corridaSchema,
  anularCorridaSchema,
  revisarCorridaSchema,
  pagoCSSSchema,
  type UpdatePayrollSettingsInput,
} from '../validation/schemas';

export const planillaRouter = Router();

// En memoria: el archivo se parsea y se descarta, no se guarda en disco.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

/**
 * La carga de planilla por archivo se RETIRÓ (PLANILLA.md, fase 7).
 *
 * El módulo calcula las deducciones en vez de leerlas de la hoja, y el archivo
 * quedó reducido a lo que sí aporta: el alta inicial del registro de empleados
 * (`/roster/preview` y `/roster/execute`).
 *
 * El 410 con la guía es para los navegadores que todavía tengan en caché el JS viejo
 * (js/planilla.js) y sigan llamando a los endpoints retirados: sin esto recibirían un
 * 404 seco y no sabrían adónde ir.
 */
const RETIRADO = {
  error:
    'La carga de planilla por archivo ya no existe. El asiento ahora lo genera el módulo de Planilla: ' +
    'registrá a los empleados en /planilla.html → Empleados (podés importarlos desde el mismo archivo) y ' +
    'corré el período en /planilla.html → Corrida. Ahí el sistema calcula SS, SE e ISR, acumula el décimo y ' +
    'las vacaciones, y contabiliza los aportes del patrono.',
  code: 'PLANILLA_CARGA_RETIRADA',
};

planillaRouter.post('/preview', (_req, res) => { res.status(410).json(RETIRADO); });
planillaRouter.post('/execute-all', (_req, res) => { res.status(410).json(RETIRADO); });

// ═════════════════════════════════════════════════════════════════════════════
// Módulo de Planilla (PLANILLA.md): registro de empleados, parámetros, corridas,
// acumulados, CSS y cuadre.
//
// Todo cuelga de /api/planilla a propósito: así el rol `planilla` lo cubre con una
// sola entrada en su lista blanca, sin depender de que cada ruta se acuerde.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Quién puede operar el módulo. El rol `planilla` SÍ entra: es el usuario de nómina,
 * el que carga empleados y corre la planilla. Lo que no puede es aprobar los
 * asientos — esa transición es del contador y va aparte, en `/corridas/:id/revisar`.
 */
const ROLES_ESCRITURA_PLANILLA = ['admin', 'contador', 'superadmin', 'planilla'] as const;

/**
 * Las tasas y las cuentas NO las toca el rol `planilla`: las lee. Cambiar la tarifa
 * de riesgos o la escala del ISR cambia lo que se le retiene a todo el mundo, y eso
 * es una decisión del contador, no de quien carga la nómina.
 */
const ROLES_PARAMETROS = ['admin', 'contador', 'superadmin'] as const;

/** Express 4 no captura rechazos async; sin esto la petición queda colgada. */
const wrap =
  (fn: (req: any, res: any) => Promise<void>) => async (req: any, res: any) => {
    try {
      await fn(req, res);
    } catch (e: any) {
      console.error('[Planilla]', e?.message);
      res.status(e?.status || 500).json({ error: e?.message || 'Error al procesar la operación de planilla' });
    }
  };

/** GET /api/planilla/cuentas — catálogo para los selectores de cuenta. */
planillaRouter.get(
  '/cuentas',
  wrap(async (req, res) => {
    const cuentas = await req.prisma.account.findMany({
      where: { companyId: req.user!.companyId },
      select: { id: true, code: true, name: true, type: true, isActive: true },
      orderBy: { code: 'asc' },
    });
    res.json(cuentas);
  }),
);

// ─── Parámetros ──────────────────────────────────────────────────────────────

/** GET /api/planilla/parametros — tasas, tabla del ISR, cuentas y avisos. */
planillaRouter.get(
  '/parametros',
  wrap(async (req, res) => {
    const companyId = req.user!.companyId;
    const [settings, resolucion, cuentas] = await Promise.all([
      getOrCreateSettings(req.prisma, companyId),
      resolverCuentasPlanilla(req.prisma, companyId),
      loadCompanyAccounts(req.prisma, companyId),
    ]);

    res.json({
      settings: {
        ...settings,
        // Las tablas EFECTIVAS: si la columna está vacía, la del código. La pantalla
        // tiene que mostrar la que se usa, no la que está guardada.
        tablaISR: parseTablaISR(settings.tablaISR),
        riesgosPorClase: parseRiesgosPorClase(settings.riesgosPorClase),
      },
      clasesRiesgo: CLASES_RIESGO,
      // El selector del día de pago semanal: se manda la lista completa para que la
      // pantalla no tenga su propia copia de los días de la semana.
      diasSemana: DIAS_SEMANA,
      // `cuentas` es la RESOLUCIÓN por concepto (con respaldos), y `configuradas` es
      // lo que hay escrito en `Company` por nombre de campo. Los selectores de la
      // pantalla escriben lo segundo: pre-seleccionarlos con lo primero los dejaba a
      // todos en blanco y el guardado borraba la configuración.
      cuentas: resolucion.cuentas,
      configuradas: resolucion.configuradas,
      faltantes: resolucion.faltantes,
      avisos: resolucion.avisos,
      // Cuentas donde puede caer el neto: bancos (1.1.02.*) y cajas.
      bancos: filterPayoutAccounts(cuentas).map((a) => ({ id: a.id, code: a.code, name: a.name })),
    });
  }),
);

/** PUT /api/planilla/parametros — edita las tasas y las cuentas de la empresa. */
planillaRouter.put(
  '/parametros',
  requireRole(...ROLES_PARAMETROS),
  validate(updatePayrollSettingsSchema),
  wrap(async (req, res) => {
    const companyId = req.user!.companyId;
    const { cuentas, tablaISR, riesgosPorClase, ...settings } = req.body as UpdatePayrollSettingsInput;

    if (Object.keys(settings).length > 0 || tablaISR !== undefined || riesgosPorClase !== undefined) {
      await getOrCreateSettings(req.prisma, companyId);
      await req.prisma.payrollSettings.update({
        where: { companyId },
        data: {
          ...settings,
          // Las tablas vacías significan "usar la del código": se guardan "[]" / "{}"
          // y el servicio las interpreta, en vez de copiar los valores del código a la BD.
          ...(tablaISR !== undefined ? { tablaISR: JSON.stringify(tablaISR) } : {}),
          // Una clase con null se guarda como ausente: el hueco tiene que llegar al
          // motor como hueco, no como una tarifa del 0%.
          ...(riesgosPorClase !== undefined
            ? {
                riesgosPorClase: JSON.stringify(
                  Object.fromEntries(
                    Object.entries(riesgosPorClase).filter(([, v]) => v !== null && v !== undefined),
                  ),
                ),
              }
            : {}),
        },
      });
    }

    if (cuentas) {
      const campos = new Set(PLANILLA_FIELDS.map((f) => f.field));
      const cambios: Record<string, string | null> = {};
      for (const [campo, valor] of Object.entries(cuentas)) {
        if (!campos.has(campo)) {
          res.status(400).json({ error: `Campo de cuenta desconocido: ${campo}` });
          return;
        }
        const id = valor ? String(valor) : null;
        if (id) {
          const acc = await req.prisma.account.findFirst({
            where: { id, companyId },
            select: { id: true },
          });
          if (!acc) {
            const etiqueta = PLANILLA_FIELDS.find((f) => f.field === campo)?.label ?? campo;
            res.status(400).json({ error: `La cuenta de "${etiqueta}" no existe en esta empresa` });
            return;
          }
        }
        cambios[campo] = id;
      }
      if (Object.keys(cambios).length > 0) {
        await req.prisma.company.update({ where: { id: companyId }, data: cambios });
      }
    }

    const resolucion = await resolverCuentasPlanilla(req.prisma, companyId);
    res.json({
      ok: true,
      configuradas: resolucion.configuradas,
      faltantes: resolucion.faltantes,
      avisos: resolucion.avisos,
    });
  }),
);

// ─── Empleados ───────────────────────────────────────────────────────────────

/** GET /api/planilla/empleados — registro con el acumulado de cada uno. */
planillaRouter.get(
  '/empleados',
  wrap(async (req, res) => {
    const empleados = await listarEmpleados(req.prisma, req.user!.companyId, {
      q: (req.query.q as string) || undefined,
      incluirInactivos: req.query.incluirInactivos === 'true',
      corte: req.query.corte ? parseLocalDate(String(req.query.corte)) : undefined,
    });
    res.json(empleados);
  }),
);

/** GET /api/planilla/empleados/:id — ficha, acumulados y últimas corridas. */
planillaRouter.get(
  '/empleados/:id',
  wrap(async (req, res) => {
    const empleado = await obtenerEmpleado(req.prisma, req.user!.companyId, req.params.id);
    if (!empleado) {
      res.status(404).json({ error: 'Empleado no encontrado' });
      return;
    }
    res.json(empleado);
  }),
);

planillaRouter.post(
  '/empleados',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  validate(createEmpleadoSchema),
  wrap(async (req, res) => {
    const empleado = await crearEmpleado(req.prisma, req.user!.companyId, req.body);
    res.status(201).json(empleado);
  }),
);

planillaRouter.patch(
  '/empleados/:id',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  validate(updateEmpleadoSchema),
  wrap(async (req, res) => {
    const empleado = await actualizarEmpleado(req.prisma, req.user!.companyId, req.params.id, req.body);
    if (!empleado) {
      res.status(404).json({ error: 'Empleado no encontrado' });
      return;
    }
    res.json(empleado);
  }),
);

// ─── Alta masiva desde el archivo de planilla ────────────────────────────────

/**
 * Arma el preview del alta: qué empleados salen del archivo, cuáles ya existen y
 * cuáles vienen con error. No escribe nada.
 */
async function construirRosterPreview(prisma: any, companyId: string, parsed: any) {
  const existentes: any[] = await prisma.employee.findMany({
    where: { companyId },
    select: { id: true, cedula: true, nombre: true, sueldoBase: true },
  });

  const porCedula = new Map<string, any>();
  const porNombre = new Map<string, any[]>();
  for (const e of existentes) {
    if (e.cedula) porCedula.set(e.cedula.trim().toLowerCase(), e);
    const n = e.nombre.trim().toLowerCase();
    porNombre.set(n, [...(porNombre.get(n) ?? []), e]);
  }

  const vistas = new Set<string>();
  const filas = parsed.rows.map((row: any) => {
    if (row.parseError) return { ...row, status: 'error', error: row.parseError, existenteId: null };

    const cedulaKey = row.cedula?.trim().toLowerCase() ?? null;
    if (cedulaKey) {
      if (vistas.has(cedulaKey)) {
        return { ...row, status: 'error', error: 'Cédula repetida dentro del archivo', existenteId: null };
      }
      vistas.add(cedulaKey);
      const existente = porCedula.get(cedulaKey);
      if (existente) {
        return {
          ...row,
          status: 'existente',
          error: `Ya existe en el registro (sueldo actual $${existente.sueldoBase.toFixed(2)})`,
          existenteId: existente.id,
        };
      }
    } else {
      // Sin cédula no hay identidad: se compara por nombre EXACTO y solo si es
      // único. Fusionar dos "Juan Pérez" distintos sería peor que duplicar uno.
      const candidatos = porNombre.get(row.nombre.trim().toLowerCase()) ?? [];
      if (candidatos.length === 1) {
        return {
          ...row,
          status: 'existente',
          error: `Coincide por nombre con un empleado ya registrado (sin cédula en el archivo)`,
          existenteId: candidatos[0].id,
        };
      }
      if (candidatos.length > 1) {
        return {
          ...row,
          status: 'error',
          error: 'Hay varios empleados con ese nombre y la fila no trae cédula: no se puede saber cuál es',
          existenteId: null,
        };
      }
    }

    return { ...row, status: 'ok', error: undefined, existenteId: null };
  });

  return {
    headers: parsed.headers,
    detectedColumns: parsed.detectedColumns,
    totalRows: parsed.totalRows,
    todas: filas,
    resumen: {
      total: filas.length,
      ok: filas.filter((f: any) => f.status === 'ok').length,
      existentes: filas.filter((f: any) => f.status === 'existente').length,
      errores: filas.filter((f: any) => f.status === 'error').length,
    },
  };
}

planillaRouter.post(
  '/roster/preview',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió ningún archivo' });
      return;
    }
    // Se valida con el mismo enum que el resto del módulo: tenía los dos valores
    // escritos a mano y se quedaba corto con la planilla semanal.
    const tipoPago = tipoPagoSchema.safeParse(String(req.body.tipoPago || '').toUpperCase());
    if (!tipoPago.success) {
      res.status(400).json({ error: 'Indica si el SUELDO del archivo es semanal, quincenal o mensual' });
      return;
    }

    const parsed = await parseRosterFile(req.file.buffer, req.file.originalname, tipoPago.data as TipoPago);
    const preview = await construirRosterPreview(req.prisma, req.user!.companyId, parsed);
    // La muestra es de 30; el resumen y la ejecución usan el archivo entero.
    res.json({ ...preview, rows: preview.todas.slice(0, 30), tipoPago: tipoPago.data });
  }),
);

planillaRouter.post(
  '/roster/execute',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  upload.single('file'),
  wrap(async (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: 'No se recibió ningún archivo' });
      return;
    }
    const tipoPago = tipoPagoSchema.safeParse(String(req.body.tipoPago || '').toUpperCase());
    if (!tipoPago.success) {
      res.status(400).json({ error: 'Indica si el SUELDO del archivo es semanal, quincenal o mensual' });
      return;
    }

    const companyId = req.user!.companyId;
    const parsed = await parseRosterFile(req.file.buffer, req.file.originalname, tipoPago.data as TipoPago);
    const preview = await construirRosterPreview(req.prisma, companyId, parsed);

    // Se re-verifica acá y no se confía en el preview: la BD pudo cambiar entre
    // los dos pasos (alguien registró a alguien mientras tanto).
    const aCrear = preview.todas.filter((f: any) => f.status === 'ok');
    const resultados = { creados: 0, omitidos: preview.resumen.existentes, errores: [] as { row: number; error: string }[] };

    for (const fila of aCrear) {
      try {
        await crearEmpleado(req.prisma, companyId, {
          nombre: fila.nombre,
          cedula: fila.cedula,
          nss: fila.nss,
          cargo: fila.cargo,
          sueldoBase: fila.sueldoBase,
          // El de la FILA, no el del formulario: el archivo puede traer los dos
          // tipos mezclados y el sueldo ya se convirtió con el de su propia fila.
          tipoPago: fila.tipoPago,
          fechaIngreso: fila.fechaIngreso,
        });
        resultados.creados++;
      } catch (e: any) {
        resultados.errores.push({ row: fila.row, error: e?.message || 'Error al crear el empleado' });
      }
    }
    // Las filas que ya venían con error del parseo también se reportan.
    for (const fila of preview.todas.filter((f: any) => f.status === 'error')) {
      resultados.errores.push({ row: fila.row, error: fila.error });
    }

    res.json({ ...resultados, total: parsed.totalRows, tipoPago: tipoPago.data });
  }),
);

// ─── Acumulados ──────────────────────────────────────────────────────────────

/** GET /api/planilla/acumulados — décimo, vacaciones y prima por empleado. */
planillaRouter.get(
  '/acumulados',
  wrap(async (req, res) => {
    const companyId = req.user!.companyId;
    const empleados = await listarEmpleados(req.prisma, companyId, {
      incluirInactivos: req.query.incluirInactivos === 'true',
      corte: req.query.corte ? parseLocalDate(String(req.query.corte)) : undefined,
    });
    res.json({
      corte: (req.query.corte as string) || null,
      empleados: empleados.map((e: any) => ({
        id: e.id,
        nombre: e.nombre,
        cedula: e.cedula,
        isActive: e.isActive,
        acumulados: e.acumulados,
      })),
    });
  }),
);

// ─── Corridas ────────────────────────────────────────────────────────────────

/** Completa el período: si no vienen las fechas, se derivan de la periodicidad. */
function opcionesDeCorrida(body: any): OpcionesCorrida {
  const fechaDesde = parseLocalDate(body.fechaDesde);
  return {
    tipo: body.tipo,
    periodicidad: body.periodicidad,
    fechaDesde: body.fechaDesde,
    fechaHasta: body.fechaHasta ?? localDateKey(finDePeriodo(body.periodicidad, fechaDesde)),
    fechaPago: body.fechaPago,
    empleadoIds: body.empleadoIds,
    ajustes: body.ajustes,
    notas: body.notas,
  };
}

/** POST /api/planilla/corridas/preview — calcula el período sin escribir nada. */
planillaRouter.post(
  '/corridas/preview',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  validate(corridaSchema),
  wrap(async (req, res) => {
    const preview = await previsualizarCorrida(req.prisma, req.user!.companyId, opcionesDeCorrida(req.body));
    res.json(preview);
  }),
);

/**
 * POST /api/planilla/corridas — ejecuta: crea la corrida, un asiento BORRADOR por
 * empleado y su Transaction. Consume UNA cuota del plan, no una por empleado: una
 * nómina es un movimiento contable, no treinta.
 */
planillaRouter.post(
  '/corridas',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  requireQuota,
  validate(corridaSchema),
  wrap(async (req, res) => {
    const resultado = await ejecutarCorrida(
      req.prisma,
      req.user!.companyId,
      req.user!.userId,
      opcionesDeCorrida(req.body),
    );
    // Media cuota la semanal: son 52 corridas al año contra 24 de la quincenal, y
    // cobrarle la cuota entera a cada una le costaría al cliente semanal el doble por
    // la misma nómina. El movimiento contable que genera es UNO (va consolidada).
    await incrementUsage(req, req.body.periodicidad === 'SEMANAL' ? 0.5 : 1);
    res.status(201).json(resultado);
  }),
);

/** GET /api/planilla/corridas — historial con el estado de sus asientos. */
planillaRouter.get(
  '/corridas',
  wrap(async (req, res) => {
    const corridas = await listarCorridas(req.prisma, req.user!.companyId, {
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json(corridas);
  }),
);

/**
 * GET /api/planilla/corridas/:id/export.csv — las columnas del archivo viejo.
 * Va ANTES de `/:id` para que Express no lo tome como un id.
 */
planillaRouter.get(
  '/corridas/:id/export.csv',
  wrap(async (req, res) => {
    const corrida = await obtenerCorrida(req.prisma, req.user!.companyId, req.params.id);
    if (!corrida) {
      res.status(404).json({ error: 'Corrida no encontrada' });
      return;
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="planilla-${corrida.tipo}-${corrida.periodo}.csv"`);
    // El BOM hace que Excel en Windows respete los acentos.
    res.send('﻿' + corridaACSV(corrida));
  }),
);

planillaRouter.get(
  '/corridas/:id',
  wrap(async (req, res) => {
    const corrida = await obtenerCorrida(req.prisma, req.user!.companyId, req.params.id);
    if (!corrida) {
      res.status(404).json({ error: 'Corrida no encontrada' });
      return;
    }
    res.json(corrida);
  }),
);

/** POST /api/planilla/corridas/:id/anular — reversos fechados hoy, en bloque. */
planillaRouter.post(
  '/corridas/:id/anular',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  validate(anularCorridaSchema),
  wrap(async (req, res) => {
    const resultado = await anularCorrida(
      req.prisma,
      req.user!.companyId,
      req.user!.userId,
      req.params.id,
      req.body.motivo,
    );
    res.json(resultado);
  }),
);

/**
 * POST /api/planilla/corridas/:id/revisar — aprueba o rechaza los asientos en
 * bloque. El rol `planilla` NO pasa por acá: aprobar asientos es del contador.
 */
planillaRouter.post(
  '/corridas/:id/revisar',
  requireRole('admin', 'contador', 'superadmin'),
  validate(revisarCorridaSchema),
  wrap(async (req, res) => {
    const resultado = await revisarCorrida(
      req.prisma,
      req.user!.companyId,
      req.user!.userId,
      req.params.id,
      req.body.accion,
      req.body.notes,
    );
    res.json(resultado);
  }),
);

// ─── Cuadre ──────────────────────────────────────────────────────────────────

/**
 * GET /api/planilla/cuadre — compara las corridas del período contra el mayor.
 * Muestra las diferencias; no arregla nada.
 */
planillaRouter.get(
  '/cuadre',
  wrap(async (req, res) => {
    const hasta = (req.query.hasta as string) || localDateKey(new Date());
    const desde = (req.query.desde as string) || `${hasta.slice(0, 4)}-01-01`;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(desde) || !/^\d{4}-\d{2}-\d{2}$/.test(hasta)) {
      res.status(400).json({ error: 'Las fechas deben venir como AAAA-MM-DD' });
      return;
    }
    res.json(await cuadrePlanilla(req.prisma, req.user!.companyId, { desde, hasta }));
  }),
);

// ─── CSS ─────────────────────────────────────────────────────────────────────

/** GET /api/planilla/css — lo que se le debe a la CSS, mes a mes, y el saldo vivo. */
planillaRouter.get(
  '/css',
  wrap(async (req, res) => {
    const meses = req.query.meses ? Math.min(24, Math.max(1, Number(req.query.meses))) : 6;
    res.json(await resumenCSS(req.prisma, req.user!.companyId, { meses }));
  }),
);

/** POST /api/planilla/css/:periodo/valorar — le pone el monto real a la obligación. */
planillaRouter.post(
  '/css/:periodo/valorar',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  wrap(async (req, res) => {
    const resultado = await valorarCSS(req.prisma, req.user!.companyId, req.params.periodo);
    res.json(resultado);
  }),
);

/**
 * POST /api/planilla/css/pago — registra el pago: debita el pasivo, acredita el banco.
 * El asiento nace en BORRADOR y lo aprueba el contador como cualquier otro.
 */
planillaRouter.post(
  '/css/pago',
  requireRole(...ROLES_ESCRITURA_PLANILLA),
  validate(pagoCSSSchema),
  wrap(async (req, res) => {
    const resultado = await registrarPagoCSS(
      req.prisma,
      req.user!.companyId,
      req.user!.userId,
      req.body,
    );
    res.status(201).json(resultado);
  }),
);

// Errores de multer (tamaño de archivo) con mensaje claro
planillaRouter.use((err: any, _req: any, res: any, next: any) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    res.status(400).json({ error: 'El archivo supera el máximo de 10MB.' });
    return;
  }
  next(err);
});
