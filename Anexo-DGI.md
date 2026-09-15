# Anexo-DGI — Flags por cuenta: Anexos DGI + bloqueo de asientos

> **Estado: EJECUTADO (2026-09-15), desplegado y verificado E2E.** Fases A–G en `main`
> (commits `6816a42` → `50b078e`). Migraciones **0014** y **0015** aplicadas en producción
> (con `scripts/backup-db.sh` previo). El texto de abajo es el plan original; las
> desviaciones y la evidencia del E2E están en "Ejecución" al final.

## Contexto

Para la declaración de renta de fin de año hacen falta **anexos por tercero (RUC/Cédula)**, pero hoy las validaciones de las cargas son fijas (RUC siempre; factura solo en gasto/compra a crédito) y existe un **modo Honorarios aparte** que duplica caminos. El rediseño mueve la decisión al **catálogo de cuentas**: dos flags por cuenta gobiernan validaciones, bloqueo y reportes.

Decisiones confirmadas con el dueño:
- **Bloqueo de cuentas en TODOS los flujos** de creación/edición de asientos (no solo cargas).
- **Se elimina el modo Honorarios** (chip, informe, parser, endpoints y configuración): los honorarios entran por la carga general (el concepto "Honorarios" clasifica a la cuenta 6.02.01, que el usuario marcará con Anexo).
- **"Por Proveedores" se convierte en "⚖️ Anexos-DGI" y se pide POR CUENTA** (sugiere las cuentas con el flag, permite cualquier cuenta existente). Absorbe al informe de Honorarios.
- Los flags se crean **apagados**; el usuario marca sus cuentas.

## Regla del flag Anexo

Cuando la **cuenta clasificada** de la fila tiene `requiresAnexo` activo, la carga exige:

| Campo | Regla |
|---|---|
| **Fecha** | Obligatoria (siempre) |
| **Monto** | Obligatorio (siempre) |
| **Detalle** | Obligatorio (descripción/concepto del movimiento) |
| **RUC/Cédula** | **Obligatorio solo con Anexo** |
| **Nombre** (tercero) | **Obligatorio solo con Anexo** |
| **Factura** | **Opcional**; obligatoria **solo si la forma de pago (FP) es Crédito** |

Sin Anexo, la fila solo exige fecha, detalle/concepto y monto (se elimina el RUC universal de hoy).
`esFilaCredito` = `paymentMethod === 'CREDITO'` (tarjeta de crédito NO exige factura).

## Fases (checklist)

### Paso 0 — Documento
- [x] Este archivo queda como plan vivo del repo.

### Fase A — Migración 0014 + API catálogo
- [x] `Account` + `requiresAnexo Boolean @default(false)` ("Lleva Anexo") y `isBlocked Boolean @default(false)` ("Bloquear asientos").
- [x] Migración `0014_account_anexo_block` (solo los 2 ADD COLUMN). Las columnas `Company.honorariosGastoId/honorariosBancoId` se dropean en **0015** tras retirar el código (evita 500 entre migrate y restart).
- [x] `accounts.ts`: GET `?anexo=true` y `?excludeBlocked=true`; POST/PUT aceptan los flags (`validation/schemas.ts`).
- [x] **Corrección de seguridad incluida**: `PUT /accounts/:id` hoy no filtra por `companyId` (cross-tenant) → `updateMany({id, companyId})` + 404; POST valida que `parentId` sea de la empresa.

### Fase B — UI del catálogo
- [x] `admin.js` (`showCrearCuenta`/`editCuenta`/`saveCuenta`): 2 checkboxes; `buildCuentaTree`: badges 📎 Anexo / ⛔ Bloqueada. Bump `?v=` de admin.js.

### Fase C — Guard de bloqueo (todos los flujos)
- [x] Nuevo `apps/api/src/services/journal-guard.ts`: `loadAccountFlags(client, companyId)` (1 query por lote) · `assertAccountsNotBlocked(client, companyId, ids, {cache})` · `assertNotBlocked(flags, ids)` (pura, para el bucle del import). Mensaje: `Cuenta <code> — <name> está bloqueada: no admite asientos.`
- [x] Aplicarlo en los **18 puntos**: journal POST/PUT · import normal (por fila) · cobros · carga inicial (lote único: rechaza todo con lista; el preview marca la fila) · facturas POST y /pay · planilla (por empleado) · retenciones compensar · reconcile create-entry (hoy sin validación) · recurring (NO exento; log con templateId) · orchestrator confirm/confirmarCobroFactura.
- [x] **Exentos con comentario**: `anular` (reversión de un asiento existente) y `year-close` (debe poder saldar cuentas con saldo).

