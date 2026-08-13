# AGENTS.md — agt-contador

## Monorepo (Turbo + npm workspaces)

```
apps/
  api/     — Express server (@agt-contador/api)   entry: src/main.ts  port 3001
  web/     — Static frontend (@agt-contador/web)  dev: npx serve ./public -p 3000
packages/
  shared/          — TS types/enums (@agt-contador/shared)
  prisma-schema/   — Prisma + SQLite (@agt-contador/prisma-schema)
  agents/          — DialogAgent, ClassificationAgent, AccountingAgent, OrchestratorAgent
```

## Commands (run from root)

| Command | What it does |
|---|---|
| `npm run dev` | `turbo dev` — runs all dev scripts in parallel |
| `npm run build` | `turbo build` — compiles TS via `tsc` |
| `npm run db:generate` | `turbo run db:generate` → `prisma generate` in prisma-schema |
| `npm run db:push` | `turbo run db:push` → pushes schema to PostgreSQL (dev; en producción usar `prisma migrate deploy`) |
| `npm run db:seed` | seeds Panamanian chart of accounts + concept catalog (depends on db:push) |
| `npm run format` | `prettier --write "**/*.{ts,tsx,json,md}"` |
| `npm run test` / `lint` | stub — all packages echo placeholder |

**Order for fresh setup:** `db:generate → db:push → db:seed → dev` (producción: `migrate deploy`).

## Database

- **PostgreSQL 16** via Prisma (SQLite anterior ya no se usa).
- `DATABASE_URL` se configura en `.env` o en variables de entorno del contenedor.
- PrismaClient se re-exporta desde `@agt-contador/prisma-schema`.
- Express augment: `req.prisma` inyectado via middleware (`apps/api/src/types.d.ts`).

## Docker

| Comando | Qué hace |
|---|---|
| `docker compose up -d` | Levanta PostgreSQL + API + nginx |
| `docker compose build api` | Reconstruye solo la imagen de la API |
| `docker compose logs api -f` | Sigue los logs de la API |
| `docker compose down` | Detiene y elimina todos los servicios |

- Puerto `3001`: API directa
- Puerto `8090`: Frontend vía nginx
- Puerto `5433`: PostgreSQL (expuesto al host)
- El entrypoint del contenedor API ejecuta `prisma db push` + seed automáticamente al arrancar

## Auth y Multi-tenancy

- **JWT + API Keys** vía `requireAuth` (`apps/api/src/middleware/auth.ts`): modo sesión web (JWT 24h) y modo programático (`sk_live_...` con SHA-256). Roles: `admin` / `contador` / `asistente`.
- Todo está scoped por `companyId` desde `req.user!.companyId`. La única referencia legítima a `demo-company` es `TEMPLATE_COMPANY_ID` en `apps/api/src/routes/auth.ts` (plantilla de plan de cuentas al registrar empresa).
- `OrchestratorAgent` exige `userId` real en el constructor (FK `createdById`). WhatsApp resuelve el admin de la empresa con `resolveWhatsAppUserId()`.

## Agent pipeline

1. **DialogAgent** — NL extraction via **DeepSeek LLM** (OpenAI-compatible API), falls back to keyword-based regex if API is unavailable. Extracts type, concept, amount, payment method, date.
2. **ClassificationAgent** — looks up concept → accountId from DB. Falls back to prefix matching if no exact match.
3. **AccountingAgent** — generates double-entry journal lines via rule-based logic per transaction type. Validates debit=credit.
4. **OrchestratorAgent** — orchestrates dialog → classify → accounting flow. Creates entries as `BORRADOR` (no longer `CONFIRMADO`). Posts to `/api/orchestrate`, confirm via `/api/orchestrate/confirm`.

## Workflow de Revisión (Contador Senior)

```
Usuario escribe transacción
  → OrchestratorAgent crea asiento como BORRADOR
  → Contador Senior revisa en panel "Revisión"
  → Aprobar  → status = CONFIRMADO (aparece en reportes)
  → Rechazar → status = RECHAZADO + notas
  → Creador corrige y re-envía (PATCH → BORRADOR)
```

| Endpoint | Descripción |
|---|---|
| `GET /api/journal/pendientes` | Lista asientos en BORRADOR pendientes de revisión |
| `POST /api/journal/:id/review` | Body: `{ action: "aprobar"\|"rechazar", notes?: string }` |
| `PATCH /api/journal/:id/status` | Solo permite RECHAZADO → BORRADOR (re-envío) |

Campos nuevos en JournalEntry: `reviewedById`, `reviewedAt`, `reviewNotes`. Enums en shared: `REVISADO`, `RECHAZADO` añadidos a `JournalEntryStatus` (REVISADO reservado para uso futuro).

## Deployment

- **nginx** (host, `/etc/nginx/sites-available/contador507.com`) serves frontend statics from `apps/web/public` (sin build) y proxea `/api/*` a `localhost:3001`. Fallback SPA `try_files … /index.html` (ojo: un `.js` mal escrito devuelve 200+HTML, no 404).
- **PM2** manages the API process (`pm2 start ecosystem.config.js` from root, auto-restarts on crash/reboot). Tras cambios de backend: `pm2 restart agt-contador-api --update-env`.
- `NODE_ENV=production` está en `ecosystem.config.js` y `.env` (el error handler global oculta mensajes internos con este flag).
- `.env` with `DATABASE_URL` must exist at root and `packages/prisma-schema/`.
- Email: `MAILER_API_URL`/`MAILER_API_KEY`/`APP_URL` — el MailerApi local corre en el puerto 3004 (PM2 `mailer-api`); sin key, los envíos se simulan en logs.
- CI: `.github/workflows/ci.yml` corre tests + typecheck en cada push/PR (sin deploy).

## Local dev URLs

- Frontend (nginx): `http://localhost:8090` and `http://147.93.145.67` (port 80)
- API direct: `http://localhost:3001`

## Current state (MVP Phase 1 completo + Fase 2 completa)

- **LLM integrado**: DeepSeek via OpenAI-compatible API, con fallback a keywords
- Tests: **55/55 pasando** via Vitest. **Lint**: ESLint configurado con `typescript-eslint`
- Auth JWT + API Keys, multi-tenant, SaaS (planes/suscripciones/cuotas), OCR+PDF+QR, conciliación bancaria, importación masiva, recurrentes, WhatsApp bot, calendario fiscal PA, dashboard de salud financiera con IA (`/api/salud`), email verification/reset (vía MailerApi local), audit log
- **Frontend modularizado**: vanilla HTML/JS/CSS (no React/Next.js) — 13 scripts classic en `public/js/` + `js/shared.js` para páginas standalone. Ver `Estado.md` para el detalle.
- Backend con middleware global de errores (`error-handler.ts`) y tareas de inicio en `services/startup.ts` (multi-empresa)
- Prisma generates client to `node_modules/@prisma/client` by default (turbo `outputs: ["src/generated/**"]` in `turbo.json` may be stale)
- Accounts seeded: full Panamanian chart (ACTIVO 1, PASIVO 2, PATRIMONIO 3, INGRESOS 4, COSTOS 5, GASTOS 6)
