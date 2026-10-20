# Facturación electrónica vía PAC (Factura Fácil)

**Estado al 20-10-2026:** integración, configuración por empresa, UI y emisión cableada a `POST /api/facturas`, todo en código. **Sin emitir todavía**: faltan las credenciales del ambiente de pruebas del proveedor y la autorización para aplicar las migraciones `0047_pac_config` y `0048_factura_pac`. Hoy la app solo genera el PDF local (`apps/api/src/services/factura-pdf.ts`); no hay XML, firma, CUFE ni envío a la DGI. **Difusión:** `apps/web/public/funciones.html` y `PUBLICIDAD.md` ya presentan el servicio con la condición «PAC configurado».

Documento de retomada. La spec del proveedor está en `docs/facturafacil.openapi.json` (Swagger 2.0 del QA).

---

## 1. Arquitectura

La app no habla con el proveedor: habla con `PacProvider`. Cada PAC implementa esa interfaz y traduce a su payload. Sumar otro proveedor es agregar un archivo en `apps/api/src/services/pac/` y un `case` en la factory; no se tocan facturas, asientos ni la UI.

```
POST /api/facturas (fase siguiente)
  └─ Invoice + asiento BORRADOR (BD, transacción local)
  └─ getPacProviderForCompany(prisma, companyId)
       └─ createPacProvider(PacProviderConfig)
            └─ FacturaFacilProvider
                 └─ POST /api/pac/reception_fe/detailed/
  └─ guarda CUFE/UUID/estado/XML en Invoice
```

| Archivo | Rol |
|---|---|
| `apps/api/src/services/pac/types.ts` | Contrato neutral: `PacProvider`, `PacInvoiceRequest`, `PacInvoiceResult`, `PacError` |
| `apps/api/src/services/pac/facturafacil.ts` | Adaptador: auth, códigos, montos, validaciones previas al 400 |
| `apps/api/src/services/pac/company-config.ts` | Configuración por empresa, cifrado, prueba de credenciales |
| `apps/api/src/services/pac/emit-invoice.ts` | Factura local → request neutral, emisión, estados y reintento |
| `apps/api/src/services/pac/config.ts` | Config desde `PAC_*` (solo scripts/ops) |
| `apps/api/src/services/pac/index.ts` | Factory `createPacProvider()` |
| `apps/api/src/routes/pac.ts` | `GET/PUT /api/pac/config`, `POST /api/pac/config/test` |
| `scripts/pac-smoke.ts` | Smoke contra QA: emite, consulta por CUFE y descarga XML/CAFE |
| `apps/api/src/services/__tests__/pac-*.test.ts` | 29 tests de mapeo y configuración |

---

## 2. Proveedor: Factura Fácil

- **QA:** `https://backend-qa-api.facturafacil.com.pa`
- **Producción:** `https://api.facturafacil.com.pa` (no usar hasta que el dueño lo autorice)
- **Auth por request:** HTTP Basic + `X-FF-Company` (UUID del emisor) + `X-FF-API-Key`; `X-FF-Branch` (UUID de sucursal) opcional.
- **Emisión:** `POST /api/pac/reception_fe/detailed/` con `{ header, document }`.
- **Consulta/idempotencia:** `GET /api/pac/reception_fe/find_by_cufe_or_id/?cufe_or_id=...` (UUID v4 o CUFE de 66 caracteres que empieza con `FE`).
- **Archivos:** `GET /api/pac/reception_fe/{id}/download_xml/?cufe=...` y `.../download_cafe/?cufe=...`.
- **Eventos:** `POST /api/pac/event/issue/` (anulación `AN`, modificación `MF`).
- **Ambiente:** `header.environment = "2"` en QA, `"1"` en producción.
- **Numeración:** `document.fd_number` es entero 0..9.999.999.999; `0` usa la secuencia interna del PAC. Sin reinicio de secuencia.
- **POS:** 3 dígitos. **Sucursal:** `branch.code` de 4 caracteres o `X-FF-Branch` (UUID).
- **Receptor contribuyente/gobierno:** RUC + DV + dirección + ubicación `PP-DD-CC`. Gobierno exige `items[].gns` (CPBS).
- **Notas de crédito/débito:** exigen `document.referred { fd_number | cufe, fd_date }`.

El mapeo completo está en `facturafacil.ts` y cubierto por `pac-facturafacil.test.ts`.

---

