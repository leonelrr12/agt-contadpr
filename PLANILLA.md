# Módulo de Planilla

> **Documentación viva del módulo.** Describe cómo está diseñado y por qué, para que las directivas se
> mantengan en un solo sitio. Se actualiza **cuando cambia una directiva**, no cuando cambia el código.
>
> ## ✅ Estado: COMPLETO — las 7 fases (25-09-2026)
> El módulo reemplazó a la carga por archivo: `/planilla.html` con sus siete pestañas, el rol `planilla` con
> su barrera, y los endpoints viejos (`/preview` y `/execute-all`) respondiendo **410 con la guía**.
> Migraciones `0022` a `0025` aplicadas en producción, y el motor verificado contra los montos reales de la
> planilla que el contador ya tenía cargada.
>
> **El archivo de planilla se sigue subiendo, pero solo para dar de alta empleados** (Planilla → Empleados →
> Alta masiva). El asiento ya no sale de la hoja: sale del motor.

---

## 1. Por qué existe

Hoy la planilla es **carga de archivo**: `routes/planilla.ts` (`/preview` + `/execute-all`) lee un CSV/XLSX,
toma las deducciones **ya calculadas** —SS, SE e ISR vienen en el archivo— y crea un asiento BORRADOR por
empleado. El `Tipo` (Sueldo / Décimo III) se elige a mano en el panel Importar y el archivo nunca trae ambos.

Eso obliga a calcular todo fuera del sistema, y deja tres huecos:

- **El sistema no sabe quién es un empleado entre meses.** Su identidad vive solo en la metadata del asiento
  (nombre y cédula opcional). Por eso no puede acumular décimo, vacaciones ni prima: no sabe que el "Juan
  Pérez" de marzo y el de abril son la misma persona. **El registro de empleados es lo que habilita todo lo
  demás.**
- **El costo patronal no existe en la contabilidad.** El archivo trae la retención del empleado, pero los
  aportes del patrono (SS 12,25% + SE 1,50%) son un gasto real que hoy no se registra en ninguna parte.
- **No hay dónde ver lo que se le debe a la CSS** ni cuándo vence. La obligación mensual del calendario
  fiscal se crea sin monto.

Es un **módulo independiente que alimenta la contabilidad**, igual que Inventario: tiene sus propias
pantallas y su propio dato, y escribe asientos en el libro compartido.

---

## 2. Las directivas (lo que manda)

Estas son las decisiones del dueño. **Si alguna cambia, se cambia acá y en el código.**

| # | Directiva |
|---|---|
| 1 | **El sistema calcula.** SS, SE e ISR salen del motor, no del archivo. La carga por archivo **se retira** cuando el módulo esté verificado; el archivo sobrevive solo como alta inicial de empleados. |
| 2 | **Rol `planilla`**: entra directo a su página y ve **solo Planilla y Empleados**. Todo lo demás se le niega, incluida la aprobación de asientos. |
| 3 | **Los acumulados arrancan con saldo inicial por empleado.** Es lo que cubre el corte de junio de ODESA sin recargar años de planilla. |
| 4 | **La provisión de prestaciones es configurable por empresa**, y nace **apagada**: los acumulados se calculan y se ven siempre, pero el asiento de provisión solo se genera si el contador lo enciende. |
| 5 | **Un asiento BORRADOR por empleado**, agrupado por la corrida. Los asientos los revisa el contador como todo el sistema, y la corrida permite aprobarlos o rechazarlos **en bloque**. |
| 6 | **El neto es el residuo**: `bruto − deducciones ya redondeadas`. Nunca se recalcula aparte. Por eso el asiento cuadra **por construcción** y desaparece la clase de bug del céntimo del SS. |
| 7 | **El motor se verifica contra los asientos ya cargados**, no contra una regla supuesta. Ver §3.1. |
| 8 | **ODESA no se toca.** La migración es solo DDL, sin backfill: los empleados se registran cuando el dueño lo decida. |

**Lo que NO entra** (y sigue pendiente en `Tuning.md` §4.4): liquidaciones de personal, ISR anual, préstamos
y embargos como descuento recurrente, control de vacaciones disfrutadas, archivo de pago al banco y portal
del empleado.

---

## 3. Cómo funciona

### 3.1 El motor de cálculo — verificado contra producción

