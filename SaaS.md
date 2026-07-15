# SaaS — Plan de Implementación para Contador507

> **Estado actual:** Aplicación multi-tenant funcional con procesamiento contable por IA.
> **Objetivo:** Evolucionar a una plataforma SaaS con planes, suscripciones, API Keys y control de cuotas.

---

## 1. Diagnóstico del Codebase Actual

### ✅ Lo que ya existe

| Componente | Estado | Detalle |
|---|---|---|
| **Multi-tenancy** | ✅ Implementado | `companyId` en todos los modelos. Registro crea empresa aislada con plan de cuentas propio |
| **Auth (JWT + roles)** | ✅ Implementado | `jsonwebtoken` con roles `admin`/`contador`/`asistente`, expiración 24h |
| **Procesamiento contable** | ✅ Implementado | OCR (Tesseract.js) + DeepSeek LLM + generación de asientos doble entrada |
| **Reportes** | ✅ Implementado | Balance, estado de resultados, flujo de caja, dashboard, export a Excel |
| **Rate limiting** | ⚠️ Parcial | Global con `express-rate-limit`. No por plan ni por tenant |
| **Frontend** | ✅ Funcional | HTML/CSS/JS vanilla (SPA con sidebar + chat + panel de reportes) |
| **ORM** | ✅ Prisma | PostgreSQL con 11 modelos |
| **Audit Log** | ✅ Implementado | Registro de acciones (login, create, review, etc.) |

### ❌ Lo que falta para ser SaaS

| Componente | Estado |
|---|---|
| **Suscripciones / Planes** | ❌ No existe |
| **Stripe (pagos)** | ❌ No existe |
| **API Keys** | ❌ Solo JWT de sesión |
| **Control de cuotas** | ❌ Sin límites por tenant |
| **Portal de facturación** | ❌ No existe |
| **Redis / caché** | ❌ Cada request va a PostgreSQL |
| **Recuperación de contraseña** | ❌ No existe |
| **Verificación de email** | ❌ No existe |

### 🐛 Bugs críticos a corregir antes del SaaS

- [x] **~~Multi-tenancy roto~~** — ✅ **IMPLEMENTADO** (2026-07-15). Se corrigieron 13 ocurrencias de `companyId: 'demo-company'` hardcodeado en `accounts.ts` (2), `journal.ts` (7) y `reports.ts` (6). Quedan solo 2 referencias legítimas en `auth.ts` (plantilla para copiar plan de cuentas durante registro).

---

## 2. Arquitectura General Propuesta

```
┌─────────────────────────────────────────────────────┐
│                   CLIENTES                           │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ Web App  │  │ Zapier/  │  │ Sistemas propios │   │
│  │(usuario) │  │ Make.com │  │ (API directa)    │   │
│  └────┬─────┘  └────┬─────┘  └────────┬─────────┘   │
│       │             │                 │              │
│       │ JWT         │ API Key         │ API Key      │
└───────┼─────────────┼─────────────────┼──────────────┘
        │             │                 │
        ▼             ▼                 ▼
┌─────────────────────────────────────────────────────┐
│              MIDDLEWARE UNIFICADO                     │
│  ┌──────────────────────────────────────────────┐    │
│  │  requireAuth() — Soporta JWT + API Keys      │    │
│  │  requireQuota() — Valida suscripción + cuota │    │
│  │  rateLimitByPlan() — Límites por plan        │    │
│  └──────────────────────────────────────────────┘    │
│                                                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ Agente   │  │ Reportes │  │ OCR / Facturas   │    │
│  │ Contable │  │          │  │                  │    │
│  └──────────┘  └──────────┘  └──────────────────┘    │
│                                                       │
│  ┌──────────────────────────────────────────────┐    │
│  │  PostgreSQL (transaccional)                   │    │
│  └──────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────┐
│              STRIPE (externo)                         │
│  ┌──────────┐  ┌──────────┐  ┌──────────────────┐    │
│  │ Checkout │  │ Customer │  │ Webhooks         │    │
│  │ Session  │  │ Portal   │  │ → tu backend     │    │
│  └──────────┘  └──────────┘  └──────────────────┘    │
└─────────────────────────────────────────────────────┘
```

### Principios de diseño

