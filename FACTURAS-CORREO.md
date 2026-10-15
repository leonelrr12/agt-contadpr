# Facturas DGI por correo (IMAP) — diseño

**Estado: DISEÑADO el 14-10-2026, NO empezado.** No hay nada de esto en el schema ni en el código.
Este documento es el plan de implementación acordado con el dueño; el estado del roadmap vive en
[`Tuning.md`](Tuning.md) §4.3.

## 1. Qué resuelve

Hoy las facturas de proveedor entran a mano (chat/importación) o por WhatsApp (foto o link del CUTE, con
el flujo de reembolsos archivando la factura recibida en `expense_claim`). Falta la vía más común: **el
proveedor le manda la factura DGI por correo a la empresa**, y alguien tiene que reenviarla a mano.

La tarea lee el buzón que la empresa asigne, detecta las facturas DGI que mandan los proveedores (PDF o
XML adjunto, o link del CUTE en el cuerpo) y las carga. El correo y el flag de «proceso activo» se
configuran en Administración.

**Decisiones del dueño (14-10-2026), textuales donde importan:**

1. **Destino**: igual que WhatsApp → extrae, clasifica y crea el asiento **BORRADOR** (aparece en
   Revisión) + archiva la factura en «Facturas recibidas» con su XML y su URL del CUTE. El contador
   aprueba o rechaza.
2. **Contrapartida**: al contado, **nunca CxP**. *«Método de pago siempre es Efectivo, va directo contra
   banco o TC, que deben ser definidos en algún punto»*, precisado el 14-10-2026: **contra una cuenta de
   BANCO, no contra Caja** → la cuenta se elige en la configuración (ver §5).
3. **Conexión**: **los dos modos**. IMAP propio de la empresa con credenciales en Administración, y
   buzón central de la plataforma con dirección de reenvío por empresa.
4. **Frecuencia**: botón **«Revisar ahora»** + una corrida automática **diaria** de madrugada.
5. **Comercial**: **no es add-on** — cualquier empresa con rol admin la configura; el único interruptor es
   `isActive`.

## 2. Lo que se reutiliza (verificado en el repo)

| Pieza | Dónde | Para qué |
|---|---|---|
| `extractFromPDF(buffer, prisma?)` | `apps/api/src/services/pdf-extractor.ts:255` | Datos de la factura desde el PDF; agnóstico del transporte |
| `buildDedupeKey` · `buscarFacturaDuplicada` · `registrarFacturaRecibida` | `apps/api/src/services/reembolsos.ts:55,72,131` | Dedupe por RUC+número+fecha+total y archivo en `expense_claim` (`workerId: null` = factura de la empresa) |
| `OrchestratorAgent.process()` / `.confirm()` | `packages/agents/src/orchestrator-agent.ts:95,591` | Asiento BORRADOR + `Transaction`, sin chat |
| `paymentMethodForzado` | `orchestrator-agent.ts:80,183` | Imponer el método de pago antes de `generateEntry` (patrón ya probado con `'REEMBOLSO'`) |
| `resolveAlias` | `packages/agents/src/accounting-agent.ts:47` | **Devuelve el propio valor si es un id del catálogo de la empresa** → sirve para forzar una cuenta por id y, de paso, valida tenant |
| `aplicarBancoMencionado` | `orchestrator-agent.ts:255` | Banco nombrado → `Company.bancoDefaultId` → `1.1.02.01` (queda como está) |
| Descarga del CUTE | `whatsapp-service.ts:106`, **duplicado** en `routes/factura.ts:62` | Bajar el PDF y el XML cuando el correo trae el link |
| `runStartupTasks` / `startRecurringCron` | `apps/api/src/services/startup.ts:16,49` | Enganche de la corrida diaria |
| Config 1:1 con upsert perezoso | `PayrollSettings` + `services/payroll-parametros.ts:289` | Modelo de configuración |
| Cifrado AES-256-GCM (`FIELD_ENC_KEY`) | `services/crypto-fields.ts:12` | Contraseña IMAP cifrada en reposo |
| Tarjeta de settings | `index.html:523-565`, `js/admin.js:337`, `js/router.js:80-99` | UI de configuración |

**No existe hoy**: cliente IMAP, parser MIME, parser XML ni ninguna ingesta de correo (`mailer.ts` solo
envía, contra el servicio sibling con Gmail).

## 3. Flujo end-to-end

