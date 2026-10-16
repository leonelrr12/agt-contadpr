# Tuning — Estado, decisiones y evolución de agt-contadpr

> **Documento único del proyecto.** Desde el 25-09-2026 consolida lo que antes vivía repartido en
> `Agente COntable.md`, `SaaS.md`, `Estado.md`, `Plan.md`, `Anexo-DGI.md`, `RetencionITBMS.md` y
> `Compensacion del credito por ITBMS Retenido.md`, todos eliminados tras la consolidación.
>
> Para arrancar el proyecto (comandos, BD, despliegue, trampas) ver **AGENTS.md**, que es el que se
> carga en cada sesión. Esto de acá es el estado del producto y lo que falta.

**Última verificación contra el código: 2026-10-15** — 45 modelos Prisma, 190 endpoints en `routes/`,
migración más alta `0038_facturas_por_correo` (**escrita, sin aplicar**), 505 tests.

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
| Conciliación bancaria — match automático por monto+fecha **por día calendario** y **vínculo fino N:1** (una fila del extracto sostenida por varias partidas del libro: las 4 facturas cobradas con un solo ACH), con vinculador en la página | `reconcile.ts`, `bank-matcher.ts`, `conciliacion.html`, tabla `bank_row_match` (migración `0036`) |
| Importación masiva CSV/XLSX **idempotente** | `import.ts`, `csv-parser.ts` |
| Transacciones recurrentes (cron 30 min) | `recurring-processor.ts`, modelo `RecurringTemplate` |
| Calendario fiscal PA (ITBMS día 15, CSS día 5, aviso/ISR 31 marzo) | `services/tax-calendar.ts` |
| Facturas PDF (logo, numeración correlativa, ITBMS desglosado, leyenda de resolución DGI) | `factura-pdf.ts`, `routes/facturas.ts` |
| Cobros a facturas | modelo `InvoicePayment` |
| Retención de ITBMS sufrida (50%) | `retencion-itbms.ts`, `routes/retenciones.ts` |
| **Form. 430 (ITBMS mensual) — informe y declaración**: el borrador calcula los renglones del mayor (renglones por tasa, pagos a la DGI y compensaciones separados del crédito fiscal, saldo anterior con signo y **cuadre contra la cuenta**); la declaración guarda lo presentado (N° de formulario, fechas, estados BORRADOR → PRESENTADA → PAGADA → ANULADA), **compensa el R52** al presentar, crea el asiento del pago y **anular revierte todo y devuelve las retenciones** | `borrador-430.ts`, `declaracion-itbms.ts`, `routes/declaraciones.ts`, `declaracion-itbms-pdf.ts`, pestaña 🧾 Form. 430 |
| Anexos DGI por cuenta + bloqueo de cuentas | `anexo-rules.ts`, `journal-guard.ts`, migración `0014` |
| Cierre de año fiscal | `year-close.ts`, `isClosing` + `period`, migración `0006` |
| Reportes (balance, resultados, flujo de caja, comprobación, auxiliares) | `routes/reports.ts` |
| Export XLSX/CSV | `services/export.ts` |
| Salud financiera con IA (ratios, score, alertas, narrativa) | `services/salud.ts` + panel 🩺 |
| Presupuestos + proyección de caja 3/6/12 | `budget-comparison.ts`, `cuentas-efectivo.ts`, migración `0017` |
| **Planilla (nómina)**: registro de empleados, cálculo de SS/SE/ISR, décimo y vacaciones, aportes del patrono en tres cuentas, CSS, cuadre y **deducciones de acreedores** (préstamos, embargos, mueblerías: catálogo por empleado que se precarga solo, con cuotas y saldo que la hacen terminar, una cuenta por pagar por acreedor y su pago) | `payroll-calc.ts`, `payroll-run.ts`, `payroll-deducciones.ts`, `payroll-acreedores.ts`, `planilla.html`, migraciones `0022`-`0031` — ver [`PLANILLA.md`](PLANILLA.md) §3.11 |
| **Inventario**: kardex con costo promedio, carga inicial por archivo, toma física, anulación y cuadre contra el mayor | `inventario.ts`, `costo-promedio.ts`, `inventario.html`, migraciones `0018`-`0020` — ver [`INVENTARIO.md`](INVENTARIO.md) |
| Multi-tenant SaaS: planes, suscripciones, API Keys, cuotas, admin | `Plan`, `Subscription`, `ApiKey`, `routes/admin.ts` |
| Audit log de asientos | `services/audit-log.ts` |
| WhatsApp (OpenWa) | `whatsapp-service.ts` |
| Cifrado en reposo AES-256-GCM | `crypto-fields.ts`, `FIELD_ENC_KEY` |

