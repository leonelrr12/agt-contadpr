# Plan — Retención ITBMS (retención sufrida, 50%) — seguimiento

> Estado: **F1-F4 IMPLEMENTADOS y E2E verificado 2026-09-05** (commit pendiente). Pendiente: compensación R52 dentro del flujo PAGO_ITBMS (se hará con el módulo de declaraciones).
> Fecha de inicio: 2026-09-05.

## Contexto

Cliente emite factura con ITBMS a un comprador que es **agente de retención**. El agente retiene el 50% del ITBMS y paga el resto. La retención **no** es saldo pendiente de CxC: es un **crédito fiscal de ITBMS** del vendedor, documentado con el certificado del agente (renglón 52 del Form. 430).

Ejemplo: factura 1,070 (subtotal 1,000 + ITBMS 70) → retención 35 → pago en banco 1,035. CxC debe quedar en 0.

Hoy el sistema (cobro PATCH /pay e import de cobros) debita banco/caja por el **efectivo** y acredita Clientes por lo mismo → si llegan 1,035 por factura de 1,070 queda saldo 35 PENDIENTE = el problema a resolver.

## Decisiones F0 (cerradas por el usuario, 2026-09-05)

1. **Higiene de dedupe** clientes/proveedores: sí, resolver único por RUC → nombre (paso previo a la retención).
2. Contraparte cliente-y-proveedor en la misma persona jurídica: **nada por ahora** (sin aviso cruzado ni unificación).
3. Campos de perfil de retención: **solo en `Client`** (no en `Supplier` todavía).
4. Modelo contable: **(A) cuenta ACTIVA de crédito fiscal** ("ITBMS Retenido por Terceros", alias `itbms-retenido-terceros`); compensación contra ITBMS por Pagar al declarar (Form. 430).

## F1 — Datos (migración manual `0010`, `migrate deploy`, regla del proyecto)

### `Client` (+4 campos)
```prisma
esAgenteRetenedor        Boolean  @default(false)
porcentajeRetencionItbms Float    @default(0.5)
vigenciaRetencionDesde   DateTime?
vigenciaRetencionHasta   DateTime?
```
Regla evaluada contra la **fecha de la factura**: `esAgenteRetenedor && vigenciaDesde ≤ fechaFactura ≤ vigenciaHasta`. El `RetencionITBMS` guarda el snapshot del hecho (no duplica ficha).

### `InvoicePayment` (+1 campo)
`retentionAmount Float @default(0)`
Semántica: `amount` = **efectivo** recibido (conciliación banco) · `retentionAmount` = retención sufrida · **aplicado = amount + retentionAmount** · `paidAmount += aplicado` (CxC queda 0) · clave de dedupe del import incluye la retención.

### Modelo `RetencionITBMS` (tabla `retencion_itbms`)
companyId, clientId, invoiceId, invoicePaymentId?, fecha, baseGravada (= invoice.amount), itbmsFacturado (= invoice.itbms), porcentaje, montoRetencion, numeroCertificado?, fechaCertificado?, estado (`PENDIENTE|RECIBIDA|APLICADA|ANULADA`), journalEntryId?, notas?, timestamps. Índices: companyId, clientId, estado.

### Catálogo
Cuenta demo **1.1.06 "ITBMS Retenido por Terceros"** (activo) + alias `itbms-retenido-terceros` (seed). Empresas sin la cuenta → error claro al cobrar con retención ("cree la cuenta con alias…"), igual que `clientes`.

## F2 — Backend

### A. Higiene de dedupe (no toca modelo)
- Resolver único por RUC → nombre exacto → nombre normalizado, compartido por los 5 puntos de creación: `facturas.ts` POST, `clients.ts` POST (hoy sin dedupe ni catch P2002 → alinear con `suppliers.ts` 409), `suppliers.ts`, `entity-service.ts`, `orchestrator-agent.ts`.
- ⚠️ Verificación previa en runtime: el `findFirst({ where: { taxId } })` con crypto-fields debe resolver (mecanismo del orchestrator). Si no resuelve → v1 con nombre normalizado y RUC queda como mejora aparte.

### B. Cobro con retención — `PATCH /facturas/:id/pay`
- Body opcional `{ efectivo?, retencionItbms?, cuentaId? }` (sin body = comportamiento actual).
- **Regla de retención (en revisión, ver sección "Regla de retención" abajo)**.
- Asiento split: débito cuenta efectivo `cash` + débito `itbms-retenido-terceros` `ret` / crédito Clientes `aplicado`. Crea `InvoicePayment` + `RetencionITBMS` (PENDIENTE) + Transaction `COBRO_CLIENTE` (amount = cash; metadata: aplicado, retención).

### C. Import cobros
- Columna opcional **"Retención ITBMS"** (patrón `/retenci[oó]n|itbms retenido/i`).
- Validaciones con la misma regla; asiento split; dedupe incluye retención.
- **Detección informativa** (nunca aplica sola): si `total − efectivo ≈ retención esperada` y el cliente es agente vigente → marca la fila "⚠️ Posible retención — confirma para aplicarla".

