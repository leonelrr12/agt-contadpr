# Módulo de Inventario

> **Documentación viva del módulo.** Describe cómo está diseñado y por qué, para que las directivas se
> mantengan en un solo sitio. Se actualiza **cuando cambia una directiva**, no cuando cambia el código.
>
> ## ⚠️ Estado: PLANIFICADO — no construido (25-09-2026)
> Nada de lo que sigue existe todavía en el código. Cuando se implemente, actualizar esta línea y la
> sección **Estado de la construcción**. El avance del roadmap vive en `Tuning.md` §4.3.

---

## 1. Por qué existe

Resuelve un problema contable real, no una función de conveniencia:

- **El inventario se debita al comprar y nunca se acredita al vender.** Una venta es
  `D Caja|Clientes / C Ventas / C ITBMS` y no toca ni inventario ni costo. Las cuentas `5.01.01 Costo de
  Productos Vendidos` existen en el catálogo y **nunca se alimentan**. El saldo de `1.1.04` solo puede crecer
  y el resultado nunca muestra el costo de lo vendido.
- **No hay cantidades en ningún lado.** `InvoiceItem` guarda descripción libre, cantidad y precio, pero no
  producto ni costo; `Bill` no tiene renglones. El libro diario registra **montos, no unidades**.

Por eso el módulo necesita un **kardex propio** que sea la fuente de verdad de las existencias, y que
alimente la contabilidad en las dos direcciones: la compra sube stock y debita inventario; la venta baja
stock y registra el costo.

Es un **módulo independiente que alimenta la contabilidad**, igual que Planilla: tiene sus propias pantallas
y su propio dato, y escribe asientos en el libro compartido.

---

## 2. Las directivas (lo que manda)

Estas son las decisiones del dueño. **Si alguna cambia, se cambia acá y en el código.**

| # | Directiva |
|---|---|
| 1 | **El módulo genera los asientos.** Entrada: `D 1.1.04.01 / C banco\|proveedores`. Salida por venta: `D 5.01.01 / C 1.1.04.01`, al costo promedio. |
| 2 | **Los asientos nacen en BORRADOR** y los revisa el contador, como todo el sistema. El movimiento de stock es inmediato; lo que queda pendiente de aprobación es el efecto contable. |
| 3 | **La compra de mercancía pasa por Inventario.** Es la **única** vía que debita `1.1.04.01`; la importación masiva y el chat dejan de mandar compras a esa cuenta. |
| 4 | **El kardex es solo para mercancía de reventa.** Materia prima e insumos son gasto, no llevan kardex. Una empresa de servicios (ODESA) no lo usa. |
| 5 | **Página propia en el mismo dominio**: `contador507.com/inventario.html`. No va al menú del SPA, que ya está lleno. |
| 6 | **Las compras y las ventas alimentan los Auxiliares de CxC y CxP**, no solo el mayor. |
| 7 | **Rol `inventario`**: ve y opera inventario, emite facturas de venta y mantiene clientes y proveedores. Todo lo demás se le niega. |

---

## 3. Cómo funciona

### 3.1 El kardex y el costo promedio

El **kardex** es la lista de movimientos de un producto, en **orden de registro** (no de fecha de
documento). Es un registro: **no se borra ni se edita**. Corregir un movimiento se hace con el **movimiento
inverso** (`revierteAId`), que devuelve las cantidades por aritmética y no obliga a ningún reporte a filtrar
nada. El inverso repone **al costo original** del movimiento que anula — ver §3.2.

Las dos decisiones que sostienen todo lo demás:

- **El valor del kardex es la suma firmada de los montos que fueron al asiento**, no `cantidad × promedio`.
  Eso hace que **kardex y mayor cuadren por construcción**, al centavo. El costo promedio se **deriva**
  (`saldoValor / saldoCantidad`) y puede quedar fraccionario sin ser un error: es un número de gestión, se
  redondea solo al mostrarlo.
- **El costo promedio vive en el producto** (estado vigente) y **el costo concreto vive en cada movimiento**
  (historia congelada). Guardar solo el promedio obligaría a reconstruir toda la cadena para leer una salida
  de marzo — y ese número cambiaría si mañana entra un movimiento anterior.

