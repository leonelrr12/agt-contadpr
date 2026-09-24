/**
 * Presupuestos: captura mensual por cuenta hoja (F1) y comparativa contra el
 * real (F2). El presupuesto es dato de gestión — no genera asientos ni toca el
 * libro diario.
 *
 * El año por defecto es el FISCAL ACTIVO (lib/fiscal-year.ts), no el calendario.
 */
import { Router } from 'express';
import type { Request, Response } from 'express';
import { requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { saveBudgetsSchema } from '../validation/schemas';
import { getAnioFiscal } from '../lib/fiscal-year';
import { buildBudgetComparison } from '../services/budget-comparison';
import { logAudit } from '../services/audit-log';

export const budgetsRouter = Router();

const r2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

// Express 4 no enruta los rechazos async: sin esto un throw deja la petición colgada.
const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      console.error('[Budgets]', e);
      res.status(500).json({ error: 'Error al procesar presupuestos' });
    }
  };

/** Año pedido por query, validado; `undefined` = el que decida el llamador. */
function anioDeQuery(raw: unknown): number | undefined {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 2000 && n <= 2100 ? n : undefined;
}

/** GET /api/budgets?year=YYYY — grilla de captura (cuentas hoja + montos guardados). */
budgetsRouter.get(
  '/',
  wrap(async (req, res) => {
    const companyId = req.user!.companyId;
    const anioFiscal = await getAnioFiscal(req.prisma, companyId);
    const year = anioDeQuery(req.query.year) ?? anioFiscal;

    const [accounts, montos] = await Promise.all([
      req.prisma.account.findMany({
        where: { companyId },
        select: { id: true, code: true, name: true, type: true, parentId: true, isActive: true },
      }),
      req.prisma.budget.findMany({
        where: { companyId, year },
        select: { accountId: true, month: true, amount: true },
      }),
    ]);

    const conHijos = new Set(accounts.filter((a: any) => a.parentId).map((a: any) => a.parentId));
    const porId = new Map(accounts.map((a: any) => [a.id, a]));
    // Solo hojas activas: el presupuesto se captura en la cuenta de detalle y el
    // rollup por categoría lo hace la comparativa. Las bloqueadas SÍ se listan
    // (isBlocked frena asientos, no presupuesto).
    const cuentas = accounts
      .filter((a: any) => a.isActive && !conHijos.has(a.id))
      .map((a: any) => {
        const padre: any = a.parentId ? porId.get(a.parentId) : null;
        const prefijo = String(a.code).split('.').slice(0, -1).join('.');
        return {
          id: a.id,
          code: a.code,
          name: a.name,
          type: a.type,
          parentId: a.parentId || null,
          categoriaKey: padre?.code || prefijo || 'OTRAS',
          categoriaName: padre?.name || (prefijo ? '(sin categoría)' : 'Otras cuentas'),
        };
      })
      .sort((a: any, b: any) => String(a.code).localeCompare(String(b.code), undefined, { numeric: true }));

    res.json({ year, anioFiscal, cuentas, montos });
  }),
);

/**
 * PUT /api/budgets — guardado en lote (semántica delta: solo toca lo enviado).
 * Un monto en 0 borra la fila; así la tabla no acumula celdas vacías.
 */
budgetsRouter.put(
  '/',
  requireRole('admin', 'contador', 'superadmin'),
  validate(saveBudgetsSchema),
  wrap(async (req, res) => {
    const companyId = req.user!.companyId;
    const { year, items } = req.body as { year: number; items: { accountId: string; month: number; amount: number }[] };

    // Multi-tenant: ninguna cuenta de otra empresa entra en la transacción
    const ids = [...new Set(items.map((i) => i.accountId))];
    const propias = await req.prisma.account.findMany({
      where: { companyId, id: { in: ids } },
      select: { id: true },
    });
    const validas = new Set(propias.map((a: any) => a.id));
    const ajenas = ids.filter((id) => !validas.has(id));
    if (ajenas.length) {
      res.status(400).json({ error: 'Cuenta no encontrada', cuentas: ajenas });
      return;
    }

    const ops: unknown[] = [];
    let guardados = 0;
    let borrados = 0;
    for (const item of items) {
      const clave = { companyId, accountId: item.accountId, year, month: item.month };
      if (Math.round(item.amount * 100) === 0) {
        ops.push(req.prisma.budget.deleteMany({ where: clave }));
        borrados++;
      } else {
        ops.push(
          req.prisma.budget.upsert({
            where: { companyId_accountId_year_month: clave },
            create: { ...clave, amount: r2(item.amount) },
            update: { amount: r2(item.amount) },
          }),
        );
        guardados++;
      }
    }
    await req.prisma.$transaction(ops as never[]);

    await logAudit(req.prisma, {
      userId: req.user!.userId,
      action: 'BUDGET_SAVED',
      entity: 'Budget',
      entityId: String(year),
      after: { year, celdas: items.length, guardados, borrados },
    });

    res.json({ success: true, year, guardados, borrados });
  }),
);

/** GET /api/budgets/comparison?year=&mes=&tipos= — real vs presupuestado. */
budgetsRouter.get(
  '/comparison',
  wrap(async (req, res) => {
    const mesRaw = Number(req.query.mes);
    const mes = Number.isInteger(mesRaw) && mesRaw >= 1 && mesRaw <= 12 ? mesRaw : null;
    const tipos = req.query.tipos === 'todas' ? 'todas' : 'resultado';
    const data = await buildBudgetComparison(req.prisma, req.user!.companyId, {
      year: anioDeQuery(req.query.year),
      mes,
      tipos,
    });
    res.json(data);
  }),
);
