import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { generateToken, requireAuth } from '../middleware/auth';

export const authRouter = Router();

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

  // Crear empresa + usuario admin en una transacción
  const result = await req.prisma.$transaction(async (tx: any) => {
    const company = await tx.company.create({
      data: {
        name: companyName,
        taxId: companyTaxId || 'N/A',
        country: 'PA',
        currency: 'USD',
      },
    });

    // Copiar plan de cuentas desde demo
    const demoAccounts = await tx.account.findMany({
      where: { companyId: 'demo-company' },
    });

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
      where: { companyId: 'demo-company' },
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
