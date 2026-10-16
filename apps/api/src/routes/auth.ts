import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { generateToken, requireAuth } from '../middleware/auth';
import { sendEmail, APP_URL } from '../services/mailer';
import { bloqueoRestante, registrarFallo, limpiarFallos } from '../services/login-guard';
import { TERMS_VERSION, necesitaAceptar } from '../lib/terms';
import { empresasDeUsuario, rolEnEmpresa } from '../services/empresas-usuario';

export const authRouter = Router();

// ID de la empresa semilla usada como plantilla de plan de cuentas y conceptos
// al registrar una empresa nueva. Si no existe en la DB, el registro crea
// empresas sin plan de cuentas (ver warn abajo).
const TEMPLATE_COMPANY_ID = 'demo-company';

/**
 * POST /api/auth/login
 * Body: { email, password }
 */
authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    res.status(400).json({ error: 'Email y contraseña son requeridos' });
    return;
  }

  // Freno por cuenta (services/login-guard.ts): no revela si el email existe.
  const bloqueo = bloqueoRestante(email);
  if (bloqueo > 0) {
    const min = Math.ceil(bloqueo / 60000);
    res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${min} minuto${min === 1 ? '' : 's'}.` });
    return;
  }

  const user = await req.prisma.user.findUnique({
    where: { email },
    include: { company: true },
  });

  if (!user || !user.isActive) {
    registrarFallo(email); // también cuenta: así no se puede sondear qué correos existen
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    registrarFallo(email);
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  limpiarFallos(email);

  // Se entra por la empresa POR DEFECTO (la última usada) y con el rol que el
  // usuario tiene EN ESA empresa: desde las membresías, un contador de despacho
  // es admin de su empresa y contador de la del cliente.
  const sesion = await sesionEnEmpresa(req.prisma, user.id, user.companyId);
  // Una línea por login: con qué empresa entró y a cuántas puede cambiar. Es lo
  // primero que se mira cuando alguien dice «no me aparece tal empresa».
  const cuantas = (await empresasDeUsuario(req.prisma, user.id, user.role === 'superadmin')).length;
  console.log(`[Auth] login ${user.email} → empresa=${user.companyId} rol=${sesion?.user?.role || '-'} puede_cambiar_a=${cuantas}`);
  if (!sesion) {
    res.status(403).json({ error: 'Tu usuario no tiene acceso a ninguna empresa. Hablá con el administrador.' });
    return;
  }
  res.json(sesion);
});

/**
 * POST /api/auth/register
 * Body: { name, email, password, companyName, companyTaxId, acceptedTerms }
 * Registra una nueva empresa + usuario admin. `acceptedTerms` es obligatorio: la
 * casilla del formulario es del navegador, pero la constancia la exige el servidor
 * (y queda registrada con la versión vigente en `lib/terms.ts`).
 */
authRouter.post('/register', async (req, res) => {
  const { name, email, password, companyName, companyTaxId, acceptedTerms } = req.body;

  if (!name || !email || !password || !companyName) {
    res.status(400).json({ error: 'Nombre, email, contraseña y nombre de empresa son requeridos' });
    return;
  }

  if (acceptedTerms !== true) {
    res.status(400).json({ error: 'Debes aceptar los Términos y Condiciones y la Política de Privacidad' });
    return;
  }

  if (password.length < 6) {
    res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
    return;
  }

  // Verificar si el email ya existe
  const existing = await req.prisma.user.findUnique({ where: { email } });
  if (existing) {
    res.status(409).json({ error: 'Ya existe un usuario con ese email' });
    return;
  }

  const hashed = await bcrypt.hash(password, 10);

  try {
    // Crear empresa + usuario admin en una transacción
    const result = await req.prisma.$transaction(async (tx: any) => {
    const company = await tx.company.create({
      data: {
        name: companyName,
        taxId: companyTaxId || `SIN-RUC-${crypto.randomUUID()}`,

        country: 'PA',
        currency: 'USD',
      },
    });

    // Copiar plan de cuentas desde demo
    const demoAccounts = await tx.account.findMany({
      where: { companyId: TEMPLATE_COMPANY_ID },
    });

    if (demoAccounts.length === 0) {
      console.warn('[Register] Plantilla demo sin cuentas — la empresa quedará sin plan de cuentas');
    }

    const accountMap: Record<string, string> = {};
    for (const acc of demoAccounts) {
      const created = await tx.account.create({
        data: {
          code: acc.code,
          name: acc.name,
          type: acc.type,
          parentId: null, // se actualiza abajo
          companyId: company.id,
          aliases: acc.aliases || [],
          // El "Lleva Anexo" de la plantilla SÍ se hereda: se marca una vez en Demo
          // (p. ej. 6.02.01 Honorarios) y todo cliente nuevo nace con el Anexo puesto.
          // `isBlocked` NO se copia a propósito: bloquear una cuenta es una decisión
          // operativa de cada empresa y heredarla le dejaría flujos rotos desde el día 1.
          requiresAnexo: acc.requiresAnexo,
        },
      });
      accountMap[acc.code] = created.id;
    }

    // Actualizar parentIds
    for (const acc of demoAccounts) {
      if (acc.parentId) {
        const parentCode = demoAccounts.find((a: any) => a.id === acc.parentId)?.code;
        if (parentCode && accountMap[parentCode] && accountMap[acc.code]) {
          await tx.account.update({
            where: { id: accountMap[acc.code] },
            data: { parentId: accountMap[parentCode] },
          });
        }
      }
    }

    // Copiar conceptos
    const demoConcepts = await tx.concept.findMany({
      where: { companyId: TEMPLATE_COMPANY_ID },
    });

    for (const c of demoConcepts) {
      // Buscar la cuenta equivalente en la nueva empresa por código
      const demoAcc = demoAccounts.find((a: any) => a.id === c.accountId);
      const newAccountId = demoAcc ? accountMap[demoAcc.code] : null;
      if (newAccountId) {
        await tx.concept.create({
          data: {
            name: c.name,
            accountId: newAccountId,
            companyId: company.id,
            confidence: c.confidence,
          },
        });
      }
    }

    const user = await tx.user.create({
      data: {
        email,
        name,
        password: hashed,
        role: 'admin',
        companyId: company.id,
        // Evidencia de la aceptación (ver lib/terms.ts)
        termsVersion: TERMS_VERSION,
        termsAcceptedAt: new Date(),
      },
    });

    // La membresía es lo que da el acceso (`user_company`): sin ella el dueño de
    // la empresa recién creada no podría entrar a su propia empresa.
    await tx.userCompany.create({ data: { userId: user.id, companyId: company.id, role: 'admin' } });

    // Crear suscripción Demo automática (14 días, 50 movimientos)
    const demoPlan = await tx.plan.findUnique({ where: { name: 'Demo' } });
    if (demoPlan) {
      const demoEnd = new Date();
      demoEnd.setDate(demoEnd.getDate() + 14);
      await tx.subscription.create({
        data: {
          companyId: company.id,
          planId: demoPlan.id,
          status: 'DEMO',
          movementsLimit: demoPlan.monthlyLimit,
          periodStart: new Date(),
          periodEnd: demoEnd,
        },
      });
    }

    return { company, user };
  });

  const token = generateToken({
    userId: result.user.id,
    companyId: result.company.id,
    role: result.user.role,
    name: result.user.name,
    email: result.user.email,
  });

  res.status(201).json({
    token,
    user: {
      id: result.user.id,
      name: result.user.name,
      email: result.user.email,
      role: result.user.role,
      company: {
        id: result.company.id,
        name: result.company.name,
        taxId: result.company.taxId,
      },
    },
  });

  // Email de verificación (no bloquea el registro; fallos solo se loguean)
  sendVerificationEmail(req.prisma, result.user);
  } catch (err: any) {
    console.error('[Register] Error:', err.message);
    if (err.code === 'P2002') {
      res.status(409).json({ error: 'Ya existe una empresa con ese RUC. Si no proporcionaste uno, intenta de nuevo.' });
      return;
    }
    res.status(500).json({ error: 'Error al crear la empresa. Por favor intenta de nuevo.' });
  }
});

/**
 * GET /api/auth/me
 * Devuelve el perfil del usuario autenticado.
 */
authRouter.get('/me', requireAuth, async (req, res) => {
  const user = await req.prisma.user.findUnique({
    where: { id: req.user!.userId },
    include: { company: true },
  });

  if (!user) {
    res.status(404).json({ error: 'Usuario no encontrado' });
    return;
  }

  // Todo lo que sale de acá es de la empresa ACTIVA (la del token), no de la
  // «casa» del usuario: `User.companyId` es solo la empresa por defecto. Con un
  // usuario de despacho, devolver la casa hacía que el sidebar dijera una empresa
  // mientras los paneles mostraban los datos de otra.
  const empresas = await empresasDeUsuario(req.prisma, user.id, user.role === 'superadmin');
  const activa = empresas.find((e: any) => e.id === req.user!.companyId);
  const company =
    req.user!.companyId === user.companyId || !activa
      ? user.company
      : await req.prisma.company.findUnique({ where: { id: req.user!.companyId } });

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: activa?.role || user.role,
    company: {
      id: company?.id || req.user!.companyId,
      name: company?.name || '',
      taxId: company?.taxId ?? null,
    },
    /** Las empresas a las que puede entrar (para el selector) con su rol en cada una. */
    empresas,
    // Estado de la aceptación de los Términos: el front lo usa para mostrar el
    // aviso de re-aceptación sin una consulta extra (ver js/terminos.js).
    terms: {
      currentVersion: TERMS_VERSION,
      acceptedVersion: user.termsVersion || null,
      acceptedAt: user.termsAcceptedAt || null,
      needsAcceptance: necesitaAceptar(user.termsVersion),
    },
  });
});

/**
 * La sesión de un usuario EN UNA EMPRESA: token + lo que el frontend guarda.
 *
 * La empresa y el rol salen de la membresía (`user_company`), no de `User`: es lo
 * que permite que la misma cuenta tenga un rol distinto en cada empresa. El
 * superadmin entra a cualquiera con su propio rol.
 *
 * Devuelve null si el usuario no tiene acceso a esa empresa.
 */
async function sesionEnEmpresa(prisma: any, userId: string, companyId: string): Promise<any | null> {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { company: true } });
  if (!user || !user.isActive) return null;

  const superadmin = user.role === 'superadmin';
  const rol = await rolEnEmpresa(prisma, userId, companyId, superadmin);
  if (!rol) return null;

  const company = companyId === user.companyId ? user.company : await prisma.company.findUnique({ where: { id: companyId } });
  if (!company) return null;

  return {
    token: generateToken({ userId: user.id, companyId, role: rol, name: user.name, email: user.email }),
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: rol,
      company: { id: company.id, name: company.name, taxId: company.taxId },
    },
  };
}

/**
 * POST /api/auth/switch-company
 * Cambia la empresa activa: devuelve un token NUEVO para esa empresa (el resto de
 * la API no cambia: sigue leyendo `req.user.companyId`, que ahora apunta a otra).
 * Solo a empresas donde el usuario tenga membresía —o a cualquiera, si es el
 * dueño de la plataforma—.
 */
authRouter.post('/switch-company', requireAuth, async (req, res) => {
  const companyId = String(req.body?.companyId || '').trim();
  if (!companyId) {
    res.status(400).json({ error: 'Falta la empresa' });
    return;
  }
  const sesion = await sesionEnEmpresa(req.prisma, req.user!.userId, companyId);
  if (!sesion) {
    res.status(403).json({ error: 'No tenés acceso a esa empresa.' });
    return;
  }
  res.json(sesion);
});

/**
 * POST /api/auth/accept-terms
 * Registra la aceptación de la versión VIGENTE (la del servidor: lo que mande el
 * cliente se ignora) y devuelve el estado actualizado. Lo llama el aviso de
 * re-aceptación que ve una cuenta cuya constancia quedó vieja o no existe.
 */
authRouter.post('/accept-terms', requireAuth, async (req, res) => {
  const user = await req.prisma.user.update({
    where: { id: req.user!.userId },
    data: { termsVersion: TERMS_VERSION, termsAcceptedAt: new Date() },
  });

  res.json({
    terms: {
      currentVersion: TERMS_VERSION,
      acceptedVersion: user.termsVersion,
      acceptedAt: user.termsAcceptedAt,
      needsAcceptance: false,
    },
  });
});

// ── Verificación de email y recuperación de contraseña ──

// Crea un token de un solo uso (VERIFY_EMAIL | RESET_PASSWORD) y guarda su hash SHA-256.
async function createAuthToken(prisma: any, userId: string, type: string, ttlMinutes = 30): Promise<string> {
  const raw = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(raw).digest('hex');
  await prisma.authToken.create({
    data: {
      userId,
      tokenHash,
      type,
      expiresAt: new Date(Date.now() + ttlMinutes * 60 * 1000),
    },
  });
  return raw;
}

/** POST /api/auth/forgot-password — siempre responde genérico (no filtra si el email existe). */
authRouter.post('/forgot-password', async (req, res) => {
  const { email } = req.body || {};
  if (!email) { res.status(400).json({ error: 'Email requerido' }); return; }
  try {
    const user = await req.prisma.user.findUnique({ where: { email } });
    if (user && user.isActive) {
      const token = await createAuthToken(req.prisma, user.id, 'RESET_PASSWORD', 30);
      const link = `${APP_URL}/forgot-password.html?token=${token}&mode=reset`;
      await sendEmail(
        email,
        'Restablece tu contraseña — Contador507',
        `Hola ${user.name},\n\nRecibimos una solicitud para restablecer tu contraseña.\nUsa este enlace (expira en 30 minutos):\n${link}\n\nSi no fuiste tú, ignora este correo.`,
        `<p>Hola <strong>${user.name}</strong>,</p><p>Recibimos una solicitud para restablecer tu contraseña.</p><p><a href="${link}">Restablecer contraseña</a> (expira en 30 minutos)</p><p>Si no fuiste tú, ignora este correo.</p>`,
      );
    }
    res.json({ message: 'Si el correo existe, recibirás un enlace para restablecer tu contraseña.' });
  } catch (error: any) {
    console.error('[Auth] forgot-password:', error?.message);
    res.status(500).json({ error: 'Error al procesar la solicitud' });
  }
});

/** POST /api/auth/reset-password — valida token de un solo uso y cambia la contraseña. */
authRouter.post('/reset-password', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) { res.status(400).json({ error: 'Token y contraseña requeridos' }); return; }
  if (password.length < 6) { res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' }); return; }
  try {
    const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
    const record = await req.prisma.authToken.findUnique({ where: { tokenHash } });
    if (!record || record.type !== 'RESET_PASSWORD' || record.usedAt || record.expiresAt < new Date()) {
      res.status(400).json({ error: 'El enlace es inválido o expiró. Solicita uno nuevo.' });
      return;
    }
    const hashed = await bcrypt.hash(password, 10);
    await req.prisma.$transaction([
      req.prisma.user.update({ where: { id: record.userId }, data: { password: hashed } }),
      req.prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    res.json({ message: 'Contraseña actualizada. Ya puedes iniciar sesión.' });
  } catch (error: any) {
    console.error('[Auth] reset-password:', error?.message);
    res.status(500).json({ error: 'Error al restablecer la contraseña' });
  }
});

/** GET /api/auth/verify-email?token=... — marca el email como verificado. */
authRouter.get('/verify-email', async (req, res) => {
  const token = String(req.query.token || '');
  if (!token) { res.status(400).json({ error: 'Token requerido' }); return; }
  try {
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    const record = await req.prisma.authToken.findUnique({ where: { tokenHash } });
    if (!record || record.type !== 'VERIFY_EMAIL' || record.usedAt || record.expiresAt < new Date()) {
      res.status(400).json({ error: 'El enlace es inválido o expiró.' });
      return;
    }
    await req.prisma.$transaction([
      req.prisma.user.update({ where: { id: record.userId }, data: { emailVerified: new Date() } }),
      req.prisma.authToken.update({ where: { id: record.id }, data: { usedAt: new Date() } }),
    ]);
    res.json({ message: 'Email verificado. ¡Gracias!' });
  } catch (error: any) {
    console.error('[Auth] verify-email:', error?.message);
    res.status(500).json({ error: 'Error al verificar el email' });
  }
});

/** Envía el email de verificación al recién registrado (no bloquea el registro). */
async function sendVerificationEmail(prisma: any, user: any): Promise<void> {
  try {
    const token = await createAuthToken(prisma, user.id, 'VERIFY_EMAIL', 24 * 60);
    const link = `${APP_URL}/forgot-password.html?token=${token}&mode=verify`;
    await sendEmail(
      user.email,
      'Verifica tu email — Contador507',
      `Hola ${user.name},\n\nVerifica tu correo con este enlace (expira en 24 horas):\n${link}`,
      `<p>Hola <strong>${user.name}</strong>,</p><p>Verifica tu correo con este enlace (expira en 24 horas):</p><p><a href="${link}">Verificar email</a></p>`,
    );
  } catch (e: any) {
    console.error('[Auth] Error enviando verificación:', e?.message);
  }
}