```
correo nuevo (IMAP propio · buzón central)
  → ledger email_factura_mensaje (unique companyId+messageId)   ← marca de procesado e idempotencia
  → detectar: PDF adjunto · XML adjunto · URL del CUTE en el cuerpo
  → dedupe (buildDedupeKey) + filtro por RUC del receptor
  → OrchestratorAgent.process() con extractedData completo (sin chat) → confirm()
      asiento BORRADOR + Transaction, contrapartida = cuenta de banco configurada
  → registrarFacturaRecibida(workerId: null, origen: 'CORREO', emailMensajeId)
  → movementsUsed += 1
  → el contador aprueba o rechaza en Revisión (ese flujo no cambia)
```

## 4. Modelo de datos — migración `0038_facturas_por_correo`

### `EmailFacturaConfig` (`@@map("email_factura_config")`, `companyId @unique`)

`isActive` (false) · `modo` (`'IMAP' | 'CENTRAL'`) · `imapHost` · `imapPort` (993) · `imapSecure` (true) ·
`imapUser` · `imapPassword` (**cifrado**, ver §11) · `imapFolder` (`INBOX`) · cursor `imapUidValidity` +
`imapLastUid` · `marcarLeido` (false) y `carpetaMover` (null) · `inboxAlias @unique` (modo CENTRAL) ·
**`cuentaPagoId`** (cuenta de BANCO de la contrapartida, §5) · `metodoPago` (`TRANSFERENCIA`) · `conceptoDefaultId` ·
`ultimaCorridaAt` · `ultimoEstado` · `ultimoDetalle`. Back-relation en `Company`.

Upsert perezoso (doctrina `PayrollSettings`): los defaults valen, las credenciales no se heredan.

### `EmailFacturaMensaje` (`@@map("email_factura_mensaje")`, ledger)

`companyId` · `origen` (`IMAP|CENTRAL`) · `folder` · `uidValidity` · `uid` · `messageId` · `remitente` ·
`asunto` · `recibidoAt` · `adjuntos` · `facturas` · `estado` · `detalle`, con
**`@@unique([companyId, messageId])`** + índices `(companyId, estado)` y `(companyId, createdAt)`.

Va **aparte** de `expense_claim` por tres razones: un correo puede traer **0, 1 o N facturas** (1:N);
hay que recordar los correos que **no** eran facturas para no re-escanear el buzón ni gastar LLM en cada
corrida; y el `Message-ID` único por empresa es la red de idempotencia que sobrevive a que cambie la
`UIDVALIDITY` del buzón o a que el proceso muera a mitad. `estado ∈ PROCESANDO · CARGADA · DUPLICADA ·
SIN_ADJUNTOS · SIN_FACTURA · SIN_DATOS · OTRO_CLIENTE · SIN_CUENTA · SIN_CONCEPTO · CUOTA · ERROR ·
INTERRUMPIDO`.

### `ExpenseClaim` (dos columnas nuevas)

`origen` (`'MANUAL'`, con backfill `UPDATE expense_claim SET origen = 'WHATSAPP'` — hoy su único escritor
es el flujo de WhatsApp) y `emailMensajeId?` FK `ON DELETE SET NULL` + índice (borrar historial de
correos no puede llevarse una factura archivada: misma doctrina que `workerId` en 0033).
`registrarFacturaRecibida` gana `origen?` y `emailMensajeId?`.

Migración **aditiva** con cabecera en español, estilo `0036`. Agregar las dos tablas nuevas a
`scripts/delete-company.sh` y `scripts/clean-test-data.sh` (borran tabla por tabla, sin cascada).

## 5. La contrapartida (el punto fino)

Forzar `paymentMethodForzado = 'EFECTIVO'` **no alcanza**: en `generateEntry` la rama EFECTIVO acredita
el alias literal `'caja'` (→ `1.1.01`, que en producción **está vacía**), y `aplicarBancoMencionado`
retorna temprano para EFECTIVO y TARJETA_CREDITO. Tampoco se puede inyectar un id por el texto: ese paso
escribe un **código**.

**Solución**: un campo opcional en el constructor del orquestador —

```ts
cuentaPagoForzada?: { id: string; name: string } | null
```

— aplicado en `process()` **después** de `aplicarBancoMencionado` y **antes** de resolver ids: busca la
línea de crédito con alias de pago (`caja` / `banco-general` / `tarjeta-credito` / `proveedores`) y la
reemplaza por esa cuenta. Se emite el **id**, que `resolveAlias` devuelve tal cual solo si pertenece al
catálogo de la empresa (`accounting-agent.ts:47`) → un id de otra empresa falla en vez de cruzar tenants.
Sin el campo, el paso es no-op: chat, web y WhatsApp no cambian.

