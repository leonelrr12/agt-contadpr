import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { crearEmpresaConPlantilla, hacerAdministrador, PLANTILLA_DEL_SISTEMA } from '../services/crear-empresa';
import { topesDeLaCuenta } from '../services/suscripcion';
import { empresasDeUsuario, esSuperadmin, sesionEnEmpresa } from '../services/empresas-usuario';

/**
 * Alta de empresas desde adentro de la app.
 *
 * Existe por el despacho: el registro público (`/auth/register`) sirve para el
 * cliente que llega nuevo, pero **rechaza el correo que ya existe** — así que un
 * contador no podía sumar un segundo cliente a su cuenta sin crear otra cuenta
 * con otro correo, que es justo lo que las membresías vinieron a evitar.
 *
 * Quién puede: **admin y superadmin**, y nadie más. Abrir libros nuevos es una
 * responsabilidad —quien la crea queda como su administrador y la empresa nace
 * con su plan Demo—, así que un `contador` o un `asistente` no la crean aunque
 * trabajen en varias empresas. Es también lo que espera un cliente: nadie le
 * abre libros a su nombre sin ser su dueño.
 *
 * La empresa nace igual que por el registro: misma función
 * (`services/crear-empresa.ts`), mismo plan de cuentas. Lo que cambia según quién
 * la crea es **la cuenta que paga**: la del despacho (el cliente se suma a su plan,
 * que es lo que un despacho compra) o una propia con su Demo si la abre el dueño de
 * la plataforma, que no es cliente de sí mismo.
 */
export const companiesRouter = Router();

// POST /api/companies — crear una empresa y entrar en ella
companiesRouter.post('/', requireRole('admin', 'superadmin'), async (req, res) => {
  const nombre = String(req.body?.name || '').trim();
  const taxId = req.body?.taxId ? String(req.body.taxId).trim() : null;

  if (!nombre) {
    res.status(400).json({ error: 'El nombre de la empresa es requerido' });
    return;
  }
  if (nombre.length > 120) {
    res.status(400).json({ error: 'El nombre de la empresa es demasiado largo' });
    return;
  }

  const userId = req.user!.userId;

  // De dónde se copia el catálogo: la plantilla del sistema (para cualquiera) o
  // una empresa del usuario —un despacho copia SU catálogo, el que ya tiene
  // armado—. Copiar el de una empresa ajena no: eso sería leer su plan de cuentas.
  const plantilla = req.body?.plantillaCompanyId ? String(req.body.plantillaCompanyId) : PLANTILLA_DEL_SISTEMA;
  if (plantilla !== PLANTILLA_DEL_SISTEMA) {
    const superadmin = await esSuperadmin(req.prisma, userId);
    const mias = await empresasDeUsuario(req.prisma, userId, superadmin);
    if (!mias.some((e: any) => e.id === plantilla)) {
      res.status(403).json({ error: 'No podés copiar el catálogo de una empresa a la que no tenés acceso.' });
      return;
    }
  }

  try {
    // ¿A qué cuenta va la empresa nueva? A la del despacho que la crea: el plan y la
    // cuota son de la cuenta, así que el cliente que se suma entra cubierto por el
    // plan que el despacho ya paga (y consume de su misma cuota). **Salvo el dueño de
    // la plataforma**, que no es cliente de sí mismo: cuando da de alta una empresa
    // lo que hace es abrir un cliente nuevo, y ese nace con su propia cuenta y su Demo.
    const cuenta = (await esSuperadmin(req.prisma, userId))
      ? undefined
      : (await req.prisma.company.findUnique({ where: { id: req.user!.companyId }, select: { cuentaId: true } }))?.cuentaId;

    // Cupo de empresas del plan: la empresa nueva se suma a la cuenta que paga, así
    // que el tope es de la cuenta entera. El superadmin no pasa por acá: lo que hace
    // es abrir un cliente nuevo, con su propia cuenta (ver arriba).
    if (cuenta) {
      const topes = await topesDeLaCuenta(req.prisma, req.user!.companyId);
      if (!topes) {
        res.status(402).json({ error: 'No tienes una suscripción activa.', code: 'NO_SUBSCRIPTION' });
        return;
      }
      if (topes.empresas.max > 0 && topes.empresas.usados >= topes.empresas.max) {
        const { usados, max } = topes.empresas;
        res.status(402).json({
          error:
            `Tu plan ${topes.plan} incluye ${max} empresa${max === 1 ? '' : 's'} y tu cuenta ya tiene ${usados}. ` +
            `Para sumar otra, pasá a un plan con más empresas.`,
          code: 'PLAN_LIMIT_EMPRESAS',
          plan: topes.plan,
          usados,
          max,
        });
        return;
      }
    }

    const company = await req.prisma.$transaction(async (tx: any) => {
      const nueva = await crearEmpresaConPlantilla(tx, { name: nombre, taxId }, { plantillaCompanyId: plantilla, cuentaId: cuenta });
      await hacerAdministrador(tx, userId, nueva.id);
      // Quedar como dueño de una empresa nueva es una decisión que se registra.
      await tx.auditLog.create({
        data: {
          userId,
          action: 'CREAR_EMPRESA',
          entity: 'Company',
          entityId: nueva.id,
          after: JSON.stringify({ nombre, taxId, catalogoDe: plantilla, cuenta: cuenta || 'nueva' }),
        },
      });
      return nueva;
    });

    // Se devuelve la sesión EN LA EMPRESA NUEVA: quien la crea entra directo.
    const sesion = await sesionEnEmpresa(req.prisma, userId, company.id);
    res.status(201).json({ company: { id: company.id, name: company.name, taxId: company.taxId }, ...(sesion || {}) });
  } catch (err: any) {
    console.error('[Companies] No se pudo crear la empresa:', err?.message);
    res.status(500).json({ error: 'No se pudo crear la empresa. Probá de nuevo.' });
  }
});
