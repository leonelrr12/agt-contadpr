# Tuning — Recomendaciones de Evolución

> Documento vivo de ideas para expandir **agt-contadpr** usando IA en procesos contables de PyMEs.
> Actualizado: 2026-07-17

---

## 📊 Diagnóstico Base

El proyecto ya cuenta con una base sólida:

| Capacidad | Estado |
|-----------|--------|
| Entrada por chat (NL → asiento contable) | ✅ DeepSeek |
| OCR de facturas/recibos (imagen) | ✅ Tesseract + LLM |
| Extracción de PDFs (DGI) | ✅ pdf-parse + LLM |
| Plan de cuentas + clasificación automática | ✅ |
| Clientes / Proveedores auto-creados | ✅ |
| Antigüedad de saldos (CxC / CxP) | ✅ |
| Reportes financieros (5 tipos) | ✅ |
| Export XLSX / CSV | ✅ |
| Multi-tenant con planes SaaS | ✅ |
| API Keys para integraciones | ✅ |
| Audit log de asientos | ✅ |
| Flujo de caja + dashboard mensual | ✅ |

---

## 🎯 Recomendaciones Priorizadas

### 🔥 Fase 1 — Inmediato (alto impacto, bajo esfuerzo)

#### 1. Conciliación Bancaria Automática ✅ Implementado
El dolor #1 de todo contador. Subir un extracto bancario (PDF o CSV) y que el sistema:

- [x] Haga matching automático por monto + fecha + descripción contra asientos registrados
- [x] Marque partidas no conciliadas y discrepancias
- [x] Sugiera asientos para comisiones bancarias, intereses, diferencias de redondeo
- [x] Dashboard de conciliación con % de avance

**Archivos:** `reconcile.ts`, `bank-matcher.ts`, `conciliacion.html`, modelos `BankStatement`/`BankStatementRow`

---

#### 2. Importación Masiva desde CSV / Excel ✅ Implementado
Muchos negocios vienen de Excel. Un asistente donde:

- [x] Suben su archivo histórico (CSV, XLSX)
- [x] La IA analiza encabezados y mapea columnas (fecha, concepto, monto, método de pago)
- [x] Sugiere la cuenta contable para cada fila usando el ClassificationAgent
- [x] Vista previa completa con validaciones (balance, cuentas inválidas)
- [x] Importación en lote con confirmación
- [x] Selector de fecha por defecto para filas sin fecha (ej. saldos iniciales a 1° enero)

**Archivos:** `import.ts`, `csv-parser.ts`, `importar.html`

---

#### 3. Transacciones Recurrentes ✅ Implementado
Automatizar lo que siempre se repite:

- [x] El usuario define: "Alquiler $800 cada día 5 del mes"
- [x] El sistema genera el asiento automáticamente en la fecha programada
- [x] Confirmación rápida antes de postear (no automático ciego)
- [ ] Detección de patrones por IA: "Este gasto de $49.99 aparece cada mes, ¿quieres hacerlo recurrente?"
- [x] Gestión de recurrentes: pausar, editar, cancelar

**Archivos:** `recurring.ts`, `recurring-processor.ts`, modelo `RecurringTemplate`

---

### ⚡ Fase 2 — Alto impacto, esfuerzo medio

#### 4. Bot de WhatsApp / Telegram ✅ Implementado
En Latinoamérica los dueños de negocio VIVEN en WhatsApp:

- [x] Mandan un audio: "gasté 50 palos en gasolina con la tarjeta"
- [x] Whisper transcribe → mismo pipeline de agentes → responde confirmación
- [x] También acepta fotos de facturas directo al OCR
- [x] Respuesta: "Listo, registrado como Combustible $50.00 con T. Crédito ✅"
- [x] Comandos rápidos: `/saldo`, `/ventas mes`, `/cxc`

**Archivos:** `whatsapp.ts`, `whatsapp-service.ts`, modelo `WhatsAppLink`

---

#### 5. Calendario Fiscal Panameño ✅ Implementado
Diferenciación fuerte para el mercado meta:

- [x] Fechas de vencimiento: ITBMS (DG-430), ISR, aviso de operación, tasa única
- [x] Notificaciones proactivas: "Quedan 5 días para declarar ITBMS"
- [x] Checklist de cumplimiento por mes con progreso visual
- [x] Recordatorios configurables (email, in-app, WhatsApp)

**Archivos:** `tax-calendar.ts` (ruta + servicio), `calendario-fiscal.html`, modelo `TaxObligation`

---

#### 6. Dashboard de Salud Financiera con IA ❌ Pendiente
Más allá de reportes estáticos:

