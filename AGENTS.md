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
| `npm run db:push` | `turbo run db:push` → pushes schema to SQLite (depends on db:generate) |
| `npm run db:seed` | seeds Panamanian chart of accounts + concept catalog (depends on db:push) |
| `npm run format` | `prettier --write "**/*.{ts,tsx,json,md}"` |
| `npm run test` / `lint` | stub — all packages echo placeholder |

**Order for fresh setup:** `db:generate → db:push → db:seed → dev`

## Database

- SQLite via Prisma. Set `DATABASE_URL` in `.env` (e.g. `file:./dev.db`).
- PrismaClient is re-exported from `@agt-contador/prisma-schema` (import from there, not `@prisma/client` directly).
- Express augment: `req.prisma` injected via middleware (`apps/api/src/types.d.ts`).

## Hardcoded IDs (no auth yet)

All routes use `companyId: 'demo-company'` and `createdById: 'demo-user'`. Add auth middleware before removing these.

## Agent pipeline

1. **DialogAgent** — keyword-based NL extraction (no LLM yet). Rule matching for types (GASTO, VENTA, etc.), concepts, payment methods, amounts, dates.
2. **ClassificationAgent** — looks up concept → accountId from DB. Falls back to prefix matching if no exact match.
3. **AccountingAgent** — generates double-entry journal lines via rule-based logic per transaction type. Validates debit=credit.
4. **OrchestratorAgent** — orchestrates dialog → classify → accounting flow. Posts to `/api/orchestrate`, confirm via `/api/orchestrate/confirm`.

## Deployment

- **nginx** serves frontend static files at `http://localhost:8090` and proxies `/api/*` to the Express backend.
- **PM2** manages the API process (`pm2 start ecosystem.config.js` from root, auto-restarts on crash/reboot).
- `.env` with `DATABASE_URL` must exist at root and `packages/prisma-schema/`.

## Local dev URLs

- Frontend (nginx): `http://localhost:8090` and `http://147.93.145.67` (port 80)
- API direct: `http://localhost:3001`

## Current state (MVP Phase 1)

- No tests, no CI, no ESLint config (package exists in devDeps but unused)
- No real LLM integration (rule-based agents)
- No auth, no Docker, no Husky
- Frontend is vanilla HTML/JS/CSS (not React/Next.js as Plan.md describes)
- Prisma generates client to `node_modules/@prisma/client` by default (turbo `outputs: ["src/generated/**"]` in `turbo.json` may be stale)
- Accounts seeded: full Panamanian chart (ACTIVO 1, PASIVO 2, PATRIMONIO 3, INGRESOS 4, COSTOS 5, GASTOS 6)
