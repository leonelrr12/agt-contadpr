import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { generateToken, requireAuth } from '../middleware/auth';
import { sendEmail, APP_URL } from '../services/mailer';

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

  const user = await req.prisma.user.findUnique({
    where: { email },
    include: { company: true },
  });

  if (!user || !user.isActive) {
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const valid = await bcrypt.compare(password, user.password);
  if (!valid) {
    res.status(401).json({ error: 'Credenciales inválidas' });
    return;
  }

  const token = generateToken({
    userId: user.id,
    companyId: user.companyId,
    role: user.role,
    name: user.name,
    email: user.email,
  });

  res.json({
    token,
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      company: {
        id: user.company.id,
        name: user.company.name,
        taxId: user.company.taxId,
      },
    },
  });
});

/**
 * POST /api/auth/register
 * Body: { name, email, password, companyName, companyTaxId }
 * Registra una nueva empresa + usuario admin.
 */
authRouter.post('/register', async (req, res) => {
  const { name, email, password, companyName, companyTaxId } = req.body;

  if (!name || !email || !password || !companyName) {
    res.status(400).json({ error: 'Nombre, email, contraseña y nombre de empresa son requeridos' });
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
      },
    });

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

  res.json({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    company: {
      id: user.company.id,
      name: user.company.name,
      taxId: user.company.taxId,
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
