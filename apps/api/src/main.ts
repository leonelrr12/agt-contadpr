import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { PrismaClient } from '@agt-contador/prisma-schema';
import { accountsRouter } from './routes/accounts';
import { journalRouter } from './routes/journal';
import { reportsRouter } from './routes/reports';
import { conceptsRouter } from './routes/concepts';
import { transactionsRouter } from './routes/transactions';
import { orchestrateRouter } from './routes/orchestrate';
import { ocrRouter } from './routes/ocr';
import { facturaRouter } from './routes/factura';
import { configRouter, publicConfigRouter } from './routes/config';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { apiKeysRouter } from './routes/api-keys';
import { billingRouter } from './routes/billing';
import { clientsRouter } from './routes/clients';
import { suppliersRouter } from './routes/suppliers';
import { tercerosRouter } from './routes/terceros';
import { importRouter } from './routes/import';
import { planillaRouter } from './routes/planilla';
import { honorariosRetiredRouter } from './routes/honorarios-retired';
import { recurringRouter } from './routes/recurring';
import { budgetsRouter } from './routes/budgets';
import { inventarioRouter } from './routes/inventario';
import { yearCloseRouter } from './routes/year-close';
import { reconcileRouter } from './routes/reconcile';
import { facturasRouter } from './routes/facturas';
import { whatsappRouter } from './routes/whatsapp';
import { taxCalendarRouter } from './routes/tax-calendar';
import { retencionesRouter } from './routes/retenciones';
import { declaracionesRouter } from './routes/declaraciones';
import { usersRouter } from './routes/users';
import { saludRouter } from './routes/salud';
import { reembolsosRouter } from './routes/reembolsos';
import { facturasEmailRouter } from './routes/facturas-email';
import { despachoRouter } from './routes/despacho';
import { companiesRouter } from './routes/companies';
import { pacRouter } from './routes/pac';
import { planRateLimiter } from './middleware/plan-rate-limit';
import { requireAuth, requireRole, limitarRolesExclusivos } from './middleware/auth';
import { errorHandler, notFoundHandler } from './middleware/error-handler';
import { encryptData, decryptResult } from './services/crypto-fields';
import { hashRucBase, separarIdentificacion } from '@agt-contador/shared';

const app = express();
const prisma: any = new PrismaClient().$extends({
  // Cifrado de campos en reposo (Company/Client/Supplier/PaymentRecord).
  // Pass-through si FIELD_ENC_KEY no está definida (ver services/crypto-fields.ts).
  query: {
    $allModels: {
      $allOperations: async ({ model, operation, args, query }) => {
        if (['Company', 'Client', 'Supplier'].includes(model) && ['create', 'createMany', 'update', 'updateMany'].includes(operation)) {
          // taxIdHash determinista para dedupe de RUC sin filtrar el valor.
          // Se hashea el RUC BASE (sin DV ni separadores) y, si el taxId trae
          // el DV pegado (`...-50`), se guarda aparte en `dv`: así el mismo
          // tercero no se duplica por escribirlo con o sin DV.
          // Un DV explícito manda: el taxId ya es la base y NO se vuelve a
          // partir (`8-819-43` + DV `33` perdería `-43` en el próximo save).
          // Sin DV explícito se separa según el tipo/la forma.
          // Al vaciar el RUC se limpia el hash (evita dedupe obsoleto).
          const d: any = (args as any).data;
          if (d && 'taxId' in d) {
            const taxIdPlain = d.taxId;
            if (typeof taxIdPlain === 'string' && taxIdPlain && !taxIdPlain.startsWith('v1:')) {
              let base = taxIdPlain;
              let dv: string | null = String(d.dv ?? '').trim() || null;
              if (dv) {
                const sufijo = `-${dv}`;
                if (base.endsWith(sufijo)) base = base.slice(0, -sufijo.length).replace(/[^0-9A-Za-z]+$/, '');
              } else {
                const partes = separarIdentificacion(base, d.taxIdType);
                base = partes.base;
                dv = partes.dv;
              }
              if (base) d.taxId = base;
              if (dv) d.dv = dv;
              // Sin FIELD_ENC_KEY el hash es '' (modo local): se guarda null
              // para no chocar con el unique de taxIdHash.
              d.taxIdHash = hashRucBase(base || taxIdPlain) || null;
            } else if (!taxIdPlain) {
              d.taxIdHash = null;
            }
          }
        }
        if (['create', 'createMany', 'update', 'updateMany'].includes(operation)) {
          (args as any).data = encryptData((args as any).data, model as string);
        }
        const result = await query(args);
        // Se descifra TODO lo que devuelve una fila, no solo las lecturas: una
        // escritura tiene que devolver lo mismo que devolvería su lectura. Sin
        // esto, `upsert` —el que usa la configuración del buzón— entregaba la
        // contraseña IMAP todavía en `v1:…` y el servidor de correo la rechazaba.
        if (
          ['findUnique', 'findFirst', 'findMany', 'findUniqueOrThrow', 'findFirstOrThrow', 'create', 'update', 'upsert', 'delete'].includes(
            operation,
          )
        ) {
          return decryptResult(result);
        }
        return result;
      },
    },
  },
});

// Trust proxy — necesario si la API está detrás de nginx o load balancer
// para que express-rate-limit use la IP real del cliente (X-Forwarded-For)
app.set('trust proxy', 1);

