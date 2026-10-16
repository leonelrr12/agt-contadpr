# Multi-Empresa para Despachos — diseño

**Estado: FASES 1a, 1b y 2 COMPLETAS Y DESPLEGADAS el 16-10-2026** (commits `cf2e3ba` y el del tablero).
La fase 3 (resumen comparativo) queda sin empezar, como estaba previsto: se hace cuando haya con qué.
Lo que se aprendió al implementarlo está en la memoria del proyecto; el diseño se deja como está.

## 1. Qué resuelve

Hoy **un usuario pertenece a UNA empresa**: `User.companyId` es una sola FK y `User.email` es único
global. Para trabajar la contabilidad de otra empresa hay que cerrar sesión y entrar con el usuario de
esa otra empresa. Y `/api/admin` (superadmin) es el panel del dueño de la plataforma —suscripciones,
pagos, planes—, no una herramienta para trabajar.

El comprador natural de un producto llamado *contador* es un despacho: alguien que lleva los libros de
varias empresas. Lo que necesita es: **entrar una vez y cambiar de empresa sin volver a loguearse**, ver
**de un vistazo qué está pendiente en cada una**, y —más adelante— comparar.

## 2. Las tres fases

| Fase | Contenido | Para quién |
|---|---|---|
| **1a** | Selector de empresa para el **superadmin** (acceso implícito a todas) | El dueño, hoy |
| **1b** | **Membresías**: un usuario en N empresas, con un rol POR empresa | El despacho real |
| **2** | **Tablero de pendientes** de todas las empresas en una pantalla | El diferenciador |
| **3** | Resumen comparativo entre empresas (ventas, gastos, resultado) | Cuando haya con qué |

## 3. Fase 1a — el selector (chico y sin tocar el modelo de datos)

- `GET /api/auth/me` devuelve `empresas[]` (para el superadmin: todas; si no, la propia).
- `POST /api/auth/switch-company { companyId }` → valida que el usuario tenga acceso y **devuelve un
  token nuevo con esa empresa**. El superadmin tiene acceso a todas por definición (ya ve todas por
  `/api/admin`).
- **Nada más cambia**: el token sigue llevando UNA empresa en `companyId`, así que las ~40 rutas que
  dependen de `req.user.companyId` siguen funcionando sin tocarse. El cambio es de dónde sale ese
  valor, no cómo se usa.
- UI: donde hoy el sidebar muestra el nombre de la empresa (`sidebar-user-company`), pasa a ser un
  desplegable cuando hay más de una. Al cambiar, se reemplaza el token y se recarga la vista.

## 4. Fase 1b — membresías (el modelo del despacho)

Tabla nueva `UserCompany` (`@@map("user_company")`): `userId` · `companyId` · `role` · `createdAt`, con
**`@@unique(userId, companyId)`**. Backfill: una fila por cada usuario existente con su empresa y su rol
actuales.

- **El rol pasa a ser por empresa**: el contador del despacho es `contador` en los libros del cliente y
  `admin` en los propios. Es lo que impide que un despacho sea admin de los libros que solo debe revisar.
- `User.companyId` queda como la empresa **por defecto** (la última usada), no como la única.
- Migración aditiva + backfill. `requireAuth` no cambia: el rol del token sale de la membresía de esa
  empresa.
- Cómo se suma un usuario a otra empresa: desde **Administración → Usuarios**, un admin puede vincular
  **por correo** a un usuario que ya existe (misma cuenta, otra empresa) — con el rol que le asigne. Y
  el superadmin puede hacerlo desde su panel. Vincular a alguien a una empresa es darle acceso a sus
  libros: queda en `AuditLog`.

## 5. Fase 2 — el tablero de pendientes

Una pantalla que, para cada empresa del usuario, muestra lo que pide atención **hoy**:

- Asientos **BORRADOR** esperando revisión (ya existe `GET /journal/pendientes`, por empresa).
- El **buzón de facturas** con problemas (los mismos estados que avisan por correo).
- **Cierres** pendientes y el mes sin cerrar.
- Facturas de venta **por cobrar vencidas** (cuando exista §"avisos de vencidos").

Cada fila lleva a la empresa y a la pantalla que corresponde (un clic: cambia de empresa y abre el
panel). Costo: un endpoint que recorra las empresas del usuario —con las consultas que ya existen,
reutilizadas— y una pantalla en el frontend.

## 6. Fase 3 — resumen comparativo

Ventas, gastos y resultado del mes por empresa, en una tabla. **No** un balance consolidado: sumar
libros de empresas distintas que no comparten patrimonio es una decisión contable que nadie pidió, y
hacerlo mal es peor que no hacerlo. Si algún día se quiere consolidar de verdad, es otro diseño.

## 7. Trampas a tener presentes

1. **El email es único global**: la misma persona en dos empresas es UNA cuenta con dos membresías,
   nunca dos usuarios con el mismo correo.
2. **El rol deja de ser un atributo del usuario** y pasa a serlo de la membresía: cualquier código que
   lea `User.role` para autorizar hay que revisarlo (`requireRole`, `limitarRolesExclusivos`, y el
   filtro de pestañas del frontend).
3. **`createdById` de los asientos** sale de un usuario real: sigue siendo el usuario de la sesión, con
   la empresa activa en ese momento (`resolveCompanyUserId` ya resuelve por empresa).
4. **La cuota es por empresa** (una `Subscription` cada una): cambiar de empresa cambia el plan vigente.
   El frontend ya la recarga en `loadSubscriptionInfo()`.