- [ ] Ratios clave automáticos: liquidez, endeudamiento, margen neto, rotación
- [ ] Explicación en lenguaje natural: "Tu margen neto bajó 3% porque los gastos de envío aumentaron 40%"
- [ ] Alertas predictivas inteligentes: "Tu flujo de caja proyectado será negativo en 2 meses"
- [ ] Recomendaciones accionables generadas por LLM

**Fundamento:** Ya existen todos los datos. Solo falta la capa de análisis y narrativa.

---

### 📋 Fase 3 — Medio plazo (diferenciación)

#### 7. Generador de Facturas PDF ❌ Pendiente
Convertir una venta registrada en factura profesional:

- [ ] Template con logo de empresa (configurable), numeración secuencial
- [ ] ITBMS desglosado, datos del cliente
- [ ] Envío directo por email al cliente
- [ ] Cumplimiento con requisitos de facturación panameña (DGI)

---

#### 8. Cierre de Período / Año Fiscal Automatizado ❌ Pendiente
- [ ] Asientos de cierre automáticos (liquidar ingresos/gastos a patrimonio)
- [ ] Ajustes sugeridos por IA (depreciación, amortización, provisiones)
- [ ] Resumen del año con comparativa vs período anterior
- [ ] Datos estructurados listos para la declaración de renta

---

#### 9. Archivo Digital de Documentos ❌ Pendiente
- [ ] Adjuntar facturas/recibos a cada asiento contable
- [ ] Almacenamiento en S3 / Cloudflare R2
- [ ] Auditoría: un clic para ver el comprobante original
- [ ] Búsqueda por proveedor, fecha, monto, concepto

---

#### 10. Centro de Costos / Proyectos ❌ Pendiente
- [ ] Etiquetar transacciones por proyecto, sucursal o departamento
- [ ] Reportes de rentabilidad segmentada
- [ ] Cruce con presupuesto por centro de costo
- [ ] Ideal para negocios con múltiples líneas de ingreso

---

### 🔮 Fase 4 — Largo plazo (expansión)

#### 11. Módulo de Nómina Simple ❌ Pendiente

#### 12. Presupuestos y Proyecciones ❌ Pendiente

#### 13. Módulo de Inventario ❌ Pendiente

#### 14. Agente Multi-Empresa para Despachos Contables ❌ Pendiente

---

## 🗺️ Ruta Recomendada

| Sprint | Qué construir | Por qué | Estado |
|--------|--------------|---------|--------|
| **1** | Conciliación bancaria | Máximo dolor contable, 80% de la base ya existe | ✅ |
| **1** | Importación CSV masiva | Elimina fricción de adopción | ✅ |
| **2** | Transacciones recurrentes | Fideliza, reduce trabajo diario | ✅ |
| **2** | Calendario fiscal PA | Diferenciación en mercado meta | ✅ |
| **3** | WhatsApp Bot | Disparador de crecimiento | ✅ |
| **3** | Dashboard IA | Conversión de datos en insights | ❌ |
| **4+** | Facturas PDF, Cierre, Archivo, CC | Maduración del ecosistema | ❌ |

---

## 🔧 Deuda Técnica Identificada

Mejoras estructurales recomendadas a mediano plazo:

- [ ] **Tipado estricto:** Eliminar `any` en agentes (PrismaClient genérico)
- [ ] **Refactor del frontend:** Modularizar `app.js` (~2166 líneas en un solo archivo)
- [ ] **Alias de cuentas dinámicos:** Mover `ALIAS_TO_CODE` del AccountingAgent a la BD
- [ ] **Agregaciones en SQL:** Reports actualmente procesan todos los datos en JS
- [ ] **Workers de Tesseract:** Nunca se liberan (memory leak)
- [ ] **Paginación real:** Journal listing actualmente pagina en memoria
- [ ] **Email verification:** No existe verificación de correo ni recuperación de contraseña
- [ ] **CI/CD:** No hay pipeline de integración continua

---

## 📐 Principios para Nuevas Features

1. **Siempre terminar en un asiento contable** — Toda funcionalidad debe alimentar el libro diario
2. **Fallback sin IA** — Si DeepSeek no está disponible, la feature debe funcionar con reglas/heurísticas
3. **Panamá-first** — ITBMS 7%, DGI, formato de RUC, calendario fiscal local
4. **Confirmación humana** — La IA sugiere, el contador confirma (nunca automático ciego en operaciones sensibles)
5. **Multi-tenant desde el diseño** — Todo scoped por `companyId`