El `paymentMethod` es **`TRANSFERENCIA`** (cuenta de banco), no `EFECTIVO`. El dueño dijo «efectivo» en el
sentido de **al contado, no CxP**; el literal debe seguir a la cuenta para que la conciliación bancaria y
el reporte de formas de pago no mientan — el asiento acredita el banco y la fila del extracto concilia
contra él con el matcher que ya existe.

El LLM queda neutralizado por tres capas, en orden: (1) `extractedData.paymentMethod` entra por contexto
y `DialogAgent` descarta el valor del modelo (`dialog-agent.ts:351`); (2) `paymentMethodForzado` se
aplica antes de `generateEntry`; (3) `cuentaPagoForzada` reemplaza la línea pase lo que pase.

**La cuenta es de BANCO** (decisión del dueño, 14-10-2026), no Caja:

- Candidatas y validación del `PUT /config`: cuentas **`1.1.02.*`** de la empresa, activas y no bloqueadas.
  **Caja (`1.1.01.*`) queda excluida** — ni como candidata ni como respaldo: en producción está vacía y
  acreditarla sería mentir el asiento.
- El valor inicial sugerido en la UI es `Company.bancoDefaultId` (`routes/config.ts`,
  `#config-banco-default`), que ya es una cuenta de banco por definición.
- El dueño mencionó también la tarjeta de crédito: admitir `2.1.03.*` es agregar el código a la lista de
  candidatas y elegir el método por tipo de cuenta (`EFECTIVO`/`TRANSFERENCIA`/`TARJETA_CREDITO`) — una
  línea, cuando lo pida.
- Si no hay cuenta configurada, el barrido devuelve `SIN_CUENTA` y **no crea asientos** (mejor no cargar
  que acreditar una cuenta equivocada).

**Consecuencia asumida**: sin `CREDITO` no se llama `autoCreateEntity`, así que **no se crea `Supplier`
ni `Bill`** — el proveedor y su RUC quedan en `expense_claim` y en `Transaction.metadata`, igual que en
WhatsApp. Si algún día se quiere el proveedor en el catálogo sin cuenta por pagar, es un
`asegurarProveedor()` de ~12 líneas (upsert por `taxIdHash`/nombre).

## 6. Dependencias

`imapflow` (cliente IMAP, promesas, `getMailboxLock`, UID nativo, timeouts) y `mailparser`
(`simpleParser` → texto + adjuntos con `Buffer` + cabeceras), ambas en `apps/api/package.json`. **JS
puro, sin binarios nativos** (a diferencia de `sharp`/`@napi-rs/canvas`). Descartados: `node-imap`
(callbacks, sin mantenimiento) y POP3 (sin UID ni carpetas).

**Sin librería de XML**: `services/dgi-xml.ts` pasa el XML a líneas `Etiqueta: valor` y lo manda por los
regex ya afinados de `pdf-extractor.ts`; es más barato de auditar que sumar `fast-xml-parser` y si falla
queda el PDF, que es el camino principal.

## 6.bis El servicio de mailer (ya existe — no hay que inventar infraestructura)

`/root/apps/mailerApi` corre como **contenedor Docker** (`mailer-api`, `127.0.0.1:3004`, healthcheck ok) con
nodemailer sobre **una cuenta Gmail** (`GMAIL_USER` / `GMAIL_PASS` en su `.env`, protegido por
`SERVICE_API_KEY`). La API lo usa con `services/mailer.ts` → `sendEmail(to, subject, text, html)`, que hoy
solo usan las rutas de auth.

Cómo se aprovecha:

- **Buzón central sin credenciales nuevas**: la misma cuenta Gmail se lee por IMAP
  (`imap.gmail.com:993`, SSL) con **la misma app password** que ya usa nodemailer. La API necesita esos dos
  valores en su propio entorno (`EMAIL_CENTRAL_IMAP_USER` / `EMAIL_CENTRAL_IMAP_PASS`, los mismos valores
  del mailer); el servicio mailer **no se toca** — sigue siendo solo de envío.
- **Dirección de reenvío por empresa con plus-addressing**: `usuario+<slug>@gmail.com` (Gmail entrega al
  mismo buzón ignorando el `+tag`), y el poller enruta por el encabezado `To`/`Delivered-To` con
  `empresaPorAlias()`. El slug vive en `email_factura_config.inboxAlias`.