// Rate limiting general: 200 requests cada 15 minutos por IP
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 200,
  standardHeaders: true,   // RateLimit-* headers
  legacyHeaders: false,    // Desactiva X-RateLimit-* (deprecados)
  message: { error: 'Demasiadas solicitudes. Intente de nuevo en 15 minutos.' },
});

// Rate limiting estricto para endpoints que invocan LLM (DeepSeek)
const llmLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes al agente. Intente de nuevo en 1 minuto.' },
});

// Rate limiting estricto para forgot-password (anti-abuso de envío de links)
const authLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intente de nuevo en 1 minuto.' },
});

// Rate limiting del login por IP (anti fuerza bruta). El freno por CUENTA —el que
// aguanta intentos repartidos entre varias IPs— vive en services/login-guard.ts.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutos
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Intente de nuevo en 15 minutos.' },
});

// Rate limiting para procesamiento pesado (OCR / PDF)
const heavyLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minuto
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes de procesamiento. Intente de nuevo en 1 minuto.' },
});

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '5mb' }));

// Evitar que errores no manejados tumben el proceso
process.on('unhandledRejection', (reason) => {
  console.error('unhandledRejection:', reason);
});
process.on('uncaughtException', (error) => {
  console.error('uncaughtException:', error.message || error);
  if (error.message?.includes('EADDRINUSE')) process.exit(1);
});

// Aplica rate limiting por ruta (antes de los routers)
app.use('/api/', generalLimiter);
app.use('/api/auth/forgot-password', authLimiter);
app.use('/api/auth/login', loginLimiter);
app.use('/api/import', heavyLimiter);
app.use('/api/reconcile', heavyLimiter);
app.use('/api/orchestrate', llmLimiter);
app.use('/api/salud', llmLimiter);
app.use('/api/ocr', heavyLimiter);
app.use('/api/factura', heavyLimiter);

// Prisma client en req para todas las rutas
app.use((req, _res, next) => {
  req.prisma = prisma;
  next();
});

// ── Rutas públicas (sin autenticación) ──
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' });
});
app.use('/api/auth', authRouter);
app.use('/api', billingRouter);  // /api/plans (público), /api/subscription (auth interno)
app.use('/api/whatsapp', whatsappRouter);  // webhook público + links (auth)
app.use('/api/config', publicConfigRouter);  // público: wa-phone, etc.

// ── Middleware de autenticación para el resto de rutas ──
app.use('/api', requireAuth);
// El rol `inventario` solo pasa por su lista blanca (ver middleware/auth.ts).
app.use('/api', limitarRolesExclusivos);

// ── Rate limiting por plan (después de auth, aplica a todas las rutas protegidas) ──
app.use('/api', planRateLimiter);

// ── Rutas protegidas ──
app.use('/api/accounts', accountsRouter);
app.use('/api/journal', journalRouter);
app.use('/api/reports', reportsRouter);
app.use('/api/concepts', conceptsRouter);
app.use('/api/transactions', transactionsRouter);
app.use('/api/orchestrate', orchestrateRouter);
app.use('/api/ocr', ocrRouter);
app.use('/api/factura', facturaRouter);
app.use('/api/clients', clientsRouter);
app.use('/api/suppliers', suppliersRouter);
app.use('/api/terceros', tercerosRouter);
app.use('/api/import', importRouter);
app.use('/api/planilla', planillaRouter);
app.use('/api/honorarios', honorariosRetiredRouter);  // modo retirado → 410 con guía
app.use('/api/recurring', recurringRouter);
app.use('/api/budgets', budgetsRouter);
app.use('/api/inventario', inventarioRouter);
app.use('/api/year-close', yearCloseRouter);
app.use('/api/reconcile', reconcileRouter);
app.use('/api/facturas', facturasRouter);
app.use('/api/retenciones-itbms', retencionesRouter);
app.use('/api/declaraciones-itbms', declaracionesRouter);
app.use('/api/users', usersRouter);
app.use('/api/tax-calendar', taxCalendarRouter);
app.use('/api/salud', saludRouter);
app.use('/api/reembolsos', reembolsosRouter);
app.use('/api/facturas-email', facturasEmailRouter);
app.use('/api/despacho', despachoRouter);
app.use('/api/companies', companiesRouter);
// Configuración de emisión electrónica por empresa (PAC). El router exige rol
// admin/superadmin y el módulo Facturas PDF. Aún no emite: solo configura y prueba.
app.use('/api/pac', pacRouter);
app.use('/api/config', requireRole('admin', 'superadmin'), configRouter);
app.use('/api/keys', apiKeysRouter);
app.use('/api/admin', requireRole('superadmin'), adminRouter);

// ── 404 y manejo global de errores (siempre al final de la pila) ──
app.use(notFoundHandler);
app.use(errorHandler);

// ── Tareas de inicio (webhook WhatsApp, obligaciones fiscales, recurrentes) ──
import { runStartupTasks, startRecurringCron } from './services/startup';
import { startEmailFacturasCron } from './services/email-facturas-cron';
prisma.$connect().then(() => {
  runStartupTasks(prisma).catch(err => {
    console.error('[Startup] Error en tareas de inicio:', err.message);
  });
  startRecurringCron(prisma);
  // El buzón de facturas por correo: una pasada diaria de madrugada (con catch-up).
  // Usa el cliente EXTENDIDO: con el crudo, la contraseña IMAP llega cifrada.
  startEmailFacturasCron(prisma);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});

export { app, prisma };
