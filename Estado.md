# Estado del Proyecto — Agente Contable (Panamá)

**Fecha del análisis**: 2026-07-15
**Branch**: `main` (clean)
**Último commit**: `b180f34` — feat: Prisma Migrate — migraciones versionadas para producción

---

## Resumen Ejecutivo

El MVP Fase 1 está **completo y funcional**. El sistema registra transacciones vía chat, procesa facturas por OCR/imagen y PDF (DGI), genera asientos contables de partida doble automáticamente, y tiene un flujo de revisión BORRADOR → CONFIRMADO/RECHAZADO. Tiene **55 tests pasando**, panel de reportes con dashboard, y corre en Docker + nginx + PM2.

### 🆕 Novedades desde el último análisis (2026-07-14 → 2026-07-15)

**SaaS implementado (Fases 1-3 completadas):**
- ✅ Planes y suscripciones: 4 planes (Demo, Emprendedor, Pyme, Despacho)
- ✅ Panel de admin: `/admin.html` con stats, gestión de suscripciones, registro de pagos (Yappy/Transferencia)
- ✅ API Keys: generación segura SHA-256, middleware unificado JWT + API Key
- ✅ Control de cuotas: `requireQuota` + `incrementUsage` en asientos contables
- ✅ Rate limiting por plan: Demo 5, Emprendedor 10, Pyme 25, Despacho 50 req/s
- ✅ Página pública de planes: `/planes.html`
- ✅ Gestión de API Keys: `/api-keys.html` con ejemplos cURL, JS, Zapier
- ✅ Navegación consolidada entre todas las páginas
- ✅ Errores amigables en `/api/orchestrate` con `friendlyError()`

**Infraestructura:**
- ✅ Backup automático diario + disaster recovery semanal (cron)
- ✅ Prisma Migrate versionado (`prisma migrate deploy` reemplaza `prisma db push`)
- ✅ Bug multi-tenancy corregido (13 `companyId: 'demo-company'` → `req.user!.companyId`)
- ✅ `AccountingAgent` con filtro `companyId` (corregía error "Cuenta contable no encontrada")
- ✅ Rate limiter corregido (sin crash IPv6, solo aplica a escrituras)

**Pendiente del plan original (Plan.md):**

| Fase | Estado |
|---|---|
| Fase 1: MVP Motor Contable | ✅ 100% completo |
| Fase 2: Documentos y Terceros | 🟡 OCR ✅ · Bancario ❌ · Clientes ❌ · Proveedores ❌ · Export ✅ |
| Fase 3: Módulos Avanzados | ❌ Inventario, Nómina, Impuestos, Auditor |
| Fase 4: IA Avanzada | ❌ Predicción, Fraude, Rentabilidad |
| Seguridad Transversal | ✅ JWT, roles, backups, logs · ❌ Cifrado en reposo |
| DevOps | ✅ Docker, PM2, nginx · ❌ CI/CD |

---

## 1. Seguridad — 🔴 Crítico

### 1.1 Sin autenticación ✅ COMPLETADO
- ~~Todo usa companyId y createdById hardcodeados. No hay login, JWT, sesiones ni middleware de auth.~~
- **Implementado**: JWT con `jsonwebtoken` + `bcryptjs`. Middleware `requireAuth` en todas las rutas. Endpoints `POST /api/auth/login`, `POST /api/auth/register` (crea empresa + copia plan de cuentas + conceptos), `GET /api/auth/me`. Login page en `/login.html`. Token en localStorage. `authFetch()` wrapper en frontend. Logout en sidebar. Multi-company listo (User.companyId).

### 1.2 CORS abierto ✅ COMPLETADO
- ~~Acepta requests de cualquier origen.~~
- **Implementado**: CORS configurable vía `CORS_ORIGIN` en `.env`. Por defecto `*` en desarrollo, restringir en producción. Solo permite GET/POST/PUT/PATCH/DELETE con headers Content-Type y Authorization.

### 1.3 Rate limiting inexistente ✅ COMPLETADO
- ~~No hay protección contra fuerza bruta, spam o DoS.~~
- **Implementado**: `express-rate-limit` con 3 niveles: general (200 req/15min), LLM (15 req/min), OCR/PDF (10 req/min). Archivo: `apps/api/src/main.ts`.
- **Commit**: (pendiente)