## 3. Configuración por empresa (Contador507)

### 3.1 Modelo `PacConfig` (una fila por empresa)

`packages/prisma-schema/prisma/schema.prisma`:

| Campo | Tipo | Uso |
|---|---|---|
| `provider` | String | `FACTURA_FACIL` (id del adaptador) |
| `environment` | String | `PRUEBAS` \| `PRODUCCION` |
| `companyUuid` | String? | UUID del emisor (`X-FF-Company`) |
| `pacApiKey` | String? | API key (`X-FF-API-Key`), **cifrada en reposo** |
| `basicUser` / `pacBasicPassword` | String? | HTTP Basic; la contraseña **cifrada en reposo** |
| `branchUuid` | String? | UUID de sucursal (`X-FF-Branch`) |
| `branchCode` | String? | Código de sucursal de 4 caracteres (cuerpo) |
| `pos` | String | Punto de venta, 3 dígitos (default `001`) |
| `enabled` | Boolean | Interruptor de emisión |
| `lastTestAt` / `lastTestOk` / `lastTestError` | | Resultado de la última prueba de conexión |

Decisiones:

- **Una sola configuración activa por empresa.** Cambiar de proveedor actualiza la fila; dos PAC emitiendo por el mismo RUC producirían dos secuencias fiscales.
- **`companyUuid` y `pacApiKey` son nullable**: la ficha se puede crear antes de que el proveedor entregue los accesos. `enabled` exige UUID + API key + sucursal.
- **Secretos cifrados** con AES-256-GCM (`services/crypto-fields.ts`): `pacApiKey` y `pacBasicPassword` se agregaron a `ENCRYPTED_FIELDS`. La API **nunca** los devuelve; solo `apiKeySet` / `basicPasswordSet`.
- **Un campo secreto vacío conserva lo guardado.** Para borrar hay que enviar `clearApiKey: true` / `clearBasicPassword: true` (y deshabilitar la emisión si estaba encendida).
- **Roles:** solo `admin` y `superadmin`; `contador` no ve credenciales fiscales del cliente.
- **Módulo:** las rutas exigen `facturas-pdf` (`requireModulo`), igual que la emisión.

### 3.2 API

```
GET  /api/pac/config        → ficha segura
PUT  /api/pac/config        → crea/actualiza (JSON)
POST /api/pac/config/test   → prueba credenciales sin emitir
```

`GET` devuelve:

```json
{
  "configured": true,
  "provider": "FACTURA_FACIL",
  "environment": "PRUEBAS",
  "companyUuid": "11111111-1111-4111-8111-111111111111",
  "pos": "001",
  "branchUuid": "22222222-2222-4222-8222-222222222222",
  "branchCode": "",
  "basicUser": "",
  "enabled": true,
  "apiKeySet": true,
  "basicPasswordSet": false,
  "lastTestAt": "2026-10-20T18:00:00.000Z",
  "lastTestOk": true,
  "lastTestError": null
}
```

`PUT` acepta los mismos campos más los secretos en claro (solo en el request) y los flags de borrado. `POST /config/test` hace una consulta por un CUFE inexistente con formato válido: un `404` prueba que la autenticación y la compañía son correctas; `401/403` o error de red se reportan como fallo. **No emite nada.**

### 3.3 Migración

`packages/prisma-schema/prisma/migrations/0047_pac_config/migration.sql` y `0048_factura_pac/migration.sql` están creadas **pero NO aplicadas**.

Orden de despliegue (cuando el dueño autorice el destino):

1. Backup de la BD.
2. `npx prisma migrate deploy` (nunca `migrate dev`: resetea) — aplica 0047 y 0048 en orden.
3. `npx prisma generate` si no se generó antes.
4. `pm2 restart agt-contador-api` y `pm2 save` (env congelado).

Si se reinicia la API **antes** de aplicar las migraciones, no solo falla `/api/pac/*`: la lista y la creación de facturas también fallan, porque el cliente Prisma nuevo referencia columnas (`pacStatus`, `itbmsRate`, `pacXml`, etc.) que todavía no existen. Aplicá primero y reiniciá después.

### 3.4 UI (implementada 20-10-2026)

En **Administración → 🏢 Empresa**, tarjeta **🧾 Emisión electrónica (PAC)** debajo de la sección DGI:

- Proveedor, ambiente (Pruebas/Producción), UUID del emisor, API key write-only, usuario/contraseña Basic, UUID o código de sucursal, POS y switch de emisión.
- Botón **Guardar PAC** (`PUT /api/pac/config`), separado del **💾 Guardar** del perfil, que no incluye esta sección.
- Botón **Probar conexión** (`POST /api/pac/config/test`): usa la configuración ya guardada, no los cambios sin guardar.
- Los secretos nunca se precargan: el placeholder dice «guardada» y un campo vacío conserva el valor. Borrar el usuario Basic elimina también su contraseña.
- Al pasar a **PRODUCCIÓN** pide confirmación explícita.
- Si `GET /api/pac/config` falla (por ejemplo, migración pendiente), la tarjeta muestra el aviso y el resto de la ficha sigue funcionando.

Archivos: `apps/web/public/js/empresa.js` (render, guardado y prueba), `apps/web/public/styles.css` (v47) e `index.html` (cache-bust `empresa.js?v=8`). La UI se sirve al instante porque nginx lee `public/`, pero la API necesita reiniciarse para exponer `/api/pac/*` y la migración `0047` aplicada para que exista la tabla.

---

## 4. Smoke script

Configuración por `.env` (raíz o `apps/api/.env`; ver `.env.example`):

```
PAC_PROVIDER=FACTURA_FACIL
PAC_ENVIRONMENT=PRUEBAS
PAC_BASE_URL=https://backend-qa-api.facturafacil.com.pa
PAC_COMPANY_UUID=...
PAC_API_KEY=...
PAC_BASIC_USER=...
PAC_BASIC_PASSWORD=...
PAC_BRANCH_UUID=...
PAC_BRANCH_CODE=...
PAC_POS=001
PAC_TIMEOUT_MS=20000
```

Comandos, desde la raíz:

```bash
npx tsx scripts/pac-smoke.ts --dry-run   # muestra el payload, NO envía
npx tsx scripts/pac-smoke.ts             # emite en QA y verifica por CUFE
npx tsx scripts/pac-smoke.ts --download  # además baja XML y CAFE
npx tsx scripts/pac-smoke.ts --fiscal-number=123
npx tsx scripts/pac-smoke.ts --allow-prod # solo si el dueño autoriza producción
```

Salidas: `0` autorizado y verificado · `1` configuración o rechazo de la DGI · `2` red/HTTP/inesperado. El script se niega a correr en `PRUEBAS` contra el host de producción y exige `--allow-prod` para `PRODUCCION`.

---

## 5. Plan de pruebas

Hecho:

- 49 tests de PAC/facturación: mapeo de códigos/fechas/montos, receptor contribuyente (DV/dirección/ubicación), cuotas a crédito, configuración por empresa, secretos, prueba de conexión, tarjeta UI y transiciones de estado (autorizada, rechazada, error, reintento idempotente).

Pendiente, en orden:

1. **Credenciales QA** del proveedor (ver `docs/SOLICITUD-ACCESO-PAC.md`).
2. **Probar sin emitir:** `POST /api/pac/config/test` o `pac-smoke --dry-run`.
3. **Smoke QA:** emitir $10 + ITBMS 7% a consumidor final; verificar CUFE; descargar XML/CAFE.
4. **Casos negativos:** contribuyente sin DV, ubicación inválida, Gobierno sin GNS, pago `OTRO` con descripción corta, nota sin referencia, `controlId` duplicado.
5. **E2E con BD:** factura + asiento + emisión real; rechazo no debe romper el asiento; reintento idempotente. Requiere migraciones aplicadas y credenciales.
6. **Producción:** solo con autorización explícita del dueño y después de QA.

---

## 6. Integración con `POST /api/facturas` (implementada 20-10-2026)

La emisión corre **después** del commit local:

1. Se crea `Invoice` + asiento BORRADOR + `Transaction` + kardex como siempre, en una transacción local.
2. `emitInvoiceWithPac()` (`services/pac/emit-invoice.ts`) carga la factura con cliente e ítems, resuelve el PAC de la empresa y arma el request neutral.
3. Marca `pacStatus=PENDIENTE`, llama `issue()` y guarda el resultado.
4. Un rechazo o error **no revierte** la factura ni el asiento: quedan `RECHAZADA`, `ERROR` o `NO_CONFIGURADO`, y se reintentan.
5. La respuesta de `POST /api/facturas` agrega `facturaElectronica` con `status`, mensaje, CUFE, número de documento, autorización, PDF y mensajes.

