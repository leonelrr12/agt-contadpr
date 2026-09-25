# Tuning — Estado, decisiones y evolución de agt-contadpr

> **Documento único del proyecto.** Desde el 25-09-2026 consolida lo que antes vivía repartido en
> `Agente COntable.md`, `SaaS.md`, `Estado.md`, `Plan.md`, `Anexo-DGI.md`, `RetencionITBMS.md` y
> `Compensacion del credito por ITBMS Retenido.md`, todos eliminados tras la consolidación.
>
> Para arrancar el proyecto (comandos, BD, despliegue, trampas) ver **AGENTS.md**, que es el que se
> carga en cada sesión. Esto de acá es el estado del producto y lo que falta.

**Última verificación contra el código: 2026-09-25** — 30 modelos Prisma, 39 rutas montadas, migración
más alta `0017_budget`, 66 tests.

---

## 1. Qué es

ERP contable para PyMEs panameñas, multi-empresa, con agentes de IA. No es un chatbot: es un sistema
contable donde el **libro diario es la fuente de verdad** y el libro mayor se obtiene agrupando
asientos — nunca se escribe directo.

El usuario describe lo que ocurrió; los agentes resuelven la parte contable; el usuario **confirma
antes de que se registre**. El orquestador no conoce detalles contables: entiende la intención, decide
qué agentes intervienen y consolida. Los agentes se comunican con tareas estructuradas, no con texto
libre.

Adaptado a Panamá: ITBMS, DGI (formulario 430 y anexos), CSS, cierre fiscal, retención de ITBMS.

### Stack real (el plan original decía otra cosa)

Express + vanilla JS · PostgreSQL 16 + Prisma · DeepSeek (compatible OpenAI, con fallback a
regex/palabras clave) · Tesseract.js para OCR · PM2 + nginx en el host. **Nunca React/Next/NestJS.**

---

## 2. Principios que no cambian

- **El libro diario manda.** El mayor es una vista.
- **Nunca inventar datos.** Si falta información, se le pide al usuario.
- Plan de cuentas + motor de reglas, no un catálogo de conceptos enumerados. Arrancó con ~50-100
  cuentas y ~100-200 conceptos; crece por correcciones del usuario, que se guardan para la próxima.
- **Confirmación explícita** antes de registrar.
- API Keys con SHA-256, nunca en texto plano.
- Cuotas contadas **por movimiento**, no por request.
- Redis solo cuando haga falta: PostgreSQL con buenos índices aguanta >1000 req/min (estimado
  necesario a partir de ~100 clientes activos simultáneos).

---

## 3. Módulos construidos

Verificado contra el código el 25-09-2026. **Si algo no está en esta lista, no existe.**

| Módulo | Evidencia |
|---|---|
| Chat NL → asiento (DeepSeek, fallback regex) | `orchestrate.ts`, `packages/agents` |
| OCR de facturas/recibos | `services/ocr.ts` (Tesseract 3 PSM + refinamiento LLM) |
| Extracción de PDFs DGI (10 campos) | `services/pdf-extractor.ts` |
| Plan de cuentas + clasificación automática | `account-lookup.ts`, `account-resolver.ts` |
| Clientes / proveedores auto-creados | modelos `Client`, `Supplier` |
| Conciliación bancaria | `reconcile.ts`, `bank-matcher.ts`, `conciliacion.html` |
| Importación masiva CSV/XLSX **idempotente** | `import.ts`, `csv-parser.ts` |
| Transacciones recurrentes (cron 30 min) | `recurring-processor.ts`, modelo `RecurringTemplate` |
| Calendario fiscal PA (ITBMS día 15, CSS día 5, aviso/ISR 31 marzo) | `services/tax-calendar.ts` |
| Facturas PDF (logo, numeración correlativa, ITBMS desglosado, leyenda de resolución DGI) | `factura-pdf.ts`, `routes/facturas.ts` |
| Cobros a facturas | modelo `InvoicePayment` |
| Retención de ITBMS sufrida (50%) | `retencion-itbms.ts`, `routes/retenciones.ts` |
| Anexos DGI por cuenta + bloqueo de cuentas | `anexo-rules.ts`, `journal-guard.ts`, migración `0014` |
| Cierre de año fiscal | `year-close.ts`, `isClosing` + `period`, migración `0006` |
| Reportes (balance, resultados, flujo de caja, comprobación, auxiliares) | `routes/reports.ts` |
| Export XLSX/CSV | `services/export.ts` |
| Salud financiera con IA (ratios, score, alertas, narrativa) | `services/salud.ts` + panel 🩺 |
| Presupuestos + proyección de caja 3/6/12 | `budget-comparison.ts`, `cuentas-efectivo.ts`, migración `0017` |
| Planilla (nómina) por archivo | `routes/planilla.ts`, migración `0012`/`0016` |
| Multi-tenant SaaS: planes, suscripciones, API Keys, cuotas, admin | `Plan`, `Subscription`, `ApiKey`, `routes/admin.ts` |
| Audit log de asientos | `services/audit-log.ts` |
| WhatsApp (OpenWa) | `whatsapp-service.ts` |
| Cifrado en reposo AES-256-GCM | `crypto-fields.ts`, `FIELD_ENC_KEY` |

