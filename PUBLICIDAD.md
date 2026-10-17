# Publicidad — el texto para las campañas

Todo lo de acá sale de [`apps/web/public/funciones.html`](apps/web/public/funciones.html) (la página que
explica la app al cliente), que a su vez está verificado contra el producto: cada cosa que dice existe en
el código. **Regla de la casa: no se agrega nada que la app no haga** — ni cantidad de clientes, ni
testimonios, ni «80 % más rápido». Lo que promete un anuncio es lo que el cliente encuentra al entrar, y
si no coincide, el que pierde es el vendedor que está enfrente.

Cómo se usa: cada bloque está listo para copiar y pegar. **Gancho** es el título del anuncio o el primer
renglón del mensaje; **cuerpo** es el texto; **remate** cierra con el WhatsApp.

---

## 1. Los seis ángulos

Cada uno es un anuncio distinto. El mismo producto, seis puertas de entrada — según a quién le duela qué.

### 1.1 · Digitar facturas

**Gancho:** Dejá de tipear facturas. Mandá la foto y listo.
**Cuerpo:**
> ¿Cuántas horas por semana pasás pasando facturas al sistema? Agarrar el papel, buscar la cuenta,
> escribir el monto, acordarte del ITBMS…
>
> En Contador507 le mandás la foto **por WhatsApp** y la factura entra sola: el proveedor, el monto y el
> ITBMS desglosado, ya como asiento listo para revisar. Vos solo aprobás.
**Remate:** Escribinos y te mostramos cómo queda en 5 minutos → WhatsApp 6403-4863

### 1.2 · Cuadrar el banco

**Gancho:** El banco ya no se cuadra con dos pantallas abiertas.
**Cuerpo:**
> Subís el estado de cuenta y el sistema cruza solo: mismo monto, misma fecha del día. Lo que queda
> suelto lo resolvés en la pantalla — y si una transferencia cubre cuatro facturas, se vinculan las
> cuatro a la misma línea del banco.
>
> Se terminó el «¿y estos $340 de qué eran?» a fin de mes.
**Remate:** Pedí una demostración con tu propio estado de cuenta → WhatsApp 6403-4863

### 1.3 · La planilla

**Gancho:** La planilla, con el Seguro Social, el décimo y las vacaciones, en un rato.
**Cuerpo:**
> Seguro Social, Seguro Educativo, ISR, décimo, vacaciones y los aportes del patrono — cada uno a su
> cuenta. La corrida se calcula y **la ves antes de confirmar**. El pago a la CSS y las planillas salen
> del mismo módulo.
>
> Quincenal, mensual o semanal. Y si un empleado tiene una clase de riesgo sin tarifa cargada, la app
> **se niega a calcular** en vez de inventarte un número.
**Remate:** ¿La corremos con tus empleados de prueba? → WhatsApp 6403-4863

### 1.4 · El Formulario 430

**Gancho:** El borrador del 430 sale del mayor, no de tu calculadora.
**Cuerpo:**
> Sumar el débito y el crédito fiscal, mirar las retenciones, cuadrar con la cuenta… El borrador de
> ITBMS se arma solo, renglón por renglón, **con el cuadre contra el mayor a la vista**.
>
> Cuando lo presentás, la app guarda lo declarado, compensa el renglón 52 y crea el asiento del pago. Y
> si te equivocaste, se anula y vuelve todo atrás.
**Remate:** Te lo mostramos con tu mes cerrado → WhatsApp 6403-4863

### 1.5 · Los cobros

**Gancho:** ¿Quién te debe y desde cuándo? Ahora lo ves de un vistazo.
**Cuerpo:**
> Cada factura lleva su saldo: cobros parciales, vencidas por cobrar, cuánto entró y en qué cuenta. Sin
> abrir Excel ni preguntarle a nadie.
**Remate:** WhatsApp 6403-4863

### 1.6 · El que compra en la calle ⭐ (el más vendible)

**Gancho:** Tu gente compra en la calle todos los días. Que no lleguen con un papelito arrugado.
**Cuerpo:**
> El de la obra, el del reparto, el del mostrador: compran y pagan de su bolsillo. Después empieza el
> «¿esto qué era?» y el «¿cuánto te debo?».
>
> Con Contador507 cada uno manda la foto o el QR de la factura **desde su celular** —no necesita usuario
> ni contraseña— y queda registrada a su nombre. En el panel ves lo que adelantó cada uno, y al pagarle
> se aprueban sus facturas de una vez: **el que paga es el que aprueba**.
**Remate:** Te lo configuramos con tu gente → WhatsApp 6403-4863

---

## 2. Frases de una línea

Para títulos de anuncio, bio de Instagram, asunto de correo, primer renglón de un mensaje.