### Fase D — Flag Anexo en la carga general de Transacciones
- [x] `classification-agent.ts`: `loadConcepts()` + `classifyAll(items, prefetched)` (clasificación en lote sin N queries; mismo algoritmo y confianza).
- [x] Nuevo `apps/api/src/services/anexo-rules.ts`: `esFilaCredito(row)` · `missingAnexoFields(row, cuenta)` → con `requiresAnexo`: 'RUC/Cédula', 'Nombre', y 'Nº de factura (obligatorio en crédito)' si FP=Crédito. El Detalle va en la validación base (siempre).
- [x] `missingImportFields` queda con fecha/detalle/monto; el preview clasifica **todo el archivo** (1 query de conceptos + 1 de flags) y devuelve `blockedRows[]`; el execute reutiliza conceptos/flags precargados por lote.
- [x] Unificar `rowConceptForClassify(row)` entre preview y execute; `metadata` añade `invoiceNumber` (= reference) para el informe.
- [x] Planilla y Cobros **sin cambios**. UI: banner de `blockedRows` y filas marcadas en el preview.

### Fase E — Retiro del modo Honorarios
- [x] Borrar `routes/honorarios.ts`, `services/honorarios-parser.ts`, `web/public/js/honorarios.js`.
- [x] Quitar: `main.ts` (import + mount) · informe y export (`reports.ts`, `export.ts`) · config (Cargas en `config.ts` + `admin.js` + `index.html`) · chip y auto-detección (`import.js`) · pestaña y render (`informes.js`/`index.html`) · tag `<script>`.
- [x] **Stub temporal `410`** en `/api/honorarios/*` con mensaje guía (navegadores con caché).
- [x] Conservar `csv-parser.ts` (regex honorarios→GASTO) y el Concept `Honorarios → 6.02.01`.
- [x] Migración **0015**: drop de `honorariosGastoId`/`honorariosBancoId`. Los asientos ya cargados no se tocan (el informe nuevo los absorbe).

### Fase F — Informe "⚖️ Anexos-DGI" por cuenta
- [x] `buildAnexosDgiReport(prisma, companyId, {accountId?, startDate?, endDate?})`: filtro `journalEntry.lines.some({accountId})` + **fix `NOT description startsWith 'ANULACIÓN:'`** (hoy los anulados siguen contando). Tercero = `metadata.provider || metadata.nombre`; factura = `invoiceNumber || aux.number || metadata.reference`.
- [x] Endpoint `GET /reports/proveedores?accountId&startDate&endDate` (mismo path; valida cuenta de la empresa → 404) + export con `accountId` (archivo `anexos-dgi-<code>-<fecha>`, hoja "Anexos DGI", columna "Tercero").
- [x] UI: pestaña `⚖️ Anexos-DGI` (se conserva la clave `proveedores` en `exportTypes`/loaders) con **selector de cuenta** (`<optgroup>` "📎 Con Anexo" + "Todas las cuentas"); render y export reutilizados; columnas: **RUC/Cédula · Tercero · Fecha · Detalle · Factura · Monto**.

### Fase G — Selectores de UI
- [x] Excluir bloqueadas en: entry-modals (manual/edición), chat, picker de carga-inicial, Cargas, banco por defecto, selects de Conceptos. **Sin filtro** en: catálogo (para desbloquearlas), auxiliar y selector de Anexos-DGI.

## Orden de despliegue (commits desplegables)
0. Este documento. 1. Migración 0014 + API catálogo. 2. UI catálogo. 3. Guard + 18 puntos. 4. Anexo en import. 5. Retiro Honorarios + 0015. 6. Informe Anexos-DGI. 7. Selectores.

**Regla crítica**: la API siempre antes que la UI que envía campos nuevos — zod descarta claves desconocidas y el PUT respondería 200 sin guardar el flag. Bumpear `?v=` de cada JS tocado en su commit.

## Riesgos / notas
- Migración en prod: autorización explícita + `./scripts/backup-db.sh` + `migrate deploy` (env de la raíz) + `prisma generate` + `rm -rf /tmp/tsx-0` + `pm2 restart agt-contador-api` (y `pm2 save` solo si se toca `.env`).
- Catálogos cacheados por request: bloquear una cuenta a mitad de un lote no afecta a ese lote (ventana aceptable, documentada).
- **No marcar cuentas de INGRESO/VENTA con Anexo** sin querer: cada venta al contado exigiría RUC/Nombre.
- Editar (PUT) un BORRADOR con cuenta bloqueada se rechaza; anular no.
- `lines.some(accountId)` en el informe: elegir una cuenta de banco lista todas las filas con tercero que la tocaron (documentar en la UI).

## Verificación E2E (empresa demo, con limpieza)
1. Flags apagados tras migrar; activar Anexo en 6.02.01 y Bloqueo en un banco (verificar GET/PUT y `?anexo=true`).
2. Import: fila con cuenta bloqueada → rechazo SOLO de esa fila; las demás cargan.
3. Anexo: honorario a crédito sin RUC/Nombre/Factura → 3 faltantes; al contado con RUC+Nombre → carga y metadata completa; sin Anexo → solo fecha/detalle/monto.
4. Anexos-DGI por 6.02.01: agrupado por RUC + detalle + export xlsx/csv; cuenta inexistente → 404.
5. Honorarios retirado: el mismo asiento se produce por la carga general; `/api/honorarios/*` → 410.
6. Bloqueo fuera del import: asiento manual → 400; anular sigue funcionando.
7. No-regresión Planilla/Cobros/Transacciones sin anexo + limpieza de datos de prueba.