**Retirado:** el modo Honorarios (migración `0015`); su stub responde 410. Los honorarios entran por
la carga general y el concepto "Honorarios" clasifica a `6.02.01`.

---

## 4. Pendiente

### 4.1 ⛔ Bloqueado por una decisión tuya — Compensación R52 del ITBMS retenido

**Es lo único realmente bloqueado del proyecto.** Aplazado el 18-09-2026 hasta tener criterio contable.

**El problema.** El crédito por ITBMS retenido entra a `1.1.07 ITBMS Retenido por Terceros`
(D Banco 1.035 + D 1.1.07 35 / C Clientes 1.070) y se declara en el **renglón 52 del Formulario 430**.
Pero `PAGO_ITBMS` debita `2.1.05 ITBMS por Pagar` contra banco por el total **sin mirar el crédito**,
así que el saldo se acumula. Hoy el único modo de aplicarlo es manual y sin reversión: `POST
/api/retenciones-itbms/compensar` (modal "Compensar R52" en Informes) crea D 2.1.05 / C 1.1.07.

**Tres decisiones abiertas** (recomendaciones provisionales, sin validar con el contador):

- **D1 — Alcance:** *A)* solo ITBMS mensual (Form. 430) completo; *B)* también ISR anual (Form. 431);
  *C)* mínimo, solo la compensación sin declaración. **Provisional: A**, o C si se quiere valor
  inmediato con mínimo riesgo.
- **D2 — Crédito mayor que el impuesto del período:** *1)* arrastrar el excedente al mes siguiente;
  *2)* preguntar cada período si arrastrar o pedir devolución; *3)* solo informarlo. **Provisional: 2**
  (no fija una regla tributaria no confirmada y deja rastro).
- **D3 — De dónde salen los montos:** *1)* calculados del mayor con ajuste del contador; *2)* tecleados
  por el contador; *3)* calculados sin ajuste. **Provisional: 1.**

**Las 5 preguntas para el contador:**
1. Si ITBMS de compras + retención sufrida > ITBMS de ventas del mes: ¿se arrastra, se pide devolución o
   queda saldo a favor quieto? ¿La app genera asiento?
2. ¿Se presenta con montos del libro o del formulario? Si difieren, ¿cuál manda para el pago?
3. ¿El pago va por el neto (ya aplicada la retención) o se paga el total y la retención se reclama aparte?
4. Compras sin derecho a crédito: hoy la app registra el ITBMS dentro del costo. ¿Correcto, o va a
   cuenta separada (`6.05.01 ITBMS Gastado`, en catálogo sin uso)?
5. ¿Qué formularios y periodicidad (430 mensual, 431 anual, otros)? ¿El vencimiento depende del último
   dígito del RUC? Hoy la app usa **día 15 fijo**.

**Brechas a cerrar en la misma entrega:**
1. No existe "declaración" como dato: `TaxObligation` es solo calendario, sin renglones, número de
   formulario ni asiento de pago.