**Retirado:** el modo Honorarios (migración `0015`); su stub responde 410. Los honorarios entran por
la carga general y el concepto "Honorarios" clasifica a `6.02.01`.

---

## 4. Pendiente

### 4.1 ✅ RESUELTO — Compensación R52 del ITBMS retenido y declaración del 430

**Cerrado el 15-10-2026** con la declaración como dato (fase 2, migración `0037`). Lo que sigue acá es
el historial de la decisión; no hay nada bloqueado.

**Lo que hay hoy:**
- **Informe borrador del 430** (fase 1, solo lectura): `borrador-430.ts`, pestaña 🧾 Form. 430.
- **Declaración como DATO**: modelo `DeclaracionItbms`, estados BORRADOR → PRESENTADA → PAGADA y
  ANULADA desde cualquiera. Presentar guarda el N° de formulario, **compensa el R52** (asiento
  D 2.1.05 / C 1.1.07 por las retenciones con certificado que se elijan), las pasa a APLICADA con
  **FK real** (`retencion_itbms.declaracionId`) y completa la obligación del calendario. Pagar crea el
  asiento contra banco (CONFIRMADO). **Anular revierte los asientos, devuelve las retenciones a
  RECIBIDA y suelta el período** (índice único parcial), que era la brecha que impedía deshacer.
- PDF de la declaración (`declaracion-itbms-pdf.ts`) con número y fecha; el borrador sale rotulado
  «NO PRESENTADO» para que no se confunda con el formulario.

**Lo que se decidió (y por qué):**
- **D1 — Alcance: solo el 430 mensual.** El 431 (ISR anual) queda fuera: es otro formulario y otro módulo.
- **D2 — El saldo a favor se ARRASTRA** al mes siguiente (contador, 15-10-2026). El informe ya lo
  aplica como saldo anterior, sin clamp a cero, y la declaración lo publica en `saldoAFavor`.
- **D3 — Montos del mayor CON ajuste del contador**: la declaración nace con los renglones del informe
  y el contador los corrige antes de presentar. Presentar exige que el renglón 52 coincida con las
  retenciones que de verdad se compensan: nada de descuadres mudos entre el formulario y el mayor.

**Brechas de la lista original — estado:**
1. **Cerrada.** La declaración existe como dato (renglones, número, fechas y asientos).
2. **Cerrada.** Anular revierte el asiento y devuelve las retenciones (antes `APLICADA` era terminal).
3. **Cerrada.** El vínculo con el asiento es una FK real (`asientoCompensacionId` / `asientoPagoId`,
   patrón `ExpenseClaim`), no el JSON de `metadata`.
4. **Cerrada.** El botón manual `POST /retenciones-itbms/compensar` y el `PATCH … estado: APLICADA`
   **se retiraron el 15-10-2026** (410 y 400 con la guía hacia la declaración): quedaba una retención
   `APLICADA` sin declaración, sin vínculo y **sin vuelta atrás**. Ahora el renglón 52 tiene un solo
   escritor y una sola salida.
5. **Aclarada.** `6.05.01` es «Impuesto Municipal»: si el contador quiere una cuenta de ITBMS gastado,
   hay que crearla.
6. **Parcial.** La tasa sigue en `process.env` para los asientos nuevos; el borrador y la declaración
   la derivan de cada asiento y avisan si no es 7/10/15 %.