El motor (`services/payroll-calc.ts`) es **puro**: sin Prisma, sin Express, sin hora del sistema. Mismo
contrato que `costo-promedio.ts`, para que se pueda probar entera. Vive con `lib/money.ts`, que aporta `r2`,
`r2MitadArriba` y `sumarMontos`.

Antes de escribirlo se contrastó cada regla contra los **77 asientos de planilla ya cargados** (71 de sueldo y
6 de décimo), leyendo solo montos agregados, sin nombres ni cédulas:

| Comprobación | Resultado |
|---|---|
| SS/SE del sueldo = 9,75% / 1,25% de `sueldo + horasExtras` | ✓ 15 de 15 combinaciones, exactas |
| Las **horas extras sí entran** en la base de cotización | ✓ 730,72 → 71,25 / 9,13 |
| **Redondeo medio-arriba** | ✓ seis casos exactos `.xx5`: 34,125→34,13 · 4,375→4,38 · 38,025→38,03 · 4,875→4,88 · 73,125→73,13 · 9,375→9,38 |
| Décimo: **SS 7,25%**, SE 0, ISR 0 | ✓ cinco niveles de sueldo, todos exactos |
| **ISR = proyección anual ×13** | ✓ ver §3.2 |
| La tabla mensual progresiva | ✗ descartada: 1.220,80/mes daría 22,81 y el archivo dice 28,10 |

Reglas del motor:

| # | Regla |
|---|---|
| R1 | `sueldo = r2(sueldoBase × diasTrabajados / diasDelMes)` — el sueldo base es **mensual**, así que el prorrateo va contra los días del **mes**, no los del período: en un mes de 31, las dos quincenas cobran 15/31 y 16/31 y entre las dos suman el mes exacto |
| R2 | Base de cotización = `sueldo + horasExtras` |
| R3 | `otrosIngresos` (bono, viático) **no cotiza** y debita la cuenta de sueldos |
| R4 | `neto = r2(bruto − ss − se − isr − otrasDeducciones)` — **residuo, jamás recalculado aparte** |
| R5 | Acumulados (solo SUELDO) = `r2(bruto × factor)` y se **congelan en el ítem** de la corrida |
| R6 | Décimo: SS al 7,25%, SE 0, ISR 0 |
| R7 | Vacaciones: pago de una prestación ya acumulada — sin SS/SE/ISR |
| R8 | El aporte del patrono se causa sobre **sueldo, décimo y vacaciones**, y en el sueldo se reparte en **tres cuentas de gasto**: SS 12,25% → `6.01.02.03` · SE 1,50% → `6.01.02.02` · Riesgos Profesionales 1,00% → `6.01.02.01`. En el décimo, SS al 10,75% |
| R9 | **Invariante que fijan los tests:** `r2(bruto − deducciones) === neto` **y** el asiento cuadra al centavo, para cualquier entrada |
| R10 | Entra a la corrida quien cumple `fechaIngreso <= fechaHasta && (!fechaSalida || fechaSalida >= fechaDesde)` |

### 3.2 El ISR

```
sueldoMensualProyectado = sueldoBase          (el vigente, no lo acumulado del año)
baseAnual               = sueldoMensual × 13
impuestoAnual           = escala anual: 0 hasta 11.000 · 15% hasta 50.000 · 25% arriba
ISR_mensual             = impuestoAnual / 13
```

En cada pago del mes va `r2(ISR_mensual / pagosDelMes)`, y **la última corrida del mes retiene el resto**
para que el mes sume exacto, sin céntimos perdidos.

> **Evidencia:** 1.220,80/mes → 15.870,40 anual → 730,56 de impuesto → /13 = 56,1969 → quincena **28,10** (el
> archivo dice 28,10, en 7 filas). Y 1.500/mes → 19.500 anual → 1.275 → /13 = 98,0769 → quincena **49,04**
> (el archivo dice 49,04, en 8 filas). Dos puntos independientes que la tabla mensual no reproduce.

**Las horas extras no mueven el ISR:** la fila con 120,32 de extras retiene lo mismo que las que no los
tienen. La proyección usa el **sueldo base**, no el bruto del período. Queda como parámetro editable.

**Dos cosas que la verificación dejó al descubierto**, y que van como aviso en pantalla, no como cambio
silencioso:

- El archivo tiene **una fila con el ISR del mes truncado** (56,19) y siete con la mitad redondeada
  (28,10 × 2 = 56,20). Es una inconsistencia de la hoja, no una regla: el motor usa medio-arriba siempre.
