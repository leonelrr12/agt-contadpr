# Planes y cuentas (despacho) — diseño

**Estado: fase 1 implementada (16-10-2026); fases 2-4 pendientes.** Las dos decisiones de fondo ya están
tomadas por el dueño: **el despacho es una entidad aparte con su propia suscripción** (no una empresa que
cubre a otras) y **el tope de movimientos se mantiene, holgado**, como red anti-abuso.

## 1. El problema

Los planes de hoy se cobran y se controlan por **una sola cosa: movimientos**. «3 usuarios», «10
usuarios», «Usuarios ilimitados» y «Múltiples API Keys» están escritos en `Plan.features` como texto
para la pantalla de precios y **no se validan en ningún lado**: hoy cualquier empresa crea los usuarios
que quiera y el despacho crea las empresas que quiera. Y la suscripción es **por empresa**, así que un
despacho con diez clientes tendría diez planes (o clientes sin plan): la propuesta comercial —el
despacho paga una vez y le cubre N empresas— no entra en el modelo.

## 2. La entidad `Cuenta`

**Todo cliente es una cuenta**, y las empresas cuelgan de ella:

```
Cuenta (la que paga)  ──1:N──  Company  ──1:N──  User (membresías)
      │                             
      └── Subscription (plan, cuota, addons)
```

- **Un cliente individual es una cuenta con UNA empresa** — no hay dos modelos ni un caso especial.
- **Un despacho es una cuenta con N empresas** (sus clientes) y sus propios usuarios.
- La **suscripción se muda de la empresa a la cuenta**: `Subscription.cuentaId` en vez de `companyId`.
  La cuota y el plan se resuelven subiendo de la empresa a su cuenta, que es un salto de una fila.

Migración aditiva + backfill: por cada empresa existente se crea una cuenta (con su nombre), se le
asigna la empresa y se mueve su suscripción. Nada cambia de comportamiento hasta que alguien crea una
segunda empresa.

**Quién puede entrar sigue saliendo de las membresías** (`user_company`), no de la cuenta: la cuenta es
de facturación, no de permisos. Un contador del despacho entra a la empresa del cliente porque tiene
membresía ahí.

## 3. Los límites, y dónde se validan

| Límite | Vive en | Se valida en |
|---|---|---|
| **Empresas por cuenta** | `Plan.maxEmpresas` | `POST /api/companies` (contando las empresas de la cuenta) |
| **Usuarios por empresa** | `Plan.maxUsuariosPorEmpresa` | `POST /api/users` — **`/vincular` no valida**, porque vincular no cambia la empresa casa de nadie y por lo tanto no suma cupo (ver la regla del conteo, abajo) |
| **Movimientos por período** | `Plan.monthlyLimit` (holgado) | `middleware/quota.ts` — ya existe y funciona |
| **Módulos incluidos** | `Plan.modulos String[]` | menú (frontend) **y** las rutas de cada módulo |

**La regla del conteo de usuarios** (la parte fina): cuenta solo los usuarios **propios** de esa
empresa —los que tienen ahí su empresa casa—, **no las membresías**. Si contara membresías, un despacho
con 3 contadores agotaría el cupo de cada cliente con su propio personal y el cliente no podría entrar a
sus libros. El personal del despacho no consume cupo de nadie; el cupo es para la gente del cliente.

## 4. Módulos incluidos por plan

Hoy Inventario y Planilla se prenden por **rol** y `facturas-pdf` por **add-on**. Pasan a decidirse por
**plan** (`Plan.modulos`), y eso se valida en dos lados —si solo se esconde el menú, la funcionalidad
sigue accesible por API—:

- El menú muestra Inventario/Planilla solo si el plan los incluye (y el rol alcanza).
- Las rutas de esos módulos responden 402 con el motivo cuando el plan no los incluye.

Los add-ons existentes (`facturas-pdf` en Empresa Demo) se respetan: el plan los incluye o la cuenta los
mantiene contratados.

## 5. Qué pasa cuando vence o no se paga

Decisión explícita, porque un plan de despacho cubre libros **de terceros**:

- **Leer y exportar nunca se corta.** La información es del cliente, no del despacho.
- Al vencer: se bloquea **escribir** (ya es el comportamiento: 402) y se avisa en el tablero.
- **Una empresa cliente no desaparece nunca** por un impago del despacho: se degrada, no se borra.

## 6. Propuesta comercial (a afinar por el dueño)