## F3 — UI (tras backend)
Ficha de cliente con perfil de agente (toggle, %, vigencias) · modal de cobro con retención sugerida · badge de detección en import · panel **Retenciones ITBMS** (listado, certificado n.º/fecha, estados).

## F4 — Reportes DGI
Auxiliar de retenciones sufridas (factura, monto gravado, ITBMS causado, ITBMS retenido, total) exportable + compensación del crédito al declarar (Form. 430, renglón 52) vía flujo PAGO_ITBMS.

## ⚖️ Regla de retención — CONFIRMADA 2026-09-05 (modelo "al cierre del neto")

El cliente nunca paga más del neto (1,035). La retención se registra como **evento único** en el pago que completa el cobro neto de la factura: un pago de una sola vez, o el último abono cuando los abonos parciales en efectivo llegaron en total a 1,035. Los abonos parciales intermedios se registran como **efectivo puro** contra el saldo bruto.

- Abono 500 → banco 500 / clientes 500 (saldo CxC 570).
- Último abono 535 → banco 535 + `itbms-retenido-terceros` **35** / clientes 570 → factura PAGADA, CxC 0, retención total 35 ✓ (un solo certificado por el total).

Variables: `S` = saldo bruto restante · `R` = retención total esperada (50% × ITBMS de la factura) · `R_rest` = R − retenciones ya registradas en esta factura.

Reglas/guardas:
1. Todo pago: `efectivo + retención ≤ S` y `retención ≤ R_rest`.
2. La retención se adjunta al pago que completa el neto: flujo normal `efectivo = S − R_rest`.
3. **Detección informativa**: si llega un pago con `S − efectivo = R_rest` → el sistema sugiere la retención antes de aplicar (confirmación explícita; nunca aplica sola).
4. **Caso excepcional (no se aplica en silencio)**: si `S < R_rest` (abonos previos en efectivo puro dejaron saldo menor que la retención pendiente) o llega un pago por el saldo completo sin espacio para retener → aviso "retención esperada (X) excede el saldo (Y) / pago completo sin retención" y decisión del usuario (ajustar abonos previos, registrar sin retención o retención diferida con certificado).
5. Retención total por factura nunca excede `R` (ni en registros parciales/diferidos).

Descartado: retención proporcional por abono (el usuario confirmó el modelo al cierre; el cliente no paga de más).

## Verificación E2E (al implementar)
Demo limpia → crear fixtures (cliente marcado agente + facturas). Casos: cobro completo 1,035/35 → asiento split balanceado, CxC 0, RetencionITBMS PENDIENTE; dos abonos proporcionales → sumas cuadran; re-subida por import → omitida (dedupe con retención); detección informativa; higiene: crear variante de nombre con mismo RUC → resuelve al registro existente.

## Estado de implementación (2026-09-05, "dale" del usuario)
- [x] F1: schema (Client agente+vigencia+taxIdHash, Supplier taxIdHash, InvoicePayment.retentionAmount, modelo `RetentionItbms` → tabla `retencion_itbms`) · migración manual `0010_retencion_itbms` aplicada · backfill taxIdHash (13 clientes) · seed cuenta 1.1.07 + alias · auto-set de hash en main.ts (Client/Supplier, limpia al vaciar RUC).
- [x] F2-A: `services/counterparty.ts` (resolver RUC-hash → nombre) usado en facturas POST, clients/suppliers POST (409 con mensaje), entity-service, orchestrator-agent (hashRuc duplicado local, RUC cifrado no matcheaba antes).
- [x] F2-B: PATCH /pay con `{efectivo, retencionItbms, cuentaId}` — split débito efectivo + `itbms-retenido-terceros` / crédito Clientes; parciales; retención solo con agente vigente y ≤ % ITBMS; crea InvoicePayment + RetentionItbms PENDIENTE.
- [x] F2-C: columna "Retención ITBMS" en import; validaciones; dedupe incluye retención; sugerencia informativa (`posibleRetencion`) cuando efectivo deja exactamente la retención pendiente; respuestas con `totalRetencionItbms`.
- [x] E2E demo (10 casos PATCH + import + re-subida idempotente + dedupe RUC 409): todos OK; datos de prueba limpiados; cuenta 1.1.07 demo conservada (la usa la feature).
- [x] F3 (UI): tab "🔖 Retenciones ITBMS" en Informes (listado + certificado/estados RECIBIDA/APLICADA/ANULADA + resumen + CSV auxiliar DGI) · ficha del cliente con perfil agente (✏️ en Auxiliares CxC, PUT /clients/:id) · modal de cobro con retención en Facturas (prefill neto, sugerencias, validación client-side) — informes.js v77 / facturas.js v77.
- [x] F4 (parcial): endpoints GET /api/retenciones-itbms (filtros estado/cliente/desde/hasta), PATCH /:id (certificado + transiciones validadas; RECIBIDA/APLICADA exigen Nº certificado), GET /report.csv (auxiliar DGI con RUC descifrado). Verificado E2E.
- [ ] F4 (restante): compensación automática del crédito al declarar (flujo PAGO_ITBMS / Form. 430 R52) — requiere el módulo de declaraciones.

## Pendientes / próximos pasos
- [ ] Commit de F1-F4 (develop → main, flujo habitual) cuando el usuario lo ordene.