- **Avisos**: si más adelante se quiere el resumen diario o el aviso de error por correo, la plomería ya
  está (`sendEmail`); el MVP no lo hace (§9).

## 7. Servicios

- **`services/dgi-cute.ts`** (nuevo, factoriza el fetch hoy duplicado):
  `descargarFacturaDgi(url): Promise<{ pdf, dgiUrl, dgiXml }>`, lanza `Error` con
  `.code ∈ DGI_DETERIORADO | DGI_NO_PDF | DGI_HTTP | DGI_TIMEOUT | DGI_QR_INVALIDO`. Cada llamador
  conserva su mensaje actual.
- **`services/pdf-extractor.ts`**: partir `extractFromPDF` en `extractFromText(rawText, prisma?)` +
  `extractFromPDF` (parse + llamada).
- **`services/company-user.ts`** (nuevo): `resolveCompanyUserId(prisma, companyId)` — el `createdById`
  obligatorio de los asientos; `whatsapp-service.ts` pasa a importarlo.
- **`services/email-facturas-config.ts`**: `CAMPOS_EMAIL_FACTURA` (única fuente de campos y etiquetas,
  doctrina `PLANILLA_FIELDS`), `getOrCreateEmailConfig`, `configPublica` (**nunca** devuelve
  `imapPassword`, devuelve `tienePassword`), `cuentaEsDeBanco`, `cuentaBancoDeEmpresa`.
- **`services/email-inbox.ts`**: `barrerFacturasPorCorreo(prisma, companyId, opts)` (**nunca lanza**: el
  error va al resumen, al ledger y a `ultimoEstado`), `probarConexion`, `procesarMensajeEntrante`
  (modo CENTRAL), `empresaPorAlias`.
  - **Lease anti-solapamiento por empresa** en un solo `updateMany` condicionado
    (`ultimoEstado != 'CORRIENDO'` o corrida de hace más de 10 min) → sirve incluso con dos instancias.
  - Cursor: `fetch(\`${desde}:*\`, { uid: true, source: true })` **filtrando `uid > imapLastUid`** (ver
    §11); si `uidValidity` cambió → cursor a 0 + ventana `SINCE` de 7 días.
  - Fila del ledger en `PROCESANDO` **antes** de bajar adjuntos; P2002 = correo ya visto.
  - Límites: 50 correos por corrida, 15 MB por mensaje, timeouts de socket (60 s) + `Promise.race`
    (180 s) por empresa.
  - Por defecto **no** se marca `\Seen` ni se mueve nada: el ledger ES la marca.
- **`services/email-factura-extract.ts`**: `extraerFacturasDeMensaje(prisma, msg)` →
  `{ via: 'PDF'|'XML'|'CUTE', factura, texto, items, clienteRuc, clienteNombre }`. PDF manda sobre XML
  (trae ítems); tope 5 facturas por correo; sin `total` y sin `proveedor` no es factura.
- **`services/email-factura-pipeline.ts`**: `cargarFacturaDesdeCorreo(prisma, cfg, det, correo)`:
  1. dedupe temprano → `DUPLICADA` sin gastar LLM;
  2. filtro de receptor (`clienteRuc` vs `Company.taxIdHash`, con fallback por dígitos del `taxId`;
     `hashField` devuelve `''` sin `FIELD_ENC_KEY` → hay que saltar la comparación) → `OTRO_CLIENTE`;
  3. cuenta de banco → si falta, `SIN_CUENTA`;
  4. contexto sintético como el de WhatsApp (`source` truthy ⇒ el motor trata `amount` como TOTAL con
     ITBMS) + `input = "compré en <proveedor> $<total> factura <numero>"`, con
     **`extractedData.selectedEntityId = null`** (ver §11), `concept` nunca vacío,
     `tipo` siempre `GASTO` (la compra de inventario exige cantidades y va por su módulo);
  5. `process()` → si `!needsConfirmation` **no se confirma nada** (`SIN_CONCEPTO`/`SIN_DATOS` con el
     `prompt` como detalle: nunca adivinar);
  6. `confirm()` → BORRADOR; `registrarFacturaRecibida(..., { workerId: null, tipo: 'GASTO',
     origen: 'CORREO', emailMensajeId })`;
  7. si esa llamada devuelve `duplicada` (carrera con otro canal) → **compensar**: borrar en una
     transacción el asiento recién creado y su `Transaction` (si no, queda un BORRADOR fantasma);
  8. `movementsUsed += 1` solo si se archivó (mismo criterio que WhatsApp).