| Plan | Empresas | Usuarios por empresa | Módulos | Movimientos | Precio |
|---|---|---|---|---|---|
| Demo | 1 | 2 | básico | 50 | $0 |
| **Individual Básico** | 1 | 3 | básico | 500 | $9.99 |
| **Individual Premium** | 1 | 3 | + inventario + planilla | 1.000 | $19.99 |
| **Despacho 3** | 3 | 3 | básico | 1.000 | $19.99 |
| **Despacho 10** | 10 | 4 | + inventario + planilla | 2.000 | $39.99 |
| **Despacho 25** | 25 | 5 | + inventario + planilla | 4.000 | $79.99 |
| **Despacho 50+** | 50 | 5 | todo | ilimitado | $149.99 |

Tres ajustes sobre la propuesta original, con el porqué (**decididos por el dueño el 16-10**):

1. **Se agrega un escalón (11-25 a $79.99).** Con el salto original, pasar de 10 a 11 clientes costaba
   3,75 veces más: el despacho que llega a 11 se queda en 10 (o esconde dos clientes), que es
   exactamente lo contrario de lo que se quiere premiar.
2. **El Individual Básico baja a $9.99.** Es la **puerta de entrada del empresario chico** —una empresa,
   tres usuarios, sin inventario ni planilla— y con eso deja de competir con el Despacho 3 ($19.99 por
   tres empresas): el doble de precio por el triple de empresas se lee solo.
3. **Los módulos también se pueden contratar como add-on** en cualquier plan pagado (el mecanismo
   `Subscription.addons` ya existe y se usa). Sin esto, un despacho de 3 clientes que necesita inventario
   para uno tendría que saltar al plan de 10 ($39.99) — el doble— por un módulo. También es lo que
   resuelve el add-on `facturas-pdf` que ya está contratado en una empresa.

**Lo que el mismo precio compra distinto** (a propósito, no es un descuido): $19.99 son **una empresa
con inventario y planilla** (Individual Premium) o **tres empresas sin ellos** (Despacho 3). Cada perfil
elige lo suyo: el negocio que necesita stock, o el contador que lleva tres clientes.

## 7. Fases

| Fase | Contenido | Verificación |
|---|---|---|
| ~~**1**~~ ✅ | `Cuenta` + backfill + `Subscription.cuentaId` + cuota/plan resolviendo por la cuenta | Todo funciona igual que hoy: la cuota de cada empresa se lee y se consume como siempre |
| ~~**2**~~ ✅ | `maxEmpresas` y `maxUsuariosPorEmpresa` en el plan, validados; contadores en la UI | No se puede pasar del tope; el mensaje dice cuántos hay y qué hacer |
| ~~**3**~~ ✅ | `Plan.modulos` + gate en menú y API (inventario, planilla) | Un plan sin inventario no lo ve ni lo puede usar por API |
| ~~**4**~~ ✅ | Panel SaaS por cuenta (asignar plan, ver empresas y usuarios) + pantalla de precios nueva | El dueño puede dar de alta un despacho y ver qué tiene contratado |

### Fase 1 — lo que quedó hecho (16-10-2026)

Migración `0041_cuenta_facturacion`: tabla `cuenta`, `Company.cuentaId` (obligatorio) y
`Subscription.cuentaId` en lugar de `companyId`. El backfill crea **una cuenta por empresa** con el id
derivado (`cta_` + id de la empresa, para poder mover cada suscripción sin mapear por nombre) y se lleva
todas sus suscripciones —vigentes e históricas— a esa cuenta. Nada cambia de comportamiento hasta que
alguien sume una segunda empresa.

**`services/suscripcion.ts` es la única fuente** del salto «empresa → cuenta → suscripción»
(`suscripcionDeEmpresa`, `incrementarUsoDeEmpresa`, `empresasDeLaCuenta`). Todo lo que antes filtraba
`subscription` por `companyId` pasa por ahí: cuota, add-ons, rate limit, panel SaaS, WhatsApp, correo,
recurrentes, cierre de año. Si mañana la cuota se reparte de otra forma, se cambia en un solo lugar.

Decisiones que no estaban escritas y se tomaron al implementar:

1. **El consumo suma, no se reparte**: `movementsUsed` sigue siendo un solo contador, ahora de la cuenta.
   Dos empresas del mismo despacho descuentan del mismo cupo.
2. **Una empresa nueva desde la app se suma a la cuenta de quien la crea** (el despacho paga por su
   cliente). **Excepción: el superadmin**, que no es cliente de sí mismo — sus altas abren cuenta nueva
   con plan Demo, que es el comportamiento de siempre para el dueño de la plataforma.