El kardex **avisa cuando un movimiento tiene fecha anterior al último del producto**: el saldo corrido va
en orden de captura, pero el asiento se registra con la fecha del documento.

### 3.2 El motor de costo (`services/costo-promedio.ts`)

Función **pura**: recibe el estado del producto y devuelve el resultado. Sin base de datos, sin Express, sin
hora del sistema — por eso se puede probar entera.

| Caso | Regla |
|---|---|
| **Entrada** | `costoTotal = r2(cantidad × costoUnitario)` y el promedio se recalcula. Con stock en 0, el promedio pasa a ser el costo de esa entrada. |
| **Salida con stock** | Al promedio vigente. **Una salida nunca cambia el promedio.** |
| **Salida que vacía el stock** | *Barrido*: sale por el valor total que quedaba, no por `cantidad × promedio`. Absorbe el redondeo acumulado y cierra en 0/0 exacto, sin centavos fantasma. |
| **Salida sin stock suficiente** | Error. Forzada: el faltante va a **costo 0** (no se inventa costo), el saldo queda negativo y el promedio se conserva — nunca negativo. Queda marcada para regularizar. |
| **Costo cero** | Si había stock, baja el promedio (correcto: es una compra más barata). Sin stock, la salida posterior vale 0 y se avisa. |
| **Ajuste positivo** | Con costo explícito, o hereda el promedio. **Sin stock se exige costo**: no se inventa. |
| **Ajuste negativo** | Al promedio; puede vaciar el stock (mismo barrido). |
| **Entrada que cubre un faltante** | Genera **dos movimientos**: la entrada y una `REGULARIZACION` que revalúa las unidades que habían salido sin costo, al costo de la compra que las cubre. Sin esto, el valor de lo vendido sin costo se queda en el activo y las unidades que quedan absorben su costo: comprar 5 a $10 con el stock en −2 daría un promedio de $16,67 en vez de $10. |
| **Reverso** | Repone al **costo original** del movimiento que anula, no al promedio vigente. Al promedio no devolvería el valor anterior — el promedio se mezcló con otros movimientos — y el kardex quedaría corrido para siempre. |
| **Redondeo** | `r2` en todo monto de asiento. El costo unitario y el promedio se guardan con precisión completa. `toFixed(2)` **solo** al mostrar texto. |

> **La regularización mueve valor, no cantidad.** Las unidades que regulariza ya salieron: su
> cantidad ya estaba descontada. Es la única fila del kardex con `cantidad = 0`, y existe porque el
> problema era de valuación, no de existencias. Restarle también la cantidad dejaría el kardex en 1
> donde físicamente hay 3.

**Invariante que los tests fijan:** el saldo final en valor es igual a la suma firmada de los montos
posteados, y el de cantidad a la suma firmada de las cantidades, en cualquier secuencia.

### 3.3 El cuadre con el mayor

`GET /api/inventario/cuadre` compara el kardex contra la contabilidad y **muestra las diferencias en vez de
esconderlas**. Cinco bloques, cada uno con su lista y su `cuadra`:

1. **Kardex vs mayor** — debe dar 0.00.
2. **Saldos en cuentas de inventario que no tienen kardex** — hoy reporta **$1,000.00 de ODESA en la cuenta
   padre `1.1.04`**, de la Carga Inicial del 31-12-2025. El contador decide: dejarlo (ODESA es servicios y no
   usa kardex), abrir el kardex con una apertura por ese monto, o reclasificarlo con un asiento manual.
   **Nada se corrige automáticamente.**
3. **Movimientos sin asiento**, y movimientos cuyo asiento quedó RECHAZADO o ANULADO.
4. **Ventas sin costo** — aviso de gestión, no error.
5. **Plantillas recurrentes de compra con cuenta de inventario** — hoy no existe ninguna.

Que el kardex y el mayor no cuadren tiene causas conocidas y listadas: el contador rechaza un asiento
después de que el stock ya se movió, alguien edita un asiento a mano, o entra un asiento manual a la cuenta
de inventario. El cuadre las delata; no las arregla solo.

### 3.4 La compra

Se registra **desde la página de Inventario**: producto, cantidad, costo unitario, proveedor y forma de pago.
En una sola operación genera el **movimiento de stock** y el **asiento** de compra.