## Ejecución (2026-09-15)

### Desviaciones sobre el plan

1. **El guard vive en `packages/agents/src/journal-guard.ts`** (+ re-export en
   `apps/api/src/services/journal-guard.ts`), no en `apps/api/src/services/`. El
   `OrchestratorAgent` también lo necesita y `packages/agents` no puede importar de
   `apps/api` (mismo motivo por el que `hashRuc` está duplicado allí). Los call sites
   de la API importan igual que en el plan.
2. **El guard devuelve mensaje, no lanza.** Express 4 no captura errores de handlers
   async: un `throw` en una ruta dejaría la petición colgada. Los mensajes de error
   que sí se lanzan dentro de transacciones (facturas, retenciones, recurring,
   orchestrator) van con `{ status: 400 }` y, en el chat, con `code: 'ACCOUNT_BLOCKED'`
   para que `friendlyError` los muestre tal cual.
3. **`honorarios.ts` también recibió el guard** entre los commits C y E: el modo seguía
   vivo hasta retirarlo y no debía quedar sin bloqueo.
4. **`missingImportFields` mantiene la etiqueta 'concepto'** (el plan la llama
   "Detalle"); es el mismo campo.
5. **`buildAnexosDgiReport(prisma, companyId, { cuenta, startDate, endDate })`** recibe
   la cuenta ya validada (id + code + name + requiresAnexo) en vez de `accountId`: la
   ruta la busca y devuelve 404, y el export reutiliza ese objeto para el nombre del
   archivo.
6. **La pestaña "Por Proveedor" ya no tiene informe propio**: pasa a ser Anexos-DGI por
   cuenta. El endpoint sin `accountId` sigue devolviendo el informe de proveedores.
7. **Los `?v=` de las Fases D y E fueron juntos** en el commit de la Fase E: el bloque
   de `<script>` es un solo hunk de git. Para separar E de F en `reports.ts`,
   `export.ts`, `informes.js` e `index.html` se usaron blobs intermedios
   (`git hash-object` + `update-index --cacheinfo`).
8. **Los flags NO se propagan a empresas nuevas**: `routes/auth.ts` copia de la
   plantilla `demo-company` solo `code/name/type/aliases`. Coherente con "los flags
   nacen apagados", pero si algún día se quiere que una empresa nueva herede el Anexo
   de 6.02.01, hay que copiar `requiresAnexo` (y decidir sobre `isBlocked`).

### Evidencia E2E (empresa demo, con limpieza — sin restos ni flags al terminar)

| Paso | Resultado |
|---|---|
| 1. Flags tras migrar | apagados en las 107 cuentas; `PUT requiresAnexo=true` guarda, `GET ?anexo=true` filtra, `?excludeBlocked=true` oculta |
| 2. Import con cuenta bloqueada | 3 filas → carga 2 y rechaza **solo** la de la cuenta bloqueada con el motivo |
| 3. Anexo en la carga | crédito sin datos → 3 faltantes (RUC/Cédula, Nombre, Nº de factura); contado con datos → carga y `metadata` completa (`provider`, `ruc`, `reference`, `invoiceNumber`); cuenta sin flag → solo fecha/concepto/monto |
| 4. Anexos-DGI | por 6.02.01: agrupa por RUC, detalle por movimiento, total; cuenta ajena/inexistente → 404; export csv y xlsx válidos (`anexos-dgi-6.02.01-<fecha>`, columnas RUC/Cédula · Tercero · Fecha · Detalle · Factura · Monto). Los honorarios cargados con el modo viejo aparecen en el informe |
| 5. Honorarios retirado | `/api/honorarios/*` → 410 con la guía; `/api/config` ya no expone el grupo; la pestaña y el chip desaparecieron |
| 6. Bloqueo fuera del import | asiento manual → 400 con el motivo; PUT de un BORRADOR con cuenta bloqueada → 400; **anular sigue funcionando** (exento) |
| 7. No-regresión | fila sin RUC en cuenta sin Anexo → carga; Planilla/Import/Cobros/Retenciones/Diario responden |

### Pendiente / a decidir por el dueño

- **Marcar las cuentas**: los flags nacen apagados. Para que el Anexo funcione hay que
  entrar a Administración → Cuentas y marcar 📎 las cuentas que lo llevan (p. ej.
  6.02.01 Honorarios Profesionales) y ⛔ las que no deban admitir asientos.
- **No marcar cuentas de INGRESO/VENTA con Anexo**: cada venta al contado exigiría
  RUC/Nombre (riesgo ya anotado arriba).
- `Account.requiresAnexo` en la plantilla `demo-company` no se copia a empresas nuevas
  (ver desviación 8).