- **`services/email-facturas-cron.ts`**: `startEmailFacturasCron(prisma)` con `setInterval` de 30 min
  (patrón `startRecurringCron`) que decide si corresponde correr (`hora local >= EMAIL_FACTURAS_HORA`,
  default 3, y `ultimaCorridaAt` no es de hoy ⇒ **catch-up**: si el VPS estaba caído a las 3, corre al
  volver). `Promise.allSettled` + try/catch por empresa (credenciales malas de una no afectan a las
  otras), timeout por empresa, cuota agotada ⇒ `CUOTA` **sin avanzar el cursor**, log
  `[EmailFacturas] empresa=… revisados=… cargadas=…`. Usar el **cliente Prisma extendido** o la
  contraseña IMAP no llega descifrada.

## 8. Rutas y UI

`routes/facturas-email.ts` montado tras `requireAuth` en `main.ts` (+ zod `updateEmailFacturaConfigSchema`):

| Ruta | Roles | Qué hace |
|---|---|---|
| `GET /config` | admin, superadmin | Config + `tienePassword` + cuentas de pago candidatas + conceptos + dirección de reenvío + estado de la última corrida |
| `PUT /config` | admin, superadmin | Guarda y valida (cuenta de banco, host/usuario si está activo); `imapPassword` ausente = sin cambios, `null` = borrar |
| `POST /probar` | admin, superadmin | «Probar conexión» (login + carpetas) |
| `POST /revisar` | admin, contador, superadmin | Barrido manual; responde 200 con el resumen aunque el estado sea de error |
| `GET /mensajes?estado=&limit=` | admin, contador, superadmin | Ledger (default 50, máx 200) |
| `POST /mensajes/:id/reprocesar` | admin, superadmin | Reintento explícito de `INTERRUMPIDO`/`ERROR` |
| `POST /inbox/generar` | admin, superadmin | Genera/rota el alias del modo CENTRAL |

UI vanilla (`js/email-facturas.js` nuevo, `?v=1`): tarjeta **«Facturas por correo»** dentro de
`#config-content` — activo, modo, credenciales IMAP (contraseña con placeholder «sin cambios»), la
dirección de reenvío con Copiar/Generar, **cuenta de contrapartida** (obligatoria si está activo, con el
método derivado a la vista), concepto por defecto, `marcarLeido`/`carpetaMover` con la ayuda de que el
sistema ya lleva su propio registro, y los botones **Probar conexión / Revisar ahora / Guardar** + línea
de estado. Segunda tarjeta con los últimos correos procesados. En `router.js`, la rama `config` llama
también a `loadPanelEmailFacturas()`.

En «Facturas recibidas» (`js/reembolsos.js`): píldora del canal leyendo `origen` + filtro por canal; en
Revisión, `entry-origin.ts` rotula «Factura recibida por correo». Subir `?v=` de `router.js` y
`reembolsos.js` al tocarlos.

## 9. Idempotencia, cuota y errores

- **Mismo correo**: unique `(companyId, messageId)` + cursor UID (dos redes independientes).
- **Misma factura con distinto Message-ID** (reenvío, o el proveedor que la manda dos veces): la detiene
  `buildDedupeKey` + el unique de `expense_claim`, ya probado en WhatsApp.
- **Muere a mitad**: fila `PROCESANDO` de más de 10 min → `INTERRUMPIDO`, visible y con «Reprocesar»
  manual; nunca auto-retry (el único hueco real de doble asiento está entre `confirm()` y
  `registrarFacturaRecibida()`, y también existe hoy en WhatsApp).
- **Cuota**: se consume 1 `movementsUsed` por factura cargada; con la cuota agotada no se descartan
  facturas, se corta la corrida sin avanzar el cursor.
- **Errores**: credenciales → `ERROR_CREDENCIALES` (la config no se desactiva sola); IMAP caído →
  `ERROR_CONEXION` y reintenta en el próximo tick; PDF ilegible → `SIN_DATOS` con las primeras 100 chars;
  sin `DEEPSEEK_API_KEY` **no es error** (cae a regex) pero se avisa en la tarjeta. Todo se ve en la
  tarjeta y en el log `[EmailFacturas]`; no se manda email de alerta (el correo es del propio cliente).

## 10. Fases (cada una verificable sola)