- Como el impuesto se divide entre 13 y el décimo se retiene en cero, **cada empleado queda con 1/13 de su
  ISR anual sin retener** (~56 al año para un sueldo de 1.220,80/mes). El motor replica lo que hace el
  archivo; corregirlo es decisión del contador.

### 3.3 La corrida

Una **corrida** (`PayrollRun`) es el período que se está pagando: la quincena, la cuota del décimo, el pago de
vacaciones. El flujo reemplaza al archivo:

1. **Elegir** tipo + período + fechas → **prellenar** con los empleados activos y sus sueldos.
2. **Editar** el grid (horas extras, días trabajados, otros ingresos, otras deducciones, notas). El navegador
   recalcula en vivo, pero **el servidor recalcula al guardar**: manda él.
3. **Ejecutar**: crea la corrida, los ítems, un asiento BORRADOR por empleado y su `Transaction`.
4. Los asientos entran a la cola de revisión del contador, como todo el sistema.

**La idempotencia es estructural**: un índice único **parcial** sobre `(companyId, tipo, periodo)` que solo
cubre las corridas vivas (`status <> 'ANULADA'`). No se puede correr dos veces el mismo período — el segundo
intento devuelve **409 con el id de la corrida existente** — pero una corrida anulada **libera el período**,
que es lo que hace posible corregir.

El `WHERE` no se puede expresar en Prisma, así que el guardia vive en SQL (migración `0023`), con el mismo
idioma que el re-cierre de año de la migración `0006`. Sin el parcial, "se anula y se rehace" sería imposible:
la fila anulada seguiría ocupando el período.

Una corrida **no se recalcula**: se anula y se rehace. Los montos del ítem quedan congelados, igual que el
costo unitario de un movimiento de kardex — es lo que hace que cambiar un factor mañana no reescriba el
pasado.

**La anulación** reusa `journal-annul.ts` ítem por ítem: el reverso va **fechado hoy** y netea desde ese mes,
mientras el original sigue contando en su período. Se bloquea si el período está cerrado o si la obligación
CSS de ese mes ya está pagada.

**Export** (`GET /corridas/:id/export.csv`): la corrida se exporta con **las mismas columnas del archivo
viejo** (`QUINCENA, NOMBRE, CEDULA, SUELDO, HORAS EXTRAS, DECIMO, SS, SE, ISR, TOPAL A PAGAR`). Sin esto,
retirar la carga por archivo dejaría al contador peor que antes: la planilla hay que presentarla a la CSS.

### 3.4 El asiento, por empleado

```
D  planillaSueldoId             sueldo
D  planillaHorasExtrasId        horasExtras        (si > 0)
D  planillaSueldoId             otrosIngresos      (si > 0 — no cotiza)
D  planillaSSPatronalGastoId    ssPatronal         → 6.01.02.03 SS Patrono
D  planillaSEPatronalGastoId    sePatronal         → 6.01.02.02 SE Patrono
D  planillaRiesgosProfesionalesId  riesgosPatronal → 6.01.02.01 Riesgos Profesionales
C  planillaSSId                 ss
C  planillaSEId                 se
C  planillaISRId                isr
C  planillaSSPatronalId         ssPatronal + riesgosPatronal
C  planillaSEPatronalId         sePatronal
C  planillaOtrasDeduccionesId   otrasDeducciones   (si > 0; sin cuenta configurada, la corrida se rechaza)
C  <banco del empleado>         neto
```

**El gasto del patrono va separado en tres cuentas; el pasivo del Seguro Social no.** Los riesgos
profesionales comparten el pasivo con la retención y con el aporte patronal porque **a la CSS se le paga todo
junto, en un solo pago**: separarlo en dos cuentas obligaría a dos pagos por el mismo hecho, y el pasivo no
netearía a cero. El gasto, en cambio, sí se analiza por separado — para eso están las tres cuentas.

Las tres se resuelven **por código del catálogo** (`6.01.02.01/.02/.03`) si no están configuradas, así que el
módulo reparte el gasto desde el primer día sin obligar a configurar tres selectores. Si tampoco existen,
caen a la cuenta genérica de aportes patronales y, de última, a Sueldos — avisando en cada caso.

**DECIMO**: `D planillaDecimoId` → `C ss` → `C banco`. **VACACIONES**: `D planillaVacacionesId` → `C banco`.
Es la semántica que el dueño ya usa hoy: la cuenta de Décimo apunta a `2.1.10 Décimo Tercer Mes por Pagar` y
el débito reduce el pasivo.

