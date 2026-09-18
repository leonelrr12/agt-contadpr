# Compensación del crédito por ITBMS Retenido — documento de decisión

> Estado: **ABIERTO — esperando decisión contable (2026-09-18)**. Este documento **no cambia código**: junta lo que ya existe, lo que falta y las decisiones que hay que tomar antes de implementar.
> Viene de `RetencionITBMS.md` (F4 restante, línea 94): *"compensación automática del crédito al declarar (flujo PAGO_ITBMS / Form. 430 R52) — requiere el módulo de declaraciones"*.
> El dueño pidió aplazarlo hasta tener el criterio contable; acá está todo lo necesario para decidirlo con el contador.

## 1. El crédito y por qué está atrapado

Un **agente de retención** (cliente con perfil de agente) retiene el **50% del ITBMS** al pagar una factura y entrega el certificado. Ese monto es un **crédito fiscal** del negocio, no un saldo por cobrar: entra a la cuenta `1.1.07 ITBMS Retenido por Terceros` y se declara en el **renglón 52 del Form. 430** (fuente: `RetencionITBMS.md`).

Ejemplo: factura 1,070 (subtotal 1,000 + ITBMS 70) → retención 35 → al banco entran 1,035. El asiento deja:

```
D  Caja/Banco                              1,035.00
D  1.1.07 ITBMS Retenido por Terceros         35.00   ← el crédito
C  Clientes                                1,070.00
```

Hoy ese saldo **se acumula y nadie lo aplica**: el pago de ITBMS debita `2.1.05 ITBMS por Pagar` contra banco por el total, sin mirar el crédito. El único modo de aplicarlo es un **botón manual** en Informes → Retenciones ITBMS.

## 2. Qué existe hoy (con rutas, para no reinventarlo)

### 2.1 Cómo entra el crédito — tres flujos, el mismo asiento split

| Flujo | Dónde |
|---|---|
| Cobro de factura desde la app | `apps/api/src/routes/facturas.ts:259` (`PATCH /api/facturas/:id/pay`), asiento en 365-380 |
| Import de cobros (archivo) | `apps/api/src/routes/import.ts:818` (`POST /api/import/cobros/execute-all`), asiento en 951-963 |
| Chat / WhatsApp | `packages/agents/src/orchestrator-agent.ts:445` (`confirmarCobroFactura`) |

Los tres crean `RetentionItbms` en estado **PENDIENTE** con su certificado y auto-marcan al cliente como agente (`services/retencion-itbms.ts:86`). La **regla de retención** (modelo "al cierre del neto") está confirmada y documentada en `RetencionITBMS.md`.

### 2.2 Cómo se aplica hoy — manual y sin reversión

`POST /api/retenciones-itbms/compensar` (`apps/api/src/routes/retenciones.ts:259`): recibe los ids de las retenciones en estado **RECIBIDA** y en una transacción crea

```
D  2.1.05 ITBMS por Pagar                  (total)
C  1.1.07 ITBMS Retenido por Terceros      (total)
```

con `Transaction` tipo `PAGO_ITBMS`, `metadata.source = 'compensacion-r52'` y las retenciones pasan a **APLICADA**. La UI es el modal `abrirCompensarR52()` de `apps/web/public/js/informes.js:949`.

### 2.3 Cómo se paga el ITBMS hoy

`PAGO_ITBMS` en el motor de asientos (`packages/agents/src/accounting-agent.ts:168`): **débito `2.1.05` / crédito banco por el total**, sin considerar el crédito. Solo se dispara desde el chat (`POST /api/orchestrate`).

### 2.4 Lo que el sistema ya calcula