3. **El plan Demo es de la cuenta y solo si esa cuenta no tiene NINGUNA suscripción** (ni vencida): si no,
   dar de alta un cliente sería la puerta para que una cuenta suspendida vuelva a tener cuota.
4. **Trampa 1 cerrada**: `Plan.reqPorSegundo` reemplaza la tabla por nombre (`Demo` 5, `Emprendedor` 10,
   `Pyme` 25, `Despacho` 50, default 5). El plan nuevo nace con 5 y se ajusta por BD o desde el panel.
5. **El panel SaaS sigue aceptando `companyId`** (resuelve la cuenta sola) y ahora muestra la cuenta con
   sus empresas; la fase 4 lo reescribe por cuenta.

### Fase 2 — lo que quedó hecho (16-10-2026)

Migración `0042_plan_limites`: `Plan.maxEmpresas` (default **1**) y `Plan.maxUsuariosPorEmpresa`
(default **3**), más los valores de la tabla comercial para los cuatro planes que existen hoy —Demo 1/2,
Emprendedor 1/3, Pyme 1/10, Despacho 50/5—. Los defaults son el **piso**, no «ilimitado»: un plan creado
a mano nace acotado. `topesDeLaCuenta()` (services/suscripcion.ts) devuelve el tope con lo usado, y de ahí
salen tanto la validación como los contadores de la UI (`/api/subscription` → `topes`).

- **Empresas**: `POST /api/companies` responde 402 `PLAN_LIMIT_EMPRESAS` con `{plan, usados, max}` y el
  mensaje dice cuántas hay y que hay que pasar a un plan con más. Mira las empresas de la **cuenta**.
- **Usuarios**: `POST /api/users` responde 402 `PLAN_LIMIT_USUARIOS`. Cuenta los **propios**
  (`User.companyId`), nunca las membresías. **`/api/users/vincular` no valida a propósito**: vincular no
  cambia la empresa casa de nadie, así que no suma cupo — es el camino del contador del despacho, justo el
  que el cupo no debe contar.
- Sin suscripción vigente las dos altas responden 402 `NO_SUBSCRIPTION` (coherente con §5: al vencer se
  bloquea escribir).
- Contadores: «N de M usuarios» en Administración → Usuarios (los de otra empresa se muestran aparte) y
  «N de M empresas» al lado de «+ Crear empresa» — al superadmin no se le muestra, porque da de alta
  clientes con cuenta propia y no tiene tope.
- **Queda pendiente y es visible**: el texto de `Plan.features` sigue siendo el viejo («Usuarios
  ilimitados» en Despacho, «1 usuario» en Demo), que ya no coincide con los topes. Eso se arregla en la
  fase 4, cuando se reescriban los planes y la pantalla de precios.

### Fase 3 — lo que quedó hecho (16-10-2026)

Migración `0043_plan_modulos`: `Plan.modulos String[]` (default `'{}'`), con los valores de §6 para los
planes que existen —Emprendedor sin módulos (básico), Pyme y Despacho con inventario y planilla, Despacho
además facturas— y **Demo con inventario y planilla aunque §6 lo llame «básico»**, porque las dos empresas
vivas usan la planilla y un cambio de planes no puede recortarle el trabajo a un cliente. Los planes
nuevos de la fase 4 traen los suyos.

**Un módulo se tiene por el plan O por un add-on contratado** (`Subscription.addons`): la cuenta puede
contratar un módulo suelto sin cambiar de plan, y el add-on `facturas-pdf` que ya existía sigue valiendo
igual. `modulosDeLaCuenta()` devuelve la unión.

- **API**: `middleware/modulo.ts` (antes `addon.ts`) monta `requireModulo` en los tres routers —
  `inventario`, `planilla` (incluido el registro de empleados) y `facturas`— y responde 402
  `MODULO_NO_INCLUIDO` con el plan y el módulo. Sin suscripción vigente, 402 `NO_SUBSCRIPTION`; vencida,
  `SUBSCRIPTION_EXPIRED`.
- **Menú**: `core.js` recibe `modulos` en `/api/subscription` y tapa los del plan; el rol sigue mandando
  por su lado (`init.js`), así que hacen falta las dos cosas. `facturas.js` mira la misma lista (antes
  miraba solo el add-on, y un plan que incluyera facturas no se habría visto).