- **ITBMS**: si la empresa declara ITBMS, el impuesto va a crédito fiscal y el kardex recibe el **neto**. Si
  no declara, el ITBMS **se capitaliza** en el costo, y el kardex y el asiento usan el mismo costo
  capitalizado. El ITBMS por defecto es **0**: no se inventa el 7%.
- Varias líneas producen **un solo asiento** (con los débitos agrupados por cuenta para que quede legible) y
  una fila de kardex por producto.
- Una compra **al contado** (caja o banco) no toca CxP y no genera factura de proveedor.
- Una compra **a crédito** acredita `2.1.01 Proveedores` y **crea la factura de proveedor**, para que
  aparezca en el auxiliar de CxP (§3.6).

**La importación masiva y el chat ya no debitan inventario.** Las compras que entren por ahí se registran
como gasto, que es lo que el catálogo de conceptos ya decía (`"Compra de mercancía" → 5.01.01`) y lo que la
pantalla de vista previa ya mostraba. Esas filas llevan un aviso de que la mercancía de reventa se carga
desde Inventario.

### 3.5 La venta

Se emite como **factura**, reusando el módulo de Facturas. No hay un camino de venta propio: duplicarlo
sería una segunda forma de facturar y con ella una segunda numeración y un segundo criterio de ITBMS.

- El renglón de la factura puede apuntar a un **producto** del catálogo. Al elegirlo se descuenta el stock y
  se añade al asiento la línea `D Costo de Productos Vendidos / C Inventario` por el costo promedio.
- **Un renglón sin producto no genera costo.** Las facturas de servicios y las históricas no cambian.
- **Stock insuficiente no rechaza la venta**: la venta ya ocurrió y la numeración es correlativa. El faltante
  se valora a 0, el saldo queda negativo y el producto entra en "regularizar" — cuando se cargue la compra,
  el motor emite la regularización sola.

### 3.6 Los Auxiliares de CxC y CxP

No alcanza con que el asiento exista: la compra y la venta tienen que **aparecer en los auxiliares**, que es
donde el contador mira quién le debe y a quién le debe.

El mecanismo es el que ya usa el sistema (`syncEntityFromEntry`, `services/entity-service.ts`): detecta la
cuenta **por código** y crea la entidad.

- Línea a `1.1.03.01 Clientes` → crea el **Invoice** → auxiliar de **CxC**.
- Línea a `2.1.01 Proveedores` → crea el **Bill** → auxiliar de **CxP**.

Consecuencias para el módulo: la **compra a crédito** tiene que disparar esa sincronización, con la
transacción que lleva el proveedor y la referencia; y la **venta** ya queda cubierta porque se emite como
factura, que crea su propio Invoice.

### 3.7 El rol `inventario`

Un usuario con este rol entra directo a la página de Inventario y **solo** puede:

- Inventario: productos, movimientos, valoración, cuadre, alertas.
- Emitir facturas de venta y consultarlas.
- Crear y consultar clientes y proveedores.

No puede ver el diario, los informes, la salud financiera, los presupuestos ni el cierre. **No puede cobrar
facturas ni editar fichas** de clientes o proveedores.

> **Barrera de seguridad.** Hoy casi ninguna ruta de la API tiene filtro de rol: el modelo es permisivo por
> defecto para cualquier usuario autenticado. Un rol restringido exige una barrera explícita que **niegue por
> defecto** y deje pasar solo una lista blanca. Va en un único punto, justo después de la autenticación, para
> no tener que auditar veinte grupos de rutas.

---

## 4. Modelo de datos (diseñado, no creado)

**`inventory_product`** — mercancía de reventa. Código interno opcional, nombre, descripción, unidad, stock
mínimo (para la alerta), **stock actual y costo promedio vigentes**, cuentas de inventario y costo
opcionales (por defecto las de la empresa), activo. Los productos **no se borran**: se desactivan.

**`inventory_movement`** — una fila por línea de documento. Producto, fecha, tipo
(`ENTRADA | SALIDA | AJUSTE_POSITIVO | AJUSTE_NEGATIVO`), origen
(`COMPRA | VENTA | AJUSTE | APERTURA | REGULARIZACION | ANULACION`), **cantidad siempre positiva** (el signo
lo da el tipo), costo unitario y total, y el saldo corrido después del movimiento (cantidad, valor y
promedio). Vínculos: asiento, factura, proveedor, referencia y notas. Clave de idempotencia para que un
doble clic o una re-subida no dupliquen stock. Estado y referencia al movimiento que revierte.