### 1.4 Secretos en el código ✅ COMPLETADO
- ~~Credenciales de PostgreSQL en texto plano en docker-compose.yml.~~
- **Implementado**: Variables `${DB_USER:-contador}`, `${DB_PASSWORD:-contador123}`, `${DB_NAME:-agt_contador}` en docker-compose.yml. `.env.example` con documentación de todas las variables requeridas.

### 1.5 Sin validación de entrada ✅ COMPLETADO
- ~~Los endpoints aceptan cualquier JSON sin sanitizar (más allá del parseo de Express).~~
- **Implementado**: `zod` v4 con schemas para todos los endpoints (accounts, concepts, transactions, journal, orchestrate, ocr). Schema en `apps/api/src/validation/schemas.ts`, middleware en `apps/api/src/middleware/validate.ts`.
- **Commit**: (pendiente)

---

## 2. Bugs — 🟠 Alta prioridad

### 2.1 Filtro de fechas roto en `balance-comprobacion` y `estado-resultados` ✅ CORREGIDO
- ~~Código frágil con spreads anidados que funcionaba por coincidencia.~~
- **Corregido**: Helper `buildDateFilter()` en `apps/api/src/lib/date-filter.ts`. Aplicado en `balance-comprobacion`, `estado-resultados`, `GET /api/journal`, `GET /api/journal/pendientes` y `GET /api/journal/mayor/:accountId`.

### 2.2 El endpoint `GET /journal/mayor/:accountId` rompe con filtro de fechas ✅ CORREGIDO
- ~~Sobrescribía `where.journalEntry` en lugar de mergear fechas. Si pasabas `startDate` Y `endDate`, solo se aplicaba el último.~~
- **Corregido**: Mismo helper `buildDateFilter()`, mergea ambas fechas correctamente.

### 2.3 `handleLocalProcessing` genera asientos con IDs inválidos ✅ CORREGIDO
- ~~`generateMockEntry` usaba strings (`'gasto'`, `'caja'`, `'banco'`) que no son IDs reales de BD.~~
- **Corregido**: Se eliminó `generateMockEntry`. En modo offline ahora se muestra un botón "🔄 Reintentar" en lugar de un modal de confirmación con IDs inválidos. El usuario puede reintentar cuando el servidor vuelva.

### 2.4 El regex de proveedor en `dialog-agent.ts` es frágil ✅ CORREGIDO
- ~~`(?:a|proveedor|de)` — "de" es demasiado común, matchea "compré **de** todo".~~
- **Corregido**: Nuevo regex con word boundaries `\b`, eliminado "de" como prefijo standalone, agregado patrón específico para "compré a/en [Nombre]".

### 2.5 El reporte `balance-comprobacion` no maneja cuentas de resultados correctamente ⬜ VERIFICADO — FUNCIONA BIEN
- El formato actual (débitos totales, créditos totales, saldo neto con indicador DEUDOR/ACREEDOR) es correcto para un balance de comprobación estándar. La fórmula `Math.abs(debit - credit)` con `balanceType` basado en qué lado es mayor funciona para todos los tipos de cuenta.

---

## 3. Arquitectura y Diseño — 🟡 Media prioridad

### 3.1 Tipos `any` por todas partes
```ts
// classification-agent.ts:9-10
private prisma: any;
private companyId: string;
```
El PrismaClient se pasa como `any` en ClassificationAgent, AccountingAgent, y OrchestratorAgent. No hay type safety para queries de BD.

### 3.2 Lógica duplicada backend ↔ frontend
| Funcionalidad | Backend | Frontend |
|---|---|---|
| Parseo de método de pago | `dialog-agent.ts:parseInput()` | `app.js:extractPaymentMethod()` |
| Parseo de concepto | `dialog-agent.ts:parseInput()` | `app.js:extractConcept()` |
| Parseo de monto | `dialog-agent.ts:parseInput()` | `app.js:extractAmount()` |
| Fechas | `ocr.ts:parsePanamanianDate()` | `pdf-extractor.ts:parseDate()` |
| Cliente LLM | `ocr.ts:getLLMClient()` | `pdf-extractor.ts:getLLMClient()` |
| Few-shot examples | `ocr.ts:findSimilarExamples()` | `pdf-extractor.ts:findSimilarExamples()` |

### 3.3 `app.js` monolítico (1314 líneas)
Todo el frontend está en un solo archivo: chat, OCR, PDF, reportes, dashboard, revisión. Es difícil de mantener.