Los aportes patronales son `D gasto / C por pagar`, así que necesitan **tres columnas nuevas** en `Company`
(el gasto y los dos pasivos). Si falta alguna, **no se inventa una cuenta**: la corrida se rechaza diciendo
**el nombre** de la cuenta que falta.

### 3.5 Los acumulados

Décimo, vacaciones y prima de antigüedad por empleado. **No se materializan**: se calculan en lectura como

```
acumulado = saldoInicial + Σ PayrollItem de corridas != ANULADA
```

con una sola consulta (`groupBy` por empleado, nada de N+1). Guardar `decimoGenerado` y su factor en el ítem
es lo que congela el histórico: cambiar `factorDecimo` mañana no reescribe el pasado.

Los factores por defecto son 1/12 (décimo), 1/12 (vacaciones, 30 días por año) y 1/52 (prima, una semana por
año), todos editables.

### 3.6 Las cuentas y la CSS

- **Parámetros** (tasas, escala del ISR, factores, interruptor de provisión) viven en la pestaña *Parámetros*
  del módulo. El rol `planilla` los **lee**; solo `admin`, `contador` y `superadmin` los editan.
- **Cuentas contables**: siguen en Administración → ⚙️ Configuración, que es territorio del admin. La tarjeta
  suma los selectores de aporte patronal y otras deducciones.
- **Pestaña CSS**: los montos por mes salen de los **ítems de las corridas**, no de los totales de la
  corrida — los totales guardan deducciones y aporte patronal sumados, y la planilla de la CSS los pide
  separados (SS obrero, SS patronal, SE obrero, SE patronal). Con eso a la vista, el contador arma el SIPE.
- **El saldo adeudado incluye los asientos en BORRADOR**, a diferencia de `getSaldoITBMS`, que exige
  CONFIRMADO. Es deliberado: lo que se le debe a la CSS no depende de que el contador haya pasado por la
  cola de revisión, y con el filtro de CONFIRMADO el módulo diría "no le debés nada" justo después de correr
  la planilla. Un asiento RECHAZADO sí se excluye, y una anulación se netea sola porque su reverso es un
  asiento vigente más.
- **Registro del pago**: `D planillaSSId (+ planillaSEId) (+ planillaISRId) / C banco`, en BORRADOR como
  todo, y marca la obligación CSS del calendario como cumplida. El banco tiene que ser una cuenta `1.1.02.*`
  de la empresa: acreditar el pago contra un ingreso dejaría el pasivo cerrado y el banco mal.

  **Las cuatro cuentas por pagar se descargan en un solo movimiento**: el Seguro Social (con el aporte del
  patrono y los riesgos profesionales adentro), el Seguro Educativo y el ISR retenido a los empleados. Es
  como se paga en la práctica —la liquidación del mes deja la CxP del Seguro Social en cero— y por eso el
  formulario tiene los tres montos y un botón que los trae del mes elegido. La descripción del asiento dice
  lo que realmente se pagó: `Pago CSS + ISR septiembre 2026`, no un genérico "pago CSS" que oculte el ISR.
- **Valorizar la obligación**: se le pone el monto real a la fila PENDING del calendario, con la misma regla
  que el recálculo del ITBMS —solo si está PENDING y sin monto real— y **sin crear filas fuera del horizonte
  de 3 meses**: si el período no está, se dice, no se inventa. De paso le da a la proyección de caja un ancla
  con monto real, que hoy no tiene.
- **El ISR retenido se paga desde acá, y la pestaña avisa cuánto queda pendiente.** Lo único que el módulo no
  hace por él es marcar una obligación del calendario fiscal: el catálogo no tiene una mensual de
  retenciones (`VENCIMIENTO_MENSUAL` solo define ITBMS y CSS), e inventarle un tipo y un vencimiento sería
  peor que dejar el pago registrado sin esa marca.

### 3.7 El rol `planilla`

Entra directo a `/planilla.html` y solo pasa por `/api/planilla`, `/api/accounts`, `/api/auth` y
`/api/health`. Un usuario `inventario` recibe 403 en `/api/planilla`, y uno `planilla` en `/api/inventario`.

**Dentro de su propio módulo tampoco puede todo**: carga empleados, corre la planilla y registra el pago a la
CSS, pero **no aprueba asientos** (`/corridas/:id/revisar`) ni **edita las tasas** (`PUT /parametros`). Cambiar
la tarifa de riesgos o la escala del ISR cambia lo que se le retiene a todo el mundo: eso es del contador.

