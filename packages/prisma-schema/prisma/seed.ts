import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  const company = await prisma.company.upsert({
    where: { taxId: '00-0000000-0-00' },
    update: {},
    create: {
      id: 'demo-company',
      name: 'Empresa Demo',
      taxId: '00-0000000-0-00',
      country: 'PA',
      currency: 'USD',
    },
  });

  await prisma.user.upsert({
    where: { email: 'admin@demo.com' },
    update: {},
    create: {
      id: 'demo-user',
      email: 'admin@demo.com',
      name: 'Administrador',
      password: '$2b$10$placeholder',
      role: 'admin',
      companyId: company.id,
    },
  });

  await prisma.journalLine.deleteMany({ where: { journalEntry: { companyId: company.id } } });
  await prisma.transaction.deleteMany({ where: { companyId: company.id } });
  await prisma.journalEntry.deleteMany({ where: { companyId: company.id } });
  await prisma.accountingRuleEntry.deleteMany();
  await prisma.accountingRule.deleteMany();
  await prisma.concept.deleteMany({ where: { companyId: company.id } });
  await prisma.account.deleteMany({ where: { companyId: company.id } });

  const accounts = [
    // ACTIVOS (1)
    { code: '1', name: 'ACTIVO', type: 'ACTIVO', parentCode: null },
    { code: '1.1', name: 'ACTIVO CORRIENTE', type: 'ACTIVO', parentCode: '1' },
    { code: '1.1.01', name: 'Caja', type: 'ACTIVO', parentCode: '1.1' },
    { code: '1.1.02', name: 'Bancos', type: 'ACTIVO', parentCode: '1.1' },
    { code: '1.1.02.01', name: 'Banco General', type: 'ACTIVO', parentCode: '1.1.02' },
    { code: '1.1.02.02', name: 'Banco Nacional', type: 'ACTIVO', parentCode: '1.1.02' },
    { code: '1.1.02.03', name: 'Banco de Panama', type: 'ACTIVO', parentCode: '1.1.02' },
    { code: '1.1.03', name: 'Cuentas por Cobrar', type: 'ACTIVO', parentCode: '1.1' },
    { code: '1.1.03.01', name: 'Clientes', type: 'ACTIVO', parentCode: '1.1.03' },
    { code: '1.1.03.02', name: 'Otras Cuentas por Cobrar', type: 'ACTIVO', parentCode: '1.1.03' },
    { code: '1.1.04', name: 'Inventario', type: 'ACTIVO', parentCode: '1.1' },
    { code: '1.1.04.01', name: 'Inventario de Mercancia', type: 'ACTIVO', parentCode: '1.1.04' },
    { code: '1.1.04.02', name: 'Inventario de Materia Prima', type: 'ACTIVO', parentCode: '1.1.04' },
    { code: '1.1.05', name: 'ITBMS por Cobrar', type: 'ACTIVO', parentCode: '1.1' },
    { code: '1.1.06', name: 'Anticipos', type: 'ACTIVO', parentCode: '1.1' },
    { code: '1.2', name: 'ACTIVO NO CORRIENTE', type: 'ACTIVO', parentCode: '1' },
    { code: '1.2.01', name: 'Propiedad, Planta y Equipo', type: 'ACTIVO', parentCode: '1.2' },
    { code: '1.2.01.01', name: 'Terrenos', type: 'ACTIVO', parentCode: '1.2.01' },
    { code: '1.2.01.02', name: 'Edificios', type: 'ACTIVO', parentCode: '1.2.01' },
    { code: '1.2.01.03', name: 'Mobiliario y Equipo', type: 'ACTIVO', parentCode: '1.2.01' },
    { code: '1.2.01.04', name: 'Equipo de Computo', type: 'ACTIVO', parentCode: '1.2.01' },
    { code: '1.2.01.05', name: 'Vehículos', type: 'ACTIVO', parentCode: '1.2.01' },
    { code: '1.2.02', name: 'Depreciación Acumulada', type: 'ACTIVO', parentCode: '1.2' },
    { code: '1.2.02.01', name: 'Dep. Acum. Edificios', type: 'ACTIVO', parentCode: '1.2.02' },
    { code: '1.2.02.02', name: 'Dep. Acum. Mobiliario', type: 'ACTIVO', parentCode: '1.2.02' },
    { code: '1.2.02.03', name: 'Dep. Acum. Computo', type: 'ACTIVO', parentCode: '1.2.02' },
    { code: '1.2.02.04', name: 'Dep. Acum. Vehículos', type: 'ACTIVO', parentCode: '1.2.02' },
    { code: '1.2.03', name: 'Activos Intangibles', type: 'ACTIVO', parentCode: '1.2' },

    // PASIVOS (2)
    { code: '2', name: 'PASIVO', type: 'PASIVO', parentCode: null },
    { code: '2.1', name: 'PASIVO CORRIENTE', type: 'PASIVO', parentCode: '2' },
    { code: '2.1.01', name: 'Proveedores', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.02', name: 'Cuentas por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.02.01', name: 'Gastos Acumulados por Pagar', type: 'PASIVO', parentCode: '2.1.02' },
    { code: '2.1.03', name: 'Tarjetas de Crédito', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.04', name: 'Préstamos Bancarios CP', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.05', name: 'ITBMS por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.06', name: 'ISR por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.07', name: 'Retenciones por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.08', name: 'CSS por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.09', name: 'Prestaciones por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.10', name: 'Décimo Tercer Mes por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.1.11', name: 'Vacaciones por Pagar', type: 'PASIVO', parentCode: '2.1' },
    { code: '2.2', name: 'PASIVO NO CORRIENTE', type: 'PASIVO', parentCode: '2' },
    { code: '2.2.01', name: 'Préstamos Bancarios LP', type: 'PASIVO', parentCode: '2.2' },
    { code: '2.2.02', name: 'Obligaciones Financieras LP', type: 'PASIVO', parentCode: '2.2' },

    // PATRIMONIO (3)
    { code: '3', name: 'PATRIMONIO', type: 'PATRIMONIO', parentCode: null },
    { code: '3.01', name: 'Capital Social', type: 'PATRIMONIO', parentCode: '3' },
    { code: '3.02', name: 'Utilidades Retenidas', type: 'PATRIMONIO', parentCode: '3' },
    { code: '3.03', name: 'Utilidad del Ejercicio', type: 'PATRIMONIO', parentCode: '3' },
    { code: '3.04', name: 'Reservas', type: 'PATRIMONIO', parentCode: '3' },
    { code: '3.05', name: 'Retiros', type: 'PATRIMONIO', parentCode: '3' },

    // INGRESOS (4)
    { code: '4', name: 'INGRESOS', type: 'INGRESO', parentCode: null },
    { code: '4.01', name: 'Ventas', type: 'INGRESO', parentCode: '4' },
    { code: '4.01.01', name: 'Ventas de Productos', type: 'INGRESO', parentCode: '4.01' },
    { code: '4.01.02', name: 'Ventas de Servicios', type: 'INGRESO', parentCode: '4.01' },
    { code: '4.02', name: 'Otros Ingresos', type: 'INGRESO', parentCode: '4' },
    { code: '4.02.01', name: 'Ingresos Financieros', type: 'INGRESO', parentCode: '4.02' },
    { code: '4.02.02', name: 'Otros Ingresos Operativos', type: 'INGRESO', parentCode: '4.02' },

    // COSTOS (5)
    { code: '5', name: 'COSTOS', type: 'COSTO', parentCode: null },
    { code: '5.01', name: 'Costo de Ventas', type: 'COSTO', parentCode: '5' },
    { code: '5.01.01', name: 'Costo de Productos Vendidos', type: 'COSTO', parentCode: '5.01' },
    { code: '5.01.02', name: 'Costo de Servicios Prestados', type: 'COSTO', parentCode: '5.01' },

    // GASTOS (6)
    { code: '6', name: 'GASTOS', type: 'GASTO', parentCode: null },
    { code: '6.01', name: 'Gastos Operativos', type: 'GASTO', parentCode: '6' },
    { code: '6.01.01', name: 'Salarios', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.02', name: 'Gastos de Combustible', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.03', name: 'Electricidad', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.04', name: 'Agua', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.05', name: 'Internet y Comunicaciones', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.06', name: 'Teléfono', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.07', name: 'Papelería y Útiles', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.08', name: 'Alquiler', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.09', name: 'Mantenimiento y Reparaciones', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.10', name: 'Seguros', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.11', name: 'Publicidad y Marketing', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.12', name: 'Gastos de Viaje', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.13', name: 'Hospedaje', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.14', name: 'Transporte', type: 'GASTO', parentCode: '6.01' },
    { code: '6.01.15', name: 'Comisiones', type: 'GASTO', parentCode: '6.01' },
    { code: '6.02', name: 'Gastos Administrativos', type: 'GASTO', parentCode: '6' },
    { code: '6.02.01', name: 'Honorarios Profesionales', type: 'GASTO', parentCode: '6.02' },
    { code: '6.02.02', name: 'Gastos Legales', type: 'GASTO', parentCode: '6.02' },
    { code: '6.02.03', name: 'Gastos de Representación', type: 'GASTO', parentCode: '6.02' },
    { code: '6.03', name: 'Gastos Financieros', type: 'GASTO', parentCode: '6' },
    { code: '6.03.01', name: 'Intereses Bancarios', type: 'GASTO', parentCode: '6.03' },
    { code: '6.03.02', name: 'Comisiones Bancarias', type: 'GASTO', parentCode: '6.03' },
    { code: '6.03.03', name: 'Intereses por Préstamos', type: 'GASTO', parentCode: '6.03' },
    { code: '6.04', name: 'Depreciaciones', type: 'GASTO', parentCode: '6' },
    { code: '6.04.01', name: 'Depreciación de Edificios', type: 'GASTO', parentCode: '6.04' },
    { code: '6.04.02', name: 'Depreciación de Mobiliario', type: 'GASTO', parentCode: '6.04' },
    { code: '6.04.03', name: 'Depreciación de Computo', type: 'GASTO', parentCode: '6.04' },
    { code: '6.04.04', name: 'Depreciación de Vehículos', type: 'GASTO', parentCode: '6.04' },
    { code: '6.05', name: 'Gastos de Impuestos', type: 'GASTO', parentCode: '6' },
    { code: '6.05.01', name: 'ITBMS Gastado', type: 'GASTO', parentCode: '6.05' },
    { code: '6.05.02', name: 'Impuesto sobre la Renta', type: 'GASTO', parentCode: '6.05' },
    { code: '6.05.03', name: 'Timbres y Otros Impuestos', type: 'GASTO', parentCode: '6.05' },
    { code: '6.06', name: 'Otros Gastos', type: 'GASTO', parentCode: '6' },
    { code: '6.06.01', name: 'Gastos Varios', type: 'GASTO', parentCode: '6.06' },
  ];

  const accountMap: Record<string, string> = {};

  for (const acc of accounts) {
    const created = await prisma.account.create({
      data: {
        code: acc.code,
        name: acc.name,
        type: acc.type,
        companyId: company.id,
        parentId: acc.parentCode ? accountMap[acc.parentCode] : null,
      },
    });
    accountMap[acc.code] = created.id;
  }

  console.log(`Created ${accounts.length} accounts`);

  const concepts = [
    { name: 'Combustible', accountCode: '6.01.02' },
    { name: 'Gasolina', accountCode: '6.01.02' },
    { name: 'Diesel', accountCode: '6.01.02' },
    { name: 'Luz', accountCode: '6.01.03' },
    { name: 'Electricidad', accountCode: '6.01.03' },
    { name: 'Internet', accountCode: '6.01.05' },
    { name: 'Cable', accountCode: '6.01.05' },
    { name: 'Teléfono', accountCode: '6.01.06' },
    { name: 'Celular', accountCode: '6.01.06' },
    { name: 'Papelería', accountCode: '6.01.07' },
    { name: 'Útiles de oficina', accountCode: '6.01.07' },
    { name: 'Alquiler', accountCode: '6.01.08' },
    { name: 'Renta', accountCode: '6.01.08' },
    { name: 'Mantenimiento', accountCode: '6.01.09' },
    { name: 'Reparación', accountCode: '6.01.09' },
    { name: 'Seguro', accountCode: '6.01.10' },
    { name: 'Publicidad', accountCode: '6.01.11' },
    { name: 'Marketing', accountCode: '6.01.11' },
    { name: 'Anuncios', accountCode: '6.01.11' },
    { name: 'Hotel', accountCode: '6.01.13' },
    { name: 'Hospedaje', accountCode: '6.01.13' },
    { name: 'Viaje', accountCode: '6.01.12' },
    { name: 'Pasaje', accountCode: '6.01.14' },
    { name: 'Transporte', accountCode: '6.01.14' },
    { name: 'Comisión', accountCode: '6.01.15' },
    { name: 'Honorarios', accountCode: '6.02.01' },
    { name: 'Abogado', accountCode: '6.02.02' },
    { name: 'Notaría', accountCode: '6.02.02' },
    { name: 'Venta', accountCode: '4.01.01' },
    { name: 'Ventas', accountCode: '4.01.01' },
    { name: 'Servicio', accountCode: '4.01.02' },
    { name: 'Servicios', accountCode: '4.01.02' },
    { name: 'Interés', accountCode: '6.03.01' },
    { name: 'Intereses bancarios', accountCode: '6.03.01' },
    { name: 'Comisión bancaria', accountCode: '6.03.02' },
    { name: 'Salario', accountCode: '6.01.01' },
    { name: 'Sueldo', accountCode: '6.01.01' },
    { name: 'Planilla', accountCode: '6.01.01' },
    { name: 'Agua', accountCode: '6.01.04' },
    { name: 'ITBMS', accountCode: '2.1.05' },
    { name: 'Compra de mercancía', accountCode: '5.01.01' },
    { name: 'Compra de inventario', accountCode: '5.01.01' },
    { name: 'Materia prima', accountCode: '5.01.02' },
    { name: 'Equipo de cómputo', accountCode: '1.2.01.04' },
    { name: 'Computadora', accountCode: '1.2.01.04' },
    { name: 'Mueble', accountCode: '1.2.01.03' },
    { name: 'Escritorio', accountCode: '1.2.01.03' },
    { name: 'Silla', accountCode: '1.2.01.03' },
    { name: 'Vehículo', accountCode: '1.2.01.05' },
    { name: 'Préstamo', accountCode: '2.2.01' },
    { name: 'Comida', accountCode: '6.06.01' },
    { name: 'Alimentación', accountCode: '6.06.01' },
    { name: 'Uniforme', accountCode: '6.01.07' },
  ];

  for (const concept of concepts) {
    await prisma.concept.create({
      data: {
        name: concept.name,
        accountId: accountMap[concept.accountCode],
        companyId: company.id,
      },
    });
  }

  console.log(`Created ${concepts.length} concepts`);
  console.log('Seed completed successfully');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
