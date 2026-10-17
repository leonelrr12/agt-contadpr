import { Router } from 'express';
import multer from 'multer';
import sharp from 'sharp';
import { requireRole } from '../middleware/auth';
import { crearEmpresaConPlantilla, hacerAdministrador, PLANTILLA_DEL_SISTEMA } from '../services/crear-empresa';
import { topesDeLaCuenta } from '../services/suscripcion';
import { empresasDeUsuario, esSuperadmin, sesionEnEmpresa } from '../services/empresas-usuario';
import { parseLocalDate } from '../lib/dates';
import { logAudit } from '../services/audit-log';

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

// ── Ficha de la empresa (Administración → Empresa) ──
//
// Lo que la DGI imprime en la ficha del contribuyente y que hasta ahora no tenía
// dónde vivir: DV, tipo de entidad, actividad, número patronal, fecha de apertura,
// observaciones internas, logo y sello. Son DATOS: no cambian ningún cálculo.
//
// Solo `admin`/`superadmin`: el perfil fiscal es del cliente, no del contador que
// lleva sus libros. El logo es el MISMO `Company.logo` que usa Facturas PDF: una
// sola fuente, dos pantallas que lo editan.

const PERFIL_SELECT = {
  id: true,
  name: true,
  taxId: true,
  dv: true,
  tipoEntidad: true,
  actividadEconomica: true,
  noPatronal: true,
  observaciones: true,
  fechaApertura: true,
  address: true,
  phone: true,
  email: true,
  logo: true,
  sello: true,
  // Configuración de facturación (la emisión vive en el módulo Facturas PDF;
  // estos datos son de la EMPRESA y se cargan aunque el add-on no esté activo).
  facturaSerie: true,
  facturaResolucion: true,
  facturaResolucionFecha: true,
};

const perfilUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

/** Multer responde con su propio error: se traduce a 413/400 en vez de un 500. */
function subirImagenesPerfil(req: any, res: any, next: any) {
  perfilUpload.fields([{ name: 'logo', maxCount: 1 }, { name: 'sello', maxCount: 1 }])(req, res, (err: any) => {
    if (!err) return next();
    const grande = err?.code === 'LIMIT_FILE_SIZE';
    res.status(grande ? 413 : 400).json({
      error: grande ? 'Cada imagen puede pesar hasta 2 MB.' : 'No se pudo leer la imagen.',
    });
  });
}

/** Las empresas nuevas nacen con un marcador cuando todavía no tienen RUC real. */
const esMarcadorRuc = (taxId: any) => typeof taxId === 'string' && taxId.startsWith('SIN-RUC-');