> El desplegable de roles del Panel Admin **solo ofrecía `contador` y `asistente`**, así que el rol
> `inventario` llevaba meses existiendo en la API sin poder asignarse desde la interfaz. Se agregaron los dos
> —el de inventario también— junto con sus etiquetas.

La barrera es **una sola** para los dos roles exclusivos (`limitarRolesExclusivos`, con un mapa de listas
blancas). Es deliberado: el resto de la API es permisivo por defecto, así que un rol restringido necesita que
se le niegue por defecto desde un único punto, no que veinte archivos de rutas se acuerden de filtrarlo.

> `/api/accounts` entra en la lista blanca porque los selectores de cuentas lo necesitan. Hoy el rol
> `inventario` ya lo llama y recibe 403 en silencio.

### 3.8 El alta masiva de empleados

El registro se puede llenar a mano o **importando el mismo archivo de planilla que ya se usa**: de ahí salen
NOMBRE, CÉDULA y SUELDO, más CARGO, NSS y FECHA DE INGRESO si el archivo los trae. El resto de las columnas se
ignora — las deducciones las calcula el motor.

**La conversión que importa:** en el archivo el SUELDO es el del **período** (casi siempre quincenal) y
`Employee.sueldoBase` es **siempre mensual**. Por eso el tipo de pago es un dato obligatorio del alta y no una
adivinanza: una quincena de 450 se guarda como 900, y el preview lo muestra antes de escribir nada.

El preview clasifica cada fila antes de tocar la base:

- **ok** — se crea.
- **existente** — ya hay un empleado con esa cédula; se omite y se muestra su sueldo actual, para que se vea
  si cambió.
- **error** — cédula repetida *dentro del archivo*, fila sin nombre, fila sin sueldo, o filas partidas por la
  coma decimal (el reparo de `tabular-utils.ts`).

Sin cédula no hay identidad: esas filas se comparan por **nombre exacto y solo si es único**. Fusionar dos
"Juan Pérez" distintos sería peor que duplicar uno.

### 3.9 Los avisos y el cuadre

**Los avisos de la corrida** son cosas que faltan cargar y que van a molestar más tarde, no errores: sin NSS
la planilla de la CSS (SIPE) rebota, sin fecha de ingreso no se puede prorratar ni calcular antigüedad, y los
asientos rechazados del mismo mes avisan antes de correr encima de una nómina que el contador ya rechazó. Solo
se avisa de quien **entra** en la corrida — llenar la pantalla con datos de gente que no se está pagando es
ruido — y los avisos que son el mismo para varios empleados se cuentan y se muestran una vez: treinta
renglones iguales tapan el que sí es distinto.

**El cuadre** (`GET /cuadre`) compara lo que las corridas dicen con lo que quedó en el mayor, en cuatro
preguntas que son las cuatro formas en que una nómina se descuadra:

1. **El neto.** Σ de los netos de las corridas contra lo acreditado a las cuentas de banco (`1.1.02.*`) de
   esos mismos asientos. Un asiento rechazado explica la diferencia, y el cuadre lo nombra.
2. **Los pasivos.** El saldo de cada cuenta por pagar contra lo que el módulo devengó **hasta la fecha** —no
   contra la ventana, que daría una diferencia inventada por el corte. Como pagar solo puede bajar la cuenta,
   un saldo **mayor** que lo devengado es imposible sin que alguien haya acreditado algo por fuera del módulo.
3. **Los asientos que no están vivos.** Uno rechazado o anulado no existe para el mayor, pero su corrida
   sigue contando para los acumulados: si el rechazo fue por un error, hay que anular la corrida y rehacerla.
4. **Quién no cobró.** Empleados activos sin ninguna corrida en el período. Es el olvido más caro porque no
   genera ningún error, y nadie reclama hasta que no le pagan.

**No arregla nada.** Un cuadre que se auto-corrige esconde el error en vez de mostrarlo — la misma doctrina
del cuadre de inventario.

### 3.10 Las tasas, y de dónde salió cada una

Todas viven en `PayrollSettings` y se editan desde la pestaña Parámetros. **Ninguna es una constante del
código**: si cambia la ley o cambia el cliente, se cambia ahí.

