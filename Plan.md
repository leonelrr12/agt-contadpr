# Plan de Implementación: Agente Contable (Panamá)

## Arquitectura General

```
┌─────────────────────────────────────────────────┐
│                    Frontend                      │
│           (React / Next.js / Electron)           │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              API Gateway (NestJS)                 │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Agente Orquestador                   │
│  (Coordina flujo, crea plan de ejecución,        │
│   consolida respuestas)                          │
├──────────────────────────────────────────────────┤
│  Agente       │  Agente       │  Agente          │
│  de Diálogo   │  Clasificación│  Contable        │
├───────────────┼───────────────┼──────────────────┤
│  Agente       │  Agente       │  Agente          │
│  Bancario     │  Clientes     │  Proveedores     │
├───────────────┼───────────────┼──────────────────┤
│  Agente       │  Agente       │  Agente          │
│  Inventario   │  Impuestos    │  Reportes        │
├───────────────┼───────────────┼──────────────────┤
│  Agente OCR   │  Agente       │  Agente          │
│               │  Nómina       │  Auditor         │
└───────────────┴───────────────┴──────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│        Base de Datos (PostgreSQL / SQLite)       │
│  Plan de Cuentas │ Libro Diario │ Libro Mayor    │
│  Clientes │ Proveedores │ Inventario │ Nómina    │
│  Documentos │ Auditoría │ Configuración          │
└──────────────────────────────────────────────────┘
```

---

## FASE 1 — MVP: Motor Contable (4-6 semanas)

**Objetivo**: Sistema funcional que registre transacciones vía chat y genere asientos contables.

### 1.1 — Infraestructura Base
| Tarea | Descripción |
|---|---|
| **1.1.1** | Inicializar proyecto TypeScript/Node.js con monorepo (Turborepo o Nx) |
| **1.1.2** | Configurar base de datos con Prisma (PostgreSQL o SQLite para desarrollo) |
| **1.1.3** | Configurar ESLint, Prettier, Husky, tests (Jest/Vitest) |
| **1.1.4** | Dockerizar entorno de desarrollo |

### 1.2 — Base de Datos (Schema)
| Tarea | Descripción |
|---|---|
| **1.2.1** | Modelo `Account` (Plan de Cuentas) |
| **1.2.2** | Modelo `JournalEntry` (Libro Diario) |
| **1.2.3** | Modelo `JournalLine` (líneas de asiento) |
| **1.2.4** | Modelo `Concept` (Catálogo de conceptos) |
| **1.2.5** | Modelo `Transaction` (transacción original del usuario) |
| **1.2.6** | Modelo `User` / `Company` |
| **1.2.7** | Seeds: plan de cuentas panameño + catálogo de conceptos |

### 1.3 — API Core
| Tarea | Descripción |
|---|---|
| **1.3.1** | CRUD de cuentas contables |
| **1.3.2** | CRUD de conceptos |
| **1.3.3** | Endpoints para crear/consultar asientos contables |
| **1.3.4** | Endpoint para balance de comprobación |
| **1.3.5** | Endpoint para libro diario y libro mayor |
| **1.3.6** | Endpoint para balance general y estado de resultados |
| **1.3.7** | Endpoint para flujo de caja |

### 1.4 — Agente de Diálogo
| Tarea | Descripción |
|---|---|
| **1.4.1** | Integración con LLM (OpenAI / Anthropic) |
| **1.4.2** | Extracción estructurada de transacciones |
| **1.4.3** | Manejo de información faltante |
| **1.4.4** | Confirmación antes de registrar |

### 1.5 — Agente de Clasificación
| Tarea | Descripción |
|---|---|
| **1.5.1** | Mapeo concepto → cuenta contable |
| **1.5.2** | Clasificación ML para conceptos nuevos |
| **1.5.3** | Aprendizaje de correcciones del usuario |