/** Fecha de solo día, en la zona del servidor (se guardó a mediodía local). */
function fechaISO(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/**
 * Fecha de solo día para MOSTRAR. Las fechas viejas de facturación se guardaron
 * a medianoche UTC (`new Date('YYYY-MM-DD')`) y las nuevas, a mediodía local:
 * leerlas con los getters locales corría un día las viejas. Se distinguen por la
 * hora UTC y cada una se lee por su día calendario.
 */
function fechaSoloDia(d: Date): string {
  const medianocheUTC = d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0;
  if (medianocheUTC) {
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }
  return fechaISO(d);
}

/** La imagen se normaliza a PNG: el navegador no tiene que adivinar el MIME. */
async function imagenADataUrl(buf: any): Promise<string | null> {
  if (!buf) return null;
  try {
    const png = await sharp(Buffer.from(buf)).png().toBuffer();
    return `data:image/png;base64,${png.toString('base64')}`;
  } catch {
    return null; // imagen guardada que sharp no puede leer: se omite la vista previa
  }
}

async function perfilJSON(c: any) {
  return {
    id: c.id,
    name: c.name || '',
    // El marcador no es un RUC: se muestra vacío para que el dueño cargue el real.
    taxId: esMarcadorRuc(c.taxId) ? '' : c.taxId || '',
    dv: c.dv || '',
    tipoEntidad: c.tipoEntidad || '',
    actividadEconomica: c.actividadEconomica || '',
    noPatronal: c.noPatronal || '',
    observaciones: c.observaciones || '',
    fechaApertura: c.fechaApertura ? fechaSoloDia(new Date(c.fechaApertura)) : '',
    address: c.address || '',
    phone: c.phone || '',
    email: c.email || '',
    hasLogo: !!c.logo,
    logoDataUrl: await imagenADataUrl(c.logo),
    hasSello: !!c.sello,
    selloDataUrl: await imagenADataUrl(c.sello),
    // Configuración DGI: la edita el perfil; el módulo de Facturas solo la usa
    // para numerar e imprimir la leyenda.
    facturaSerie: c.facturaSerie || '',
    facturaResolucion: c.facturaResolucion || '',
    facturaResolucionFecha: c.facturaResolucionFecha ? fechaSoloDia(new Date(c.facturaResolucionFecha)) : '',
  };
}

/** Imagen de perfil: se reduce y se guarda como PNG (mismo criterio que el logo). */
async function imagenParaGuardar(file: any, max: { width: number; height: number }): Promise<Buffer> {
  if (!String(file?.mimetype || '').startsWith('image/')) {
    throw Object.assign(new Error('El archivo debe ser una imagen (PNG, JPG, etc.).'), { status: 400 });
  }
  return sharp(file.buffer)
    .resize({ ...max, fit: 'inside', withoutEnlargement: true })
    .png()
    .toBuffer();
}

const limpiar = (v: any) => (v === undefined || v === null ? '' : String(v).trim());

/**
 * Fecha de solo día (`YYYY-MM-DD`) al Date de mediodía local.
 * Devuelve `undefined` cuando el texto no es una fecha válida (y anota el error);
 * `null` cuando viene vacía (borrar el dato).
 */
function parseFechaDia(valor: string, etiqueta: string, errores: string[]): Date | null | undefined {
  if (!valor) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(valor)) {
    errores.push(`${etiqueta} no es válida.`);
    return undefined;
  }
  const d = parseLocalDate(valor);
  // El round-trip descarta fechas que JS "corrige" solo (2026-02-31 → marzo).
  if (Number.isNaN(d.getTime()) || fechaISO(d) !== valor) {
    errores.push(`${etiqueta} no es válida.`);
    return undefined;
  }
  return d;
}

// GET /api/companies/current — ficha completa (con las imágenes como data URL)
companiesRouter.get('/current', requireRole('admin', 'superadmin'), async (req, res) => {
  const company = await req.prisma.company.findUnique({
    where: { id: req.user!.companyId },
    select: PERFIL_SELECT,
  });
  if (!company) {
    res.status(404).json({ error: 'Empresa no encontrada' });
    return;
  }
  res.json(await perfilJSON(company));
});