**Historial de la decisión** (lo que estaba bloqueado hasta el 15-10-2026): el crédito por ITBMS
retenido entra a `1.1.07` y se declara en el renglón 52; `PAGO_ITBMS` debitaba `2.1.05` por el total
sin mirar el crédito, así que el saldo se acumulaba, y el único modo de aplicarlo era el botón manual
`POST /retenciones-itbms/compensar` (que sigue ahí, para uso manual). Las **5 preguntas al contador**
que originaron el bloqueo quedan contestadas así: (1) el excedente **se arrastra**; (2) manda el
formulario presentado, con el libro al lado —el borrador enseña los dos y la declaración guarda lo
declarado—; (3) el pago se registra por lo que **efectivamente se pagó** (el modal lo propone con el
saldo declarado y se puede corregir); (4) el ITBMS de compras sin derecho a crédito sigue dentro del
costo, y `6.05.01` es «Impuesto Municipal»; (5) 430 mensual, vence el **día 15** (confirmado, sin regla
de último dígito del RUC).

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
- **Los $1.000 de ODESA en `1.1.04.02 Inventario de Materia Prima`** (Carga Inicial del 31-12-2025). El
  cuadre del inventario lo reporta y **no se toca solo**: el contador decide si se gastó, si se abre el
  kardex con una apertura por ese monto, o si se reclasifica. Además, por la regla de §5 la materia prima
  **no lleva kardex**, así que ese saldo está en una cuenta que no debería tenerlo.

---

### 4.3 📋 Módulos no empezados

- **Facturas DGI por correo (IMAP)** — ✅ **COMPLETO Y EN USO desde el 16-10-2026** (migraciones `0038`
  y `0039` aplicadas; seis fases desplegadas). Lee el buzón que la empresa asigne —IMAP propio o el
  buzón central de la plataforma con dirección de reenvío— y carga las facturas que mandan los
  proveedores (PDF/XML adjunto o link del CUTE) como asiento BORRADOR + archivo en «Facturas
  recibidas», con corrida diaria de madrugada, «Revisar ahora», reproceso manual y **aviso por correo
  cuando una factura no se pudo cargar**. El diseño y las trampas están en
  [`FACTURAS-CORREO.md`](FACTURAS-CORREO.md).
- **§10 Centro de Costos / Proyectos** — etiquetar transacciones por proyecto, sucursal o departamento;
  rentabilidad segmentada; cruce con presupuesto. El más transversal: toca informes, presupuesto y facturas.
- **§14 Agente Multi-Empresa para Despachos** — ✅ **COMPLETO Y DESPLEGADO el 16-10-2026** (las cuatro fases):
  selector de empresa (el superadmin entra a cualquiera sin reloguearse), **membresías** con rol POR
  empresa (migración `0040`, una cuenta trabaja varias empresas) y el **tablero de pendientes**
  «🏢 Mis empresas» con borradores por revisar, buzón con problemas, por cobrar vencido, obligaciones
  fiscales y cuota de cada empresa, más el **comparativo** de ventas, costos+gastos y resultado del mes
  y del año (misma fuente de cálculo que el informe de cada empresa; no es un balance consolidado). El
  diseño está en [`DESPACHO.md`](DESPACHO.md).
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
- **§11 Nómina:** lo que queda **fuera** de [`PLANILLA.md`](PLANILLA.md) — liquidaciones de personal, ISR
  anual, y el registro del pago mensual del ISR retenido a la DGI (el calendario fiscal no tiene esa
  obligación).
- **§11 Nómina — el año de 53 pagos:** la planilla semanal paga `mensual × 12/52` por semana, así que un año
  con 53 días de pago cuesta 53/52 del sueldo anual del contrato (pasa cada cinco o seis años, según en qué
  día caiga el 1 de enero). El módulo no hace nada especial al respecto —cada semana trabajada se paga— pero
  es una decisión del contador, no un olvido. Ver [`PLANILLA.md`](PLANILLA.md) §3.1.
