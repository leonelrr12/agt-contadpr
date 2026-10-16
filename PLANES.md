# Planes y cuentas (despacho) — diseño

**Estado: PROPUESTA del 16-10-2026, sin empezar.** Las dos decisiones de fondo ya están tomadas por el
dueño: **el despacho es una entidad aparte con su propia suscripción** (no una empresa que cubre a
otras) y **el tope de movimientos se mantiene, holgado**, como red anti-abuso.

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
| **Usuarios por empresa** | `Plan.maxUsuariosPorEmpresa` | `POST /api/users` y `POST /api/users/vincular` |
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
| **Individual Básico** | 1 | 3 | básico | 500 | $12.99 |
| **Individual Premium** | 1 | 3 | + inventario + planilla | 1.000 | $19.99 |
| **Despacho 3** | 3 | 3 | básico | 1.000 | $19.99 |
| **Despacho 10** | 10 | 4 | + inventario + planilla | 2.000 | $39.99 |
| **Despacho 25** | 25 | 5 | + inventario + planilla | 4.000 | $79.99 |
| **Despacho 50+** | 50 | 5 | todo | ilimitado | $149.99 |

Dos ajustes sobre la propuesta original, con el porqué:

1. **Se agrega un escalón (11-25 a $79.99).** Con el salto original, pasar de 10 a 11 clientes costaba
   3,75 veces más: el despacho que llega a 11 se queda en 10 (o esconde dos clientes), que es
   exactamente lo contrario de lo que se quiere premiar.
2. **El plan de despacho de 3 ($19.99) y el Individual Básico ($12.99) quedan cerca.** Está bien que el
   de despacho sea mejor negocio, pero conviene que el individual tenga algo propio (hoy no lo tiene):
   el individual es **una** empresa con sus 3 usuarios, y el de despacho exige ser varios clientes. Si no
   alcanza, la alternativa es subir el de 3 empresas a $24.99.

## 7. Fases

| Fase | Contenido | Verificación |
|---|---|---|
| **1** | `Cuenta` + backfill + `Subscription.cuentaId` + cuota/plan resolviendo por la cuenta | Todo funciona igual que hoy: la cuota de cada empresa se lee y se consume como siempre |
| **2** | `maxEmpresas` y `maxUsuariosPorEmpresa` en el plan, validados; contadores en la UI | No se puede pasar del tope; el mensaje dice cuántos hay y qué hacer |
| **3** | `Plan.modulos` + gate en menú y API (inventario, planilla) | Un plan sin inventario no lo ve ni lo puede usar por API |
| **4** | Panel SaaS por cuenta (asignar plan, ver empresas y usuarios) + pantalla de precios nueva | El dueño puede dar de alta un despacho y ver qué tiene contratado |

## 8. Trampas detectadas

1. **`plan-rate-limit.ts` está cableado por NOMBRE de plan** (`Demo: 5, Emprendedor: 10, Pyme: 25,
   Despacho: 50`). Si los planes se renombran o se crean nuevos, el rate limit cae a 5 req/s **en
   silencio**. Hay que moverlo a un campo del plan (`reqPorSegundo`) antes de tocar los nombres.
2. **La cuota es por período y fraccionaria** (la planilla semanal consume media cuota): al mudarla a la
   cuenta, el reinicio de período y el `movementsUsed` tienen que seguir por empresa… o pasar a la
   cuenta entera. Decisión: **la cuota es de la cuenta** (es la que paga), y el consumo se suma de todas
   sus empresas.
3. **El panel SaaS** (`/api/admin`) y la pantalla de precios (`/api/plans`) leen la suscripción por
   empresa: hay que pasarlos por la cuenta, o quedan mostrando datos viejos.
4. **`userAddons` en el frontend** (`window.userAddons`, usado para mostrar Facturas PDF) sale de la
   suscripción: con la cuenta, sale de la cuenta.
5. **Los roles exclusivos** (`inventario`, `planilla`) solo tienen sentido si el plan incluye el módulo:
   crear un usuario de planilla en un plan sin planilla tiene que rechazarse con ese motivo.