- La contabilidad de tu negocio, sin digitar.
- Mandá la foto. El asiento se hace solo.
- Tu contabilidad desde el celular, por WhatsApp.
- El banco se cuadra solo.
- Facturas de proveedores que se cargan mientras dormís.
- El 430 sale del mayor, no de tu calculadora.
- La planilla completa, sin pelear con las tasas.
- Cada empleado manda su gasto desde el celular.
- Contabilidad panameña de verdad: ITBMS, CSS, ISR y cierre de año.
- Para el contador: tres clientes por $19.99 al mes.

---

## 3. A quién le hablás (segmentación)

| Audiencia | Qué le duele | Qué anuncio usar |
|---|---|---|
| **Ferretería, restaurante, distribuidora, taller** | Digitar, cuadrar el banco, saber si gana | 1.1, 1.2, 1.5 |
| **Construcción, reparto, servicios con gente en la calle** | Los viáticos y los papelitos | **1.6** |
| **Negocio con proveedores que facturan por correo** | Cargar facturas de compra | 1.1 + canal del correo (§4) |
| **Contador independiente / despacho chico** | Cuántos clientes puede llevar | §5 (despacho) |
| **Negocio con empleados** | La planilla y la CSS | 1.3 |

---

## 4. Los cinco canales (para posts de «¿sabías que…?»)

Cada canal da un post corto. Son los que hacen decir «ah, ¿eso se puede?».

1. **WhatsApp o chat** — «Compré combustible por $40 con tarjeta» y ya. La IA entiende y arma el asiento.
2. **Foto** — la del recibo o la factura: se lee (OCR) y se sacan total, fecha, proveedor, RUC e ITBMS.
3. **El QR de la factura DGI** ⭐ — le mandás **la foto del QR** y la app entra a la DGI, baja el CUTE,
   saca los datos y arma el asiento. También hay escáner con la cámara en el panel.
4. **Excel o CSV** — el archivo del banco o tu plantilla. Volver a subir el mismo archivo **no duplica**.
5. **El correo de la empresa** ⭐ — le das el buzón donde tus proveedores mandan las facturas y **las carga
   sola de madrugada**. Si alguna no entra, **te avisa por correo y dice por qué**.

---

## 5. El despacho contable (campaña aparte)

**Gancho:** Llevá tres clientes por lo que te cuesta un almuerzo.
**Cuerpo:**
> Plan Despacho 3: **$19.99 al mes**, tres empresas, mil movimientos, tres usuarios por empresa.
>
> Cambiás de cliente sin cerrar sesión, tenés el tablero con lo que le falta a cada uno —borradores por
> revisar, buzón con problemas, por cobrar vencido, obligaciones— y el comparativo de ventas y resultado
> entre todas. Tus clientes entran a sus libros con su propio usuario, y cada uno nace con **tu** plan de
> cuentas y tus conceptos.
**Remate:** WhatsApp 6403-4863

Escalones: Despacho 10 $39.99 · Despacho 25 $79.99 · Despacho 50+ $149.99 (movimientos ilimitados).

---

## 6. Objeciones (decirlo antes que el cliente)

Adelantarse es lo que hace que después no haya reclamo:

- **«¿Emite factura electrónica?»** — No. Lee las facturas electrónicas que te mandan tus proveedores,
  pero para emitir CFE hace falta un PAC autorizado. Emite facturas en PDF con los datos y la leyenda de
  resolución de la DGI.
- **«¿Le presenta a la DGI por mí?»** — No. Prepara el borrador, la declaración y los asientos;
  presentar y firmar es tuyo.
- **«¿Reemplaza a mi contador?»** — No. Le saca la digitación y el cálculo, y le deja la revisión con el
  detalle al lado.
- **«¿Los números salen de la nada?»** — No. Si una empresa no tiene historial de montos, la proyección
  **avisa** en vez de estimar.

---

## 7. Tres campañas armadas

**A · «La calle» (viáticos)** — para construcción, reparto y servicios.
Anuncio con el ángulo 1.6. Público: negocios con cuadrillas. Cierre: ofrecer configurarlo con su gente
(es un servicio, no una venta: engancha al dueño).

**B · «El QR» (lo más panameño)** — el más fácil de entender: cualquier negocio panameño vio un QR de
factura electrónica.
Anuncio corto con el canal 3. Cierre: «mandanos el QR de una factura y te mostramos el asiento que sale».

**C · «Tres clientes por $19.99» (despacho)** — el §5.
Público: contadores. Ojo: hablarle de **clientes que puede llevar**, no de funciones.

---

## 8. Datos fijos (siempre iguales en todo anuncio)

- **WhatsApp:** 6403-4863 · [wa.me/50764034863](https://wa.me/50764034863)
- **Correo:** admin@contador507.com
- **Precios y planes:** contador507.com/planes.html · **Qué hace:** contador507.com/funciones.html
- **Pago:** Yappy al 6403-4863 · Transferencia ACH, Caja de Ahorros, cuenta de ahorros 590000078733, titular Leonel Rodriguez
- **Prueba:** 14 días gratis, sin tarjeta (1 empresa, 3 usuarios, 50 movimientos, **todos los módulos**)