1. **No empezar de cero** — evolucionar el codebase existente incrementalmente
2. **Stripe para todo lo financiero** — no almacenar tarjetas, no calcular impuestos manualmente
3. **API Keys con SHA-256** — nunca guardar en texto plano
4. **Cuotas por período de facturación** — contar movimientos, no requests
5. **Redis solo cuando sea necesario** — PostgreSQL con buenos índices aguanta >1000 req/min

---

## 3. Stack Tecnológico

| Capa | Tecnología actual | Cambios para SaaS |
|---|---|---|
| **Backend** | Node.js + Express + TypeScript | Igual |
| **Base de datos** | PostgreSQL + Prisma | Igual + nuevos modelos |
| **Auth** | JWT (jsonwebtoken) | Extender para soportar API Keys |
| **Pagos** | — | **Stripe** (SDK oficial) |
| **Frontend** | HTML/CSS/JS vanilla | Agregar páginas: `planes.html`, `api-keys.html` |
| **Caché (futuro)** | — | Redis (cuando >100 clientes activos) |
| **Infra** | Docker + PM2 + Nginx | Igual |

---

## 4. Plan de Implementación (3 Fases)

---

### Fase 1: Planes, Suscripciones y Pagos Manuales ✅ IMPLEMENTADO (2026-07-15)

**Duración estimada:** 2-3 semanas | **Duración real:** ~2 horas

> **Decisión:** Se descartó Stripe en favor de pagos manuales (Yappy / Transferencia Bancaria) + panel de admin para activar suscripciones, por ser más adecuado para el mercado panameño.

#### 4.1.1 — Corregir bug multi-tenancy (PRE-REQUISITO) ✅ IMPLEMENTADO

Reemplazar todos los `companyId: 'demo-company'` hardcodeados por `companyId: req.user!.companyId` en:
- `apps/api/src/routes/accounts.ts` ✅ (2 ocurrencias)
- `apps/api/src/routes/journal.ts` ✅ (7 ocurrencias)
- `apps/api/src/routes/reports.ts` ✅ (6 ocurrencias)

> **Nota:** Las 2 referencias restantes en `auth.ts` son correctas — copian el plan de cuentas desde `demo-company` como plantilla para nuevas empresas durante el registro.

#### 4.1.2 — Nuevos modelos en Prisma ✅ IMPLEMENTADO

```prisma
model Plan {
  id             String         @id @default(cuid())
  name           String         // "Emprendedor", "Pyme", "Despacho"
  description    String?        // Descripción para la UI
  stripePriceId  String         @unique // price_xxx de Stripe
  monthlyLimit   Int            // 100, 500, 2000 movimientos/mes
  price          Float          // Precio mensual en USD
  features       String         @default("[]") // JSON array de features
  isActive       Boolean        @default(true)
  createdAt      DateTime       @default(now())

  subscriptions  Subscription[]
}

model Subscription {
  id                   String    @id @default(cuid())
  companyId            String
  planId               String
  stripeSubscriptionId String?   @unique
  stripeCustomerId     String?
  status               String    @default("inactive")
  // Estados: "active", "past_due", "canceled", "trialing"
  currentPeriodStart   DateTime
  currentPeriodEnd     DateTime
  canceledAt           DateTime?
  createdAt            DateTime  @default(now())
  updatedAt            DateTime  @updatedAt

  company Company @relation(fields: [companyId], references: [id])
  plan    Plan    @relation(fields: [planId], references: [id])

  @@index([companyId])
  @@index([stripeCustomerId])
}

model Usage {
  id             String   @id @default(cuid())
  companyId      String
  subscriptionId String
  periodStart    DateTime
  periodEnd      DateTime
  count          Int      @default(0)

  @@unique([subscriptionId, periodStart])
  @@index([companyId])
}
```

#### 4.1.3 — Endpoints implementados ✅

```
GET  /api/plans                     — Público, lista planes disponibles
GET  /api/subscription              — Info de suscripción del usuario autenticado
GET  /api/admin/stats               — Dashboard de admin (empresas, suscripciones, ingresos)
GET  /api/admin/subscriptions       — Listar todas las suscripciones
GET  /api/admin/subscriptions/:id   — Detalle de una suscripción
POST /api/admin/subscriptions       — Crear/activar suscripción para una empresa
PATCH /api/admin/subscriptions/:id  — Actualizar suscripción (extender, cambiar plan)
GET  /api/admin/payments            — Historial de pagos
POST /api/admin/payments            — Registrar un pago (Yappy/Transferencia/etc) y renovar suscripción
GET  /api/admin/plans               — Listar planes (admin)
```

