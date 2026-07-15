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
import { configRouter } from './routes/config';
import { authRouter } from './routes/auth';
import { adminRouter } from './routes/admin';
import { apiKeysRouter } from './routes/api-keys';
import { billingRouter } from './routes/billing';
import { planRateLimiter } from './middleware/plan-rate-limit';
import { requireAuth, requireRole } from './middleware/auth';

const app = express();
const prisma = new PrismaClient();

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

// Aplica rate limiting por ruta (antes de los routers)
app.use('/api/', generalLimiter);
app.use('/api/orchestrate', llmLimiter);
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

// ── Middleware de autenticación para el resto de rutas ──
app.use('/api', requireAuth);

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
app.use('/api/config', requireRole('admin'), configRouter);
app.use('/api/keys', apiKeysRouter);
app.use('/api/admin', requireRole('admin'), adminRouter);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`API server running on http://localhost:${PORT}`);
});

export { app, prisma };