Campos fiscales en `Invoice`: `itbmsRate`, `pacStatus`, `pacProvider`, `pacEnvironment`, `pacControlId`, `pacAttempts`, `cufe`, `pacDocumentUuid`, `pacDocumentNumber`, `pacAuthorizationNumber`, `pacPdfUrl`, `pacQrData`, `pacXml`, `pacMessages`, `pacAuthorizedAt`, `pacLastError`.

- **Reintento:** `POST /api/facturas/:id/emitir`. Si ya está `AUTORIZADA` devuelve el documento guardado sin llamar al PAC.
- **Idempotencia:** `controlId = invoice.id`. Tras un `RECHAZADA` se usa `invoice.id-r<attempt>` (el anterior no fue autorizado y reenviar el mismo id podría devolver el rechazo cacheado). Tras un `ERROR` de red se conserva `invoice.id` para no duplicar.
- **XML:** `GET /api/facturas/:id/xml` sirve el XML guardado; no viaja en las listas por tamaño.
- **UI:** la lista de facturas tiene columna **Electrónica** (chip de estado + CUFE), botón **Emitir/Reintentar** y **XML** para autorizadas. El modal de emisión informa el resultado del PAC.
- **Receptor contribuyente:** `Client` ahora tiene `dv` y `location`; se completan en Auxiliares → ficha del cliente, junto con la dirección. El DV también se separa del RUC si viene pegado (`8-733-2267-88`).
- **Factura a crédito:** se envía `payment_term=CREDITO` con una cuota por el total a la fecha de vencimiento.

Limitaciones actuales: receptores Gobierno y extranjeros no están soportados (faltan GNS/país); notas de crédito/débito y contingencia son fase 2; `fd_number=0` queda pendiente de confirmar con el proveedor.

---

## 7. Preguntas abiertas para Factura Fácil

1. ¿La API key es por empresa emisora o hay una clave maestra de integrador? ¿Cómo se dan de alta empresas nuevas?
2. ¿HTTP Basic es obligatorio además del API key? ¿Es por empresa?
3. ¿La sucursal se crea por API (`header.branch`) o en el portal? ¿Cómo se obtiene su UUID?
4. ¿El POS lo asigna el proveedor o lo elige el emisor?
5. Para un SaaS multiempresa: ¿recomiendan `fd_number = 0` o enviar el correlativo local? ¿Cómo evitar que la secuencia local y la del PAC diverjan?
6. ¿Cómo se reinicia una secuencia en QA?
7. Política de duplicados: ¿`header.id` es idempotente? ¿Devuelven `201 duplicated` o `409`?
8. Límites de tasa, timeout y allowlist de IP.
9. ¿El `201` siempre trae CUFE, o hay que consultar el estado después? ¿Qué estados llegan asincrónicamente?
10. Descargas XML/CAFE: ¿misma autenticación? ¿`send_email` manda correos reales en QA?
11. ¿Los eventos de anulación/contingencia funcionan en QA?
12. Datos de prueba: RUCs de prueba, catálogo de ubicaciones `PP-DD-CC`, CPBS/GNS y unidades de medida.
13. Firma/certificado: ¿lo maneja el PAC? ¿Necesitan algún registro nuestro como proveedor de software ante la DGI?
14. Canal de soporte y SLA de onboarding.

---

## 8. Checklist para retomar

- [ ] Recibir credenciales QA (UUID emisor, API key, Basic, sucursal, POS).
- [ ] Cargar `PAC_*` en `.env` y correr `--dry-run`.
- [ ] Correr el smoke real y adjuntar CUFE/XML al proveedor si lo piden.
- [x] UI de configuración en **Empresa** (hecha; requiere API reiniciada y migración aplicada para guardar).
- [x] Emisión cableada a `POST /api/facturas` + `POST /:id/emitir` + `GET /:id/xml` (hecha; no live hasta aplicar 0047/0048 y reiniciar).
- [x] Página comercial (`funciones.html`) y documento de campañas (`PUBLICIDAD.md`) actualizados.
- [ ] Autorizar y aplicar las migraciones `0047` y `0048` + `pm2 restart` + `pm2 save`.
- [ ] Configurar la empresa desde la UI y completar DV/ubicación de los clientes contribuyentes.
- [ ] E2E en QA y luego producción con autorización.