- **§11 Nómina:** las tarifas de Riesgos Profesionales de las clases II a V. La tabla arranca con la clase I
  (1,00%) y las demás se cargan desde Planilla → Parámetros; un empleado en una clase sin tarifa **rechaza su
  fila** en la corrida, a propósito.
- **Retención ITBMS:** probar el flujo multi-turn real por WhatsApp (orden categoría→pago→resto) y el
  caso de respuesta corta con solo el número.

---

### 4.5 Deuda técnica

- **Lógica duplicada backend ↔ frontend:** parseo de método de pago, concepto, monto, y dos copias de
  fechas, cliente LLM y few-shot (`ocr.ts` vs `pdf-extractor.ts`). Candidato a módulo compartido.
- **`prisma: any` en los servicios: `tsc` no valida las consultas.** Un `include` con una relación que
  no existe compila y revienta en runtime —pasó el 28-09 con el desglose de deducciones colgado del
  ítem en vez de la corrida, y el endpoint devolvió 500 hasta que se reinició el proceso—. Mitigación
  desde el 15-10: **`test-utils/prisma-validador.ts`** es un Prisma de mentira que valida
  `include`/`select` contra el **DMMF real** del schema —**bajando por las relaciones**: el include que
  rompió era anidado— y anota qué consultas corrió. Lo usan
  `services/__tests__/payroll-includes.test.ts` (8 lecturas de planilla),
  `routes/__tests__/lecturas-includes.test.ts` (~26 endpoints de informes, inventario, auxiliares,
  reembolsos, conciliación, salud y presupuesto), `routes/__tests__/escrituras-includes.test.ts`
  (importación y conciliación bancaria) y `services/__tests__/recurrentes-cierre-includes.test.ts`
  (los recurrentes del cron y el cierre de año, que nadie mira a mano). Al tocar otro módulo,
  apuntarle el mismo arnés.
- **Sin tests contra la BD real.** Los 465 tests son de servicio y de ruta, con **stubs de Prisma a
  mano** (los de ruta levantan Express y pegan con `fetch`: `reconcile-upload`, `declaraciones-itbms`).
  No hay ni un test que toque PostgreSQL, así que lo que depende del motor (índices únicos parciales,
  constraints, `$transaction` de verdad) se verifica a mano. OCR/PDF tampoco tienen tests de contenido.
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
  compras y pagos). Es **acumulado, no de un período**. Su estimado mensual corta en el **último
  instante del mes en hora local**: con `new Date(year, month, 0)` (medianoche del último día) los
  asientos de ese día —que se guardan a mediodía— quedaban fuera del número que el calendario le
  enseña al contador (corregido el 15-10-2026).
- **El saldo a favor se arrastra** al mes siguiente; no se pide en devolución (contador, 15-10-2026).
  El borrador del 430 lo aplica: el mes siguiente lo recibe como saldo anterior, sin clamp a cero.
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

**Facturación**
- La cantidad de un renglón es un **entero**. Un **servicio** va siempre en cantidad 1 y el detalle —horas,
  días, alcance— se escribe en la descripción del trabajo. No se factura por 2,5 horas ni por 2,5 lb.
- Una factura puede mezclar renglones de mercancía (con producto del inventario) y de servicios (sin
  producto). Solo los primeros mueven stock y generan línea de costo.

**Anexos DGI y bloqueo de cuentas**
- Con `requiresAnexo`, la fila exige siempre fecha, monto y detalle, y **además RUC/cédula y nombre del
  tercero**. La factura es opcional, obligatoria solo si la forma de pago es CRÉDITO (tarjeta de crédito
  no la exige). Sin el flag, solo fecha/detalle/monto.
- El bloqueo (`isBlocked`) se aplica en 18 puntos de escritura. **Excepciones deliberadas:** `anular`
  (revierte un asiento existente) y `year-close` (debe poder saldar cuentas con saldo).