- **Calendario fiscal**: `TaxObligation` (`schema.prisma:625`) con tipo, período, vencimiento, monto estimado/real y estado PENDING/COMPLETED/OVERDUE; ITBMS con **vencimiento día 15 fijo** (`services/tax-calendar.ts:31`).
- **Saldo de ITBMS**: `getSaldoITBMS()` (`services/tax-calendar.ts:151`) suma las líneas de la cuenta `2.1.05` de asientos **CONFIRMADO**: créditos (ventas) − débitos (compras y pagos). Es saldo **acumulado**, no de un período.
- **Desglose compras/ventas por ITBMS**: el informe por proveedores y el Anexos-DGI ya separan `subtotal / itbms / total` (`routes/reports.ts:48` y `:147`).
- **Resumen del crédito**: `GET /api/retenciones-itbms/resumen-r52` (`routes/retenciones.ts:233`) devuelve `totalRetenido`, `disponibleR52` (RECIBIDA), `yaAplicado` y `pendienteCertificado`.

## 3. Brechas detectadas (útiles para cuando se decida)

1. **No existe el concepto de "declaración"** como dato: `TaxObligation` es un recordatorio de calendario, no guarda renglones, ni Nº de formulario, ni el asiento de pago.
2. **La compensación no se puede revertir**: en `canTransition` (`routes/retenciones.ts:21`) APLICADA es terminal y no hay endpoint de anulación. Anular el asiento por la vía genérica **no devuelve** las retenciones a RECIBIDA.
3. **Falta el vínculo persistente**: `RetentionItbms.journalEntryId` apunta al asiento del **cobro**, no al de la compensación; el vínculo real vive solo en el `metadata` JSON de la transacción.
4. **Resolución de cuentas inconsistente**: `compensar` usa alias estricto, mientras los cobros usan búsqueda tolerante (alias → código `1.1.07` → nombre). Si una empresa creó la cuenta a mano sin alias, la compensación falla donde el cobro funciona.
5. **`6.05.01 ITBMS Gastado` está en el catálogo y nadie la usa**: las compras debitan el ITBMS directo a `2.1.05`, así que el crédito de compras ya viene neteado en la misma cuenta que el débito de ventas (esto hay que confirmarlo con el contador: ver pregunta 4).
6. **La tasa vive en `process.env`**: `PUT /api/config` escribe en memoria (`routes/config.ts:43`), no en BD; cada capa recalcula con default 7%. Si la declaración depende de la tasa histórica, hoy no queda registrada por período.

## 4. Las tres decisiones abiertas

### D1 — Alcance de la primera entrega

| Opción | Qué implica | Consecuencia |
|---|---|---|
| **A. Solo ITBMS mensual (Form. 430)** | Declaración del período: débito fiscal (ventas), crédito fiscal (compras), retención sufrida (R52), saldo anterior, asiento + pago | Cierra lo pendiente; el modelo se diseña para crecer |
| **B. ITBMS + ISR anual (Form. 431)** | Lo anterior más ISR con anticipo y conciliación | Bastante más: hoy la app solo toca ISR en la planilla (`2.1.06` y `6.05.02` están en el catálogo, sin uso) |
| **C. Mínimo: solo la compensación** | Un flujo que aplique el crédito disponible al pagar el ITBMS, sin declaración | Lo más barato y ya resuelve el saldo atrapado; la declaración queda para después |

*Recomendación provisional: **A**, o **C** si se quiere valor inmediato con el mínimo riesgo.* **Pendiente de validar.**

### D2 — Qué hacer cuando el crédito supera el impuesto del período

| Opción | Qué hace el sistema | Asiento |
|---|---|---|
| **1. Arrastrar al mes siguiente** | El excedente queda como saldo a favor y se descuenta en la próxima declaración | Deja el remanente en una cuenta de crédito, no en el gasto |
| **2. Decidir por período** | Calcula el excedente y pregunta: arrastrar o solicitar devolución; sin respuesta no lo aplica | Ninguno hasta que se decida; queda anotado como pendiente |
| **3. Solo informarlo** | Muestra el saldo a favor y no genera asiento | El crédito sigue acumulado en su cuenta |