### 3.4 Sistema de aliases de cuentas frágil
```ts
// accounting-agent.ts:10-24
const ALIAS_TO_CODE: Record<string, string> = {
  caja: '1.1.01',
  'banco-general': '1.1.02.01',
  // ...
};
```
El `AccountingAgent.generateEntry()` usa strings alias en lugar de accountIds reales. Luego `OrchestratorAgent.process()` llama a `resolveAlias()` para traducirlos. Si se agrega una cuenta nueva, hay que modificar código en 2 lugares.

### 3.5 Reportes cargan TODOS los datos en memoria
```ts
// reportsRouter.get('/balance-comprobacion')
const lines = await req.prisma.journalLine.findMany({ where, include: { account: true } });
// Agrega en JS, sin GROUP BY en BD
```
Para 1000 transacciones funciona, para 100,000 va a colapsar. Ningún reporte usa agregación SQL.

### 3.6 `GET /api/journal` también pagina en memoria
```ts
// journal.ts:89-114
const allEntries = await req.prisma.journalEntry.findMany({ where, ... });
// ... enrich + filter + paginate in JS
```
Carga TODOS los asientos y pagina en JavaScript. No escala.

### 3.7 El modelo `AuditLog` nunca se escribe ✅ COMPLETADO
- ~~Está definido en Prisma pero ningún endpoint crea registros de auditoría.~~
- **Implementado**: Servicio `audit-log.ts` con función `logAudit()`. Integrado en: creación de asiento (JOURNAL_CREATED), revisión (JOURNAL_APPROVED/REJECTED), anulación (JOURNAL_ANNULED). Registra userId, before/after en JSON.

### 3.8 Workers de OCR nunca se liberan
```ts
// ocr.ts:17-31
async function getWorkers() {
  if (!workers) {
    workers = await Promise.all([...]); // Nunca se termina/libera
  }
  return workers;
}
```
Se crean 3 workers de Tesseract que quedan en memoria para siempre.

---

## 4. Mejoras Funcionales — 🟢 Sugerencias

### 4.1 Exportación de reportes ✅ COMPLETADO
- ~~No hay endpoints para exportar a Excel, CSV o PDF.~~
- **Implementado**: Endpoint `GET /api/reports/export/:type?format=xlsx|csv` con soporte para 5 reportes: balance-comprobacion, balance-general, estado-resultados, flujo-caja, diario. Excel (.xlsx) con formato profesional (headers azules, columnas monetarias, auto-ancho). CSV con escaping estándar. Botones de descarga en frontend (📥 Excel / CSV) en paneles Diario, Balance, Resultados y Dashboard.

### 4.2 Conciliación bancaria
El agente bancario está en el plan (Fase 2) pero no implementado.

### 4.3 Módulo de ITBMS
- No hay reporte de ITBMS (formulario DGI 420).
- El cálculo de ITBMS en compras/ventas asume tasa fija (7%), no maneja exenciones ni regímenes especiales.

### 4.4 Cierre fiscal
No hay concepto de período fiscal. Los reportes toman rangos de fecha arbitrarios, pero no hay cierre contable con ajustes de cierre.

### 4.5 UI para gestionar cuentas y conceptos ✅ COMPLETADO
- ~~Las cuentas y conceptos se siembran desde seed.ts y se exponen vía API, pero no hay UI para crearlos/editarlos.~~
- **Implementado**: Panel de Administración completo con:
  - **Cuentas Contables**: crear nueva cuenta, editar nombre y estado (activa/inactiva), vista jerárquica con botones de edición inline
  - **Conceptos**: crear nuevo concepto con selector de cuenta, editar nombre/cuenta/estado
  - **Configuración**: panel para cambiar tasa ITBMS (0-20%) y habilitar/deshabilitar cálculo automático
  - Sidebar reorganizada con secciones "Reportes" y "Administración"
  - Endpoint `GET/PUT /api/config` para configuración en memoria

### 4.6 Notificaciones
El modelo `User` existe pero no hay emails, notificaciones push ni alertas.

---

## 5. Infraestructura y DevOps — 🟡 Media prioridad

### 5.1 Variables de entorno inconsistentes
- `.env` existe en raíz pero `prisma-schema` también necesita `DATABASE_URL`.
- `ecosystem.config.js` lee `process.env` que no existe al momento de cargar el módulo.