| Fase | Contenido | Verificación |
|---|---|---|
| **0** | Refactors sin cambio de comportamiento: `dgi-cute.ts`, `extractFromText`, `company-user.ts`, `ENCRYPTED_FIELDS += imapPassword`, `origen` en `registrarFacturaRecibida` | PDF real y URL del CUTE por WhatsApp y por `/api/factura/extract-url` dan lo mismo que antes; tests del API verdes |
| **1** | Schema + migración `0038` + scripts de borrado | `prisma validate`; `migrate diff --from-url <BD local>` sin diferencias; `migrate deploy` local; smoke de las dos tablas |
| **2** | Config, rutas GET/PUT/PROBAR, tarjeta UI | Guardar/leer sin perder la contraseña (`GET` nunca la devuelve); cuenta de otra empresa o bloqueada → 400; probar conexión ok y con credenciales malas |
| **3** | Barrido + ledger + detección, **sin crear asientos** | 3 correos de prueba (PDF DGI, XML, promoción): el ledger queda `SIN_FACTURA`/`SIN_ADJUNTOS`; `journalEntry.count` y `expenseClaim.count` NO cambian; el segundo `POST /revisar` no inserta filas |
| **4** | Pipeline headless + contrapartida + píldora de canal | Factura real: BORRADOR en Revisión acreditando la **cuenta de banco configurada**, fila en «Facturas recibidas», `movementsUsed +1`; repetir → `DUPLICADA` sin asiento nuevo; otro RUC → no carga |
| **5** | Cron, aislamiento, timeouts, reproceso | Una empresa con host inválido no afecta a la otra; dos «Revisar ahora» simultáneos → uno responde `YA_CORRIENDO`; matar el proceso → `INTERRUMPIDO` + Reprocesar |
| **6** | Buzón central: alias + `procesarMensajeEntrante` + poller propio | Reenviar a `alias@dominio` carga la empresa correcta; dirección desconocida se ignora; rotar el alias invalida el viejo |

Tests unitarios nuevos (puros, con fixtures): `email-factura-extract.test.ts` (un `.eml` y un XML real
sacado de `SELECT "dgiXml" FROM expense_claim LIMIT 1`), `dgi-xml.test.ts`,
`email-facturas-config.test.ts` (`cuentaEsDeBanco`).

## 11. Trampas verificadas

1. `client.fetch('N:*')` con `N` mayor que el último UID **devuelve el último mensaje** (quirk IMAP):
   filtrar siempre `uid > imapLastUid`.
2. `paymentMethodForzado` se aplica **después** de la guarda de `entityMatches`
   (`orchestrator-agent.ts:161` vs `:183`): sin `extractedData.selectedEntityId = null` el flujo headless
   se queda esperando un selector que nadie puede responder.
3. `ENCRYPTED_FIELDS` es **por nombre de campo y global**: un campo nuevo llamado `email`, `phone`,
   `taxId` o `reference` se cifra solo y deja de ser consultable → el alias del buzón se llama
   `inboxAlias`; y `imapPassword` hay que **agregarlo** a la lista o queda en claro.
4. `hashField` devuelve `''` sin `FIELD_ENC_KEY`: nunca comparar contra un hash vacío (matchearían todas
   las empresas).
5. `expense_claim.dgiXml` se guarda crudo y hoy nadie lo parsea; el CUFE no se lee en ninguna parte.
6. `GET /api/reembolsos/facturas` devuelve hoy el `dgiXml` completo de hasta 1000 filas: conviene
   recortar el `select` en la fase 4 (el canal correo multiplica el peso de esa respuesta).
7. `pm2 restart` **no** recarga `.env` (ver `AGENTS.md`): las variables nuevas exigen `pm2 delete` +
   `start` + `pm2 save`; y borrar `/tmp/tsx-0` antes de reiniciar tras cambios en `apps/api`.

## 12. Despliegue

Migración y variables nuevas a producción **solo con autorización explícita del dueño nombrando el
destino**. `prisma migrate deploy` desde `packages/prisma-schema` con el `.env` de la raíz. Variables:
`EMAIL_FACTURAS_HORA`, `EMAIL_FACTURAS_INTERVALO_MIN`, `EMAIL_INBOUND_DOMAIN` y `EMAIL_CENTRAL_IMAP_*`
(solo si se activa el buzón central). Gate final: skill `apps/api:verify`.

## Fuera de alcance (decisiones explícitas)

Guardar el PDF original (no hay almacén de binarios; se sigue guardando el XML + la URL, como WhatsApp),
crear `Supplier`/`Bill` desde el correo, avisos por email al cliente ante errores, y el add-on comercial.