### 1.6 — Agente Contable
| Tarea | Descripción |
|---|---|
| **1.6.1** | Motor de reglas de débito/crédito |
| **1.6.2** | Generación de asientos contables (partida doble) |
| **1.6.3** | Validación de balance |
| **1.6.4** | Registro en libro diario |

### 1.7 — Agente Orquestador
| Tarea | Descripción |
|---|---|
| **1.7.1** | Pipeline de acciones |
| **1.7.2** | Comunicación entre agentes vía JSON estructurado |
| **1.7.3** | Manejo de errores y rollback |

### 1.8 — Frontend MVP
| Tarea | Descripción |
|---|---|
| **1.8.1** | Interfaz de chat |
| **1.8.2** | Confirmación (Sí / Editar / Cancelar) |
| **1.8.3** | Botón flotante "+" con acciones rápidas |
| **1.8.4** | Panel lateral con resumen |

---

## FASE 2 — Documentos y Terceros (4-6 semanas)

**Objetivo**: Integrar OCR, bancos, clientes y proveedores.

### 2.1 — Agente OCR
- Integración OCR (Tesseract.js / Azure Document Intelligence)
- Extracción de: proveedor, fecha, monto, ITBMS, factura
- Almacenamiento de documentos

### 2.2 — Agente Bancario
- Importación de estados bancarios (CSV, PDF, OFX)
- Conciliación automática y manual
- Detección de duplicados

### 2.3 — Agente Clientes
- Facturas emitidas y cuentas por cobrar
- Notificaciones de pagos vencidos

### 2.4 — Agente Proveedores
- Facturas recibidas y cuentas por pagar
- Programación de pagos

### 2.5 — Importación/Exportación
- Importar Excel/CSV
- Exportar reportes a Excel y formatos DGI

---

## FASE 3 — Módulos Avanzados (6-8 semanas)

**Objetivo**: Inventario, nómina, impuestos y reportes.

### 3.1 — Agente Inventario
- FIFO, costo promedio, alertas de stock

### 3.2 — Agente Nómina
- Salarios, décimo tercer mes, CSS, vacaciones

### 3.3 — Agente Impuestos
- ITBMS, retenciones, ISR, formularios DGI

### 3.4 — Agente Reportes
- Dashboard, ratios financieros, PDF

### 3.5 — Gestión Documental
- Almacenamiento y búsqueda de documentos

### 3.6 — Agente Auditor
- Logs, reversiones, detección de anomalías

---

## FASE 4 — IA Avanzada (4-6 semanas)

**Objetivo**: Inteligencia predictiva.

### 4.1 — Predicción de Flujo de Caja
### 4.2 — Detección de Fraude
### 4.3 — Análisis de Rentabilidad
### 4.4 — Alertas Inteligentes
### 4.5 — Explicación en Lenguaje Natural

---

## Seguridad (Transversal)
- Autenticación JWT
- Roles y permisos
- Cifrado en reposo
- Backups automáticos
- Logs de acceso

## Stack Tecnológico

| Componente | Tecnología |
|---|---|
| Frontend | React + Next.js o Electron |
| Backend | NestJS |
| Base de datos | PostgreSQL (prod) / SQLite (dev) |
| ORM | Prisma |
| LLM | OpenAI GPT-4o / Anthropic Claude |
| OCR | Azure Document Intelligence |
| Documentos | MinIO (S3-compatible) |
| Cola de tareas | BullMQ (Redis) |
| Testing | Jest + Vitest + Playwright |
| CI/CD | GitHub Actions |
| Monorepo | Turborepo |

## Cronograma Estimado

```
Semana  1-6   │ Fase 1: MVP Motor Contable
Semana  7-12  │ Fase 2: Documentos y Terceros
Semana 13-20  │ Fase 3: Módulos Avanzados
Semana 21-26  │ Fase 4: IA Avanzada
              │
              └── Pruebas, despliegue e iteración continua
```