*Recomendación provisional: **2** — no fija una regla tributaria que no está confirmada y deja rastro de cada decisión.* **Pendiente de validar** (es la pregunta 1 para el contador).

### D3 — De dónde salen los montos de la declaración

| Opción | Qué hace | Riesgo |
|---|---|---|
| **1. Calculados del mayor, con ajuste** | Suma del libro (ventas, compras, retenciones del período), muestra el desglose por cuenta y documento, y el contador puede ajustar antes de confirmar | Ninguno relevante: queda BORRADOR con revisión, igual que los asientos |
| **2. Tecleados por el contador** | Se copian del formulario | Simple y siempre coincide con lo declarado, pero no valida contra el libro |
| **3. Calculados, sin ajuste** | Se declara lo que dice el mayor | Estricto, pero un asiento mal cargado no se puede corregir en la declaración |

*Recomendación provisional: **1**.* **Pendiente de validar.**

## 5. Boceto de diseño (no vinculante, para cuando se decida)

- **Modelo**: `DeclaracionITBMS` (o `TaxReturn` con campo `type` si D1 = B), con `companyId`, `period` (`YYYY-MM`), renglones (`baseVentas`, `itbmsDebito`, `baseCompras`, `itbmsCredito`, `retencionAplicada`, `saldoAnterior`, `saldoAPagar`/`saldoAFavor`), `numeroFormulario`, `fechaPresentacion`, `estado` (BORRADOR → PRESENTADA → PAGADA, ANULADA), asientos asociados y auditoría. Migración manual numerada `0017`, como las anteriores.
- **Flujo**: crear BORRADOR con el cálculo del período → ver desglose y ajustar → **presentar** (asiento de declaración + retenciones a APLICADA + `TaxObligation` a COMPLETED) → **pagar** (asiento de pago) → **anular** (revierte todo: retenciones a RECIBIDA y asiento reversado).
- **Reutilizar**: aliases y `validateEntry` del `AccountingAgent`, `findRetencionAccount` (búsqueda tolerante), `checkNotBlocked`, `logAudit`, `requireQuota` si crea asientos, el patrón de router de `routes/retenciones.ts` y la UI de pestaña en Informes (`buildInformesTable`, export CSV/PDF con token por query).
- **Arreglos que conviene meter en la misma entrega**: reversión de la compensación (brecha 2), FK de `RetentionItbms` al asiento de compensación (brecha 3) y unificar la resolución de la cuenta (brecha 4).

## 6. Preguntas para el contador

1. Cuando el ITBMS de compras **más** la retención sufrida supera el ITBMS de las ventas del mes, ¿el exceso se **arrastra** al mes siguiente, se **solicita devolución**, o se deja como saldo a favor quieto? ¿La app debe generar asiento por eso?
2. La declaración, ¿se presenta con los montos del **libro** o con los del **formulario**? Si difieren, ¿cuál manda para el pago?
3. ¿El pago se hace por el **neto** (ya aplicada la retención) o se paga el total y la retención se reclama aparte?
4. Las compras **sin derecho a crédito fiscal**: hoy la app registra el ITBMS dentro del costo. ¿Está correcto así, o debería ir a una cuenta separada (existe `6.05.01 ITBMS Gastado`, sin uso)?
5. ¿Qué formularios y con qué periodicidad se presentan (430 mensual, 431 anual, otros)? ¿El vencimiento depende del **último dígito del RUC**? Hoy la app usa día 15 fijo para todos.

## 7. Qué NO dice este documento

No afirma reglas tributarias que no estén ya en el repositorio. Lo que aparece como práctica del Form. 430 sale de `RetencionITBMS.md` y del código; todo lo demás (arrastre, devolución, renglones exactos, vencimientos por RUC) va marcado como **a confirmar con el contador**. Tampoco propone fechas ni compromisos: se retoma cuando la decisión contable esté tomada.
