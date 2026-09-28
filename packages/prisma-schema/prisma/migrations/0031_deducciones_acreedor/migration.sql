-- Deducciones de acreedores por empleado (bancos, mueblerías, embargos).
-- Ver Tuning.md §4.4 y el comentario de los modelos en schema.prisma.
--
-- Qué resuelve: hasta acá, todo lo que no era SS, SE ni ISR caía en UNA sola cuenta
-- (`Company.planillaOtrasDeduccionesId`) y se tecleaba a mano en cada corrida, así que
-- el pasivo de cada acreedor no se podía conciliar ni pagar por separado y una deuda
-- que debía terminar seguía corriendo porque nadie contaba las cuotas.
--
-- Convenciones que sostienen el diseño:
--  · `payroll_deduction` es el catálogo (por empleado y acreedor). `cuentaId` es la
--    cuenta por pagar DEL ACREEDOR; la genérica queda para lo que no tiene acreedor.
--  · `payroll_item_deduction` es el detalle CONGELADO por corrida. Cuelga de
--    (runId, employeeId) y no del ítem porque el camino consolidado usa `createMany` y
--    Prisma no devuelve sus ids; con la misma clave entra en un INSERT más.
--  · `monto > 0` es la ÚNICA marca de "cuota aplicada": el saldo es su suma y la cuota
--    que toca es el conteo + 1. Una cuota saltada se guarda con monto 0 y `omitida`,
--    así queda la constancia sin mover el saldo ni el calendario.
--  · `acreedor` y `cuentaId` viajan como snapshot al detalle: cambiar la cuenta del
--    catálogo mañana no puede reescribir a dónde se acreditó ayer.
--  · Nada de esto se materializa como saldo: se deriva de las corridas vivas, igual
--    que los acumulados de décimo y vacaciones.
--
-- Aditiva y SIN backfill: solo crea tablas. ODESA no se toca — sus deducciones se
-- registran cuando el dueño lo decida.

-- CreateTable
CREATE TABLE "payroll_deduction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "acreedor" TEXT NOT NULL,
    "cuentaId" TEXT NOT NULL,
    "tipo" TEXT NOT NULL DEFAULT 'FIJO',
    "montoFijo" DOUBLE PRECISION,
    "porcentaje" DOUBLE PRECISION,
    "cuotas" INTEGER,
    "montoTotal" DOUBLE PRECISION,
    "saldoInicial" DOUBLE PRECISION,
    "fechaInicio" TIMESTAMP(3),
    "fechaFin" TIMESTAMP(3),
    "aplicaEnDiciembre" BOOLEAN NOT NULL DEFAULT true,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notas" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payroll_deduction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payroll_item_deduction" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "employeeId" TEXT NOT NULL,
    "deduccionId" TEXT NOT NULL,
    "acreedor" TEXT NOT NULL,
    "cuentaId" TEXT NOT NULL,
    "monto" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "omitida" BOOLEAN NOT NULL DEFAULT false,
    "motivoOmitida" TEXT,
    "cuotaNumero" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payroll_item_deduction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payroll_deduction_companyId_employeeId_isActive_idx" ON "payroll_deduction"("companyId", "employeeId", "isActive");

-- CreateIndex
CREATE INDEX "payroll_deduction_companyId_cuentaId_idx" ON "payroll_deduction"("companyId", "cuentaId");

-- CreateIndex
CREATE INDEX "payroll_item_deduction_companyId_employeeId_deduccionId_idx" ON "payroll_item_deduction"("companyId", "employeeId", "deduccionId");

-- CreateIndex
CREATE INDEX "payroll_item_deduction_companyId_cuentaId_idx" ON "payroll_item_deduction"("companyId", "cuentaId");

-- CreateIndex
CREATE UNIQUE INDEX "payroll_item_deduction_runId_employeeId_deduccionId_key" ON "payroll_item_deduction"("runId", "employeeId", "deduccionId");

-- AddForeignKey
ALTER TABLE "payroll_deduction" ADD CONSTRAINT "payroll_deduction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deduction" ADD CONSTRAINT "payroll_deduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_deduction" ADD CONSTRAINT "payroll_deduction_cuentaId_fkey" FOREIGN KEY ("cuentaId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item_deduction" ADD CONSTRAINT "payroll_item_deduction_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item_deduction" ADD CONSTRAINT "payroll_item_deduction_runId_fkey" FOREIGN KEY ("runId") REFERENCES "payroll_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item_deduction" ADD CONSTRAINT "payroll_item_deduction_employeeId_fkey" FOREIGN KEY ("employeeId") REFERENCES "employee"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payroll_item_deduction" ADD CONSTRAINT "payroll_item_deduction_deduccionId_fkey" FOREIGN KEY ("deduccionId") REFERENCES "payroll_deduction"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