2. La compensación **no se puede revertir**: `APLICADA` es terminal en `canTransition` y anular el
   asiento no devuelve las retenciones a `RECIBIDA`.
3. `RetentionItbms.journalEntryId` apunta al asiento del cobro, no al de compensación (el vínculo real
   solo vive en `metadata` JSON).
4. Resolución de cuentas inconsistente: `compensar` exige alias exacto, los cobros usan búsqueda
   tolerante. Una cuenta `1.1.07` creada a mano sin alias rompe la compensación.
5. `6.05.01 ITBMS Gastado` existe sin uso (pregunta 4).
6. La tasa de ITBMS vive en `process.env` (default 7%) y no queda registrada por período.

**Boceto de diseño (no vinculante):** modelo `DeclaracionITBMS` con `companyId`, `period`, renglones
(`baseVentas`, `itbmsDebito`, `baseCompras`, `itbmsCredito`, `retencionAplicada`, `saldoAnterior`,
`saldoAPagar`/`saldoAFavor`), `numeroFormulario`, `fechaPresentacion`, `estado` (BORRADOR → PRESENTADA →
PAGADA, ANULADA) y asientos asociados. Flujo: borrador → ajustar → presentar (asiento + retenciones a
APLICADA + `TaxObligation` completada) → pagar → anular (revierte todo). Reutiliza `validateEntry` del
`AccountingAgent`, `findRetencionAccount`, `checkNotBlocked`, `logAudit`, `requireQuota`.

---

### 4.2 🔧 Construido pero sin activar (última milla)

Trabajo ya pagado que hoy no rinde nada:

- **Anexo-DGI: los flags están apagados.** `Account.requiresAnexo` / `isBlocked` nacen en `false`. Hay que
  entrar a **Administración → Cuentas** y marcar 📎 las que llevan anexo (p. ej. `6.02.01 Honorarios
  Profesionales`) y ⛔ las que no deban admitir asientos.
  **No marcar cuentas de INGRESO/VENTA con Anexo**: cada venta al contado pasaría a exigir RUC y nombre.
  *Limitación conocida:* los flags **no se copian** a empresas nuevas (`routes/auth.ts` copia de la
  plantilla solo `code/name/type/aliases`). Si algún día se quiere que una empresa nueva herede el
  Anexo de `6.02.01`, hay que copiar `requiresAnexo`.
- **Alertas de presupuesto nunca disparadas contra datos reales.** El código está y los tests lo cubren
  con el semáforo real, pero **ninguna empresa tiene presupuesto capturado**, así que la ruta no se ha
  ejercitado en producción. Basta con capturar el presupuesto de una empresa real.
- **Proyección fiscal en cero en empresas sin historial de montos.** ODESA no tiene ni una obligación
  valorada (todas en 0 o NULL), así que su proyección no estima impuestos y subestima las salidas. Sin
  un monto histórico del que tirar el sistema no inventa cifras — es correcto, pero significa que para
  esa empresa la proyección fiscal todavía no sirve. Se arregla valorando sus obligaciones en el
  Calendario Fiscal.

---

### 4.3 📋 Módulos no empezados

Ninguno tiene modelo en el schema todavía.

- **§13 Inventario** — existencias con costo promedio, entradas/salidas alimentadas por compras y ventas,
  alertas de stock mínimo, valoración. *Siguiente en la fila.* **Diseño completo, directivas y estado de
  construcción en [`INVENTARIO.md`](INVENTARIO.md)** — acá solo va el avance, para que los dos documentos no
  se separen.
- **§10 Centro de Costos / Proyectos** — etiquetar transacciones por proyecto, sucursal o departamento;
  rentabilidad segmentada; cruce con presupuesto. El más transversal: toca informes, presupuesto y facturas.
- **§14 Agente Multi-Empresa para Despachos** — vista unificada de todos los clientes del despacho,
  tablero de pendientes, cambio rápido entre empresas, reportes consolidados. **El mayor diferenciador
  del roadmap** (el comprador natural de un producto llamado *contador* es un despacho, no una empresa
  suelta), pero con pocas empresas en la base construir la vista ahora es adivinar.