**Cambios aditivos a lo existente:** cuentas de inventario por defecto en `Company`, y `productId` opcional
en los renglones de factura.

---

## 5. Endpoints (diseñados, no creados)

| Endpoint | Quién | Notas |
|---|---|---|
| `GET /productos` | autenticado | Con totales: valor, bajo mínimo, negativos |
| `POST /productos` · `PATCH /productos/:id` | + `inventario` | El `PATCH` nunca toca stock ni costo |
| `GET /productos/:id/kardex` | autenticado | Incluye el saldo del mayor y si cuadra |
| `POST /entradas` · `POST /salidas` · `POST /ajustes` | + `inventario` | Consumen cuota; generan asiento BORRADOR |
| `POST /movimientos/:id/anular` | + `inventario` | Con motivo; crea el inverso |
| `GET /movimientos` · `GET /valoracion` · `GET /alertas` · `GET /cuadre` | autenticado | |

---

## 6. Estado de la construcción

| Fase | Contenido | Estado |
|---|---|---|
| 1 | Modelos + migración `0018` + motor de costo puro | ✅ **Hecho** (25-09) — 19 tests |
| 2 | API y asientos (productos, entradas, salidas, kardex, valoración) | ⬜ Pendiente |
| 3 | Página `inventario.html` + enlace desde el SPA | ⬜ Pendiente |
| 4 | La venta descuenta stock (`InvoiceItem.productId`) | ⬜ Pendiente |
| 5 | La compra deja de entrar por importación y chat | ⬜ Pendiente |
| 6 | Cuadre y alertas | ⬜ Pendiente |
| 7 | Ajustes, anulación y toma física | ⬜ Pendiente |

La Fase 1 dejó en la base las tablas `inventory_product` e `inventory_movement`, `invoice_item.productId`
y las cuentas de inventario por empresa. Nada las usa todavía: son aditivas y no cambian ningún
comportamiento existente.

Las fases 1 a 3 son aditivas y se despliegan sin tocar ningún flujo existente. La **fase 5 es el único
cambio de comportamiento sobre datos vivos** y va al final, cuando el módulo ya es la alternativa.

---

## 7. Verificación

Se prueba en `demo-company` (nunca en ODESA, que es un cliente real) y se limpia con
`scripts/clean-test-data.sh`, que hay que ampliar para que borre también las tablas del módulo.

El ciclo que tiene que cerrar: producto con mínimo → entrada → segunda entrada a otro costo (el promedio se
recalcula y **los movimientos anteriores no cambian**) → factura de parte del stock (**el asiento de venta
lleva además la línea de costo**) → salida del resto (**acredita exactamente el valor que quedaba y el kardex
cierra en 0/0**, sin centavos fantasma) → `GET /valoracion` con diferencia 0.00 contra el mayor.

Además: la compra a crédito tiene que aparecer en el **auxiliar de CxP** y la venta en el de **CxC**; el rol
`inventario` recibe 403 en diario, informes y salud; y una factura **sin producto** genera exactamente el
mismo asiento que hoy.

---

## 8. Riesgos y trampas conocidas

- **El kardex es un hecho físico y no se revierte si el contador rechaza el asiento**; el mayor sí. Es un
  descuadre legítimo, el cuadre lo lista y ofrece anular el movimiento. No se engancha nada en el flujo de
  revisión del diario.
- **Concurrencia**: dos salidas simultáneas del mismo producto pueden perder una. Se toma un lock por
  producto dentro de la transacción, **en orden de id** para evitar deadlocks.
- **Fechas a mediodía local**, o un movimiento del 17 se ve como del 16 en el navegador.
- **Cuentas bloqueadas**: se verifica antes de crear el movimiento, o queda kardex huérfano. Ojo con `1.1.04`
  de ODESA, que está bloqueada — es la cuenta **padre**, no la del kardex.
- **`InvoiceItem.cantidad` es entero**: hoy no se puede facturar 2,5 LB. El kardex sí acepta fracciones. Si
  se vende por peso, hay que cambiar el tipo de la columna.
- **XSS**: la página define su propia función de escape y la usa en todo texto que venga del usuario.