**Calendario fiscal**
- Los vencimientos son **días, no instantes**: se guardan a **mediodía local** (la convención del repo)
  y el corte de «vencido» es el **inicio del día** — una obligación que vence hoy sigue vigente, y
  visible en el panel, hasta que el día termina. Corregido el 15-10-2026: estaban a medianoche del
  servidor y en verano (EDT) se pintaban **un día antes** en Panamá (un ITBMS del 15-ago se veía 14/08)
  y pasaban a OVERDUE la noche anterior; en invierno las zonas coinciden y no se notaba. La corrida del
  calendario **normaliza sola** las filas viejas y devuelve a PENDING las mal marcadas, así que no hizo
  falta migrar a mano.

**Declaración de ITBMS (Form. 430)**
- **Es una foto, no un puntero.** Los renglones nacen del borrador y el contador los corrige **mientras
  está en BORRADOR**; al presentar quedan congelados y la fila no se recalcula nunca más. Para corregir
  hay que anular y volver a declarar (el período queda libre: el índice único es parcial,
  `WHERE estado <> 'ANULADA'`).
- **El renglón 52 tiene que cuadrar con lo que se aplica.** Presentar exige que el renglón declarado sea
  igual a la suma de las retenciones que se compensan en el mayor; si no, dice cuánto falta y cómo
  arreglarlo. Solo entran las **RECIBIDAS con certificado** anteriores al cierre (las PENDIENTE se
  informan aparte: en ODESA hoy son 25 con $4.727,36 sin certificado).
- **Los asientos los revisa el contador.** La compensación del R52 nace **BORRADOR** (igual que el botón
  manual de compensar); el **pago** nace CONFIRMADO, porque es un pago ya hecho.
- **Nada se borra.** Anular crea el espejo con `anularAsiento` (fechado hoy, no reescribe el mes
  declarado), devuelve las retenciones a RECIBIDA y la obligación a pendiente; el número de formulario
  no se reutiliza.
- **El renglón 52 se aplica SOLO al presentar** la declaración (único escritor desde el 15-10-2026):
  los caminos viejos —`POST /retenciones-itbms/compensar` y marcar `APLICADA` por PATCH— devuelven la
  guía. Registrar el certificado (📥) sigue siendo cosa de la pestaña Retenciones ITBMS.
- Los **pagos y compensaciones ya contabilizados no son renglones del formulario**: van en la
  liquidación del informe, no en la declaración (`saldo a pagar = débito − crédito − R52 + saldo anterior`).

**Cierre fiscal**- Los asientos de cierre se marcan `isClosing` + `period` y quedan **excluidos de reportes y diario**
  (no del mayor `3.03`). Índice único parcial por empresa/año.
- El balance de comprobación sin filtro usa el **año fiscal activo** (último asiento).

**Inventario**
- El kardex lleva **solo mercancía de reventa**. Materia prima e insumos son gasto y no lo tocan; una empresa
  de servicios no usa el módulo.
- El valor del kardex es la **suma firmada de los montos que fueron al asiento**, no `cantidad × promedio`:
  así cuadra con el mayor **por construcción**. El costo promedio se deriva.
- **La compra de mercancía entra por Inventario**, que es la única vía que debita `1.1.04.01` con cantidad.
  La importación y el chat mandan sus compras a la cuenta que resuelva el clasificador.
- El kardex **no se borra ni se edita**: se corrige con el movimiento inverso, **al costo original** (al
  promedio vigente no devolvería el valor anterior).
- **La anulación es por operación, no por fila**: el asiento cubre todos los movimientos.
- Los asientos del módulo nacen **BORRADOR** y los revisa el contador; el movimiento de stock es inmediato.
- Un renglón de factura **sin producto** no mueve stock ni genera costo: los servicios se facturan igual que
  siempre. Detalle completo en [`INVENTARIO.md`](INVENTARIO.md).

**Anulación de asientos**
- **Anular no reescribe la historia.** El asiento original **sigue contando** en el período en que se
  registró, y el reverso —fechado el día de la corrección— lo netea desde ese mes en adelante.
- El original queda marcado con `anuladoPorId` (migración `0021`), una seña para la UI que ningún reporte
  mira. Fuente única: `services/journal-annul.ts`, compartida por el diario y el inventario.

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