| Parámetro | Valor | De dónde salió |
|---|---|---|
| `ssObrero` | 9,75% | ✓ verificado contra los 77 asientos cargados |
| `seObrero` | 1,25% | ✓ verificado |
| `ssPatronal` | 12,25% | el contador |
| `sePatronal` | 1,50% | el contador |
| `riesgosProfesionales` | 1,00% | **derivado**: 13,25% del patrono − 12,25% de Seguro Social. Depende de la clase de riesgo |
| `ssObreroDecimo` | 7,25% | ✓ verificado (cinco niveles de sueldo, exactos) |
| `seObreroDecimo` | 0 | ✓ verificado |
| `ssPatronalDecimo` | 10,75% | el contador. Es **menor** que el del sueldo |
| Escala del ISR | anual: 0 / 15% / 25% sobre 11.000 y 50.000 | ✓ verificado |
| Meses del ISR | 13 | ✓ verificado |
| `factorDecimo` · `factorVacaciones` · `factorPrima` | 1/12 · 1/12 · 1/52 | acumulados |
| `provisionarPrestaciones` | apagado | se enciende cuando el contador lo decida |

**Los riesgos profesionales van por clase de riesgo, y son por empleado.** Una empresa puede tener una
oficina al 1,00% y un almacén con otra clase, así que `Employee.claseRiesgo` (I a V, opcional) decide la
tarifa: el empleado sin clase usa la general. **Una clase sin tarifa cargada no se asume en cero** — la fila
de ese empleado se rechaza, y si hay alguna, la corrida entera no se ejecuta. Un cero silencioso subvaluaría
el pasivo del patrono y el balance cuadraría igual, así que nadie lo notaría hasta que llegara la
fiscalización. La tabla arranca solo con la clase I; las demás se cargan desde Parámetros.

**Dos avisos sobre esta tabla**, porque son decisiones y no descubrimientos:

- El **1,00% de riesgos profesionales es una resta**, no un dato que el contador haya dictado: sale de que el
  total del patrono es 13,25% y el Seguro Social 12,25%. Si la clase de riesgo del cliente no es la I, se
  corrige en Parámetros.
- El **décimo lleva solo Seguro Social del patrono**. El contador dio una sola tasa para el décimo (10,75%) y
  del lado del empleado el Seguro Educativo también es cero. Si resultara que el patrono sí paga Seguro
  Educativo o riesgos sobre el décimo, son dos líneas en `calcularItem` — está dicho acá para que sea una
  decisión y no un olvido.

---

## 4. Modelo de datos

Migraciones **`0022_planilla`** (los cuatro modelos), **`0023_payroll_run_unico_parcial`** (el índice único
que libera el período al anular), **`0024_patronal_tres_cuentas`** (el gasto del patrono en tres cuentas) y
**`0025_empleado_clase_riesgo`** — SQL escrito a mano, **solo DDL, cero backfill**.

**`Employee`** — `companyId`, `cedula?`, `nss?`, `nombre`, `cargo?`, `sueldoBase` (**siempre mensual**),
`tipoPago` (`QUINCENAL`|`MENSUAL`), `fechaIngreso?`, `fechaSalida?`, `bancoCuentaId?`, `cuentaBanco?`,
`isActive`, `decimoSaldoInicial`, `vacacionesSaldoInicial`, `primaSaldoInicial`, `fechaSaldoInicial?`,
`notas?`. `@@unique([companyId, cedula])`.

La cédula es **nullable a propósito**: Postgres deja convivir varios NULL y así los empleados sin cédula (los
del archivo viejo) no se pierden. **Los empleados no se borran: se desactivan** — el histórico los referencia.

**`PayrollRun`** — `tipo`, `periodicidad`, `periodo` (**lleva la granularidad dentro**: `2026-06-Q1`,
`2026-06`, `2026`, `2026-08-14`), `periodoMensual` (la llave para cruzar con el calendario CSS),
`fechaDesde`, `fechaHasta`, `fechaPago`, `status` (**`BORRADOR`|`EJECUTADA`|`ANULADA`**), totales congelados,
`asientosCount`, `motivoAnulacion?`. `@@unique([companyId, tipo, periodo])`.

El estado se llama `EJECUTADA` y no `CONFIRMADO` a propósito: en este sistema `CONFIRMADO` ya significa "el
contador aprobó el asiento", y una corrida "confirmada" con 30 asientos en BORRADOR sería una mentira en
pantalla.

