# Solicitud de acceso e integración — Factura Fácil (ambiente de pruebas)

> Documento para enviar al proveedor. Reemplazar todo lo que está entre `[...]` antes de enviarlo. La versión para compartir está publicada como artifact.

---

## Carta de solicitud

**[Ciudad], [fecha]**

**Para:** Equipo comercial / técnico de Factura Fácil
**Asunto:** Solicitud de acceso al ambiente de pruebas y credenciales de integración para Contador507

Estimados señores:

Contador507 es una plataforma de contabilidad en la nube para empresas panameñas: registra movimientos, emite facturas, lleva libros y prepara declaraciones. Nuestros clientes son contribuyentes que necesitan emitir comprobantes fiscales electrónicos, y queremos hacerlo a través de un PAC autorizado en lugar de manejar firma y transmisión propias.

Solicitamos el alta como integrador y el acceso al **ambiente de pruebas** de Factura Fácil para:

1. Validar el flujo de emisión de facturas electrónicas, notas de crédito y notas de débito.
2. Confirmar el esquema de autenticación y los datos de emisor/sucursal que debemos administrar por cada empresa.
3. Probar la consulta por CUFE, la descarga de XML/CAFE y el manejo de rechazos antes de pasar a producción.

Nuestra integración es **servidor a servidor y multiempresa**: cada empresa cliente tendrá su propio RUC, sucursal y punto de venta, y sus credenciales se guardan cifradas en nuestra base de datos. No emitimos en nombre de Contador507: emitimos por cuenta de cada contribuyente que contrata la plataforma.

Agradecemos indicarnos el proceso de onboarding, la documentación vigente y los datos que debemos completar. Quedamos atentos.

**[Nombre y apellido]**
**[Cargo]**
**[Teléfono] · [correo]**
Contador507 · [sitio web]

---

## Anexo técnico

### 1. Datos de la empresa integradora

| Dato | Valor |
|---|---|
| Razón social | `[Razón social completa]` |
| RUC | `[RUC]` |
| DV | `[DV]` |
| Dirección | `[dirección]` |
| Teléfono | `[teléfono]` |
| Correo técnico | `[correo]` |
| Sitio web | `[https://...]` |
| Contacto técnico | `[nombre, cargo, correo, teléfono]` |
| IP de salida del servidor | `[IP pública]` |
| Volumen estimado inicial | `[N]` facturas/mes; pico `[N]`/hora |

### 2. Datos que solicitamos recibir para QA

| Dato | Uso en la API | Ejemplo / formato |
|---|---|---|
| URL base del ambiente de pruebas | Endpoint | `https://backend-qa-api.facturafacil.com.pa` |
| UUID de la empresa emisora | Header `X-FF-Company` | UUID `8-4-4-4-12` |
| API key de la empresa | Header `X-FF-API-Key` | cadena |
| Usuario HTTP Basic | Header `Authorization` | usuario |
| Contraseña HTTP Basic | Header `Authorization` | contraseña |
| UUID de sucursal | Header `X-FF-Branch` | UUID |
| Código de sucursal (si aplica) | `header.branch.code` | 4 caracteres |
| Código de punto de venta (POS) | `header.pos` | 3 dígitos (`001`) |
| Ambiente | `header.environment` | `"2"` en pruebas, `"1"` en producción |

También necesitamos, si está disponible:

- Catálogo de **ubicaciones** (`PP-DD-CC`) y de **unidades de medida** (`mu`).
- Catálogo **CPBS/GNS** para facturas a Gobierno.
- RUC/cédula de prueba para receptores contribuyente y consumidor final.
- Credenciales o instrucciones para el **entorno de pruebas de la DGI** (si el PAC las provee).
- Documentación de la política de **duplicados/idempotencia** (`header.id`) y de **límites de tasa**.

### 3. Flujo que vamos a implementar

1. `POST /api/pac/reception_fe/detailed/` con `{ header, document }` para emitir.
2. `GET /api/pac/reception_fe/find_by_cufe_or_id/?cufe_or_id=...` para consultar estado y reintentar de forma idempotente.
3. `GET /api/pac/reception_fe/{id}/download_xml/?cufe=...` y `.../download_cafe/?cufe=...` para archivar XML y representación gráfica.
4. `POST /api/pac/event/issue/` para anulación/contingencia (fase 2).

Cada empresa tendrá su propia configuración. El `controlId` que enviaremos en `header.id` será el identificador interno de la factura, para que un reintento no duplique el comprobante.

### 4. Preguntas para el proveedor

1. ¿La API key es por empresa emisora o existe una clave maestra de integrador? ¿Cómo se habilitan empresas nuevas?
2. ¿HTTP Basic es obligatorio además del API key? ¿Es por empresa o por integrador?
3. ¿La sucursal se crea por API (`header.branch`) o en el portal? ¿Cómo obtenemos su UUID?
4. ¿El POS lo asigna el proveedor o lo elige el emisor?
5. Para un SaaS multiempresa, ¿recomiendan `fd_number = 0` (secuencia interna del PAC) o enviar el correlativo local? ¿Cómo se evita que ambas secuencias diverjan?
6. ¿Cómo se reinicia una secuencia en el ambiente de pruebas?
7. Política de duplicados: ¿`header.id` es idempotente? ¿La respuesta es `201 duplicated` o `409`?
8. Límites de tasa, timeout recomendado y allowlist de IP.
9. ¿El `201` siempre incluye CUFE, o hay que consultar el estado después? ¿Qué estados se resuelven de forma asincrónica?
10. ¿La descarga de XML/CAFE usa la misma autenticación? ¿`send_email` envía correos reales en QA?
11. ¿Los eventos de anulación/contingencia funcionan en QA?
12. ¿La firma/certificado la maneja el PAC? ¿Necesitan algún registro o identificación nuestra como proveedor de software ante la DGI?
13. ¿Hay términos especiales para integradores/revendedores que dan servicio a múltiples contribuyentes?

### 5. Seguridad y manejo de datos

- Las credenciales por empresa se guardan **cifradas en reposo** (AES-256-GCM) y nunca se devuelven al frontend.
- La emisión se hace desde el backend; no hay credenciales en el navegador.
- Podemos restringir las llamadas a una IP fija y rotar credenciales si el proveedor lo requiere.
- No almacenamos certificados de firma: la firma y transmisión quedan del lado del PAC.

### 6. Checklist de respuesta

- [ ] Proceso de alta de integrador y de empresas emisoras.
- [ ] Credenciales de QA (UUID, API key, Basic).
- [ ] Sucursal y POS de prueba.
- [ ] Catálogos y datos de prueba.
- [ ] Documentación de duplicados, límites y ambientes.
- [ ] Contacto de soporte técnico durante la integración.