- **§9 Archivo Digital de Documentos** — adjuntar facturas/recibos a cada asiento, S3/Cloudflare R2,
  búsqueda por proveedor/fecha/monto. El menos atractivo: exige infraestructura y credenciales nuevas
  para un beneficio que hoy nadie pide.

Del plan original (Fase 2 y 4), sin cobertura en lo anterior: **notificaciones de pagos vencidos**
(clientes) y **programación de pagos** (proveedores); **detección de fraude** y **análisis de
rentabilidad** por segmento.

---

### 4.4 Detalles menores

- **§3 Recurrentes:** detección de patrones por IA ("este gasto de $49.99 aparece cada mes, ¿lo hago
  recurrente?").
- **§7 Facturas:** **envío por email al cliente** (lo demás está: logo, correlativo, ITBMS, resolución).
- **§8 Cierre:** ajustes sugeridos por IA (depreciación, amortización, provisiones) y **resumen del año
  con comparativa** contra el período anterior.
- **§11 Nómina:** registro de **empleados** con salarios y cargos (hoy es carga por archivo, no hay
  modelo de empleado), recordatorios de cuotas CSS y acumulados para décimo tercer mes y liquidaciones.
- **Retención ITBMS:** probar el flujo multi-turn real por WhatsApp (orden categoría→pago→resto) y el
  caso de respuesta corta con solo el número.

---

### 4.5 Deuda técnica

- **Lógica duplicada backend ↔ frontend:** parseo de método de pago, concepto, monto, y dos copias de
  fechas, cliente LLM y few-shot (`ocr.ts` vs `pdf-extractor.ts`). Candidato a módulo compartido.
- **Sin tests de integración de la API** ni de OCR/PDF. Los 66 tests actuales son unitarios con stubs
  de Prisma, sin BD.
- **DevOps:** el puerto de PostgreSQL se expone al host en el compose; la API no tiene healthcheck de
  Docker aunque exista `/api/health`; el `entrypoint.sh` corre `prisma db push` + seed en cada arranque
  (correcto en dev, peligroso en producción); `ecosystem.config.js` lee `process.env` que no existe al
  cargar el módulo.
- **Notificaciones proactivas:** el modelo `User` existe pero no hay emails ni avisos push (la
  verificación de email y la recuperación de contraseña sí están).
- **Rotación de API keys cada 90 días** y **caché de clasificaciones** para conceptos repetidos:
  mitigaciones de riesgo identificadas y no implementadas.

---

## 5. Reglas de negocio y contables

**ITBMS**
- Neto vs total según la fuente: un **PDF trae el total**, un **texto dictado el neto**. La extracción
  explícita de ITBMS manda sobre el cálculo.
- En la carga masiva, sin columna de ITBMS el asiento dice el monto del archivo; la casilla "Calcular
  ITBMS" lo reactiva por archivo.
- `getSaldoITBMS` suma las líneas de `2.1.05` de asientos CONFIRMADO (créditos de ventas − débitos de
  compras y pagos). Es **acumulado, no de un período**.
- La retención sufrida **no es saldo de CxC**: es un crédito fiscal con certificado, declarable en el
  renglón 52 del Form. 430. Cuenta `1.1.07`.
- **Regla "al cierre del neto"** (confirmada 05-09): el cliente nunca paga más del neto; la retención se
  registra como **evento único** en el pago que completa el cobro neto. Los abonos parciales intermedios
  son efectivo puro contra el saldo bruto. Un solo certificado por el total. Descartado: retención
  proporcional por abono.
- Agente retenedor válido si `esAgenteRetenedor && vigenciaDesde ≤ fechaFactura ≤ vigenciaHasta`; se
  guarda snapshot en la retención. Estados: `PENDIENTE|RECIBIDA|APLICADA|ANULADA`, y pasar a
  RECIBIDA/APLICADA **exige número de certificado**.
- En `InvoicePayment`: `amount` = efectivo (lo que entra al banco), `retentionAmount` = retención
  sufrida; lo aplicado a la factura es la suma.
- Compras sin derecho a crédito: la app registra el ITBMS dentro del costo (a confirmar — pregunta 4 de §4.1).

**Anexos DGI y bloqueo de cuentas**
- Con `requiresAnexo`, la fila exige siempre fecha, monto y detalle, y **además RUC/cédula y nombre del
  tercero**. La factura es opcional, obligatoria solo si la forma de pago es CRÉDITO (tarjeta de crédito
  no la exige). Sin el flag, solo fecha/detalle/monto.
- El bloqueo (`isBlocked`) se aplica en 18 puntos de escritura. **Excepciones deliberadas:** `anular`
  (revierte un asiento existente) y `year-close` (debe poder saldar cuentas con saldo).

**Cierre fiscal**
- Los asientos de cierre se marcan `isClosing` + `period` y quedan **excluidos de reportes y diario**
  (no del mayor `3.03`). Índice único parcial por empresa/año.
- El balance de comprobación sin filtro usa el **año fiscal activo** (último asiento).

**Presupuestos**
- Monto siempre positivo, en la **dirección natural** de la cuenta. No hay fila anual: es la suma de los 12
  meses. El rollup es por `parentId` directo, no por prefijo de código.
- Semáforo: verde ≤5%, ámbar ≤15%, rojo por encima, con **materialidad de 25 USD**. Un desvío favorable
  grande es ámbar, no verde (presupuesto mal estimado). Gasto sin presupuesto va a rojo directo en la
  grilla, pero **no genera alerta** (decisión del dueño: sería ruidoso).
- Las alertas comparan siempre **contra el mes en curso**, nunca contra el presupuesto anual completo:
  hacerlo marca rojo a cualquiera que vaya al día.

**Proyección de caja**
- El efectivo es **caja + bancos + alias** (`lib/cuentas-efectivo.ts`), el mismo criterio del informe de
  flujo de caja. No usar el prefijo `1.1.01` a mano: en producción esa cuenta está vacía.
- Se computa siempre a 12 meses y se recorta al horizonte pedido; los 3 primeros meses no dependen del
  horizonte. El score se queda en 3 meses; las alertas siguen el horizonte pedido.
- Los meses sin obligación fiscal **valorada** se estiman con el último monto conocido y se marcan con
  `*`; sin monto histórico no se inventa nada.

---

## 6. Comercial

**Pagos manuales, no Stripe.** Se descartó Stripe en favor de **Yappy / transferencia bancaria** + panel
de admin para activar suscripciones, por ser lo adecuado para el mercado panameño. (LemonSqueezy quedó
como alternativa por soportar LATAM sin entidad en EE.UU.) **No hay campos de Stripe en el schema.**

| Plan | Movimientos/mes | Precio | Rate limit |
|---|---|---|---|
| Demo | 50 | $0 | 5 req/s |
| Emprendedor | 100 | $19.99 | 10 req/s |
| Pyme | 500 | $49.99 | 25 req/s |
| Despacho | 2,000 | $149.99 | 50 req/s |

El rate limit se cuenta **por empresa**, no por IP.

**Ciclo de vida de la suscripción:** `active` acceso completo · `past_due` banner + 7 días de gracia ·
`canceled` se bloquea crear movimientos y queda solo lectura (reportes y exportación) · `trialing`.

**API Keys:** prefijo `sk_live_`, hash SHA-256 en BD, revocación por soft-delete, la llave completa se
devuelve **una sola vez**.

**Pendiente comercial:** portal de facturación de autoservicio.

---

## 7. Despliegue y operación

Todo esto está detallado en **AGENTS.md** (que se carga en cada sesión). Resumen de lo que no es obvio:

- La API corre en **PM2**; el frontend lo sirve el **nginx del sistema** apuntando a
  `apps/web/public` (sin build: es un sitio estático, los cambios de JS son inmediatos y hay que subir
  el `?v=` del script en `index.html`).
- Producción: `NODE_ENV=production`, errores 500 sin detalle al cliente, CORS por `CORS_ORIGIN`.
- Rate limiting en 3 niveles: general 200/15min, LLM 15/min, OCR-PDF 10/min.
- Cron interno: recurrentes cada 30 min.
- **Backups:** `/root/backup.sh` (cron 03:00 diario, 05:00 domingos), fuera de git a propósito.