#### 4.1.4 — Pagos manuales (Yappy / Transferencia) ✅

Eventos a procesar:
- `checkout.session.completed` → Crear `Subscription`, activar `status: "active"`
- `invoice.paid` → Actualizar `currentPeriodEnd`
- `invoice.payment_failed` → Marcar `status: "past_due"`
- `customer.subscription.deleted` → Marcar `status: "canceled"`
- `customer.subscription.updated` → Sincronizar cambios de plan

#### 4.1.5 — Seed de planes

```typescript
// En packages/prisma-schema/prisma/seed.ts (agregar al seed existente)
const plans = [
  {
    name: 'Emprendedor',
    description: 'Para profesionales independientes',
    stripePriceId: 'price_XXXXXXXX', // Crear en Stripe Dashboard primero
    monthlyLimit: 100,
    price: 19.99,
    features: JSON.stringify([
      'Hasta 100 movimientos/mes',
      'Procesamiento por IA',
      'Escáner OCR de facturas',
      'Reportes básicos',
      'Exportación a Excel',
      'Soporte por email'
    ]),
  },
  {
    name: 'Pyme',
    description: 'Para pequeñas y medianas empresas',
    stripePriceId: 'price_YYYYYYYY',
    monthlyLimit: 500,
    price: 49.99,
    features: JSON.stringify([
      'Hasta 500 movimientos/mes',
      'Procesamiento por IA avanzado',
      'Escáner OCR de facturas',
      'Todos los reportes',
      'Exportación a Excel',
      'API Key para integraciones',
      'Soporte prioritario'
    ]),
  },
  {
    name: 'Despacho',
    description: 'Para despachos contables',
    stripePriceId: 'price_ZZZZZZZZ',
    monthlyLimit: 2000,
    price: 149.99,
    features: JSON.stringify([
      'Hasta 2,000 movimientos/mes',
      'Procesamiento por IA avanzado',
      'Escáner OCR de facturas',
      'Todos los reportes',
      'Exportación a Excel',
      'Múltiples API Keys',
      'White-label',
      'Soporte dedicado'
    ]),
  },
];
```

#### 4.1.6 — Páginas de frontend ✅ IMPLEMENTADO

- `planes.html` — Grid de 4 tarjetas (Demo, Emprendedor, Pyme, Despacho) con features, precio, instrucciones de pago Yappy/Transferencia
- Endpoint `/api/subscription` integrado en el backend para mostrar estado en el dashboard

---

### Fase 2: API Keys para acceso programático ✅ IMPLEMENTADO (2026-07-15)

**Duración estimada:** 2 semanas | **Duración real:** ~45 minutos

#### 4.2.1 — Modelo Prisma ✅ IMPLEMENTADO

```prisma
model ApiKey {
  id         String    @id @default(cuid())
  companyId  String
  name       String    // "Producción", "Test", "Zapier"
  keyHash    String    @unique  // SHA-256 del token completo
  prefix     String    @default("sk_live_")
  truncated  String    // "sk_live_8f3a...9b2c" para mostrar
  lastUsedAt DateTime?
  createdAt  DateTime  @default(now())
  expiresAt  DateTime?
  isRevoked  Boolean   @default(false)

  company Company @relation(fields: [companyId], references: [id])

  @@index([companyId])
  @@index([keyHash])
  @@map("api_key")
}
```

#### 4.2.2 — Generación segura (nunca texto plano)

```typescript
import crypto from 'crypto';

function generateApiKey(companyId: string, name: string) {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const apiKey = `sk_live_${rawToken}`;

  // Versión truncada para mostrar en el dashboard
  const truncated = `${apiKey.slice(0, 15)}...${apiKey.slice(-4)}`;

  // Hash SHA-256 para guardar en BD
  const keyHash = crypto.createHash('sha256').update(apiKey).digest('hex');

  // Guardar solo el hash en BD
  // await prisma.apiKey.create({ data: { companyId, name, keyHash, truncated } });

  // Retornar la llave real SOLO UNA VEZ
  return { apiKey, truncated };
}
```

#### 4.2.3 — Middleware unificado de autenticación

Modificar `requireAuth` para aceptar **dos modos**:

