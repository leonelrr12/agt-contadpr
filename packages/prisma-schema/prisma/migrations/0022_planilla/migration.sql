-- Planilla como módulo: registro de empleados, corridas con montos congelados,
-- acumulados (décimo, vacaciones, prima) y parámetros de cálculo.
-- Ver PLANILLA.md en la raíz del repo y el comentario de los modelos.
--
-- Convenciones que sostienen el diseño:
--  · `sueldoBase` es SIEMPRE mensual; `tipoPago` decide cómo se parte el período.
--  · `payroll_run.periodo` lleva la granularidad dentro ("2026-06-Q1" | "2026-06" |
--    "2026" | "2026-08-14") porque una nómina real mezcla gente quincenal y mensual.
--    `periodoMensual` es la llave con el calendario CSS, sin parsear strings.
--  · `@@unique(companyId, tipo, periodo)` es la idempotencia de la corrida: no se
--    puede pagar dos veces el mismo período. Reemplaza el dedupe por metadata.
--  · `payroll_item.neto` es el RESIDUO (bruto − deducciones ya redondeadas): por eso
--    el asiento cuadra por construcción y no hay céntimo que absorber.
--  · Los montos del ítem quedan CONGELADOS: la corrida se anula y se rehace, no se
--    recalcula. Igual que el costo unitario de un movimiento de kardex.
--  · `tablaISR` es JSON en un String; `'[]'` significa "usar la tabla legal del código".
--
-- Aditiva y SIN backfill: solo crea tablas y añade columnas NULLables. ODESA no se
-- toca — sus empleados se registran cuando el dueño lo decida.

-- AlterTable: cuentas del módulo. Los aportes del patrono necesitan gasto y pasivo
-- por separado, aunque hoy las dos apunten al mismo pasivo que la retención del
-- obrero (a la CSS se le paga una sola vez, pero el gasto no es la retención).
ALTER TABLE "Company" ADD COLUMN     "planillaSSPatronalId" TEXT,
ADD COLUMN     "planillaSEPatronalId" TEXT,
ADD COLUMN     "planillaPatronalGastoId" TEXT,
ADD COLUMN     "planillaOtrasDeduccionesId" TEXT;

-- CreateTable
CREATE TABLE "employee" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "cedula" TEXT,
    "nss" TEXT,
    "nombre" TEXT NOT NULL,
    "cargo" TEXT,
    "sueldoBase" DOUBLE PRECISION NOT NULL,
    "tipoPago" TEXT NOT NULL DEFAULT 'QUINCENAL',
    "fechaIngreso" TIMESTAMP(3),
    "fechaSalida" TIMESTAMP(3),
    "bancoCuentaId" TEXT,
    "cuentaBanco" TEXT,
    "decimoSaldoInicial" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vacacionesSaldoInicial" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "primaSaldoInicial" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "fechaSaldoInicial" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "employee_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_run" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "periodicidad" TEXT NOT NULL DEFAULT 'QUINCENAL',
    "periodo" TEXT NOT NULL,
    "periodoMensual" TEXT NOT NULL,
    "fechaDesde" TIMESTAMP(3) NOT NULL,
    "fechaHasta" TIMESTAMP(3) NOT NULL,
    "fechaPago" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'BORRADOR',
    "totalBruto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDeducciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalNeto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPatronal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalDecimoGenerado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalVacacionesGeneradas" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "totalPrimaGenerada" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "asientosCount" INTEGER NOT NULL DEFAULT 0,
    "notas" TEXT,
    "motivoAnulacion" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_item" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "diasTrabajados" INTEGER NOT NULL,
    "sueldo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "horasExtras" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otrosIngresos" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "bruto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ss" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "se" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "isr" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "otrasDeducciones" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "neto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ssPatronal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "sePatronal" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "decimoGenerado" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "vacacionesGeneradas" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "primaGenerada" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "journalEntryId" TEXT,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_settings" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "ssObrero" DOUBLE PRECISION NOT NULL DEFAULT 0.0975,
    "seObrero" DOUBLE PRECISION NOT NULL DEFAULT 0.0125,
    "ssPatronal" DOUBLE PRECISION NOT NULL DEFAULT 0.1225,
    "sePatronal" DOUBLE PRECISION NOT NULL DEFAULT 0.015,
    "ssObreroDecimo" DOUBLE PRECISION NOT NULL DEFAULT 0.0725,
    "seObreroDecimo" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "factorDecimo" DOUBLE PRECISION NOT NULL DEFAULT 0.0833333333,
    "factorVacaciones" DOUBLE PRECISION NOT NULL DEFAULT 0.0833333333,
    "factorPrima" DOUBLE PRECISION NOT NULL DEFAULT 0.0192307692,
    "tablaISR" TEXT NOT NULL DEFAULT '[]',
    "provisionarPrestaciones" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "employee_companyId_isActive_idx" ON "employee"("companyId", "isActive");

-- CreateIndex: la cédula NULL convive (identidad de los empleados que no la traían)
CREATE UNIQUE INDEX "employee_companyId_cedula_key" ON "employee"("companyId", "cedula");

-- CreateIndex
CREATE INDEX "payroll_run_companyId_fechaPago_idx" ON "payroll_run"("companyId", "fechaPago");

-- CreateIndex
CREATE INDEX "payroll_run_companyId_periodoMensual_idx" ON "payroll_run"("companyId", "periodoMensual");

-- CreateIndex: la idempotencia de la corrida
CREATE UNIQUE INDEX "payroll_run_companyId_tipo_periodo_key" ON "payroll_run"("companyId", "tipo", "periodo");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_item_runId_employeeId_key" ON "payroll_item"("runId", "employeeId");

-- CreateIndex: los acumulados por empleado se leen con un solo groupBy
CREATE INDEX "payroll_item_companyId_employeeId_idx" ON "payroll_item"("companyId", "employeeId");

-- CreateIndex
CREATE INDEX "payroll_item_journalEntryId_idx" ON "payroll_item"("journalEntryId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_settings_companyId_key" ON "payroll_settings"("companyId");

-- AddForeignKey
ALTER TABLE "employee" ADD CONSTRAINT "employee_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_run" ADD CONSTRAINT "payroll_run_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item" ADD CONSTRAINT "payroll_item_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_settings" ADD CONSTRAINT "payroll_settings_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