**`PayrollItem`** — `diasTrabajados`, `sueldo`, `horasExtras`, `otrosIngresos`, `bruto`, `ss`, `se`, `isr`,
`otrasDeducciones`, `neto`, `ssPatronal`, `sePatronal`, `riesgosPatronal`, `decimoGenerado`,
`vacacionesGeneradas`, `primaGenerada`, `journalEntryId?`, `notas?`. `@@unique([runId, employeeId])`.

**`PayrollSettings`** — 1:1 con `Company`, creada perezosamente: las seis tasas, los tres factores, la escala
del ISR (JSON en String, convención del repo) y el interruptor `provisionarPrestaciones`.

**`Company`** suma `planillaSSPatronalId`, `planillaSEPatronalId`, `planillaPatronalGastoId` y
`planillaOtrasDeduccionesId`.

---

## 5. Endpoints

Todos cuelgan de `/api/planilla`, así que la lista blanca del rol los cubre sin entradas nuevas.

| Método | Ruta | Qué hace |
|---|---|---|
| GET/POST/PATCH | `/empleados` · `/empleados/:id` | Registro de empleados y saldos iniciales. No borra: desactiva |
| POST | `/roster/preview` · `/roster/execute` | Alta masiva desde el archivo de planilla |
| GET/PUT | `/parametros` | Tasas, escala del ISR, factores e interruptor. Los selectores de cuentas salen de acá |
| GET | `/cuentas` | Catálogo de cuentas para los selectores |
| POST | `/corridas/preview` | Prellena el período y calcula sin escribir |
| POST | `/corridas` | Ejecuta: corrida + ítems + asientos BORRADOR + `Transaction` |
| GET | `/corridas` · `/corridas/:id` | Historial y detalle, con el estado de cada asiento |
| POST | `/corridas/:id/recalcular` · `/anular` | Solo en BORRADOR; la anulación reusa `journal-annul.ts` |
| POST | `/corridas/:id/revisar` | Aprueba o rechaza **en bloque**, con reporte por empleado |
| GET | `/corridas/:id/export.csv` | Las columnas del archivo viejo |
| GET | `/acumulados` · `/acumulados/:employeeId` | Décimo, vacaciones y prima por empleado |
| GET | `/css` | Calendario, montos por aporte y saldo adeudado |
| POST | `/css/pago` · `/css/:periodo/valorar` | Registra el pago a la CSS y valoriza la obligación |
| GET | `/cuadre` | Corridas del período contra el mayor: neto, pasivos, asientos no vivos y quién no cobró |

Las escrituras se reparten en dos niveles de permiso: `ROLES_ESCRITURA_PLANILLA` (admin, contador, superadmin
y **planilla**) para lo operativo, y `ROLES_PARAMETROS` (sin el rol de nómina) para las tasas y las cuentas.

---

## 6. Estado de la construcción

| # | Fase | Estado |
|---|---|---|
| 1 | Modelos, migración y motor puro | ✅ Hecho (25-09) — `payroll-calc.ts` con 57 tests; migración `0022` aplicada |
| 2 | Empleados y parámetros | ✅ Hecho (25-09) — registro, alta masiva, acumulados y parámetros |
| 3 | La corrida | ✅ Hecho (25-09) — preview, ejecución con asientos, export, revisión y anulación en bloque |
| 4 | Acumulados, historial y CSS | ✅ Hecho (25-09) — resumen por mes, valorización de la obligación y registro del pago |
| 5 | Página, rol y navegación | ✅ Hecho (25-09) — `planilla.html` con 6 pestañas, rol `planilla` con su barrera, y los roles en el Panel Admin |
| 6 | Avisos y cuadre | ✅ Hecho (25-09) — avisos de higiene en la corrida y pestaña de cuadre contra el mayor |
| 7 | Retiro de la carga por archivo y documentación | ✅ Hecho (25-09) — 410 con guía, modo 👷 Planilla fuera de Importar, `clean-test-data.sh` extendido |

El **retiro de la carga por archivo fue al final**, cuando el módulo ya estaba verificado. Lo que se retiró y
lo que quedó:

- `POST /planilla/preview` y `POST /planilla/execute-all` → **410 con la guía**, no un 404 seco: un navegador
  con el JS viejo en caché tiene que poder leer adónde ir.
- El modo `👷 Planilla` salió de Importar (`index.html`, `import.js`, `js/planilla.js`), y el panel de
  Administración dejó un puntero a Planilla → Parámetros en vez de una segunda tarjeta de cuentas: tenerlas en
  dos pantallas era pedir que se separaran.