```typescript
export async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token requerido' });
  }

  const token = authHeader.slice(7);

  // Modo 1: API Key (prefijo "sk_live_")
  if (token.startsWith('sk_live_')) {
    const keyHash = crypto.createHash('sha256').update(token).digest('hex');
    const key = await req.prisma.apiKey.findUnique({
      where: { keyHash },
      include: {
        company: {
          include: {
            subscriptions: {
              where: { status: 'active' }
            }
          }
        }
      }
    });

    if (!key || key.isRevoked) {
      return res.status(401).json({ error: 'API Key inválida' });
    }

    if (key.expiresAt && key.expiresAt < new Date()) {
      return res.status(401).json({ error: 'API Key expirada' });
    }

    // Actualizar lastUsedAt (asíncrono, no bloquea)
    req.prisma.apiKey.update({
      where: { id: key.id },
      data: { lastUsedAt: new Date() }
    }).catch(() => {});

    req.user = {
      userId: key.company.users[0]?.id || '',
      companyId: key.companyId,
      role: 'admin',
      name: key.company.name,
      email: '',
    };

    return next();
  }

  // Modo 2: JWT (sesión web)
  try {
    const decoded = jwt.verify(token, JWT_SECRET) as AuthUser;
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}
```

#### 4.2.4 — Endpoints de gestión ✅ IMPLEMENTADO

```
GET    /api/keys          — Listar API Keys (truncadas, sin hash, con lastUsedAt)
POST   /api/keys          — Generar nueva (retorna llave completa UNA VEZ)
DELETE /api/keys/:id      — Revocar API Key (soft-delete con isRevoked)
```

#### 4.2.5 — Middleware unificado ✅ IMPLEMENTADO

El middleware `requireAuth` en `middleware/auth.ts` ahora soporta dos modos:
- **JWT** (sesión web): token de 24h — sin cambios para la app web
- **API Key** (sk_live_...): SHA-256 hasheado, validado contra la BD, actualiza lastUsedAt

#### 4.2.6 — Frontend ✅ IMPLEMENTADO

- `api-keys.html` — Página completa con: crear, listar, copiar, revocar keys + ejemplos de uso (cURL, JS, Zapier)

---

### Fase 3: Control de Cuotas y Rate Limiting por Plan ✅ IMPLEMENTADO (2026-07-15)

**Duración estimada:** 1-2 semanas | **Duración real:** ~30 minutos

#### 4.3.1 — Middleware de cuota

```typescript
// apps/api/src/middleware/quota.ts
export async function requireQuota(req, res, next) {
  const companyId = req.user!.companyId;

  const subscription = await req.prisma.subscription.findFirst({
    where: { companyId, status: 'active' },
    include: { plan: true },
  });

  if (!subscription) {
    return res.status(402).json({
      error: 'Suscripción requerida',
      code: 'SUBSCRIPTION_REQUIRED',
    });
  }

  // Contar movimientos en el período actual (usa el período de Stripe)
  const usage = await req.prisma.usage.findUnique({
    where: {
      subscriptionId_periodStart: {
        subscriptionId: subscription.id,
        periodStart: subscription.currentPeriodStart,
      },
    },
  });

  const currentUsage = usage?.count || 0;

  if (currentUsage >= subscription.plan.monthlyLimit) {
    return res.status(429).json({
      error: 'Límite mensual alcanzado',
      code: 'QUOTA_EXCEEDED',
      limit: subscription.plan.monthlyLimit,
      usage: currentUsage,
    });
  }

  req.subscription = subscription;
  next();
}
```

#### 4.3.2 — Incrementar contador al crear movimientos

```typescript
// En POST /api/transactions y POST /api/orchestrate/confirm
await req.prisma.usage.upsert({
  where: {
    subscriptionId_periodStart: {
      subscriptionId: subscription.id,
      periodStart: subscription.currentPeriodStart,
    },
  },
  update: { count: { increment: 1 } },
  create: {
    companyId: req.user!.companyId,
    subscriptionId: subscription.id,
    periodStart: subscription.currentPeriodStart,
    periodEnd: subscription.currentPeriodEnd,
    count: 1,
  },
});
```

#### 4.3.3 — Rate limiting por plan ✅ IMPLEMENTADO

Middleware `planRateLimiter` en `middleware/plan-rate-limit.ts`:
- Demo / sin plan: 3 req/s
- Emprendedor: 5 req/s
- Pyme: 15 req/s
- Despacho: 30 req/s
- Aplicado a todas las rutas protegidas después de auth
- Key: companyId (no IP), permite uso justo entre usuarios de la misma red

#### 4.3.4 — Endpoint de uso detallado ✅ IMPLEMENTADO