### 5.2 Docker compose expone puerto 5433 al host
Aunque es útil para desarrollo, en producción la BD no debería estar expuesta.

### 5.3 Sin healthchecks en la API
Hay un endpoint `/api/health` pero Docker compose no lo usa para healthcheck del servicio `api`.

### 5.4 `entrypoint.sh` no fue revisado
El entrypoint ejecuta `prisma db push` + seed en cada arranque, lo cual es correcto para dev pero peligroso en prod (podría pisar datos).

### 5.5 Sin CI/CD
No hay GitHub Actions ni otro pipeline configurado.

---

## 6. Tests — 🟢 Bien

- **55 tests pasando** (18 nuevos en el último commit).
- Cubren: `dialog-agent` (150 líneas de tests), `classification-agent` (82), `accounting-agent` (329), `orchestrator-agent` (78).
- Los tests usan stubs de Prisma (sin BD real), lo cual es correcto para unit testing.
- **Falta**: Tests de integración para los endpoints de la API, tests de OCR/PDF, tests de frontend.

---

## 7. Prioridades Recomendadas (Roadmap)

### 🔴 Antes de producción (Semana 1-2)
1. **Implementar autenticación JWT** con roles
2. **CORS restrictivo** + rate limiting
3. **Validación de entrada** con zod en todos los endpoints
4. **Arreglar bugs de filtros de fecha** en reportes y mayor
5. **Arreglar `generateMockEntry`** en el frontend para que no use IDs inválidos
6. **Escribir al AuditLog** en create/update/delete/anular

### 🟠 Corto plazo (Semana 2-4)
7. **Tipos estrictos** — eliminar `any` de los agents
8. **Extraer lógica duplicada**: `getLLMClient`, `findSimilarExamples`, `parseDate`
9. **Paginación real en BD** para `/api/journal`
10. **Agregación SQL** para reportes (raw queries o Prisma groupBy)
11. **Healthcheck en Docker** para el servicio API
12. **Variables de entorno unificadas** (`.env` único o config central)

### 🟡 Mediano plazo (1-2 meses)
13. Refactorizar `app.js` en módulos separados
14. Exportación Excel/CSV de reportes
15. Reporte de ITBMS (formulario 420 DGI)
16. UI de gestión de cuentas y conceptos
17. Cierre fiscal y período contable
18. Tests de integración API + tests E2E

### 🟢 Largo plazo (Fase 2-3 del plan)
19. Agente bancario con conciliación
20. OCR avanzado (Azure Document Intelligence)
21. Módulo de inventario, nómina, impuestos
22. Frontend en React/Next.js (como dice Plan.md)
23. CI/CD con GitHub Actions

---

## 8. Notas Técnicas

- **LLM**: DeepSeek Chat (vía API compatible con OpenAI). Bien integrado, con fallback a regex/keywords. La extracción funciona razonablemente bien.
- **OCR**: Tesseract.js con 3 PSM modes + refinamiento con LLM. El pipeline híbrido (Tesseract → LLM → regex fallback) es sólido.
- **PDF**: `pdf-parse` + DeepSeek para facturas electrónicas DGI. La extracción de 10 campos (proveedor, RUC, factura, fechas, ITBMS, etc.) es completa.
- **Few-shot learning**: Se guardan correcciones en `OCRExample` y se usan como ejemplos en prompts futuros. Buen approach.
- **Base de datos**: PostgreSQL 16. El schema de Prisma está bien diseñado, con relaciones correctas y unique constraints donde aplican.
- **Frontend**: Vanilla JS + HTML + CSS. Funcional pero difícil de escalar. Compressor.js para imágenes, Chart.js para gráficos.
- **Despliegue**: Docker Compose con 2 servicios (db + api). Nginx en el host (no en Docker) para servir estáticos y proxy inverso.

---

## 9. Conclusión

El MVP está **sólido para ser una Fase 1**. El pipeline de agentes funciona, el OCR y PDF son funcionales, los reportes cubren lo básico, y hay un flujo de revisión implementado. Los 55 tests dan confianza en el core contable.

**El blocker principal para producción es la ausencia total de autenticación y autorización.** Le siguen bugs en filtros de fechas de reportes y la paginación en memoria que no escalará.

La deuda técnica es manejable: tipos `any`, lógica duplicada, y un frontend monolítico. Se puede pagar incrementalmente sin reescribir todo.