- **`planilla-parser.ts` se borró**, pero el archivo sigue entrando por el alta masiva de empleados, que usa
  `tabular-utils.ts` — ahí viven las trampas que costó descubrir (la coma decimal panameña, las fechas de
  Excel sin perder un día).
- Los asientos de planilla que ya estaban cargados **no se tocan**: son historia. El retiro quita la
  capacidad de crear nuevos por esa vía, no lo ya contabilizado.

---

## 7. Verificación

La empresa de pruebas es **`demo-company`**. **ODESA no se toca.**

**Línea base, antes de empezar y al terminar:** `SELECT count(*) FROM "Transaction" WHERE type='PLANILLA'` →
**77**, y las tablas nuevas en cero para el `companyId` de ODESA.

1. **Unitarios** — el fixture dorado de tasas reales, R1–R10 y las fronteras del ISR (anual exactamente en
   11.000 y en 50.000, y la corrida que reparte el residuo del mes).
2. **Empleados** — alta masiva desde un archivo real → fichas prellenadas → saldos iniciales.
3. **Corrida** — prellenar una quincena, editar, ejecutar → asientos BORRADOR con origen 🧮 y cada uno
   cuadrando al centavo. Un sueldo "feo" (333,33) también cuadra exacto.
4. **Doble corrida** — mismo período → 409 con el id de la existente, no duplicado ni 500.
5. **Acumulados** — dos quincenas seguidas: acumulado = saldo inicial + Σ ítems; anular la primera y ver que
   vuelve al valor previo. Prender la provisión y confirmar que el asiento gana sus líneas.
6. **CSS** — el saldo deudor iguala SS + patronal de las corridas del mes; registrar el pago y ver el pasivo
   cerrarse; la obligación CSS de ODESA sigue con su monto en NULL.
7. **Rol** — un usuario `planilla` creado desde la UI entra directo a su página; `/api/journal`,
   `/api/reports`, `/api/config`, `/api/salud` y `/api/users` responden 403; `/api/planilla/*` y
   `/api/accounts` responden 200; revisar una corrida responde 403. Un usuario `inventario` recibe 403 en
   `/api/planilla`.
8. **Export** — el CSV abre con los montos exactos y las columnas del archivo viejo.

---

## 8. Riesgos y trampas conocidas

- **El rol nuevo abre un agujero si no se generaliza la barrera.** `limitarRolInventario` dejaba pasar a
  cualquier rol que no fuera `inventario`: sin generalizarlo a `limitarRolesExclusivos`, un rol `planilla`
  habría pasado por toda la API sin que nada lo frenara. Es la primera cosa que hay que mirar si algún día se
  agrega un tercer rol restringido.
- **El neto como residuo** implica que puede diferir en un céntimo de lo que calcule el banco. Es deliberado:
  es lo que hace que el asiento cuadre sin absorber céntimos en un monto que el contador reconoce.
- **Una transacción de Prisma por empleado**, no una para toda la corrida: el timeout interactivo es de 5
  segundos y no hay ni un `{timeout}` en el repo. Con una sola, una caída a mitad tira la planilla del mes.
- **El asiento incluye el aporte patronal**, así que su total es mayor que el `amount` de la `Transaction`
  (el bruto del empleado). Es correcto, pero cualquier consumidor que compare ambos números se confundiría.
- **`clean-test-data.sh`** tiene que borrar `payroll_item` antes de `payroll_run` y de `employee`, y todos
  antes de `JournalEntry` (el `journalEntryId` no es FK, pero el orden hijos→padres sí importa). El script ya
  está extendido; el orden se verificó con un `ROLLBACK`, no borrando de verdad.
- **Los asientos de planilla cargados por archivo siguen en el diario** y no se tocan: el retiro quita la
  capacidad de crear nuevos por esa vía, no lo ya contabilizado. Su origen sigue leyéndose como 🧮 en el
  diario, porque el `metadata.source` es el mismo en los dos caminos a propósito.
- **Fechas a mediodía local** (`parseLocalDate`) en `fechaPago`, `fechaIngreso`, `fechaSalida` y
  `fechaSaldoInicial`. La mitad de los bugs de fecha del repo vienen de acá.
- **Multi-tenant**: siempre `findFirst({ where: { id, companyId } })`, nunca `findUnique({ where: { id } })`.
- **XSS**: los nombres de empleado vienen de archivos. `esc()` en cada interpolación de la página.