`GET /api/subscription` ahora incluye:
- `usagePercent`: porcentaje de cuota consumida
- `daysLeft` / `daysTotal`: días restantes en el período
- `dailyUsage`: desglose diario de movimientos
- `rateLimit`: límite de requests/segundo del plan

// Middleware dinámico que ajusta el límite según el plan
app.use('/api/', async (req, res, next) => {
  if (!req.user?.companyId) return next();

  const subscription = await getActiveSubscription(req.user.companyId);
  const maxRequests = subscription
    ? planRateLimits[subscription.plan.name] || 5
    : 5;

  // Aplicar rate limit dinámico
  rateLimit({
    windowMs: 1000,
    max: maxRequests,
    keyGenerator: (req) => req.user!.companyId,
  })(req, res, next);
});
```

---

## 5. Consideraciones de Negocio

### 5.1 — Planes sugeridos

| Plan | Movimientos/mes | Precio (USD/mes) | Ideal para |
|---|---|---|---|
| **Emprendedor** | 100 | $19.99 | Profesionales independientes |
| **Pyme** | 500 | $49.99 | Negocios pequeños/medianos |
| **Despacho** | 2,000 | $149.99 | Despachos contables con múltiples clientes |

### 5.2 — Flujo de registro

1. Usuario llega a `planes.html` → elige plan → hace clic en "Comenzar"
2. Stripe Checkout (hosted) → pago con tarjeta
3. Webhook `checkout.session.completed` → backend crea `Company` + `User` + `Subscription`
4. Redirección a `login.html` con credenciales enviadas por email
5. Primer login → wizard de configuración (datos de empresa, plan de cuentas)

### 5.3 — ¿Qué hacer cuando se vence una suscripción?

| Estado | Acción |
|---|---|
| `past_due` | Mostrar banner en la UI. Seguir permitiendo acceso por 7 días de gracia |
| `canceled` | Bloquear creación de nuevos movimientos. Permitir acceso de solo lectura (reportes, exportación) |
| `active` | Acceso completo |

---

## 6. Roadmap Visual

```
                     Ahora    Semana 1-2     Semana 3-4     Semana 5-6     Semana 7-8
                        │         │              │              │              │
Corregir multi-tenancy  ████████  │              │              │              │
Modelos Prisma (Plan/   ████████  │              │              │              │
  Subscription/Usage)   ████████  │              │              │              │
Stripe Checkout +        ████████████████████   │              │              │
  Webhooks               ████████████████████   │              │              │
Frontend: planes.html             ██████████████│              │              │
                                        │        │              │              │
Modelo ApiKey                                   ██████████████ │              │
Middleware API Key                               ██████████████ │              │
Frontend: api-keys.html                          ██████████████ │              │
                                                        │        │              │
Middleware cuota                                          ██████████████████████
Rate limiting por plan                                    ██████████████████████
Dashboard de uso                                          ██████████████████████
                                                                     │
                                                               🚀 LANZAMIENTO
```

---

## 7. Riesgos y Mitigaciones

| Riesgo | Mitigación |
|---|---|
| **Stripe no disponible en Panamá** | Usar LemonSqueezy como alternativa (soporta LATAM sin necesidad de entidad en US) |
| **API Key leak** | Permitir revocación inmediata. Rotación automática cada 90 días. Rate limit por key |
| **Abuso del OCR** | El OCR es costoso (CPU). Limitar a N facturas/mes según plan |
| **Costo de DeepSeek API** | Cachear resultados de clasificación para conceptos repetidos. Limitar llamadas LLM por plan |
| **Migración de datos** | `prisma db push` actualmente. Migrar a `prisma migrate` antes de producción SaaS |

---

## 8. Notas Técnicas

- **Stripe SDK**: `npm install stripe` (SDK oficial de Node.js)
- **Webhook local**: Usar `stripe listen --forward-to localhost:3001/api/billing/webhook` para desarrollo
- **Variables de entorno nuevas**:
  ```
  STRIPE_SECRET_KEY=sk_live_xxx
  STRIPE_WEBHOOK_SECRET=whsec_xxx
  STRIPE_PRICE_EMPRENDEDOR=price_xxx
  STRIPE_PRICE_PYME=price_xxx
  STRIPE_PRICE_DESPACHO=price_xxx
  ```
- **Redis (fase futura)**: Instalar `ioredis`. Solo necesario cuando >100 clientes activos simultáneos
