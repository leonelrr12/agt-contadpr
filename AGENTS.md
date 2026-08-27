# AGENTS.md — agt-contador

## Guardrails (prioridad alta)
- **NO usar WebSearch ni WebFetch** — resolver con los archivos locales del repo.
- **Frontend = Vanilla HTML/JS/CSS** — nunca React/Next/JSX. Cambios visuales en `apps/web/public/*.html` o `public/js/` (13 scripts clásicos).
- **BD: PostgreSQL 16 vía Prisma** (SQLite en desuso).

## Monorepo (Turbo + npm workspaces)
- `apps/api` — Express (`@agt-contador/api`), entry `src/main.ts`, puerto 3001
- `apps/web` — estático (`@agt-contador/web`), sirve `public/` por nginx (sin build)
- `packages/shared` (tipos/enums) · `packages/prisma-schema` (Prisma) · `packages/agents` (DialogAgent, ClassificationAgent, AccountingAgent, OrchestratorAgent)

## Comandos (desde la raíz)
| Comando | Qué hace |
|---|---|
| `npm run dev` / `build` | turbo dev / tsc |
| `npm run db:generate` / `db:push` / `db:seed` | prisma generate / push / seed (orden: generate→push→seed; prod: migrate deploy) |
| `npm run format` | prettier |
| `npm run test` / `lint` | stubs |

## BD y despliegue
- `DATABASE_URL` en `.env` (raíz y `packages/prisma-schema/`). PrismaClient re-exportado desde `@agt-contador/prisma-schema`; `req.prisma` inyectado en Express.
- **PM2** gestiona la API (`pm2 start ecosystem.config.js`). Tras cambios backend: `pm2 restart agt-contador-api`. **Trampa env**: cambiar credenciales/keys en `.env` requiere `pm2 delete` + `start` (dotenv NO sobreescribe vars existentes; `restart` conserva env congelado).
- **Trampa caché tsx**: el caché real está en **`/tmp/tsx-0`** (no `/root/.tsx-cache`) — borrar SIEMPRE antes de reiniciar tras cambios en `apps/api`.
- nginx sirve `apps/web/public` y proxea `/api/*` → `localhost:3001` (fallback SPA).
- Docker: `docker compose up -d` (PostgreSQL 5433, API 3001, nginx 8090). El entrypoint del API corre `prisma db push` + seed al arrancar.

## Auth y multi-tenancy
- JWT (24h) + API Keys (`sk_live_` SHA-256) vía `requireAuth` (`middleware/auth.ts`). Roles: `superadmin` (dueño plataforma — ÚNICO con acceso a AdminSaaS `/api/admin`), `admin` (dueño empresa), `contador`, `asistente` (sin uso).
- Todo scoped por `req.user.companyId`. Única referencia legítima a `demo-company`: `TEMPLATE_COMPANY_ID` en `routes/auth.ts` (plantilla al registrar).
- `OrchestratorAgent` exige `userId` real (FK createdById); WhatsApp resuelve con `resolveWhatsAppUserId()`.

## Pipeline de agentes
1. DialogAgent — extracción NL (DeepSeek, fallback regex) → 2. ClassificationAgent — concepto→cuenta (fallback prefijos) → 3. AccountingAgent — líneas doble partida (valida débito=crédito) → 4. OrchestratorAgent — crea asiento **BORRADOR**, confirma vía `/api/orchestrate/confirm`.

## Revisión (Contador Senior)
BORRADOR → `POST /api/journal/:id/review` (`aprobar`→CONFIRMADO / `rechazar`+notes) · `PATCH /:id/status` solo RECHAZADO→BORRADOR · `GET /journal/pendientes`. Campos: `reviewedById`, `reviewedAt`, `reviewNotes`.

## Cierre fiscal (2026)
- Asientos de cierre: `JournalEntry.isClosing` + `period` (migración 0006, índice único parcial por empresa/año). **Excluidos de reportes/diario** (no del mayor 3.03).
- `POST /api/year-close/:year` cierra el año (solo CONFIRMADOS, salda cuentas de resultado a 3.03, alerta de saldos invertidos). Anular: `POST /api/year-close/:id/anular` o admin (clave `YEAR_CLOSE_KEY`, default `cierre123`).
- Balance de comprobación: débito/crédito del período + saldo acumulado; sin filtro usa el **año fiscal activo** (`lib/fiscal-year.ts`, último asiento).

## Local dev
- Frontend: `http://localhost:8090` y `http://147.93.145.67` · API: `http://localhost:3001`
