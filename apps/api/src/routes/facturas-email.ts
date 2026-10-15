/**
 * Facturas DGI por correo: la tarjeta de Administración.
 *
 * Acá se configura el buzón y se prueba la conexión. El barrido (leer los
 * correos nuevos, dejarlos en el ledger y crear los asientos BORRADOR) llega en
 * la fase siguiente y cuelga de estas mismas rutas.
 *
 * Solo `admin` y `superadmin`: son credenciales de correo de la empresa. El
 * contador verá el ledger cuando exista, pero no las toca.
 */

import { Router } from 'express';
import { requireRole } from '../middleware/auth';
import { validate } from '../middleware/validate';
import { updateEmailFacturaConfigSchema, probarEmailFacturaSchema } from '../validation/schemas';
import {
  CAMPOS_EMAIL_FACTURA,
  configPublica,
  cuentaBancoDeEmpresa,
  cuentasBancoDeEmpresa,
  getOrCreateEmailConfig,
} from '../services/email-facturas-config';
import { probarConexion } from '../services/email-inbox';

export const facturasEmailRouter = Router();

const ROLES = ['admin', 'superadmin'] as const;

/**
 * La dirección de reenvío del modo CENTRAL: `usuario+alias@dominio`, que Gmail
 * entrega al mismo buzón ignorando el `+tag`. Null mientras no haya alias.
 */
function direccionReenvio(inboxAlias: string | null): string | null {
  const central = process.env.EMAIL_CENTRAL_IMAP_USER || '';
  const [usuario, dominio] = central.split('@');
  if (!inboxAlias || !usuario || !dominio) return null;
  return `${usuario}+${inboxAlias}@${dominio}`;
}

/** Lo que la tarjeta necesita para pintarse: config pública + candidatas. */
async function payloadConfig(prisma: any, companyId: string) {
  const cfg = await getOrCreateEmailConfig(prisma, companyId);
  const [cuentasPago, conceptos] = await Promise.all([
    cuentasBancoDeEmpresa(prisma, companyId),
    prisma.concept.findMany({
      where: { companyId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const pub = configPublica(cfg);
  return {
    ...pub,
    direccionReenvio: direccionReenvio(pub.inboxAlias),
    cuentasPago,
    conceptos,
    campos: CAMPOS_EMAIL_FACTURA,
  };
}

// GET /api/facturas-email/config — la tarjeta (nunca devuelve la contraseña)
facturasEmailRouter.get('/config', requireRole(...ROLES), async (req, res) => {
  res.json(await payloadConfig(req.prisma, req.user!.companyId));
});

// PUT /api/facturas-email/config — guardar
facturasEmailRouter.put(
  '/config',
  requireRole(...ROLES),
  validate(updateEmailFacturaConfigSchema),
  async (req, res) => {
    const companyId = req.user!.companyId;
    const body = req.body as Record<string, any>;
    const actual = await getOrCreateEmailConfig(req.prisma, companyId);
    const data: Record<string, any> = {};

    for (const { field } of CAMPOS_EMAIL_FACTURA) {
      if (field === 'cuentaPagoId' || body[field] === undefined) continue;
      data[field] = body[field];
    }

    // La contrapartida tiene regla propia: cuenta de BANCO de esta empresa,
    // activa y sin bloquear (nunca Caja: en producción está vacía).
    if (body.cuentaPagoId !== undefined) {
      if (body.cuentaPagoId) {
        const cuenta = await cuentaBancoDeEmpresa(req.prisma, companyId, body.cuentaPagoId);
        if (!cuenta) {
          res.status(400).json({
            error: 'La cuenta de contrapartida debe ser una cuenta de banco (1.1.02.*) de esta empresa, activa y sin bloquear.',
          });
          return;
        }
        data.cuentaPagoId = cuenta.id;
      } else {
        data.cuentaPagoId = null;
      }
    }

    if (body.conceptoDefaultId !== undefined) {
      if (body.conceptoDefaultId) {
        const concepto = await req.prisma.concept.findFirst({
          where: { id: String(body.conceptoDefaultId), companyId },
          select: { id: true },
        });
        if (!concepto) {
          res.status(400).json({ error: 'El concepto por defecto no existe en esta empresa' });
          return;
        }
        data.conceptoDefaultId = concepto.id;
      } else {
        data.conceptoDefaultId = null;
      }
    }

    // Contraseña: ausente = sin cambios; vacía o null = borrarla. El navegador
    // nunca la recibe, así que no puede reenviarla «igual que estaba».
    if ('imapPassword' in body) {
      data.imapPassword = body.imapPassword ? String(body.imapPassword) : null;
    }

    // Activar exige que el buzón pueda leerse Y que el asiento tenga contra qué
    // ir: una configuración activa a la que le falta media pieza no falla ruidoso,
    // falla en silencio todas las madrugadas.
    const resultante = { ...actual, ...data };
    if (resultante.isActive) {
      if (resultante.modo === 'CENTRAL') {
        res.status(400).json({
          error: 'El buzón central todavía no está disponible. Por ahora usa el modo IMAP (la dirección de reenvío llega en la próxima entrega).',
        });
        return;
      }
      if (!resultante.imapHost || !resultante.imapUser) {
        res.status(400).json({ error: 'Para leer el buzón hacen falta el servidor y el usuario.' });
        return;
      }
      if (!resultante.imapPassword) {
        res.status(400).json({ error: 'Falta la contraseña del buzón.' });
        return;
      }
      if (!resultante.cuentaPagoId) {
        res.status(400).json({
          error: 'Falta la cuenta de contrapartida: es la cuenta de banco que acreditan los asientos.',
        });
        return;
      }
    }

    await req.prisma.emailFacturaConfig.update({ where: { companyId }, data });
    res.json(await payloadConfig(req.prisma, companyId));
  },
);

// POST /api/facturas-email/probar — «Probar conexión» sin guardar
facturasEmailRouter.post(
  '/probar',
  requireRole(...ROLES),
  validate(probarEmailFacturaSchema),
  async (req, res) => {
    const cfg = await getOrCreateEmailConfig(req.prisma, req.user!.companyId);
    const body = req.body as Record<string, any>;

    // Lo escrito manda —incluido un campo que el usuario vació a propósito—; lo
    // que no vino, sale de lo guardado. La contraseña es la excepción: solo se usa
    // la escrita porque el navegador nunca la tiene (`||`, no `??`).
    const prueba = {
      imapHost: body.imapHost !== undefined ? body.imapHost : cfg.imapHost,
      imapPort: body.imapPort !== undefined ? body.imapPort : cfg.imapPort,
      imapSecure: body.imapSecure !== undefined ? body.imapSecure : cfg.imapSecure,
      imapUser: body.imapUser !== undefined ? body.imapUser : cfg.imapUser,
      imapPassword: body.imapPassword || cfg.imapPassword,
      imapFolder: body.imapFolder || cfg.imapFolder || 'INBOX',
    };

    // 200 aunque la conexión falle: el veredicto va en el cuerpo y la tarjeta lo
    // muestra. Un status de error haría que el navegador lo trate como excepción.
    res.json(await probarConexion(prueba));
  },
);