- **Trampa 5 cerrada**: los roles exclusivos (`inventario`, `planilla`) se rechazan con
  `ROL_REQUIERE_MODULO` al crear el usuario, al vincularlo y al cambiarle el rol, si el plan no incluye su
  módulo — un usuario así quedaría encerrado en una pantalla que responde 402.
- Esconder el menú es cortesía; **la barrera es la API**, que es lo que pide §4.

### Fase 4 — lo que quedó hecho (16-10-2026)

Migración `0044_planes_nuevos`: la tabla de §6, con los tres planes viejos **desactivados**
(`isActive = false`: salen de la vitrina y del selector del panel, pero la fila sigue viva para las
suscripciones que los referencian). `monthlyLimit = 999999` es «ilimitado» en Despacho 50+ y la UI lo
dice así.

- **Panel por cuenta** (`GET /api/admin/cuentas`): una fila por cliente que paga, con sus empresas, los
  **usuarios propios** de cada una, la cuota, los módulos y el historial de suscripciones. Elige la
  vigente con **la misma regla que la app** —la de período más largo entre las que pueden operar—, así el
  panel no dice algo distinto de lo que ve el cliente; eso está en un test porque elegir mal la vigente
  hace decidir sobre datos falsos.
- Los topes superados se pintan en rojo con el nombre de la empresa que los pasó: es lo que hay que ir a
  resolver, no algo para esconder.
- **Asignar plan** elige la cuenta de una lista (antes había que pegar un `companyId` a mano) y expira la
  vigente de la cuenta entera. Los add-ons se prenden y apagan desde la misma fila.
- **Pantalla de precios** rearmada con los CAMPOS del plan —empresas, usuarios, movimientos, módulos— en
  vez del texto de `features`: lo que se publica es lo que la API valida. `features` queda solo para lo
  que no es un campo (soporte, API Keys). Módulos adicionales: Facturas PDF con su precio, e Inventario y
  Planilla con «consultar» — **el precio de esos dos como add-on sigue sin definirse** (decisión del
  dueño).
- **Pendiente de decisión del dueño**: Demo quedó con inventario y planilla (como estaba) porque las dos
  cuentas vivas los usan; bajarlo a «básico» —como dice §6— exige moverlas a un plan pago. Y con los topes
  nuevos (3-5 usuarios por empresa), Odesa —5 usuarios propios en una sola empresa— no entra en ningún
  plan individual: le toca Despacho 25/50+ o una excepción.

## 8. Trampas detectadas

1. ~~**`plan-rate-limit.ts` está cableado por NOMBRE de plan** (`Demo: 5, Emprendedor: 10, Pyme: 25,
   Despacho: 50`). Si los planes se renombran o se crean nuevos, el rate limit cae a 5 req/s **en
   silencio**. Hay que moverlo a un campo del plan (`reqPorSegundo`) antes de tocar los nombres.~~
   **CERRADA en la fase 1**: es `Plan.reqPorSegundo` (migración `0041`), y con eso los nombres de los
   planes ya se pueden tocar.
2. **La cuota es por período y fraccionaria** (la planilla semanal consume media cuota): al mudarla a la
   cuenta, el reinicio de período y el `movementsUsed` tienen que seguir por empresa… o pasar a la
   cuenta entera. Decisión: **la cuota es de la cuenta** (es la que paga), y el consumo se suma de todas
   sus empresas. **Aplicado en la fase 1**: un solo `movementsUsed` por cuenta, con el incremento
   resuelto por la empresa que hizo el movimiento.
3. **El panel SaaS** (`/api/admin`) y la pantalla de precios (`/api/plans`) leen la suscripción por
   empresa: hay que pasarlos por la cuenta, o quedan mostrando datos viejos. **El panel ya lee por
   cuenta** (fase 1); la pantalla de precios se rehace en la fase 4, cuando cambien los planes.
4. ~~**`userAddons` en el frontend** (`window.userAddons`, usado para mostrar Facturas PDF) sale de la
   suscripción: con la cuenta, sale de la cuenta.~~ **Resuelto**: `/api/subscription` resuelve por la
   cuenta, así que el add-on contratado por el despacho vale en todas sus empresas.
5. **Los roles exclusivos** (`inventario`, `planilla`) solo tienen sentido si el plan incluye el módulo:
   crear un usuario de planilla en un plan sin planilla tiene que rechazarse con ese motivo.
   **CERRADA en la fase 3**: se rechaza con `ROL_REQUIERE_MODULO` al crear, al vincular y al cambiar el rol.