// PATCH /api/companies/current — guarda la ficha (multipart si hay logo/sello)
companiesRouter.patch('/current', requireRole('admin', 'superadmin'), subirImagenesPerfil, async (req: any, res) => {
  try {
    const actual = await req.prisma.company.findUnique({
      where: { id: req.user!.companyId },
      select: PERFIL_SELECT,
    });
    if (!actual) {
      res.status(404).json({ error: 'Empresa no encontrada' });
      return;
    }

    const body = req.body || {};
    const data: any = {};
    const errores: string[] = [];

    if (body.name !== undefined) {
      const nombre = limpiar(body.name);
      if (!nombre) errores.push('El nombre es obligatorio.');
      else if (nombre.length > 120) errores.push('El nombre no puede superar 120 caracteres.');
      else data.name = nombre;
    }

    if (body.taxId !== undefined) {
      const ruc = limpiar(body.taxId);
      if (!ruc) {
        // Vaciar el RUC solo vale si la empresa todavía no tiene uno real.
        if (!esMarcadorRuc(actual.taxId)) errores.push('El RUC no puede quedar vacío.');
      } else if (ruc.length > 50) {
        errores.push('El RUC no puede superar 50 caracteres.');
      } else {
        data.taxId = ruc;
      }
    }

    if (body.dv !== undefined) {
      const dv = limpiar(body.dv);
      if (dv && !/^\d{1,2}$/.test(dv)) errores.push('El DV son hasta 2 dígitos.');
      else data.dv = dv || null;
    }

    // Si el RUC viene completo (`342-240-75526-50`), el último grupo es el DV:
    // se separa para que el RUC base sea comparable y el DV se imprima al lado.
    if (data.taxId) {
      const m = data.taxId.match(/^(.*)-(\d{1,2})$/);
      if (m && m[1].split('-').length >= 3) {
        if (!data.dv) data.dv = m[2];
        if (data.dv === m[2]) data.taxId = m[1];
      }
    }

    const textos: [string, number, string][] = [
      ['tipoEntidad', 100, 'El tipo de entidad'],
      ['actividadEconomica', 100, 'La actividad económica'],
      ['noPatronal', 100, 'El número patronal'],
      ['address', 300, 'La dirección'],
      ['phone', 50, 'El teléfono'],
    ];
    for (const [campo, max, etiqueta] of textos) {
      if (body[campo] === undefined) continue;
      const valor = limpiar(body[campo]);
      if (valor.length > max) {
        errores.push(`${etiqueta} no puede superar ${max} caracteres.`);
        continue;
      }
      data[campo] = valor || null;
    }

    if (body.email !== undefined) {
      const email = limpiar(body.email);
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errores.push('El email no es válido.');
      else if (email.length > 150) errores.push('El email no puede superar 150 caracteres.');
      else data.email = email || null;
    }

    if (body.observaciones !== undefined) {
      const obs = String(body.observaciones ?? '').trim();
      if (obs.length > 10000) errores.push('Las observaciones no pueden superar 10.000 caracteres.');
      else data.observaciones = obs || null;
    }

    if (body.fechaApertura !== undefined) {
      const d = parseFechaDia(limpiar(body.fechaApertura), 'La fecha de apertura', errores);
      if (d !== undefined) data.fechaApertura = d;
    }

    // ── Facturación electrónica (DGI) ──
    // Vive acá y no en el módulo Facturas: son datos de la EMPRESA. El módulo
    // (add-on) solo emite; la ficha se completa aunque todavía no lo tenga.
    if (body.facturaSerie !== undefined) {
      const serie = limpiar(body.facturaSerie).toUpperCase();
      if (serie && !/^[A-Za-z0-9]{1,5}$/.test(serie)) {
        errores.push('La serie debe tener hasta 5 caracteres alfanuméricos.');
      } else {
        data.facturaSerie = serie || null;
      }
    }

    if (body.facturaResolucion !== undefined) {
      const resolucion = limpiar(body.facturaResolucion);
      if (resolucion.length > 100) errores.push('La resolución no puede superar 100 caracteres.');
      else data.facturaResolucion = resolucion || null;
    }

    if (body.facturaResolucionFecha !== undefined) {
      const d = parseFechaDia(limpiar(body.facturaResolucionFecha), 'La fecha de la resolución', errores);
      if (d !== undefined) data.facturaResolucionFecha = d;
    }

    const logo = req.files?.logo?.[0];
    if (logo) {
      try {
        data.logo = await imagenParaGuardar(logo, { width: 800, height: 200 });
      } catch (e: any) {
        errores.push(e?.message || 'La imagen del logo no es válida.');
      }
    } else if (String(body.removeLogo) === 'true') {
      data.logo = null;
    }

    const sello = req.files?.sello?.[0];
    if (sello) {
      try {
        data.sello = await imagenParaGuardar(sello, { width: 400, height: 400 });
      } catch (e: any) {
        errores.push(e?.message || 'La imagen del sello no es válida.');
      }
    } else if (String(body.removeSello) === 'true') {
      data.sello = null;
    }

    if (errores.length) {
      res.status(400).json({ error: errores.join(' ') });
      return;
    }

    if (Object.keys(data).length) {
      await req.prisma.company.update({ where: { id: req.user!.companyId }, data });
      await logAudit(req.prisma, {
        userId: req.user!.userId,
        action: 'EMPRESA_PERFIL_UPDATED',
        entity: 'Company',
        entityId: req.user!.companyId,
        after: {
          campos: Object.keys(data).filter((k) => k !== 'logo' && k !== 'sello'),
          logo: 'logo' in data ? !!data.logo : undefined,
          sello: 'sello' in data ? !!data.sello : undefined,
        },
      }).catch(() => {});
    }

    const company = await req.prisma.company.findUnique({
      where: { id: req.user!.companyId },
      select: PERFIL_SELECT,
    });
    res.json(await perfilJSON(company));
  } catch (err: any) {
    console.error('[Companies] No se pudo guardar el perfil:', err?.message);
    res.status(500).json({ error: 'No se pudo guardar el perfil de la empresa. Probá de nuevo.' });
  }
});
